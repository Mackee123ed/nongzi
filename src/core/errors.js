/**
 * 统一的错误体系。
 *
 * 每一类错误都带一个稳定的英文 code：前端与测试只依赖 code，
 * message 是给用户看的中文文案，可随时润色而不破坏契约。
 */
export class AppError extends Error {
  constructor(message, { code = 'INTERNAL', status = 500, details = null, cause = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** 入参校验失败（字段缺失、格式错误、业务规则不满足）。 */
export class ValidationError extends AppError {
  constructor(message = '输入的数据不合法', details = null) {
    super(message, { code: 'VALIDATION', status: 422, details });
  }
}

/** 目标资源不存在。 */
export class NotFoundError extends AppError {
  constructor(message = '未找到对应的数据') {
    super(message, { code: 'NOT_FOUND', status: 404 });
  }
}

/** 唯一约束冲突等数据层面的冲突。 */
export class ConflictError extends AppError {
  constructor(message = '数据已存在或与现有数据冲突') {
    super(message, { code: 'CONFLICT', status: 409 });
  }
}

/** 未登录或会话失效。 */
export class AuthError extends AppError {
  constructor(message = '请先登录') {
    super(message, { code: 'AUTH_REQUIRED', status: 401 });
  }
}

/** 已登录但无权访问该数据或执行该操作。 */
export class PermissionError extends AppError {
  constructor(message = '没有权限执行该操作') {
    super(message, { code: 'FORBIDDEN', status: 403 });
  }
}

/** 依赖缺失，例如选择了 MySQL 但未安装驱动。 */
export class ConfigError extends AppError {
  constructor(message = '系统配置有误') {
    super(message, { code: 'CONFIG', status: 500 });
  }
}

/**
 * 把底层驱动抛出的错误翻译为业务错误。
 * 各数据库对同类问题的错误码/文案都不同，收敛在此处。
 */
export function translateDbError(err) {
  if (err instanceof AppError) return err;

  const raw = String(err?.message ?? err);
  const code = String(err?.code ?? '');

  if (/UNIQUE constraint failed|duplicate key|Duplicate entry|ER_DUP_ENTRY|2627|23505/i.test(raw)) {
    return new ConflictError('数据已存在，请检查编号等唯一字段是否重复');
  }
  if (/FOREIGN KEY constraint failed|foreign key constraint|1452|23503/i.test(raw)) {
    return new ValidationError('关联的数据不存在，或该记录仍被其他数据引用');
  }
  if (/NOT NULL constraint failed|23502|Cannot insert the value NULL/i.test(raw)) {
    return new ValidationError('必填字段不能为空');
  }
  if (/CHECK constraint failed|23514/i.test(raw)) {
    return new ValidationError('字段取值不在允许范围内');
  }

  const wrapped = new AppError(`数据库操作失败：${raw}`, { code: 'DB_ERROR', status: 500, cause: err });
  wrapped.driverCode = code;
  return wrapped;
}
