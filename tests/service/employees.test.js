import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.js';
import { createEmployeesService } from '../../src/services/employees.js';
import { verifyPassword } from '../../src/services/auth.js';
import { buildScope } from '../../src/domain/scope.js';

/** L1（高管层）上下文：可见全部数据，身份证与住址取原文。 */
const l1ctx = () => ({
  user: { id: 1, level: 'L1', name: '管理员' },
  scope: buildScope({ id: 1, level: 'L1' }, {}),
});

/**
 * 按库中真实的组织数据构造某个员工的上下文。
 * 与 auth 服务登录后的做法一致：区域树、员工表、范围表一次性读入，
 * 交给 domain/scope.js 的纯函数求闭包。
 */
async function ctxFor(db, employeeId) {
  const actor = await db.one('select id, name, level from employee where id = ?', [employeeId]);
  const regions = await db.query('select id, parent_id from region');
  const employees = await db.query('select id, manager_id from employee');
  const scopes = await db.query('select employee_id, scope_type, scope_value_id from employee_scope');
  return {
    user: { id: actor.id, level: actor.level, name: actor.name },
    scope: buildScope(actor, { regions, employees, scopes }),
  };
}

const employeeInput = (over = {}) => ({
  empNo: 'E001',
  name: '张三',
  level: 'L3',
  jobTitle: '业务员',
  photoPath: '/photos/e001.png',
  idCard: '110101199001011234',
  homeAddress: '黑龙江省哈尔滨市南岗区某街 1 号',
  phone: '13800000001',
  emergencyContact: '李四',
  emergencyPhone: '13900000001',
  hireDate: '2024-01-01',
  ...over,
});

