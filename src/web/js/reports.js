/**
 * 报表描述表。
 *
 * 需求书里列出了大量「按时间段 + 按某维度」的查询，它们形状高度一致：
 * 一组筛选条件 + 一张表 + 一行合计。这里把每一条查询描述成一个条目，
 * 前端只需要一个通用报表页面就能渲染全部报表。
 */

import { money, qty, date } from './fmt.js';

const range = (extra = []) => [
  { key: 'from', label: '开始日期', type: 'date' },
  { key: 'to', label: '结束日期', type: 'date' },
  ...extra,
];

const ROW_NUMBER = { key: '_index', title: '#', format: (_v, _row) => '' };

export const REPORTS = {
  /* ---------- 库存（需求书 3.4） ---------- */
  'inventory.movements': {
    title: '库存出入库查询',
    spec: '3.4 库存查询（按时间段）',
    description: '不选品种则统计所有品种；选定品种后可按经销商进一步细分。',
    path: '/reports/inventory.movements',
    params: range([
      { key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' },
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers' },
    ]),
    columns: [
      { key: 'varietyCode', title: '品种编码' },
      { key: 'varietyName', title: '品种名称' },
      { key: 'dealerName', title: '经销商' },
      { key: 'totalIn', title: '入库量', align: 'right', format: qty, total: (t) => qty(t.totalIn) },
      { key: 'totalOut', title: '出库量', align: 'right', format: qty, total: (t) => qty(t.totalOut) },
      { key: 'balance', title: '结存', align: 'right', format: qty, total: (t) => qty(t.balance) },
    ],
  },

  'inventory.stock': {
    title: '实时库存总览',
    spec: '3.3 实时库存',
    path: '/reports/inventory.stock',
    params: [],
    columns: [
      { key: 'code', title: '品种编码' },
      { key: 'name', title: '品种名称' },
      { key: 'kindLabel', title: '类别' },
      { key: 'totalIn', title: '累计入库', align: 'right', format: qty },
      { key: 'totalOut', title: '累计出库', align: 'right', format: qty },
      { key: 'quantity', title: '当前库存', align: 'right', format: qty },
    ],
  },

  /* ---------- 销售（需求书 5.2） ---------- */
  'sales.detail': {
    title: '销售明细',
    spec: '5.2 销售查询（明细）',
    description: '明细按销售单逐行列出。',
    path: '/reports/sales',
    fixedParams: { mode: 'detail' },
    params: range([
      { key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' },
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers' },
    ]),
    columns: [
      { key: 'orderDate', title: '销售日期', format: date },
      { key: 'orderNo', title: '销售单号' },
      { key: 'dealerName', title: '经销商' },
      { key: 'varietyCode', title: '品种编码' },
      { key: 'varietyName', title: '品种名称' },
      { key: 'quantity', title: '数量', align: 'right', format: qty, total: (t) => qty(t.totalQuantity) },
      { key: 'unitPriceCents', title: '单价', align: 'right', format: money },
      { key: 'amountCents', title: '金额', align: 'right', format: money, total: (t) => money(t.totalAmountCents) },
      { key: 'rebateCents', title: '返利', align: 'right', format: money, total: (t) => money(t.totalRebateCents) },
    ],
  },

  'sales.summary': {
    title: '销售汇总',
    spec: '5.2 销售查询（汇总）',
    description: '按品种汇总；选择「按经销商拆分」则同时给出每个经销商的合计。',
    path: '/reports/sales',
    fixedParams: { mode: 'summary' },
    params: range([
      { key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' },
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers' },
      {
        key: 'dimension',
        label: '汇总维度',
        type: 'select',
        options: [
          { value: '', label: '按品种汇总' },
          { value: 'dealer', label: '按经销商拆分' },
        ],
      },
    ]),
    columns: [
      { key: 'varietyCode', title: '品种编码' },
      { key: 'varietyName', title: '品种名称' },
      { key: 'dealerName', title: '经销商' },
      { key: 'orderCount', title: '单数', align: 'right' },
      { key: 'totalQuantity', title: '销售数量', align: 'right', format: qty, total: (t) => qty(t.totalQuantity) },
      { key: 'totalAmountCents', title: '销售金额', align: 'right', format: money, total: (t) => money(t.totalAmountCents) },
      { key: 'totalRebateCents', title: '返利金额', align: 'right', format: money, total: (t) => money(t.totalRebateCents) },
    ],
  },

  /* ---------- 财务（需求书 4.3 / 4.4 / 4.5） ---------- */
  'finance.summary': {
    title: '收支明细（按时间段）',
    spec: '4.3 按时间段收支明细',
    path: '/reports/finance.summary',
    params: range(),
    stats: (data) => [
      { label: '收入合计', value: money(data.totalIncomeCents) },
      { label: '支出合计', value: money(data.totalExpenseCents) },
      { label: '结余', value: money(data.netCents), negative: data.netCents < 0 },
    ],
    columns: [
      { key: 'kindLabel', title: '类型' },
      { key: 'categoryName', title: '分类' },
      { key: 'flowCount', title: '笔数', align: 'right' },
      { key: 'totalCents', title: '金额', align: 'right', format: money },
    ],
  },

  'finance.category': {
    title: '分类收支明细',
    spec: '4.4 分类收入明细 / 4.5 分类支出明细',
    description: '支出类目下可展开成本明细（采购价格、运输费用、制种费用、加工费用）。',
    path: '/reports/finance.category',
    params: range([
      {
        key: 'kind',
        label: '收支类型',
        type: 'select',
        options: [
          { value: 'income', label: '收入' },
          { value: 'expense', label: '支出' },
        ],
      },
    ]),
    columns: [
      { key: 'categoryName', title: '分类' },
      { key: 'flowCount', title: '笔数', align: 'right' },
      { key: 'totalCents', title: '金额', align: 'right', format: money, total: (t) => money(t.totalCents) },
      { key: 'componentsText', title: '成本明细' },
    ],
  },

  'finance.ledger': {
    title: '经销商往来账',
    spec: '4.3 按时间段某经销商往来账',
    path: '/reports/finance.dealer-ledger',
    params: range([
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers', required: true },
    ]),
    stats: (data) => [
      { label: '收入合计', value: money(data.totalIncomeCents) },
      { label: '支出合计', value: money(data.totalExpenseCents) },
      { label: '往来余额', value: money(data.netCents), negative: data.netCents < 0 },
    ],
    columns: [
      { key: 'occurredAt', title: '时间', format: date },
      { key: 'kindLabel', title: '类型' },
      { key: 'categoryName', title: '分类' },
      { key: 'name', title: '名称' },
      { key: 'amountCents', title: '金额', align: 'right', format: money },
    ],
  },

  'finance.balance': {
    title: '账户余额',
    spec: '4.3 当前账户余额',
    path: '/reports/finance.balance',
    params: [],
    stats: (data) => [
      { label: '账户余额合计', value: money(data.totalBalanceCents), negative: data.totalBalanceCents < 0 },
    ],
    columns: [
      { key: 'code', title: '账户编码' },
      { key: 'name', title: '账户名称' },
      { key: 'openingBalanceCents', title: '期初余额', align: 'right', format: money },
      { key: 'incomeCents', title: '累计收入', align: 'right', format: money },
      { key: 'expenseCents', title: '累计支出', align: 'right', format: money },
      { key: 'balanceCents', title: '当前余额', align: 'right', format: money },
    ],
  },

  /* ---------- 客户（需求书 6.3） ---------- */
  'customer.feedback': {
    title: '经销商反馈查询',
    spec: '6.3 反馈查询（按时间段）',
    description: '不选品种与经销商则列出全部；任选其一即按对应维度过滤。',
    path: '/reports/customer.feedback',
    params: range([
      { key: 'varietyId', label: '品种', type: 'lookup', lookup: 'varieties' },
      { key: 'dealerId', label: '经销商', type: 'lookup', lookup: 'dealers' },
    ]),
    columns: [
      { key: 'feedbackDate', title: '反馈日期', format: date },
      { key: 'dealerName', title: '经销商' },
      { key: 'varietyName', title: '品种' },
      { key: 'content', title: '反馈内容' },
    ],
  },

  /* ---------- 员工与工资（需求书 7.5） ---------- */
  'payroll.salary': {
    title: '工资发放支出',
    spec: '7.5 某员工 / 所有员工发放工资支出',
    path: '/reports/payroll.salary',
    params: range([
      { key: 'employeeId', label: '员工', type: 'lookup', lookup: 'employees' },
    ]),
    stats: (data) => [
      { label: '基本工资合计', value: money(data.baseCents) },
      { label: '绩效工资合计', value: money(data.performanceCents) },
      { label: '年终奖合计', value: money(data.yearEndBonusCents) },
      { label: '工资总支出', value: money(data.totalCents) },
    ],
    columns: [
      { key: 'employeeName', title: '员工' },
      { key: 'period', title: '所属期' },
      { key: 'baseCents', title: '基本工资', align: 'right', format: money, total: (t) => money(t.baseCents) },
      { key: 'performanceCents', title: '绩效工资', align: 'right', format: money, total: (t) => money(t.performanceCents) },
      { key: 'yearEndBonusCents', title: '年终奖', align: 'right', format: money, total: (t) => money(t.yearEndBonusCents) },
      { key: 'totalCents', title: '合计', align: 'right', format: money, total: (t) => money(t.totalCents) },
    ],
  },

  'payroll.social': {
    title: '五险一金缴纳',
    spec: '7.5 某员工 / 所有员工公司承担五险一金缴纳',
    description: '只统计公司承担部分，个人承担部分单列供参考。',
    path: '/reports/payroll.social',
    params: range([
      { key: 'employeeId', label: '员工', type: 'lookup', lookup: 'employees' },
    ]),
    stats: (data) => [
      { label: '公司承担社保', value: money(data.companySiCents) },
      { label: '公司承担公积金', value: money(data.companyFundCents) },
      { label: '公司承担合计', value: money(data.employerTotalCents) },
    ],
    columns: [
      { key: 'employeeName', title: '员工' },
      { key: 'period', title: '所属期' },
      { key: 'baseCents', title: '缴纳基数', align: 'right', format: money },
      { key: 'companySiCents', title: '公司社保', align: 'right', format: money, total: (t) => money(t.companySiCents) },
      { key: 'companyFundCents', title: '公司公积金', align: 'right', format: money, total: (t) => money(t.companyFundCents) },
      { key: 'personalSiCents', title: '个人社保', align: 'right', format: money },
      { key: 'personalFundCents', title: '个人公积金', align: 'right', format: money },
    ],
  },

  'payroll.total': {
    title: '工资及五险一金总支出',
    spec: '7.5 某员工工资及五险一金总支出',
    path: '/reports/payroll.salary',
    fixedParams: { mode: 'total' },
    params: range([
      { key: 'employeeId', label: '员工', type: 'lookup', lookup: 'employees' },
    ]),
    stats: (data) => [
      { label: '工资合计', value: money(data.salaryTotalCents) },
      { label: '公司承担五险一金', value: money(data.employerSocialInsuranceTotalCents) },
      { label: '总支出', value: money(data.grandTotalCents) },
    ],
    columns: [
      { key: 'employeeName', title: '员工' },
      { key: 'salaryTotalCents', title: '工资合计', align: 'right', format: money, total: (t) => money(t.salaryTotalCents) },
      { key: 'employerSocialInsuranceTotalCents', title: '公司承担五险一金', align: 'right', format: money, total: (t) => money(t.employerSocialInsuranceTotalCents) },
      { key: 'grandTotalCents', title: '总支出', align: 'right', format: money, total: (t) => money(t.grandTotalCents) },
    ],
  },
};

export { ROW_NUMBER };
