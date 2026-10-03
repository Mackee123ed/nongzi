/**
 * 全部业务表的结构定义。
 *
 * 用 {{PK}} / {{TEXT}} / {{MONEY}} 这类逻辑类型标记书写，由 dialect 展开为各数据库
 * 的原生类型，因此同一份定义可在 SQLite / MySQL / PostgreSQL / SQL Server 上建表。
 *
 * 约定：
 *   - 表名与列名一律小写 snake_case 且不加引号。这是四种数据库唯一的重合点：
 *     PostgreSQL 会把未加引号的标识符转小写，SQL Server 保留大小写，
 *     MySQL 在 Linux 上区分大小写。只有全小写不加引号才能保证四种库取出的
 *     列名完全一致。
 *   - 金额列一律 *_cents，整数「分」。不使用 DECIMAL，避开定点数与浮点差异。
 *   - 时间列一律用应用层写入的字符串，不用数据库的 CURRENT_TIMESTAMP 默认值，
 *     这样测试可完全确定，四种库的时间行为也一致。
 */

export const TABLES = {
  /** 区域树，支撑 L2 经理层的「管辖范围」。 */
  region: `
    id {{PK}},
    code {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    parent_id {{FK}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}}
  `,

  /** 员工。level 决定权限等级，是本系统权限模型的根。 */
  employee: `
    id {{PK}},
    emp_no {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    level {{TEXT}} NOT NULL CHECK (level IN ('L1', 'L2', 'L3')),
    job_title {{TEXT}},
    password_hash {{TEXT}},
    password_salt {{TEXT}},
    must_change_password {{BOOL}} DEFAULT 0,
    photo_path {{TEXT}},
    id_card {{TEXT}},
    home_address {{TEXT}},
    phone {{TEXT}},
    emergency_contact {{TEXT}},
    emergency_phone {{TEXT}},
    hire_date {{DATE}},
    leave_date {{DATE}},
    manager_id {{FK}},
    is_active {{BOOL}} DEFAULT 1,
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /**
   * 员工的管辖范围，支撑 L2「管辖管理查询」。
   * 需求书只说「管辖范围」而未定义其数据来源，这里补充为两个维度：
   *   scope_type='region'  → 分管区域
   *   scope_type='variety' → 分管品种线
   */
  employee_scope: `
    id {{PK}},
    employee_id {{FK}} NOT NULL,
    scope_type {{TEXT}} NOT NULL CHECK (scope_type IN ('region', 'variety')),
    scope_value_id {{FK}} NOT NULL,
    created_at {{DATETIME}}
  `,

  /**
   * 品种。在营（active）与待营（pending）共表，用 kind 区分。
   * 待营品种转在营只是改 kind，业务上更自然，销售与库存也能统一外键到本表。
   */
  variety: `
    id {{PK}},
    kind {{TEXT}} NOT NULL CHECK (kind IN ('active', 'pending')),
    code {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    nature {{TEXT}} CHECK (nature IN ('general_agent', 'own')),
    national_approval_no {{TEXT}},
    expected_approval_year {{INT}},
    suitable_temp_zone {{TEXT}},
    promo_region {{TEXT}},
    features {{LONGTEXT}},
    pack_spec {{TEXT}},
    pilot_pack_spec {{TEXT}},
    unit_price_cents {{MONEY}},
    tiered_rebate_note {{TEXT}},
    policy {{TEXT}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 经销商（客户）。 */
  dealer: `
    id {{PK}},
    code {{TEXT}} NOT NULL,
    company_name {{TEXT}} NOT NULL,
    region_id {{FK}},
    contact_name {{TEXT}},
    phone {{TEXT}},
    is_pilot {{BOOL}} DEFAULT 0,
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 经销商与品种的关系：代理品种 / 试点品种。 */
  dealer_variety: `
    id {{PK}},
    dealer_id {{FK}} NOT NULL,
    variety_id {{FK}} NOT NULL,
    relation {{TEXT}} NOT NULL CHECK (relation IN ('agent', 'pilot')),
    created_at {{DATETIME}}
  `,

  /** 经销商反馈（需求书 6.2）。反馈日期与反馈品种在此，而非挂在经销商主档上。 */
  dealer_feedback: `
    id {{PK}},
    dealer_id {{FK}} NOT NULL,
    variety_id {{FK}},
    feedback_date {{DATE}} NOT NULL,
    content {{LONGTEXT}} NOT NULL,
    created_at {{DATETIME}},
    created_by {{FK}}
  `,

  /**
   * 出入库流水（需求书 3.3）。
   *
   * 需求书把字段列成「入库时间/入库量/出库时间/出库量」，那是表单的形状而非数据的形状。
   * 这里建模为带方向的流水：direction + quantity + occurred_at，一行一次出入库。
   * 好处是「实时库存 = 入库合计 − 出库合计」这类统计都退化成一次 GROUP BY，
   * 而且天然支持按时间段查询。
   */
  inventory_txn: `
    id {{PK}},
    variety_id {{FK}} NOT NULL,
    dealer_id {{FK}},
    direction {{TEXT}} NOT NULL CHECK (direction IN ('in', 'out')),
    occurred_at {{DATETIME}} NOT NULL,
    quantity {{INT}} NOT NULL,
    unit {{TEXT}} DEFAULT '袋',
    unit_price_cents {{MONEY}},
    amount_cents {{MONEY}},
    source_type {{TEXT}},
    source_id {{FK}},
    operator_id {{FK}},
    remark {{TEXT}},
    created_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 销售单表头。 */
  sales_order: `
    id {{PK}},
    order_no {{TEXT}} NOT NULL,
    dealer_id {{FK}} NOT NULL,
    order_date {{DATE}} NOT NULL,
    total_amount_cents {{MONEY}} NOT NULL DEFAULT 0,
    total_rebate_cents {{MONEY}} NOT NULL DEFAULT 0,
    status {{TEXT}} NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'confirmed', 'voided')),
    operator_id {{FK}},
    remark {{TEXT}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 销售单明细。需求书 5.1 的「品种名称」即此处的 variety_id。 */
  sales_order_item: `
    id {{PK}},
    order_id {{FK}} NOT NULL,
    variety_id {{FK}} NOT NULL,
    quantity {{INT}} NOT NULL,
    unit_price_cents {{MONEY}} NOT NULL,
    amount_cents {{MONEY}} NOT NULL,
    rebate_cents {{MONEY}} NOT NULL DEFAULT 0,
    created_at {{DATETIME}}
  `,

  /** 收支分类（需求书 4.4 / 4.5）。 */
  finance_category: `
    id {{PK}},
    code {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    kind {{TEXT}} NOT NULL CHECK (kind IN ('income', 'expense')),
    has_detail {{BOOL}} NOT NULL DEFAULT 0,
    sort_order {{INT}} DEFAULT 0,
    created_at {{DATETIME}}
  `,

  /** 费用明细子项，如采购价格 / 运输费用 / 制种费用 / 加工费用（需求书 4.5）。 */
  finance_component: `
    id {{PK}},
    code {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    category_code {{TEXT}},
    sort_order {{INT}} DEFAULT 0,
    created_at {{DATETIME}}
  `,

  /** 账户。「当前账户余额」以此为基础。 */
  account: `
    id {{PK}},
    code {{TEXT}} NOT NULL,
    name {{TEXT}} NOT NULL,
    type {{TEXT}} CHECK (type IN ('bank', 'cash')),
    opening_balance_cents {{MONEY}} NOT NULL DEFAULT 0,
    is_active {{BOOL}} NOT NULL DEFAULT 1,
    created_at {{DATETIME}},
    updated_at {{DATETIME}}
  `,

  /**
   * 收支流水（需求书 4.1 / 4.2）。
   * source_type + source_id 关联来源业务单据，落实需求书 9「财务管理 ↔ 各业务模块」。
   */
  finance_flow: `
    id {{PK}},
    flow_no {{TEXT}},
    kind {{TEXT}} NOT NULL CHECK (kind IN ('income', 'expense')),
    category_id {{FK}} NOT NULL,
    occurred_at {{DATETIME}} NOT NULL,
    name {{TEXT}} NOT NULL,
    amount_cents {{MONEY}} NOT NULL,
    account_id {{FK}},
    dealer_id {{FK}},
    source_type {{TEXT}} CHECK (source_type IN ('manual', 'sale', 'inventory', 'salary', 'social_insurance', 'purchase', 'other')),
    source_id {{FK}},
    operator_id {{FK}},
    remark {{TEXT}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 流水对应的费用明细金额，各项之和须等于流水金额。 */
  finance_flow_component: `
    id {{PK}},
    flow_id {{FK}} NOT NULL,
    component_code {{TEXT}} NOT NULL,
    amount_cents {{MONEY}} NOT NULL DEFAULT 0,
    created_at {{DATETIME}}
  `,

  /** 工资（需求书 7.2）。 */
  salary_record: `
    id {{PK}},
    employee_id {{FK}} NOT NULL,
    period {{TEXT}} NOT NULL,
    pay_date {{DATE}},
    base_cents {{MONEY}} NOT NULL DEFAULT 0,
    performance_cents {{MONEY}} NOT NULL DEFAULT 0,
    year_end_bonus_cents {{MONEY}} NOT NULL DEFAULT 0,
    remark {{TEXT}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 社保与公积金（需求书 7.3）。 */
  social_insurance_record: `
    id {{PK}},
    employee_id {{FK}} NOT NULL,
    period {{TEXT}} NOT NULL,
    pay_date {{DATE}},
    base_cents {{MONEY}} NOT NULL DEFAULT 0,
    company_fund_cents {{MONEY}} NOT NULL DEFAULT 0,
    personal_fund_cents {{MONEY}} NOT NULL DEFAULT 0,
    company_si_cents {{MONEY}} NOT NULL DEFAULT 0,
    personal_si_cents {{MONEY}} NOT NULL DEFAULT 0,
    remark {{TEXT}},
    created_at {{DATETIME}},
    updated_at {{DATETIME}},
    created_by {{FK}}
  `,

  /** 应用设置，如是否在销售确认时自动生成收入流水。 */
  app_setting: `
    id {{PK}},
    setting_key {{TEXT}} NOT NULL,
    setting_value {{TEXT}},
    updated_at {{DATETIME}}
  `,

  /** 操作审计。财务系统没有留痕是不可接受的。 */
  audit_log: `
    id {{PK}},
    employee_id {{FK}},
    action {{TEXT}} NOT NULL,
    entity {{TEXT}},
    entity_id {{FK}},
    detail {{LONGTEXT}},
    occurred_at {{DATETIME}} NOT NULL
  `,
};

/**
 * 唯一索引。用独立语句创建而非写在建表语句里：
 * MySQL 的库内 KEY 语法与另外三种数据库不通用。
 */
export const UNIQUE_INDEXES = [
  ['ux_variety_code', 'variety', ['code']],
  ['ux_dealer_code', 'dealer', ['code']],
  ['ux_employee_emp_no', 'employee', ['emp_no']],
  ['ux_region_code', 'region', ['code']],
  ['ux_finance_category_code', 'finance_category', ['code']],
  ['ux_finance_component_code', 'finance_component', ['code']],
  ['ux_account_code', 'account', ['code']],
  ['ux_app_setting_key', 'app_setting', ['setting_key']],
  ['ux_salary_employee_period', 'salary_record', ['employee_id', 'period']],
  ['ux_social_employee_period', 'social_insurance_record', ['employee_id', 'period']],
  ['ux_sales_order_no', 'sales_order', ['order_no']],
];

/** 普通索引，主要服务于按时间段与维度的报表查询。 */
export const INDEXES = [
  ['ix_variety_kind', 'variety', ['kind']],
  ['ix_dealer_region', 'dealer', ['region_id']],
  ['ix_inventory_txn_variety_time', 'inventory_txn', ['variety_id', 'occurred_at']],
  ['ix_inventory_txn_dealer', 'inventory_txn', ['dealer_id']],
  ['ix_inventory_txn_time', 'inventory_txn', ['occurred_at']],
  ['ix_sales_order_date', 'sales_order', ['order_date']],
  ['ix_sales_order_dealer', 'sales_order', ['dealer_id']],
  ['ix_sales_item_order', 'sales_order_item', ['order_id']],
  ['ix_sales_item_variety', 'sales_order_item', ['variety_id']],
  ['ix_finance_flow_time', 'finance_flow', ['occurred_at']],
  ['ix_finance_flow_kind', 'finance_flow', ['kind']],
  ['ix_finance_flow_dealer', 'finance_flow', ['dealer_id']],
  ['ix_feedback_date', 'dealer_feedback', ['feedback_date']],
  ['ix_feedback_dealer', 'dealer_feedback', ['dealer_id']],
  ['ix_feedback_variety', 'dealer_feedback', ['variety_id']],
  ['ix_employee_scope_emp', 'employee_scope', ['employee_id']],
  ['ix_salary_period', 'salary_record', ['period']],
  ['ix_social_period', 'social_insurance_record', ['period']],
];