describe('employees — 员工管理（需求书 7.1 ~ 7.5）', () => {
  let db;
  let svc;
  let ctx;

  beforeEach(async () => {
    db = await makeDb();
    svc = createEmployeesService(db);
    ctx = l1ctx();
  });
  afterEach(async () => { await db.close(); });

  describe('7.1 员工信息录入', () => {
    test('录入全部字段并原样读回', async () => {
      const r1 = await db.insert('region', { code: 'R01', name: '黑龙江' });
      const r2 = await db.insert('region', { code: 'R02', name: '哈尔滨', parent_id: r1 });
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E000', name: '王经理', level: 'L2' }));

      const id = await svc.createEmployee(ctx, employeeInput({ managerId: boss, regionIds: [r1, r2] }));
      const e = await svc.getEmployee(ctx, id);

      assert.equal(e.empNo, 'E001');
      assert.equal(e.name, '张三');
      assert.equal(e.level, 'L3');
      assert.equal(e.levelLabel, '员工层');
      assert.equal(e.jobTitle, '业务员');
      assert.equal(e.photoPath, '/photos/e001.png');
      assert.equal(e.idCard, '110101199001011234');
      assert.equal(e.homeAddress, '黑龙江省哈尔滨市南岗区某街 1 号');
      assert.equal(e.phone, '13800000001');
      assert.equal(e.emergencyContact, '李四');
      assert.equal(e.emergencyPhone, '13900000001');
      assert.equal(e.hireDate, '2024-01-01');
      assert.equal(e.leaveDate, null);
      assert.equal(e.managerId, boss);
      assert.equal(e.managerName, '王经理');
      assert.equal(e.isActive, true);
      assert.deepEqual(e.regionIds, [r1, r2]);
      assert.deepEqual(e.regions.map((r) => r.name), ['黑龙江', '哈尔滨']);
    });

    test('职级只允许 L1 / L2 / L3 并翻译为中文', async () => {
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ level: 'L9' })), /职级/);

      const a = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '甲', level: 'L1' }));
      const b = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '乙', level: 'L2' }));
      assert.equal((await svc.getEmployee(ctx, a)).levelLabel, '高管层');
      assert.equal((await svc.getEmployee(ctx, b)).levelLabel, '经理层');
    });

    test('员工工号 / 姓名 / 职级为必填', async () => {
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ empNo: '' })), /员工工号/);
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ name: '' })), /姓名/);
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ level: null })), /职级/);
    });

    test('员工工号唯一', async () => {
      await svc.createEmployee(ctx, employeeInput());
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ name: '另一个' })), /已存在/);
    });

    test('建号时密码加密存储，绝不落明文', async () => {
      const id = await svc.createEmployee(ctx, employeeInput({ password: 'init-1234' }));
      const row = await db.one('select * from employee where id = ?', [id]);

      assert.ok(row.password_hash, '应有密码哈希');
      assert.notEqual(row.password_hash, 'init-1234');
      assert.ok(row.password_salt, '应有随机盐');
      assert.equal(verifyPassword('init-1234', row.password_hash, row.password_salt), true);
    });

    test('密码过短时拒绝', async () => {
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ password: '123' })), /密码/);
    });

    test('不传密码时不生成登录凭据（该员工无法登录）', async () => {
      const id = await svc.createEmployee(ctx, employeeInput());
      const row = await db.one('select * from employee where id = ?', [id]);

      assert.equal(row.password_hash, null);
      assert.equal(row.password_salt, null);
      assert.equal(verifyPassword('whatever', row.password_hash, row.password_salt), false);
    });

    test('任何读接口都不返回密码字段', async () => {
      const id = await svc.createEmployee(ctx, employeeInput({ password: 'init-1234' }));
      const rows = [await svc.getEmployee(ctx, id), ...await svc.listEmployees(ctx, {})];
      assert.equal(rows.length, 2);

      for (const e of rows) {
        assert.equal('passwordHash' in e, false);
        assert.equal('password_hash' in e, false);
        assert.equal('passwordSalt' in e, false);
        assert.equal(JSON.stringify(e).includes('password'), false, '序列化结果里不应出现 password');
      }
    });

    test('离职日期不得早于入职日期', async () => {
      await assert.rejects(
        () => svc.createEmployee(ctx, employeeInput({ hireDate: '2024-06-01', leaveDate: '2024-05-01' })),
        /离职日期/,
      );
    });

    test('直属上级必须存在，且不能是本人', async () => {
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ managerId: 99999 })), /上级/);

      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E000', name: '王经理', level: 'L2' }));
      await assert.rejects(() => svc.updateEmployee(ctx, boss, { managerId: boss }), /上级/);
    });

    test('上下级不能成环', async () => {
      const a = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '甲', level: 'L2' }));
      const b = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '乙', managerId: a }));
      await assert.rejects(() => svc.updateEmployee(ctx, a, { managerId: b }), /上级/);
    });

    test('分管区域必须存在', async () => {
      await assert.rejects(() => svc.createEmployee(ctx, employeeInput({ regionIds: [99999] })), /分管区域/);
    });

    test('修改员工并覆盖分管区域', async () => {
      const r1 = await db.insert('region', { code: 'R01', name: '黑龙江' });
      const r2 = await db.insert('region', { code: 'R02', name: '吉林' });
      const id = await svc.createEmployee(ctx, employeeInput({ regionIds: [r1] }));

      await svc.updateEmployee(ctx, id, { name: '张三丰', phone: '13800000002', regionIds: [r1, r2] });
      const e = await svc.getEmployee(ctx, id);
      assert.equal(e.name, '张三丰');
      assert.equal(e.phone, '13800000002');
      assert.deepEqual(e.regionIds, [r1, r2]);

      await svc.updateEmployee(ctx, id, { regionIds: [] });
      assert.deepEqual((await svc.getEmployee(ctx, id)).regionIds, []);
    });

    test('改工号不能与已存在的工号冲突', async () => {
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E001' }));
      const b = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李四' }));

      await assert.rejects(() => svc.updateEmployee(ctx, b, { empNo: 'E001' }), /已存在/);

      await svc.updateEmployee(ctx, b, { empNo: 'E003' });
      assert.equal((await svc.getEmployee(ctx, b)).empNo, 'E003');
    });

    test('修改时可重置密码，留空表示不改', async () => {
      const id = await svc.createEmployee(ctx, employeeInput({ password: 'init-1234' }));
      const before = await db.one('select password_hash from employee where id = ?', [id]);

      await svc.updateEmployee(ctx, id, { name: '张三丰', password: '' });
      const after = await db.one('select * from employee where id = ?', [id]);
      assert.equal(after.password_hash, before.password_hash, '留空不应改动密码');
      assert.equal(after.name, '张三丰');

      await svc.updateEmployee(ctx, id, { password: 'new-5678' });
      const reset = await db.one('select * from employee where id = ?', [id]);
      assert.notEqual(reset.password_hash, before.password_hash);
      assert.equal(verifyPassword('new-5678', reset.password_hash, reset.password_salt), true);
      assert.equal(verifyPassword('init-1234', reset.password_hash, reset.password_salt), false);

      await assert.rejects(() => svc.updateEmployee(ctx, id, { password: '123' }), /密码/);
    });

    test('没有需要更新的字段时报错', async () => {
      const id = await svc.createEmployee(ctx, employeeInput());
      await assert.rejects(() => svc.updateEmployee(ctx, id, {}), /没有需要更新的字段/);
    });

    test('按关键字与职级筛选，默认不含离职员工', async () => {
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '张三', level: 'L3' }));
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李四', level: 'L2' }));
      const c = await svc.createEmployee(ctx, employeeInput({ empNo: 'E003', name: '王五', level: 'L3' }));

      assert.equal((await svc.listEmployees(ctx, {})).length, 3);
      assert.deepEqual((await svc.listEmployees(ctx, { level: 'L3' })).map((e) => e.empNo), ['E001', 'E003']);
      assert.deepEqual((await svc.listEmployees(ctx, { keyword: '李' })).map((e) => e.empNo), ['E002']);
      assert.deepEqual((await svc.listEmployees(ctx, { keyword: 'E003' })).map((e) => e.empNo), ['E003']);
      await assert.rejects(() => svc.listEmployees(ctx, { level: 'L9' }), /职级/);

      await svc.terminateEmployee(ctx, c, '2026-02-28');
      assert.equal((await svc.listEmployees(ctx, {})).length, 2, '离职员工默认不出现');
      assert.equal((await svc.listEmployees(ctx, { includeInactive: true })).length, 3);
    });

    test('离职：写入离职日期并停用账号', async () => {
      const id = await svc.createEmployee(ctx, employeeInput({ hireDate: '2024-01-01' }));
      await svc.terminateEmployee(ctx, id, '2026-02-28');

      const e = await svc.getEmployee(ctx, id);
      assert.equal(e.leaveDate, '2026-02-28');
      assert.equal(e.isActive, false);
    });

    test('离职日期不得早于入职日期', async () => {
      const id = await svc.createEmployee(ctx, employeeInput({ hireDate: '2024-06-01' }));
      await assert.rejects(() => svc.terminateEmployee(ctx, id, '2024-05-01'), /离职日期/);
    });

    test('员工不存在或不在可见范围内按不存在处理', async () => {
      await assert.rejects(() => svc.getEmployee(ctx, 99999), /员工/);
    });
  });

  describe('7.4 员工查询权限', () => {
    test('L1 可见全部员工', async () => {
      for (let i = 1; i <= 5; i++) {
        await svc.createEmployee(ctx, employeeInput({ empNo: `E00${i}`, name: `员工${i}` }));
      }
      assert.equal((await svc.listEmployees(l1ctx(), {})).length, 5);
    });

    test('L2 可见本人与全部下属（递归，不止直属）', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2' }));
      const sub = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李下属', managerId: boss }));
      const sub2 = await svc.createEmployee(ctx, employeeInput({ empNo: 'E003', name: '赵下属', managerId: sub }));

      const l2 = await ctxFor(db, boss);
      const rows = await svc.listEmployees(l2, {});
      assert.deepEqual(rows.map((e) => e.id), [boss, sub, sub2]);
    });

    test('L2 只有一名下属时恰好可见 2 人', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2' }));
      const sub = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李下属', managerId: boss }));
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E003', name: '孙无关' }));

      const l2 = await ctxFor(db, boss);
      const rows = await svc.listEmployees(l2, {});
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((e) => e.id), [boss, sub]);
    });

    test('L2 按分管区域可见（含下级区域），区域外一律不可见', async () => {
      const r1 = await db.insert('region', { code: 'R01', name: '黑龙江' });
      const r2 = await db.insert('region', { code: 'R02', name: '哈尔滨', parent_id: r1 });
      const r3 = await db.insert('region', { code: 'R03', name: '吉林' });

      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2', regionIds: [r1] }));
      const inScope = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '哈尔滨员工', regionIds: [r2] }));
      const outScope = await svc.createEmployee(ctx, employeeInput({ empNo: 'E003', name: '吉林员工', regionIds: [r3] }));
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E004', name: '无区域员工' }));

      const l2 = await ctxFor(db, boss);
      const rows = await svc.listEmployees(l2, {});
      assert.deepEqual(rows.map((e) => e.id), [boss, inScope]);
      await assert.rejects(() => svc.getEmployee(l2, outScope), /员工/);
    });

    test('L3 只可见本人', async () => {
      const me = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '我', level: 'L3' }));
      await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '别人' }));

      const l3 = await ctxFor(db, me);
      const rows = await svc.listEmployees(l3, {});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, me);

      const other = await db.one('select id from employee where emp_no = ?', ['E002']);
      await assert.rejects(() => svc.getEmployee(l3, other.id), /员工/);
    });

    test('L2 未配置任何范围时收紧为查不到数据', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2' }));

      const l2 = await ctxFor(db, boss);
      assert.equal((await svc.listEmployees(l2, {})).length, 0);
      await assert.rejects(() => svc.getEmployee(l2, boss), /员工/);
    });

    test('L1 可见身份证与家庭住址原文，其他人只见掩码', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2' }));
      const sub = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李下属', managerId: boss }));

      const byL1 = await svc.getEmployee(ctx, sub);
      assert.equal(byL1.idCard, '110101199001011234');
      assert.equal(byL1.homeAddress, '黑龙江省哈尔滨市南岗区某街 1 号');

      const l2 = await ctxFor(db, boss);
      const byL2 = await svc.getEmployee(l2, sub);
      assert.equal(byL2.idCard, '110101********1234', '保留前 6 后 4');
      assert.equal(byL2.homeAddress, '***');

      const l3 = await ctxFor(db, sub);
      const byL3 = await svc.getEmployee(l3, sub);
      assert.equal(byL3.idCard, '110101********1234');
      assert.equal(byL3.homeAddress, '***');

      const listed = await svc.listEmployees(l2, {});
      assert.equal(listed.find((e) => e.id === sub).idCard, '110101********1234');
    });

    test('掩码对空值安全', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '王经理', level: 'L2' }));
      const sub = await svc.createEmployee(ctx, employeeInput({
        empNo: 'E002', name: '李下属', managerId: boss, idCard: null, homeAddress: null,
      }));

      const l2 = await ctxFor(db, boss);
      const e = await svc.getEmployee(l2, sub);
      assert.equal(e.idCard, null);
      assert.equal(e.homeAddress, null);
      assert.equal((await svc.getEmployee(ctx, sub)).idCard, null);
    });
  });

  describe('7.2 员工工资', () => {
    let emp;
    beforeEach(async () => { emp = await svc.createEmployee(ctx, employeeInput()); });

    test('录入工资：元进分存，出参同时给分与元', async () => {
      const { id, created } = await svc.recordSalary(ctx, {
        employeeId: emp,
        period: '2026-03',
        payDate: '2026-03-10',
        baseSalary: '8000.00',
        performanceSalary: '2000.50',
        yearEndBonus: '10000',
      });
      assert.ok(id > 0);
      assert.equal(created, true);

      const rows = await svc.listSalaries(ctx, { employeeId: emp });
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.equal(r.period, '2026-03');
      assert.equal(r.payDate, '2026-03-10');
      assert.equal(r.baseCents, 800000);
      assert.equal(r.base, '8000.00');
      assert.equal(r.performanceCents, 200050);
      assert.equal(r.performance, '2000.50');
      assert.equal(r.yearEndBonusCents, 1000000);
      assert.equal(r.yearEndBonus, '10000.00');
      assert.equal(r.totalCents, 2000050);
      assert.equal(r.employeeId, emp);
      assert.equal(r.employeeName, '张三');
      assert.equal(r.empNo, 'E001');
    });

    test('绩效与年终奖缺省为 0', async () => {
      await svc.recordSalary(ctx, { employeeId: emp, period: '2026-03', baseSalary: '8000' });
      const r = (await svc.listSalaries(ctx, { employeeId: emp }))[0];
      assert.equal(r.performanceCents, 0);
      assert.equal(r.yearEndBonusCents, 0);
      assert.equal(r.payDate, '2026-03-01', '未填发放日期时取所属期首日');
    });

    test('同一员工同一期间再次录入视为更正（upsert），不产生第二条记录', async () => {
      const a = await svc.recordSalary(ctx, { employeeId: emp, period: '2026-03', baseSalary: '8000' });
      const b = await svc.recordSalary(ctx, { employeeId: emp, period: '2026-03', baseSalary: '8500' });

      assert.equal(a.created, true);
      assert.equal(b.created, false, '第二次是更正');
      assert.equal(b.id, a.id);

      const rows = await svc.listSalaries(ctx, { employeeId: emp });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].baseCents, 850000);
    });

    test('所属期格式与金额校验', async () => {
      await assert.rejects(
        () => svc.recordSalary(ctx, { employeeId: emp, period: '2026/03', baseSalary: '1' }), /所属期/,
      );
      await assert.rejects(
        () => svc.recordSalary(ctx, { employeeId: emp, period: '2026-13', baseSalary: '1' }), /所属期/,
      );
      await assert.rejects(
        () => svc.recordSalary(ctx, { employeeId: emp, period: '2026-03', baseSalary: 'abc' }), /基本工资/,
      );
      await assert.rejects(
        () => svc.recordSalary(ctx, { employeeId: 99999, period: '2026-03', baseSalary: '1' }), /员工/,
      );
    });

    test('按时间段与员工筛选工资', async () => {
      const other = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李四' }));
      await svc.recordSalary(ctx, { employeeId: emp, period: '2026-03', payDate: '2026-03-10', baseSalary: '1000' });
      await svc.recordSalary(ctx, { employeeId: emp, period: '2026-04', payDate: '2026-04-10', baseSalary: '2000' });
      await svc.recordSalary(ctx, { employeeId: other, period: '2026-03', payDate: '2026-03-20', baseSalary: '3000' });

      assert.equal((await svc.listSalaries(ctx, { from: '2026-03-01', to: '2026-03-31' })).length, 2);
      assert.equal((await svc.listSalaries(ctx, { from: '2026-03-01', to: '2026-03-31', employeeId: emp })).length, 1);
      assert.equal((await svc.listSalaries(ctx, { from: '2026-03-10', to: '2026-03-10' })).length, 1, '起止同日只含当天');
    });
  });

  describe('7.3 员工社保', () => {
    let emp;
    beforeEach(async () => { emp = await svc.createEmployee(ctx, employeeInput()); });

    test('录入社保与公积金：元进分存', async () => {
      const { id, created } = await svc.recordSocialInsurance(ctx, {
        employeeId: emp,
        period: '2026-03',
        payDate: '2026-03-15',
        base: '8000',
        companyFund: '1200',
        personalFund: '1100',
        companySi: '2000',
        personalSi: '800',
      });
      assert.ok(id > 0);
      assert.equal(created, true);

      const rows = await svc.listSocialInsurance(ctx, { employeeId: emp });
      assert.equal(rows.length, 1);
      const r = rows[0];
      assert.equal(r.period, '2026-03');
      assert.equal(r.payDate, '2026-03-15');
      assert.equal(r.baseCents, 800000);
      assert.equal(r.base, '8000.00');
      assert.equal(r.companyFundCents, 120000);
      assert.equal(r.companyFund, '1200.00');
      assert.equal(r.personalFundCents, 110000);
      assert.equal(r.companySiCents, 200000);
      assert.equal(r.personalSiCents, 80000);
      assert.equal(r.employerTotalCents, 320000, '公司承担 = 公积金 + 社保');
      assert.equal(r.personalTotalCents, 190000);
      assert.equal(r.employeeName, '张三');
    });

    test('兼容前端表单的字段名（baseAmount / companySocial / personalSocial）', async () => {
      await svc.recordSocialInsurance(ctx, {
        employeeId: emp,
        period: '2026-03',
        baseAmount: '8000',
        companyFund: '1200',
        personalFund: '1100',
        companySocial: '2000',
        personalSocial: '800',
      });

      const r = (await svc.listSocialInsurance(ctx, { employeeId: emp }))[0];
      assert.equal(r.baseCents, 800000);
      assert.equal(r.companyFundCents, 120000);
      assert.equal(r.personalFundCents, 110000);
      assert.equal(r.companySiCents, 200000);
      assert.equal(r.personalSiCents, 80000);
    });

    test('同一员工同一期间再次录入视为更正（upsert）', async () => {
      const a = await svc.recordSocialInsurance(ctx, { employeeId: emp, period: '2026-03', base: '8000', companySi: '2000' });
      const b = await svc.recordSocialInsurance(ctx, { employeeId: emp, period: '2026-03', base: '8000', companySi: '2400' });

      assert.equal(a.created, true);
      assert.equal(b.created, false);

      const rows = await svc.listSocialInsurance(ctx, { employeeId: emp });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].companySiCents, 240000);
    });

    test('所属期与员工校验，并按时间段筛选', async () => {
      await assert.rejects(
        () => svc.recordSocialInsurance(ctx, { employeeId: emp, period: '2026-3', base: '1' }), /所属期/,
      );
      await assert.rejects(
        () => svc.recordSocialInsurance(ctx, { employeeId: 99999, period: '2026-03', base: '1' }), /员工/,
      );

      const other = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李四' }));
      await svc.recordSocialInsurance(ctx, { employeeId: emp, period: '2026-03', payDate: '2026-03-15', base: '8000' });
      await svc.recordSocialInsurance(ctx, { employeeId: other, period: '2026-04', payDate: '2026-04-15', base: '6000' });

      assert.equal((await svc.listSocialInsurance(ctx, { from: '2026-03-01', to: '2026-03-31' })).length, 1);
      assert.equal((await svc.listSocialInsurance(ctx, { from: '2026-03-15', to: '2026-03-15' })).length, 1);
      assert.equal((await svc.listSocialInsurance(ctx, {})).length, 2);
    });
  });

  describe('7.5 工资与社保查询（按时间段）', () => {
    let e1;
    let e2;

    beforeEach(async () => {
      e1 = await svc.createEmployee(ctx, employeeInput({ empNo: 'E001', name: '张三' }));
      e2 = await svc.createEmployee(ctx, employeeInput({ empNo: 'E002', name: '李四' }));

      // 3 月：张三 8000 + 2000 绩效 + 10000 年终奖；公司承担 1200 公积金 + 2000 社保
      await svc.recordSalary(ctx, {
        employeeId: e1, period: '2026-03', payDate: '2026-03-10',
        baseSalary: '8000', performanceSalary: '2000', yearEndBonus: '10000',
      });
      await svc.recordSocialInsurance(ctx, {
        employeeId: e1, period: '2026-03', payDate: '2026-03-15',
        base: '8000', companyFund: '1200', personalFund: '1100', companySi: '2000', personalSi: '800',
      });

      // 4 月：李四 6000；公司承担 600 公积金 + 1000 社保
      await svc.recordSalary(ctx, { employeeId: e2, period: '2026-04', payDate: '2026-04-10', baseSalary: '6000' });
      await svc.recordSocialInsurance(ctx, {
        employeeId: e2, period: '2026-04', payDate: '2026-04-20',
        base: '6000', companyFund: '600', personalFund: '500', companySi: '1000', personalSi: '400',
      });
    });

    test('① 某个员工发放工资支出', async () => {
      const report = await svc.payrollReport(ctx, { from: '2026-03-01', to: '2026-03-31', employeeId: e1 });

      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].employeeName, '张三');
      assert.equal(report.rows[0].baseCents, 800000);
      assert.equal(report.rows[0].performanceCents, 200000);
      assert.equal(report.rows[0].yearEndBonusCents, 1000000);
      assert.equal(report.totals.salaryTotalCents, 2000000);
      assert.equal(report.totals.salaryTotal, '20000.00');
    });

    test('② 所有员工发放工资支出', async () => {
      const report = await svc.payrollReport(ctx, { from: '2026-03-01', to: '2026-04-30' });

      assert.deepEqual(report.rows.map((r) => r.employeeName), ['张三', '李四']);
      assert.equal(report.totals.employeeCount, 2);
      assert.equal(report.totals.salaryTotalCents, 2600000);
      // 合计在根上与 totals 上都能取到，行上带同名明细合计
      assert.equal(report.salaryTotalCents, 2600000);
      assert.equal(report.baseCents, 1400000);
      assert.equal(report.performanceCents, 200000);
      assert.equal(report.yearEndBonusCents, 1000000);
      assert.equal(report.totalCents, 2600000);
      assert.equal(report.rows[0].totalCents, 2000000);
    });

    test('③ 某个员工公司承担五险一金', async () => {
      const report = await svc.socialInsuranceReport(ctx, { from: '2026-03-01', to: '2026-03-31', employeeId: e1 });

      assert.equal(report.rows.length, 1);
      assert.equal(report.totals.companyFundCents, 120000);
      assert.equal(report.totals.companySiCents, 200000);
      assert.equal(report.totals.employerTotalCents, 320000);
      assert.equal(report.totals.employerTotal, '3200.00');
    });

    test('④ 所有员工公司承担五险一金', async () => {
      const report = await svc.socialInsuranceReport(ctx, { from: '2026-03-01', to: '2026-04-30' });

      assert.equal(report.rows.length, 2);
      assert.equal(report.totals.employerTotalCents, 480000);
      assert.equal(report.employerTotalCents, 480000, '合计在根上同样可取');
      assert.equal(report.companyFundCents, 180000);
      assert.equal(report.companySiCents, 300000);
    });

    test('公司承担部分不含个人承担部分', async () => {
      const report = await svc.socialInsuranceReport(ctx, { from: '2026-03-01', to: '2026-04-30' });

      // 个人承担：1100 + 800 + 500 + 400 = 2800 元，单独列出但绝不并入公司支出
      assert.equal(report.totals.personalFundCents, 160000);
      assert.equal(report.totals.personalSiCents, 120000);
      assert.equal(report.totals.personalTotalCents, 280000);
      assert.equal(report.totals.employerTotalCents, 480000);
      assert.notEqual(report.totals.employerTotalCents, 480000 + 280000);
      assert.equal(report.rows[0].employerTotalCents, 320000);
      assert.equal(report.rows[0].personalTotalCents, 190000);
    });

    test('⑤ 某员工工资及五险一金总支出', async () => {
      const report = await svc.payrollReport(ctx, {
        from: '2026-03-01', to: '2026-03-31', employeeId: e1, includeSocialInsurance: true,
      });

      assert.equal(report.totals.salaryTotalCents, 2000000);
      assert.equal(report.totals.employerSocialInsuranceTotalCents, 320000);
      assert.equal(report.totals.grandTotalCents, 2320000);
      assert.equal(report.rows[0].grandTotalCents, 2320000);
      // 根上镜像一份，便于 7.5 的第三种问法直接取数
      assert.equal(report.salaryTotalCents, 2000000);
      assert.equal(report.employerSocialInsuranceTotalCents, 320000);
      assert.equal(report.grandTotalCents, 2320000);
      // 个人承担的 1900 元不属于公司支出，既不扣减也不计入
      assert.equal(report.totals.personalSocialInsuranceTotalCents, 190000);
    });

    test('不勾选 includeSocialInsurance 时不含五险一金', async () => {
      const report = await svc.payrollReport(ctx, { from: '2026-03-01', to: '2026-03-31', employeeId: e1 });

      assert.equal(report.totals.employerSocialInsuranceTotalCents, 0);
      assert.equal(report.totals.grandTotalCents, report.totals.salaryTotalCents);
    });

    test('时间段左闭右开，起止同日只覆盖当天', async () => {
      const oneDaySi = await svc.socialInsuranceReport(ctx, { from: '2026-03-15', to: '2026-03-15' });
      assert.equal(oneDaySi.rows.length, 1);
      assert.equal(oneDaySi.totals.employerTotalCents, 320000);

      const oneDaySalary = await svc.payrollReport(ctx, { from: '2026-03-15', to: '2026-03-15' });
      assert.equal(oneDaySalary.rows.length, 0, '3 月 15 日没有发工资');
    });

    test('区间外与空区间一律为 0', async () => {
      const empty = await svc.payrollReport(ctx, { from: '2027-01-01', to: '2027-12-31' });
      assert.deepEqual(empty.rows, []);
      assert.equal(empty.totals.salaryTotalCents, 0);
      assert.equal(empty.totals.grandTotalCents, 0);

      const emptySi = await svc.socialInsuranceReport(ctx, { from: '2027-01-01', to: '2027-12-31' });
      assert.deepEqual(emptySi.rows, []);
      assert.equal(emptySi.totals.employerTotalCents, 0);
    });

    test('报表同样受权限范围限制', async () => {
      const boss = await svc.createEmployee(ctx, employeeInput({ empNo: 'E100', name: '王经理', level: 'L2' }));
      await svc.updateEmployee(ctx, e1, { managerId: boss });
      const l2 = await ctxFor(db, boss);

      const report = await svc.payrollReport(l2, { from: '2026-03-01', to: '2026-04-30' });
      assert.deepEqual(report.rows.map((r) => r.employeeName), ['张三'], 'L2 的「所有员工」只含其可见员工');
      assert.equal(report.totals.salaryTotalCents, 2000000);

      // 直接指名范围外的员工，只能得到 0，而不是别人的工资
      const direct = await svc.payrollReport(l2, { from: '2026-03-01', to: '2026-04-30', employeeId: e2 });
      assert.deepEqual(direct.rows, []);
      assert.equal(direct.totals.salaryTotalCents, 0);

      const si = await svc.socialInsuranceReport(l2, { from: '2026-03-01', to: '2026-04-30' });
      assert.equal(si.rows.length, 1);
      assert.equal(si.totals.employerTotalCents, 320000);

      const l3 = await ctxFor(db, e2);
      const own = await svc.payrollReport(l3, { from: '2026-03-01', to: '2026-04-30' });
      assert.deepEqual(own.rows.map((r) => r.employeeName), ['李四']);
      assert.equal(own.totals.salaryTotalCents, 600000);
    });
  });
});
