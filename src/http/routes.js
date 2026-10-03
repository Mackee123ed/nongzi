/**
 * API 路由表。
 *
 * 三条约定：
 *   1. 处理函数收到的 context 已经是 { user, scope, params, query, body }，
 *      其中 scope 由会话里的职级算出。业务方法一律以它为第一个参数，
 *      权限过滤在服务层完成，路由层不做任何放行判断。
 *   2. 查询参数里空串一律转成 null。前端表单没填的项就是空串，
 *      若原样传给服务层，会被当成一个「值为空字符串」的有效条件。
 *   3. 报表类接口把服务层的返回值规整成统一的 { rows, totals, ...统计量 }，
 *      前端因此只需要一个通用报表页面。
 */

import { saveConfig, loadConfig, redactConfig, validateConfig } from '../config.js';

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const text = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;

export function registerApiRoutes(router, services) {
  const {
    db, auth, inventory, customers, employees, finance, sales,
    contextFor, describeScope, config, configPath,
  } = services;

  /* -------------------- 认证 -------------------- */

  router.post('/api/auth/login', async (c) => {
    const result = await auth.login(c.body.empNo, c.body.password);
    const scope = await contextFor(result.user);
    return {
      token: result.token,
      user: result.user,
      mustChangePassword: result.user.mustChangePassword,
      scopeKind: scope.scope.kind,
      scopeLabel: describeScope(scope.scope),
    };
  });

  router.post('/api/auth/logout', async (c) => {
    await auth.logout(c.token);
    return { ok: true };
  });

  router.get('/api/auth/me', async (c) => {
    const scope = await contextFor(c.user);
    return {
      user: c.user,
      scopeKind: scope.scope.kind,
      scopeLabel: describeScope(scope.scope),
    };
  });

  router.post('/api/auth/password', async (c) => {
    await auth.changePassword(c.token, c.body.oldPassword, c.body.newPassword);
    return { ok: true };
  });

  /* -------------------- 库存：品种 -------------------- */

  router.get('/api/varieties', (c) => inventory.listVarieties(c, {
    kind: text(c.query.kind),
    keyword: text(c.query.keyword),
  }));

  router.post('/api/varieties', (c) => inventory.createVariety(c, c.body));

  router.get('/api/varieties/:id', (c) => inventory.getVariety(c, int(c.params.id)));

  router.put('/api/varieties/:id', (c) => inventory.updateVariety(c, int(c.params.id), c.body));

  router.post('/api/varieties/:id/promote', (c) => inventory.promoteVariety(c, int(c.params.id), c.body));

  /* -------------------- 库存：出入库与查询 -------------------- */

  router.get('/api/inventory/movements', (c) => inventory.listMovements(c, {
    from: text(c.query.from),
    to: text(c.query.to),
    varietyId: int(c.query.varietyId),
    dealerId: int(c.query.dealerId),
  }));

  router.post('/api/inventory/movements', (c) => inventory.recordMovement(c, c.body));

  router.get('/api/inventory/stock', (c) => inventory.getStock(c, {
    varietyId: int(c.query.varietyId),
  }));

  /* -------------------- 销售 -------------------- */

  router.get('/api/sales/orders', (c) => sales.listOrders(c, {
    from: text(c.query.from),
    to: text(c.query.to),
    dealerId: int(c.query.dealerId),
    status: text(c.query.status),
  }));

  router.post('/api/sales/orders', (c) => sales.createOrder(c, c.body));

  router.get('/api/sales/orders/:id', (c) => sales.getOrder(c, int(c.params.id)));

  router.post('/api/sales/orders/:id/void', (c) => sales.voidOrder(c, int(c.params.id), c.body.reason ?? null));

  /* -------------------- 客户 -------------------- */

  router.get('/api/dealers', (c) => customers.listDealers(c, {
    regionId: int(c.query.regionId),
    keyword: text(c.query.keyword),
  }));

  router.post('/api/dealers', (c) => customers.createDealer(c, c.body));

  router.get('/api/dealers/:id', (c) => customers.getDealer(c, int(c.params.id)));

  router.put('/api/dealers/:id', (c) => customers.updateDealer(c, int(c.params.id), c.body));

  router.get('/api/feedback', (c) => customers.listFeedback(c, {
    from: text(c.query.from),
    to: text(c.query.to),
    varietyId: int(c.query.varietyId),
    dealerId: int(c.query.dealerId),
  }));

  router.post('/api/feedback', (c) => customers.recordFeedback(c, c.body));

  /* -------------------- 员工 / 工资 / 社保 -------------------- */

  router.get('/api/employees', (c) => employees.listEmployees(c, {
    keyword: text(c.query.keyword),
    level: text(c.query.level),
    includeInactive: bool(c.query.includeInactive),
  }));

  router.post('/api/employees', (c) => employees.createEmployee(c, c.body));

  router.get('/api/employees/:id', (c) => employees.getEmployee(c, int(c.params.id)));

  router.put('/api/employees/:id', (c) => employees.updateEmployee(c, int(c.params.id), c.body));

  router.post('/api/employees/:id/terminate', (c) => employees.terminateEmployee(
    c, int(c.params.id), text(c.body.leaveDate),
  ));

  router.get('/api/salaries', (c) => employees.listSalaries(c, {
    from: text(c.query.from), to: text(c.query.to), employeeId: int(c.query.employeeId),
  }));

  router.post('/api/salaries', (c) => employees.recordSalary(c, c.body));

  router.get('/api/social-insurance', (c) => employees.listSocialInsurance(c, {
    from: text(c.query.from), to: text(c.query.to), employeeId: int(c.query.employeeId),
  }));

  router.post('/api/social-insurance', (c) => employees.recordSocialInsurance(c, c.body));

  /* -------------------- 财务 -------------------- */

  router.get('/api/finance/categories', async () => {
    const rows = await db.query('select * from finance_category order by sort_order, id');
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      hasDetail: Boolean(r.has_detail),
    }));
  });

  router.get('/api/finance/flows', (c) => finance.listFlows(c, {
    from: text(c.query.from),
    to: text(c.query.to),
    kind: text(c.query.kind),
    categoryCode: text(c.query.categoryCode),
    dealerId: int(c.query.dealerId),
  }));

  router.post('/api/finance/flows', (c) => (c.body.kind === 'income'
    ? finance.recordIncome(c, c.body)
    : finance.recordExpense(c, c.body)));

  /* -------------------- 区域 -------------------- */

  router.get('/api/regions', async (c) => {
    const rows = await db.query('select * from region order by code');
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      parentId: r.parent_id,
      parentName: r.parent_id ? (byId.get(r.parent_id)?.name ?? null) : null,
    }));
  });

  router.post('/api/regions', async (c) => {
    const { requireText, optionalId } = await import('../core/validate.js');
    const code = requireText(c.body.code, '区域编码');
    const name = requireText(c.body.name, '区域名称');
    const existing = await db.one('select id from region where code = ?', [code]);
    if (existing) {
      const { ValidationError } = await import('../core/errors.js');
      throw new ValidationError(`区域编码 ${code} 已存在`);
    }
    return db.insert('region', {
      code,
      name,
      parent_id: optionalId(c.body.parentId, '上级区域'),
    });
  });

  /* -------------------- 报表 -------------------- */
  // 需求书 3.4 / 4.3 / 4.4 / 4.5 / 5.2 / 6.3 / 7.5 的每一条查询都在此暴露。
  // 统一返回 { rows, totals, ...统计量 }，前端一个通用报表页即可全部渲染。

  router.get('/api/reports/inventory.movements', (c) => inventory.movementsReport(c, {
    from: text(c.query.from), to: text(c.query.to),
    varietyId: int(c.query.varietyId), dealerId: int(c.query.dealerId),
  }));

  router.get('/api/reports/inventory.stock', async (c) => {
    const rows = await inventory.stockOverview(c);
    return {
      rows,
      totals: {
        totalIn: rows.reduce((s, r) => s + r.totalIn, 0),
        totalOut: rows.reduce((s, r) => s + r.totalOut, 0),
        quantity: rows.reduce((s, r) => s + r.quantity, 0),
      },
    };
  });

  router.get('/api/reports/sales', (c) => sales.salesReport(c, {
    from: text(c.query.from), to: text(c.query.to),
    varietyId: int(c.query.varietyId), dealerId: int(c.query.dealerId),
    mode: text(c.query.mode) ?? 'detail',
    dimension: text(c.query.dimension),
  }));

  router.get('/api/reports/finance.summary', (c) => finance.summary(c, {
    from: text(c.query.from), to: text(c.query.to),
  }));

  router.get('/api/reports/finance.category', (c) => finance.categoryReport(c, {
    from: text(c.query.from), to: text(c.query.to), kind: text(c.query.kind),
  }));

  router.get('/api/reports/finance.dealer-ledger', (c) => finance.dealerLedger(c, {
    from: text(c.query.from), to: text(c.query.to), dealerId: int(c.query.dealerId),
  }));

  router.get('/api/reports/finance.balance', async (c) => {
    const result = await finance.accountBalance(c, { accountId: int(c.query.accountId) });
    return {
      rows: result.accounts ?? [],
      totalBalanceCents: result.totalBalanceCents ?? 0,
    };
  });

  router.get('/api/reports/customer.feedback', (c) => customers.feedbackReport(c, {
    from: text(c.query.from), to: text(c.query.to),
    varietyId: int(c.query.varietyId), dealerId: int(c.query.dealerId),
    dimension: text(c.query.dimension),
  }));

  router.get('/api/reports/payroll.salary', async (c) => {
    const employeeId = int(c.query.employeeId);
    const mode = text(c.query.mode);

    if (mode === 'total') {
      const r = await employees.payrollReport(c, {
        from: text(c.query.from), to: text(c.query.to),
        employeeId, includeSocialInsurance: true,
      });
      return {
        rows: r.rows ?? [],
        totals: {
          salaryTotalCents: r.totalSalaryCents ?? 0,
          employerSocialInsuranceTotalCents: r.totalEmployerSocialInsuranceCents ?? 0,
          grandTotalCents: r.grandTotalCents ?? 0,
        },
        salaryTotalCents: r.totalSalaryCents ?? 0,
        employerSocialInsuranceTotalCents: r.totalEmployerSocialInsuranceCents ?? 0,
        grandTotalCents: r.grandTotalCents ?? 0,
      };
    }

    const r = await employees.payrollReport(c, {
      from: text(c.query.from), to: text(c.query.to), employeeId,
    });
    const rows = r.rows ?? [];
    const totals = {
      baseCents: rows.reduce((s, x) => s + (x.baseCents ?? 0), 0),
      performanceCents: rows.reduce((s, x) => s + (x.performanceCents ?? 0), 0),
      yearEndBonusCents: rows.reduce((s, x) => s + (x.yearEndBonusCents ?? 0), 0),
      totalCents: rows.reduce((s, x) => s + (x.salaryTotalCents ?? 0), 0),
    };
    return {
      rows: rows.map((x) => ({ ...x, totalCents: x.salaryTotalCents })),
      totals,
      ...totals,
    };
  });

  router.get('/api/reports/payroll.social', async (c) => {
    const r = await employees.socialInsuranceReport(c, {
      from: text(c.query.from), to: text(c.query.to), employeeId: int(c.query.employeeId),
    });
    const rows = r.rows ?? [];
    const totals = {
      companySiCents: rows.reduce((s, x) => s + (x.companySiCents ?? 0), 0),
      companyFundCents: rows.reduce((s, x) => s + (x.companyFundCents ?? 0), 0),
      personalSiCents: rows.reduce((s, x) => s + (x.personalSiCents ?? 0), 0),
      personalFundCents: rows.reduce((s, x) => s + (x.personalFundCents ?? 0), 0),
    };
    return {
      rows,
      totals,
      ...totals,
      employerTotalCents: totals.companySiCents + totals.companyFundCents,
    };
  });

  /* -------------------- 系统配置（需求书 8.4） -------------------- */

  router.get('/api/system/db-config', () => redactConfig(config));

  router.put('/api/system/db-config', async (c) => {
    if (!configPath) {
      const { ConfigError } = await import('../core/errors.js');
      throw new ConfigError('当前以只读方式启动，无法保存配置');
    }
    const current = loadConfig(configPath, { dataDir: config.dataDir });
    const next = {
      ...current,
      database: {
        ...current.database,
        dialect: text(c.body.dialect) ?? current.database.dialect,
        host: text(c.body.host) ?? current.database.host,
        port: int(c.body.port),
        database: text(c.body.database) ?? current.database.database,
        user: text(c.body.user),
        // 密码留空表示不修改，避免前端每次都回显并覆盖
        password: c.body.password ? String(c.body.password) : current.database.password,
      },
    };
    validateConfig(next);
    saveConfig(configPath, next);
    return { saved: true, restartRequired: true };
  });
}
