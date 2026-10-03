/**
 * 员工管理（需求书 7.1 ~ 7.5）：档案、工资、社保，以及三张按时间段的报表。
 *
 * 几处刻意的建模决定：
 *
 * 1. 「分管区域」「直属上级」不另建表：前者复用 employee_scope(scope_type='region')，
 *    后者就是 employee.manager_id。这两处正是 domain/scope.js 构造 L2 管辖范围的输入，
 *    写在一处、读在一处，就不会出现「档案里的分管区域」与「权限里的管辖范围」两套数据。
 *
 * 2. 工资/社保按 (员工, 所属期) 唯一（schema 里已有唯一索引）。本模块把它实现为
 *    「再次录入即更正」（upsert）而不是报错：本模块不提供删除接口，若选择报错，
 *    一个录错的月份就永远无法修正。返回值里带 created 标志，调用方仍能区分首录与更正。
 *
 * 3. 时间段一律打在 pay_date 上，而不是 period 上。period('YYYY-MM') 表达不了
 *    需求书 7.5 的任意时间段，pay_date 可以。未填发放日期时取所属期首日，
 *    避免记录因为 pay_date 为空而在所有区间报表里消失。
 *
 * 4. 身份证与家庭住址是个人敏感信息，非 L1 一律掩码后再出参（在 DTO 层做，
 *    而不是靠前端不打开展示）。掩码做在出参处，任何读方法都不可能漏。
 */

import { NotFoundError, ValidationError } from '../core/errors.js';
import { applyScope } from '../domain/scope.js';
import { fromCents, sumCents } from '../domain/money.js';
import { normalizeDateRange, dateRangeToSql, periodOf, today } from '../domain/daterange.js';
import { hashPassword } from './auth.js';
import {
  requireText, optionalText, requireEnum, requireMoney, optionalMoney,
  optionalId, optionalDate, requireDate,
} from '../core/validate.js';

const LEVELS = ['L1', 'L2', 'L3'];
const LEVEL_LABELS = { L1: '高管层', L2: '经理层', L3: '员工层' };

/** 最短初始密码长度，与 auth.js 保持一致。 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * 员工在权限过滤中可绑定的列。
 *
 * region 轴不能直接打在 employee 上（员工表没有区域列），要靠 employee_scope 关联到
 * region；employee 与 self 两轴都落在「被查员工」的 id 上 —— L2 看的是下属，
 * L3 看的是本人，所以两轴用同一列，applyScope 会把它们 OR 起来。
 */
const EMPLOYEE_SCOPE_BINDING = { region: 'r.id', employee: 'e.id', self: 'e.id' };

/** 仅 L1（高管层）可见身份证与住址原文。 */
const canViewSensitive = (ctx) => ctx?.scope?.kind === 'all' || ctx?.user?.level === 'L1';

/** 身份证掩码：保留前 6 位（地区码）与后 4 位，中间一律星号。太短则整体掩码，避免越掩越露。 */
function maskIdCard(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= 10) return '***';
  return `${text.slice(0, 6)}${'*'.repeat(text.length - 10)}${text.slice(-4)}`;
}

/** 家庭住址非 L1 一律整体掩码：地址的每一段都可能定位到人，留头留尾没有意义。 */
function maskHomeAddress(value) {
  if (value === null || value === undefined) return null;
  return '***';
}

function toEmployee(row, { regions = [], maskSensitive = false } = {}) {
  return {
    id: row.id,
    empNo: row.emp_no,
    name: row.name,
    level: row.level,
    levelLabel: LEVEL_LABELS[row.level] ?? row.level,
    jobTitle: row.job_title ?? null,
    photoPath: row.photo_path ?? null,
    idCard: maskSensitive ? maskIdCard(row.id_card) : (row.id_card ?? null),
    homeAddress: maskSensitive ? maskHomeAddress(row.home_address) : (row.home_address ?? null),
    phone: row.phone ?? null,
    emergencyContact: row.emergency_contact ?? null,
    emergencyPhone: row.emergency_phone ?? null,
    hireDate: row.hire_date ?? null,
    leaveDate: row.leave_date ?? null,
    managerId: row.manager_id ?? null,
    managerName: row.manager_name ?? null,
    isActive: Number(row.is_active) === 1,
    // 分管区域既是档案字段，也是 L2 管辖范围的来源，读接口一并回显，便于前端展示与核对
    regionIds: regions.map((r) => r.id),
    regions,
    createdAt: row.created_at ?? null,
  };
}

