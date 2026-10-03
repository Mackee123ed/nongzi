/**
 * 主数据「资源描述表」。
 *
 * 每个受管实体在这里描述一次：接口路径、字段、列显示、必填项。
 * 前端因此只需要一个通用的列表+表单页面，而不是每个实体各写一套页面。
 * 需求书里的十几个录入界面（在营品种、待营品种、经销商、员工、工资、社保…）
 * 全部由这张表驱动。
 */

import { money, qty, date, tag } from './fmt.js';

const NATURE_OPTIONS = [
  { value: 'general_agent', label: '总代' },
  { value: 'own', label: '自有' },
];

/** 品种：在营与待营共用一处定义，用 kind 参数区分（后端也是单表）。 */
function varietyResource(kind, title) {
  const isActive = kind === 'active';
  const fields = [
    { key: 'code', label: '品种编码', required: true },
    { key: 'name', label: '品种名称', required: true },
    ...(isActive
      ? [{ key: 'nature', label: '品种性质', type: 'select', options: NATURE_OPTIONS, required: true },
        { key: 'unitPrice', label: '单价（元）', type: 'money' }]
      : [{ key: 'expectedApprovalYear', label: '预国审年份', type: 'number' },
        { key: 'pilotPackSpec', label: '试点包装规格' }]),
    { key: 'nationalApprovalNo', label: '国审编号' },
    { key: 'suitableTempZone', label: '适合积温带' },
    { key: 'promoRegion', label: '推广区域' },
    { key: 'packSpec', label: '包装规格' },
    ...(isActive
      ? [{ key: 'tieredRebateNote', label: '阶梯返' }, { key: 'policy', label: '政策' }]
      : []),
    { key: 'features', label: '品种特点', type: 'textarea', wide: true },
  ];

  return {
    key: `variety-${kind}`,
    title,
    path: '/varieties',
    listParams: { kind },
    fields,
    columns: [
      { key: 'code', title: '品种编码' },
      { key: 'name', title: '品种名称' },
      ...(isActive
        ? [{ key: 'natureLabel', title: '性质' },
          { key: 'unitPriceCents', title: '单价（元）', align: 'right', format: money }]
        : [{ key: 'expectedApprovalYear', title: '预国审年份' }]),
      { key: 'suitableTempZone', title: '适合积温带' },
      { key: 'promoRegion', title: '推广区域' },
      { key: 'packSpec', title: '包装规格' },
    ],
    // 待营品种可一键转为在营
    rowActions: isActive ? null : [{
      label: '转在营',
      run: async (row, ctx) => {
        const { api } = await import('./api.js');
        await api.post(`/varieties/${row.id}/promote`, {
          nature: ctx.nature ?? 'own',
          unitPrice: ctx.unitPrice ?? '',
        });
      },
    }],
  };
}

