/**
 * 服务装配：把所有业务模块组装成一个可供 HTTP 层调用的对象。
 *
 * 这里是唯一决定「模块之间如何互相引用」的地方。例如销售需要调用财务来生成
 * 收入流水，靠的就是在这里把 finance 注入 sales，而不是让两个模块互相 import——
 * 后者会形成循环依赖，也让单元测试无法单独构造某个模块。
 */

import { createAuthService } from './auth.js';
import { createInventoryService } from './inventory.js';
import { createCustomersService } from './customers.js';
import { createEmployeesService } from './employees.js';
import { createFinanceService } from './finance.js';
import { createSalesService } from './sales.js';
import { buildScope, describeScope } from '../domain/scope.js';
import { registerApiRoutes } from '../http/routes.js';

export function createServices({ db, config = null, configPath = null }) {
  const auth = createAuthService(db);
  const inventory = createInventoryService(db);
  const customers = createCustomersService(db);
  const employees = createEmployeesService(db);
  const finance = createFinanceService(db);
  // 销售单确认后要自动生成「销售收入」流水，因此把财务服务注入销售服务
  const sales = createSalesService(db, { financeService: finance });

  /**
   * 计算当前用户的数据可见范围（需求书 2.2）。
   *
   * 组织结构数据量很小（区域表、员工表），每次请求重算一遍即可，
   * 换来的是「任何人改了管辖范围立刻生效」，不必处理缓存失效。
   */
  async function buildScopeFor(user) {
    if (user.level === 'L1') return buildScope(user, {});

    const [regions, employees, scopes] = await Promise.all([
      db.query('select id, parent_id from region'),
      db.query('select id, manager_id from employee'),
      db.query('select employee_id, scope_type, scope_value_id from employee_scope'),
    ]);

    return buildScope(user, { regions, employees, scopes });
  }

  /** 组装请求上下文：用户 + 数据范围。 */
  async function contextFor(user) {
    return { user, scope: await buildScopeFor(user) };
  }

  const registry = {
    db,
    config,
    configPath,
    auth,
    inventory,
    customers,
    employees,
    finance,
    sales,

    buildScopeFor,
    contextFor,
    describeScope,

    /** 由 HTTP 层调用，把全部接口挂到路由器上。 */
    registerRoutes(router) {
      registerApiRoutes(router, registry);
    },

    async ensureDefaultAdmin() {
      return auth.ensureDefaultAdmin();
    },
  };

  return registry;
}