function toSalary(row) {
  const totalCents = Number(row.base_cents) + Number(row.performance_cents) + Number(row.year_end_bonus_cents);
  return {
    id: row.id,
    employeeId: row.employee_id,
    empNo: row.emp_no ?? null,
    employeeName: row.employee_name ?? null,
    period: row.period,
    payDate: row.pay_date ?? null,
    baseCents: row.base_cents,
    base: fromCents(row.base_cents),
    performanceCents: row.performance_cents,
    performance: fromCents(row.performance_cents),
    yearEndBonusCents: row.year_end_bonus_cents,
    yearEndBonus: fromCents(row.year_end_bonus_cents),
    totalCents,
    total: fromCents(totalCents),
    remark: row.remark ?? null,
    createdAt: row.created_at ?? null,
  };
}

function toSocialInsurance(row) {
  const employerTotalCents = Number(row.company_fund_cents) + Number(row.company_si_cents);
  const personalTotalCents = Number(row.personal_fund_cents) + Number(row.personal_si_cents);
  return {
    id: row.id,
    employeeId: row.employee_id,
    empNo: row.emp_no ?? null,
    employeeName: row.employee_name ?? null,
    period: row.period,
    payDate: row.pay_date ?? null,
    baseCents: row.base_cents,
    base: fromCents(row.base_cents),
    companyFundCents: row.company_fund_cents,
    companyFund: fromCents(row.company_fund_cents),
    personalFundCents: row.personal_fund_cents,
    personalFund: fromCents(row.personal_fund_cents),
    companySiCents: row.company_si_cents,
    companySi: fromCents(row.company_si_cents),
    personalSiCents: row.personal_si_cents,
    personalSi: fromCents(row.personal_si_cents),
    // 「公司承担五险一金」= 公司承担的公积金 + 公司承担的社保，仅此两项
    employerTotalCents,
    employerTotal: fromCents(employerTotalCents),
    personalTotalCents,
    personalTotal: fromCents(personalTotalCents),
    remark: row.remark ?? null,
    createdAt: row.created_at ?? null,
  };
}

/**
 * 所属期（'YYYY-MM'）。也接受 'YYYY-MM-DD'：前端日期控件给的是完整日期，
 * 而工资/社保的所属期只到月，取所在月即可。
 */
function requirePeriod(value, label) {
  const text = requireText(value, label);
  if (/^\d{4}-\d{2}$/.test(text)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) {
      throw new ValidationError(`${label}格式不正确，应为 YYYY-MM`);
    }
    return text;
  }
  try {
    return periodOf(text);
  } catch {
    throw new ValidationError(`${label}格式不正确，应为 YYYY-MM`);
  }
}

/**
 * 取第一个「填了值」的金额字段，返回「分」。
 *
 * 同一含义在前后端有两套命名（表单用 baseAmount / companySocial，本模块按列名取
 * base / companySi），这里一次兜住，避免前端提交的字段名对不上就静默存成 0。
 */
function amountOf(input, label, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return requireMoney(value, label);
    }
  }
  return 0;
}

/** 离职日期不得早于入职日期。两者都是可空的，只在都填了时校验。 */
function assertLeaveAfterHire(hireDate, leaveDate) {
  if (hireDate && leaveDate && leaveDate < hireDate) {
    throw new ValidationError('离职日期不能早于入职日期');
  }
}