export const RESOURCES = {
  'variety-active': varietyResource('active', '在营品种'),
  'variety-pending': varietyResource('pending', '待营品种'),

  dealer: {
    key: 'dealer',
    title: '经销商',
    path: '/dealers',
    fields: [
      { key: 'code', label: '编号', required: true },
      { key: 'companyName', label: '公司名称', required: true },
      { key: 'contactName', label: '负责人姓名' },
      { key: 'phone', label: '联系电话' },
      { key: 'regionId', label: '所在区域', type: 'lookup', lookup: 'regions' },
      { key: 'agentVarietyIds', label: '代理品种', type: 'multilookup', lookup: 'varieties' },
      { key: 'pilotVarietyIds', label: '试点品种', type: 'multilookup', lookup: 'varieties' },
    ],
    columns: [
      { key: 'code', title: '编号' },
      { key: 'companyName', title: '公司名称' },
      { key: 'regionName', title: '所在区域' },
      { key: 'contactName', title: '负责人' },
      { key: 'phone', title: '联系电话' },
      { key: 'agentVarietyNames', title: '代理品种' },
    ],
  },

  employee: {
    key: 'employee',
    title: '员工信息',
    path: '/employees',
    fields: [
      { key: 'empNo', label: '员工工号', required: true },
      { key: 'name', label: '姓名', required: true },
      {
        key: 'level',
        label: '职级',
        type: 'select',
        required: true,
        options: [
          { value: 'L1', label: 'L1 高管层（全部查询）' },
          { value: 'L2', label: 'L2 经理层（管辖查询）' },
          { value: 'L3', label: 'L3 员工层（操作）' },
        ],
      },
      { key: 'password', label: '初始密码', hint: '新建时必填，编辑时留空表示不改' },
      { key: 'idCard', label: '身份证' },
      { key: 'phone', label: '联系电话' },
      { key: 'emergencyContact', label: '紧急联系人' },
      { key: 'emergencyPhone', label: '紧急联系电话' },
      { key: 'hireDate', label: '入职日期', type: 'date' },
      { key: 'leaveDate', label: '离职日期', type: 'date' },
      { key: 'homeAddress', label: '家庭住址', wide: true },
      { key: 'photoPath', label: '照片路径' },
    ],
    columns: [
      { key: 'empNo', title: '工号' },
      { key: 'name', title: '姓名' },
      { key: 'levelLabel', title: '职级' },
      { key: 'phone', title: '联系电话' },
      { key: 'idCard', title: '身份证' },
      { key: 'hireDate', title: '入职日期', format: date },
      { key: 'leaveDate', title: '离职日期', format: date },
    ],
  },

  salary: {
    key: 'salary',
    title: '员工工资',
    path: '/salaries',
    fields: [
      { key: 'employeeId', label: '员工', type: 'lookup', lookup: 'employees', required: true },
      { key: 'period', label: '所属期（YYYY-MM）', type: 'month', required: true },
      { key: 'payDate', label: '发放日期', type: 'date' },
      { key: 'baseSalary', label: '基本工资（元）', type: 'money' },
      { key: 'performanceSalary', label: '绩效工资（元）', type: 'money' },
      { key: 'yearEndBonus', label: '年终奖（元）', type: 'money' },
    ],
    columns: [
      { key: 'employeeName', title: '员工' },
      { key: 'period', title: '所属期' },
      { key: 'payDate', title: '发放日期', format: date },
      { key: 'baseCents', title: '基本工资', align: 'right', format: money },
      { key: 'performanceCents', title: '绩效工资', align: 'right', format: money },
      { key: 'yearEndBonusCents', title: '年终奖', align: 'right', format: money },
      { key: 'totalCents', title: '合计', align: 'right', format: money },
    ],
  },

  'social-insurance': {
    key: 'social-insurance',
    title: '员工社保',
    path: '/social-insurance',
    fields: [
      { key: 'employeeId', label: '员工', type: 'lookup', lookup: 'employees', required: true },
      { key: 'period', label: '所属期（YYYY-MM）', type: 'month', required: true },
      { key: 'payDate', label: '社保缴纳日期', type: 'date' },
      { key: 'baseAmount', label: '社保缴纳基数（元）', type: 'money' },
      { key: 'companyFund', label: '公司承担公积金（元）', type: 'money' },
      { key: 'personalFund', label: '个人承担公积金（元）', type: 'money' },
      { key: 'companySocial', label: '公司承担社保（元）', type: 'money' },
      { key: 'personalSocial', label: '个人承担社保（元）', type: 'money' },
    ],
    columns: [
      { key: 'employeeName', title: '员工' },
      { key: 'period', title: '所属期' },
      { key: 'payDate', title: '缴纳日期', format: date },
      { key: 'baseCents', title: '缴纳基数', align: 'right', format: money },
      { key: 'companyFundCents', title: '公司公积金', align: 'right', format: money },
      { key: 'companySiCents', title: '公司社保', align: 'right', format: money },
      { key: 'personalFundCents', title: '个人公积金', align: 'right', format: money },
      { key: 'personalSiCents', title: '个人社保', align: 'right', format: money },
    ],
  },

  feedback: {
    key: 'feedback',
    title: '经销商反馈',
    path: '/feedback',
    fields: [
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers', required: true },
      { key: 'varietyId', label: '反馈品种', type: 'lookup', lookup: 'varieties' },
      { key: 'feedbackDate', label: '反馈日期', type: 'date', required: true },
      { key: 'content', label: '反馈内容', type: 'textarea', required: true, wide: true },
    ],
    columns: [
      { key: 'feedbackDate', title: '反馈日期', format: date },
      { key: 'dealerName', title: '经销商' },
      { key: 'varietyName', title: '品种' },
      { key: 'content', title: '反馈内容' },
    ],
  },

  region: {
    key: 'region',
    title: '区域',
    path: '/regions',
    fields: [
      { key: 'code', label: '区域编码', required: true },
      { key: 'name', label: '区域名称', required: true },
      { key: 'parentId', label: '上级区域', type: 'lookup', lookup: 'regions' },
    ],
    columns: [
      { key: 'code', title: '区域编码' },
      { key: 'name', title: '区域名称' },
      { key: 'parentName', title: '上级区域' },
    ],
  },

  'finance-flow': {
    key: 'finance-flow',
    title: '收支流水',
    path: '/finance/flows',
    fields: [
      {
        key: 'kind',
        label: '收支类型',
        type: 'select',
        required: true,
        options: [{ value: 'income', label: '收入' }, { value: 'expense', label: '支出' }],
      },
      { key: 'categoryCode', label: '分类', type: 'lookup', lookup: 'finance-categories', required: true },
      { key: 'occurredAt', label: '时间', type: 'date', required: true },
      { key: 'name', label: '名称', required: true },
      { key: 'amount', label: '金额（元）', type: 'money', required: true },
      { key: 'dealerId', label: '关联经销商', type: 'lookup', lookup: 'dealers' },
      { key: 'remark', label: '备注', wide: true },
    ],
    columns: [
      { key: 'occurredAt', title: '时间', format: date },
      { key: 'kindLabel', title: '类型', format: (v) => tag(v, v === '收入' ? 'tag-ok' : 'tag-warn') },
      { key: 'categoryName', title: '分类' },
      { key: 'name', title: '名称' },
      { key: 'dealerName', title: '经销商' },
      { key: 'amountCents', title: '金额', align: 'right', format: money },
    ],
  },
};

/** 下拉数据源。 */
export const LOOKUPS = {
  varieties: { path: '/varieties', label: (r) => `${r.code} ${r.name}`, cache: true },
  dealers: { path: '/dealers', label: (r) => `${r.code} ${r.companyName}`, cache: true },
  employees: { path: '/employees', label: (r) => `${r.empNo} ${r.name}`, cache: true },
  regions: { path: '/regions', label: (r) => `${r.code} ${r.name}`, cache: true },
  'finance-categories': {
    path: '/finance/categories', label: (r) => r.name, cache: true, flat: true,
  },
};