export function createEmployeesService(db) {
  /**
   * 可见员工的 id 子查询。
   *
   * 用「IN 子查询」而不是在每条语句里直接 join employee_scope：一个员工可以挂多条
   * region 范围行，直接 join 会让工资/社保行按范围条数翻倍，金额汇总随之虚高。
   * 子查询出现重复 id 无妨，IN 自动去重。
   */
  function visibleEmployees(ctx) {
    const scope = applyScope(ctx.scope, EMPLOYEE_SCOPE_BINDING);
    return {
      sql: `select e.id from employee e
              left join employee_scope es on es.employee_id = e.id and es.scope_type = 'region'
              left join region r on r.id = es.scope_value_id
             where 1=1${scope.sql}`,
      params: scope.params,
    };
  }

  /** 读取员工行。不存在或超出可见范围一律按「不存在」处理，避免泄漏范围外的存在性。 */
  async function findEmployee(ctx, id) {
    const visible = visibleEmployees(ctx);
    const row = await db.one(
      `select emp.*, m.name as manager_name
         from employee emp
         left join employee m on m.id = emp.manager_id
        where emp.id = ? and emp.id in (${visible.sql})`,
      [id, ...visible.params],
    );
    if (!row) throw new NotFoundError('员工不存在或不在您的可见范围内');
    return row;
  }

  /** 批量取分管区域，避免列表页 N+1。返回 employeeId → [{id, code, name}]。 */
  async function loadRegionScopes(ids) {
    const map = new Map();
    if (ids.length === 0) return map;

    const rows = await db.query(
      `select es.employee_id, r.id as region_id, r.code, r.name
         from employee_scope es
         join region r on r.id = es.scope_value_id
        where es.scope_type = 'region'
          and es.employee_id in (${ids.map(() => '?').join(', ')})
        order by es.employee_id, r.id`,
      ids,
    );

    for (const row of rows) {
      const key = Number(row.employee_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ id: row.region_id, code: row.code, name: row.name });
    }
    return map;
  }

  /** 校验分管区域存在，返回去重后的 id 数组。 */
  async function resolveRegionIds(value) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw new ValidationError('分管区域必须是数组');

    const ids = value.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new ValidationError('分管区域不正确');
      return n;
    });
    const unique = [...new Set(ids)];

    for (const regionId of unique) {
      const region = await db.one('select id from region where id = ?', [regionId]);
      if (!region) throw new NotFoundError(`分管区域不存在：${regionId}`);
    }
    return unique;
  }

  /**
   * 覆盖某员工的 region 范围行。
   *
   * 只删 scope_type='region' 的行：同一个员工还可能挂着 variety 范围（另一位模块负责），
   * 一并删掉会把品种线的管辖范围悄悄清空。
   */
  async function replaceRegionScopes(t, employeeId, regionIds) {
    await t.run(
      'delete from employee_scope where employee_id = ? and scope_type = ?',
      [employeeId, 'region'],
    );
    for (const regionId of regionIds) {
      await t.insert('employee_scope', {
        employee_id: employeeId,
        scope_type: 'region',
        scope_value_id: regionId,
      });
    }
  }

  /**
   * 校验直属上级：必须存在，不能是本人，也不能形成上下级环。
   * 环本身不会让 domain/scope.js 的闭包死循环（那里有环保护），但会让「下属」失去意义，
   * 属于应当当场拒绝的脏数据。
   */
  async function resolveManagerId(managerId, selfId) {
    if (managerId === null) return null;

    const self = selfId === null ? null : Number(selfId);
    if (self !== null && Number(managerId) === self) {
      throw new ValidationError('直属上级不能是本人');
    }

    let cursor = Number(managerId);
    const seen = new Set();
    while (true) {
      if (self !== null && cursor === self) {
        throw new ValidationError('直属上级不能是本人的下级，否则会形成上下级环路');
      }
      if (seen.has(cursor)) break; // 库里已有环：不再深挖，交给后续修数据
      seen.add(cursor);

      const row = await db.one('select id, manager_id from employee where id = ?', [cursor]);
      if (!row) throw new NotFoundError(`直属上级不存在：${managerId}`);
      if (row.manager_id === null || row.manager_id === undefined) break;
      cursor = Number(row.manager_id);
    }
    return managerId;
  }

  /** 在事务里写入员工行，随后覆盖其 region 范围；两处要么都成功要么都回滚。 */
  async function insertEmployeeWithScopes(columns, regionIds) {
    return db.tx(async (t) => {
      const id = await t.insert('employee', columns);
      await replaceRegionScopes(t, id, regionIds);
      return id;
    });
  }

  /**
   * 工资按员工汇总（左闭右开的 pay_date 区间内）。
   *
   * pay_date 存的是 '2026-03-10'，所以时间段必须用日期粒度的 normalizeDateRange /
   * dateRangeToSql：带时间的边界 '2026-03-10 00:00:00' 在字符串比较下大于
   * '2026-03-10'，会让「起止同日」的查询一条都查不到（静默返回 0，最难发现）。
   */
  async function salaryAggregates(ctx, { range = null, employeeId = null } = {}) {
    const visible = visibleEmployees(ctx);
    const conditions = [`s.employee_id in (${visible.sql})`];
    const params = [...visible.params];

    if (range) {
      const timeFilter = dateRangeToSql(range, 's.pay_date');
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
    }
    if (employeeId) { conditions.push('s.employee_id = ?'); params.push(employeeId); }

    return db.query(
      `select s.employee_id, e.emp_no, e.name as employee_name,
              coalesce(sum(s.base_cents), 0) as base_cents,
              coalesce(sum(s.performance_cents), 0) as performance_cents,
              coalesce(sum(s.year_end_bonus_cents), 0) as year_end_bonus_cents
         from salary_record s
         join employee e on e.id = s.employee_id
        where ${conditions.join(' and ')}
        group by s.employee_id, e.emp_no, e.name`,
      params,
    );
  }

  /** 社保按员工汇总；公司承担与个人承担分开累计，绝不混入彼此。 */
  async function socialInsuranceAggregates(ctx, { range = null, employeeId = null } = {}) {
    const visible = visibleEmployees(ctx);
    const conditions = [`s.employee_id in (${visible.sql})`];
    const params = [...visible.params];

    if (range) {
      const timeFilter = dateRangeToSql(range, 's.pay_date');
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
    }
    if (employeeId) { conditions.push('s.employee_id = ?'); params.push(employeeId); }

    return db.query(
      `select s.employee_id, e.emp_no, e.name as employee_name,
              coalesce(sum(s.base_cents), 0) as base_cents,
              coalesce(sum(s.company_fund_cents), 0) as company_fund_cents,
              coalesce(sum(s.personal_fund_cents), 0) as personal_fund_cents,
              coalesce(sum(s.company_si_cents), 0) as company_si_cents,
              coalesce(sum(s.personal_si_cents), 0) as personal_si_cents
         from social_insurance_record s
         join employee e on e.id = s.employee_id
        where ${conditions.join(' and ')}
        group by s.employee_id, e.emp_no, e.name`,
      params,
    );
  }

  return {
    /** 7.1 员工信息录入。工号唯一，密码经 scrypt 加密后落库。 */
    async createEmployee(ctx, input) {
      const empNo = requireText(input.empNo, '员工工号', { maxLength: 32 });
      const name = requireText(input.name, '姓名', { maxLength: 32 });
      const level = requireEnum(input.level, '职级', LEVELS, LEVEL_LABELS);

      const existing = await db.one('select id from employee where emp_no = ?', [empNo]);
      if (existing) throw new ValidationError(`员工工号 ${empNo} 已存在`);

      const hireDate = optionalDate(input.hireDate, '入职日期');
      const leaveDate = optionalDate(input.leaveDate, '离职日期');
      assertLeaveAfterHire(hireDate, leaveDate);

      const managerId = await resolveManagerId(optionalId(input.managerId, '直属上级'), null);
      const regionIds = await resolveRegionIds(input.regionIds ?? []);

      // 初始密码可选：门卫、临时工等岗位未必需要登录账号，此时留空即「无法登录」。
      let credentials = { password_hash: null, password_salt: null, must_change_password: 0 };
      const rawPassword = input.password === null || input.password === undefined
        ? ''
        : String(input.password);
      if (rawPassword.trim() !== '') {
        if (rawPassword.length < MIN_PASSWORD_LENGTH) {
          throw new ValidationError(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
        }
        const { hash, salt } = hashPassword(rawPassword);
        // 管理员代设的初始密码首次登录必须改，与 auth.ensureDefaultAdmin 的初始管理员一致
        credentials = { password_hash: hash, password_salt: salt, must_change_password: 1 };
      }

      return insertEmployeeWithScopes({
        emp_no: empNo,
        name,
        level,
        job_title: optionalText(input.jobTitle, '职务'),
        photo_path: optionalText(input.photoPath, '照片'),
        id_card: optionalText(input.idCard, '身份证号', { maxLength: 18 }),
        home_address: optionalText(input.homeAddress, '家庭住址', { maxLength: 255 }),
        phone: optionalText(input.phone, '联系电话', { maxLength: 32 }),
        emergency_contact: optionalText(input.emergencyContact, '紧急联系人'),
        emergency_phone: optionalText(input.emergencyPhone, '紧急联系电话'),
        hire_date: hireDate,
        leave_date: leaveDate,
        manager_id: managerId,
        // 建号时就填了离职日期的，直接按离职处理，不用再走一次离职接口
        is_active: leaveDate ? 0 : 1,
        ...credentials,
        created_by: ctx.user?.id ?? null,
      }, regionIds);
    },

    /** 7.1 修改员工。传入 regionIds 即整体覆盖其分管区域（传 [] 表示清空）。 */
    async updateEmployee(ctx, id, input) {
      const current = await findEmployee(ctx, id);
      const patch = {};
      let regionIds;

      if (input.empNo !== undefined) {
        const empNo = requireText(input.empNo, '员工工号', { maxLength: 32 });
        const other = await db.one('select id from employee where emp_no = ? and id <> ?', [empNo, id]);
        if (other) throw new ValidationError(`员工工号 ${empNo} 已存在`);
        patch.emp_no = empNo;
      }
      if (input.name !== undefined) patch.name = requireText(input.name, '姓名', { maxLength: 32 });
      if (input.level !== undefined) patch.level = requireEnum(input.level, '职级', LEVELS, LEVEL_LABELS);
      if (input.jobTitle !== undefined) patch.job_title = optionalText(input.jobTitle, '职务');
      if (input.photoPath !== undefined) patch.photo_path = optionalText(input.photoPath, '照片');
      if (input.idCard !== undefined) patch.id_card = optionalText(input.idCard, '身份证号', { maxLength: 18 });
      if (input.homeAddress !== undefined) patch.home_address = optionalText(input.homeAddress, '家庭住址', { maxLength: 255 });
      if (input.phone !== undefined) patch.phone = optionalText(input.phone, '联系电话', { maxLength: 32 });
      if (input.emergencyContact !== undefined) patch.emergency_contact = optionalText(input.emergencyContact, '紧急联系人');
      if (input.emergencyPhone !== undefined) patch.emergency_phone = optionalText(input.emergencyPhone, '紧急联系电话');
      if (input.managerId !== undefined) {
        patch.manager_id = await resolveManagerId(optionalId(input.managerId, '直属上级'), id);
      }
      if (input.regionIds !== undefined) regionIds = await resolveRegionIds(input.regionIds);

      // 重置密码。留空表示不改（与前端表单「编辑时留空表示不改」的提示一致），
      // 因此这里不能把它当成必填项来校验。
      const rawPassword = input.password === null || input.password === undefined
        ? ''
        : String(input.password);
      if (rawPassword.trim() !== '') {
        if (rawPassword.length < MIN_PASSWORD_LENGTH) {
          throw new ValidationError(`密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位`);
        }
        const { hash, salt } = hashPassword(rawPassword);
        patch.password_hash = hash;
        patch.password_salt = salt;
        patch.must_change_password = 1;
      }

      // 入职/离职日期是成对的：只改其中一个也要按改后的组合校验先后顺序
      const hireDate = input.hireDate !== undefined ? optionalDate(input.hireDate, '入职日期') : current.hire_date;
      const leaveDate = input.leaveDate !== undefined ? optionalDate(input.leaveDate, '离职日期') : current.leave_date;
      assertLeaveAfterHire(hireDate, leaveDate);
      if (input.hireDate !== undefined) patch.hire_date = hireDate;
      if (input.leaveDate !== undefined) {
        patch.leave_date = leaveDate;
        // 补填离职日期即停用；清空离职日期即复职，避免出现「在职但停用」的矛盾状态
        patch.is_active = leaveDate ? 0 : 1;
      }

      if (Object.keys(patch).length === 0 && regionIds === undefined) {
        throw new ValidationError('没有需要更新的字段');
      }

      await db.tx(async (t) => {
        if (Object.keys(patch).length > 0) await t.update('employee', patch, { id });
        if (regionIds !== undefined) await replaceRegionScopes(t, id, regionIds);
      });
      return id;
    },

    /** 7.1 单个员工详情。超出可见范围按「不存在」处理。 */
    async getEmployee(ctx, id) {
      const row = await findEmployee(ctx, id);
      const regions = await loadRegionScopes([row.id]);
      return toEmployee(row, {
        regions: regions.get(Number(row.id)) ?? [],
        maskSensitive: !canViewSensitive(ctx),
      });
    },

    /** 7.1 员工列表。默认只看在职；keyword 匹配工号 / 姓名 / 电话。 */
    async listEmployees(ctx, { keyword = null, level = null, includeInactive = false } = {}) {
      const visible = visibleEmployees(ctx);
      const conditions = [`emp.id in (${visible.sql})`];
      const params = [...visible.params];

      if (!includeInactive) conditions.push('emp.is_active = 1');
      if (level) {
        conditions.push('emp.level = ?');
        params.push(requireEnum(level, '职级', LEVELS, LEVEL_LABELS));
      }
      if (keyword) {
        conditions.push('(emp.name like ? or emp.emp_no like ? or emp.phone like ?)');
        const like = `%${keyword}%`;
        params.push(like, like, like);
      }

      const rows = await db.query(
        `select emp.*, m.name as manager_name
           from employee emp
           left join employee m on m.id = emp.manager_id
          where ${conditions.join(' and ')}
          order by emp.emp_no`,
        params,
      );
      const regions = await loadRegionScopes(rows.map((r) => r.id));
      const maskSensitive = !canViewSensitive(ctx);
      return rows.map((row) => toEmployee(row, {
        regions: regions.get(Number(row.id)) ?? [],
        maskSensitive,
      }));
    },

    /** 7.1 离职办理：写入离职日期并停用账号（停用后 auth 的已签发会话立即失效）。 */
    async terminateEmployee(ctx, id, leaveDate = null) {
      const current = await findEmployee(ctx, id);
      // 未指定离职日期时取当天：接口签名里这一项是可选的，缺省不该拒绝办理
      const leave = leaveDate ? requireDate(leaveDate, '离职日期') : today();
      assertLeaveAfterHire(current.hire_date, leave);

      await db.update('employee', { leave_date: leave, is_active: 0 }, { id });
      return id;
    },

    /** 7.2 员工工资录入。同一员工同一所属期再次录入视为更正（upsert）。 */
    async recordSalary(ctx, input) {
      const employeeId = optionalId(input.employeeId, '员工');
      if (!employeeId) throw new ValidationError('员工不能为空');
      await findEmployee(ctx, employeeId);

      const period = requirePeriod(input.period, '工资所属期');
      const payDate = input.payDate
        ? requireDate(input.payDate, '发放日期')
        : `${period}-01`;

      const columns = {
        employee_id: employeeId,
        period,
        pay_date: payDate,
        base_cents: requireMoney(input.baseSalary, '基本工资'),
        // 绩效与年终奖缺省为 0：列都是 NOT NULL，用 null 会撞约束，用 0 则语义正确
        performance_cents: optionalMoney(input.performanceSalary, '绩效工资') ?? 0,
        year_end_bonus_cents: optionalMoney(input.yearEndBonus, '年终奖') ?? 0,
        remark: optionalText(input.remark, '备注'),
        created_by: ctx.user?.id ?? null,
      };

      const existing = await db.one(
        'select id from salary_record where employee_id = ? and period = ?',
        [employeeId, period],
      );
      if (existing) {
        await db.update('salary_record', columns, { id: existing.id });
        return { id: existing.id, created: false };
      }
      return { id: await db.insert('salary_record', columns), created: true };
    },

    /** 7.2 工资明细（按 pay_date 的时间段 + 员工）。 */
    async listSalaries(ctx, { from = null, to = null, employeeId = null } = {}) {
      const range = normalizeDateRange(from, to);
      const visible = visibleEmployees(ctx);
      const who = optionalId(employeeId, '员工');

      const conditions = [`s.employee_id in (${visible.sql})`];
      const params = [...visible.params];
      const timeFilter = dateRangeToSql(range, 's.pay_date');
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (who) { conditions.push('s.employee_id = ?'); params.push(who); }

      const rows = await db.query(
        `select s.*, e.emp_no, e.name as employee_name
           from salary_record s
           join employee e on e.id = s.employee_id
          where ${conditions.join(' and ')}
          order by s.pay_date desc, s.id desc`,
        params,
      );
      return rows.map(toSalary);
    },

    /** 7.3 员工社保与公积金录入。同一员工同一所属期再次录入视为更正（upsert）。 */
    async recordSocialInsurance(ctx, input) {
      const employeeId = optionalId(input.employeeId, '员工');
      if (!employeeId) throw new ValidationError('员工不能为空');
      await findEmployee(ctx, employeeId);

      const period = requirePeriod(input.period, '社保所属期');
      const payDate = input.payDate
        ? requireDate(input.payDate, '缴纳日期')
        : `${period}-01`;

      const columns = {
        employee_id: employeeId,
        period,
        pay_date: payDate,
        base_cents: amountOf(input, '社保缴纳基数', 'baseAmount', 'base'),
        company_fund_cents: amountOf(input, '公司承担公积金', 'companyFund'),
        personal_fund_cents: amountOf(input, '个人承担公积金', 'personalFund'),
        company_si_cents: amountOf(input, '公司承担社保', 'companySocial', 'companySi'),
        personal_si_cents: amountOf(input, '个人承担社保', 'personalSocial', 'personalSi'),
        remark: optionalText(input.remark, '备注'),
        created_by: ctx.user?.id ?? null,
      };

      const existing = await db.one(
        'select id from social_insurance_record where employee_id = ? and period = ?',
        [employeeId, period],
      );
      if (existing) {
        await db.update('social_insurance_record', columns, { id: existing.id });
        return { id: existing.id, created: false };
      }
      return { id: await db.insert('social_insurance_record', columns), created: true };
    },

    /** 7.3 社保缴纳明细（按 pay_date 的时间段 + 员工）。 */
    async listSocialInsurance(ctx, { from = null, to = null, employeeId = null } = {}) {
      const range = normalizeDateRange(from, to);
      const visible = visibleEmployees(ctx);
      const who = optionalId(employeeId, '员工');

      const conditions = [`s.employee_id in (${visible.sql})`];
      const params = [...visible.params];
      const timeFilter = dateRangeToSql(range, 's.pay_date');
      if (timeFilter.sql) { conditions.push(timeFilter.sql); params.push(...timeFilter.params); }
      if (who) { conditions.push('s.employee_id = ?'); params.push(who); }

      const rows = await db.query(
        `select s.*, e.emp_no, e.name as employee_name
           from social_insurance_record s
           join employee e on e.id = s.employee_id
          where ${conditions.join(' and ')}
          order by s.pay_date desc, s.id desc`,
        params,
      );
      return rows.map(toSocialInsurance);
    },

    /**
     * 7.5 工资支出报表，一个方法覆盖三种问法：
     *   ① 某员工发放工资支出        → 传 employeeId
     *   ② 所有员工发放工资支出      → 都不传（受当前用户权限范围限制）
     *   ⑤ 某员工工资及五险一金总支出 → 传 employeeId + includeSocialInsurance: true
     *
     * includeSocialInsurance 只并入「公司承担」的公积金与社保 —— 个人承担部分是
     * 从员工工资里代扣的，不是公司的支出，混进来会把人工成本算高。
     */
    async payrollReport(ctx, { from = null, to = null, employeeId = null, includeSocialInsurance = false } = {}) {
      const range = normalizeDateRange(from, to);
      const who = optionalId(employeeId, '员工');

      // 工资与社保分两条语句各自聚合后再在内存里合并：两者在 (员工, 期间) 上并非一一对应
      // （某月可能只发了工资、没缴社保），直接 join 会让金额按匹配行数翻倍。
      const entries = new Map();
      for (const row of await salaryAggregates(ctx, { range, employeeId: who })) {
        entries.set(Number(row.employee_id), {
          employeeId: Number(row.employee_id),
          empNo: row.emp_no,
          employeeName: row.employee_name,
          baseCents: Number(row.base_cents),
          performanceCents: Number(row.performance_cents),
          yearEndBonusCents: Number(row.year_end_bonus_cents),
          employerSocialInsuranceTotalCents: 0,
          personalSocialInsuranceTotalCents: 0,
        });
      }

      if (includeSocialInsurance) {
        for (const row of await socialInsuranceAggregates(ctx, { range, employeeId: who })) {
          const key = Number(row.employee_id);
          // 只有社保没有工资的员工同样要出现，否则这块钱在总支出里被漏掉
          if (!entries.has(key)) {
            entries.set(key, {
              employeeId: key,
              empNo: row.emp_no,
              employeeName: row.employee_name,
              baseCents: 0,
              performanceCents: 0,
              yearEndBonusCents: 0,
              employerSocialInsuranceTotalCents: 0,
              personalSocialInsuranceTotalCents: 0,
            });
          }
          const entry = entries.get(key);
          entry.employerSocialInsuranceTotalCents = Number(row.company_fund_cents) + Number(row.company_si_cents);
          entry.personalSocialInsuranceTotalCents = Number(row.personal_fund_cents) + Number(row.personal_si_cents);
        }
      }

      const rows = [...entries.values()]
        .map((e) => {
          const salaryTotalCents = e.baseCents + e.performanceCents + e.yearEndBonusCents;
          const grandTotalCents = salaryTotalCents + e.employerSocialInsuranceTotalCents;
          return {
            employeeId: e.employeeId,
            empNo: e.empNo,
            employeeName: e.employeeName,
            baseCents: e.baseCents,
            base: fromCents(e.baseCents),
            performanceCents: e.performanceCents,
            performance: fromCents(e.performanceCents),
            yearEndBonusCents: e.yearEndBonusCents,
            yearEndBonus: fromCents(e.yearEndBonusCents),
            salaryTotalCents,
            salaryTotal: fromCents(salaryTotalCents),
            // 与工资明细接口同名的「应发合计」（基本 + 绩效 + 年终奖），不含五险一金
            totalCents: salaryTotalCents,
            total: fromCents(salaryTotalCents),
            employerSocialInsuranceTotalCents: e.employerSocialInsuranceTotalCents,
            employerSocialInsuranceTotal: fromCents(e.employerSocialInsuranceTotalCents),
            // 个人承担部分仅作核对用，不计入任何合计数
            personalSocialInsuranceTotalCents: e.personalSocialInsuranceTotalCents,
            personalSocialInsuranceTotal: fromCents(e.personalSocialInsuranceTotalCents),
            grandTotalCents,
            grandTotal: fromCents(grandTotalCents),
          };
        })
        .sort((a, b) => String(a.empNo).localeCompare(String(b.empNo)));

      const totals = {
        employeeCount: rows.length,
        baseCents: sumCents(rows, (r) => r.baseCents),
        performanceCents: sumCents(rows, (r) => r.performanceCents),
        yearEndBonusCents: sumCents(rows, (r) => r.yearEndBonusCents),
        salaryTotalCents: sumCents(rows, (r) => r.salaryTotalCents),
        totalCents: sumCents(rows, (r) => r.totalCents),
        employerSocialInsuranceTotalCents: sumCents(rows, (r) => r.employerSocialInsuranceTotalCents),
        personalSocialInsuranceTotalCents: sumCents(rows, (r) => r.personalSocialInsuranceTotalCents),
        grandTotalCents: sumCents(rows, (r) => r.grandTotalCents),
      };
      totals.base = fromCents(totals.baseCents);
      totals.performance = fromCents(totals.performanceCents);
      totals.yearEndBonus = fromCents(totals.yearEndBonusCents);
      totals.salaryTotal = fromCents(totals.salaryTotalCents);
      totals.total = fromCents(totals.totalCents);
      totals.employerSocialInsuranceTotal = fromCents(totals.employerSocialInsuranceTotalCents);
      totals.personalSocialInsuranceTotal = fromCents(totals.personalSocialInsuranceTotalCents);
      totals.grandTotal = fromCents(totals.grandTotalCents);

      return {
        // 合计同时摊在根上与 totals 上（同一个对象）：报表页的合计栏读根，
        // 表格合计读 totals，两种取法都成立，不必约定只认其中一层。
        ...totals,
        rows,
        totals,
        range: { from: range.from, toExclusive: range.toExclusive },
      };
    },

    /**
     * 7.5 公司承担五险一金报表，覆盖两种问法：
     *   ③ 某个员工公司承担五险一金 → 传 employeeId
     *   ④ 所有员工公司承担五险一金 → 不传（受当前用户权限范围限制）
     *
     * 口径：公司承担 = companyFundCents + companySiCents。个人承担的两项单独列出，
     * 绝不并入 —— 那是从员工工资里代扣的钱，不是公司的支出。
     */
    async socialInsuranceReport(ctx, { from = null, to = null, employeeId = null } = {}) {
      const range = normalizeDateRange(from, to);
      const who = optionalId(employeeId, '员工');

      const rows = (await socialInsuranceAggregates(ctx, { range, employeeId: who }))
        .map((row) => {
          const employerTotalCents = Number(row.company_fund_cents) + Number(row.company_si_cents);
          const personalTotalCents = Number(row.personal_fund_cents) + Number(row.personal_si_cents);
          return {
            employeeId: Number(row.employee_id),
            empNo: row.emp_no,
            employeeName: row.employee_name,
            baseCents: Number(row.base_cents),
            base: fromCents(Number(row.base_cents)),
            companyFundCents: Number(row.company_fund_cents),
            companyFund: fromCents(Number(row.company_fund_cents)),
            companySiCents: Number(row.company_si_cents),
            companySi: fromCents(Number(row.company_si_cents)),
            employerTotalCents,
            employerTotal: fromCents(employerTotalCents),
            personalFundCents: Number(row.personal_fund_cents),
            personalFund: fromCents(Number(row.personal_fund_cents)),
            personalSiCents: Number(row.personal_si_cents),
            personalSi: fromCents(Number(row.personal_si_cents)),
            personalTotalCents,
            personalTotal: fromCents(personalTotalCents),
          };
        })
        .sort((a, b) => String(a.empNo).localeCompare(String(b.empNo)));

      const totals = {
        employeeCount: rows.length,
        baseCents: sumCents(rows, (r) => r.baseCents),
        companyFundCents: sumCents(rows, (r) => r.companyFundCents),
        companySiCents: sumCents(rows, (r) => r.companySiCents),
        employerTotalCents: sumCents(rows, (r) => r.employerTotalCents),
        personalFundCents: sumCents(rows, (r) => r.personalFundCents),
        personalSiCents: sumCents(rows, (r) => r.personalSiCents),
        personalTotalCents: sumCents(rows, (r) => r.personalTotalCents),
      };
      totals.base = fromCents(totals.baseCents);
      totals.companyFund = fromCents(totals.companyFundCents);
      totals.companySi = fromCents(totals.companySiCents);
      totals.employerTotal = fromCents(totals.employerTotalCents);
      totals.personalFund = fromCents(totals.personalFundCents);
      totals.personalSi = fromCents(totals.personalSiCents);
      totals.personalTotal = fromCents(totals.personalTotalCents);

      return {
        // 同上：根上与 totals 都能取到合计
        ...totals,
        rows,
        totals,
        range: { from: range.from, toExclusive: range.toExclusive },
      };
    },

  };
}
