import { requireCondition } from './policy.mjs';

export function prepared(db, sql, ...args) {
  return db.prepare(sql).bind(...args);
}

export async function readRows(db, sql, ...args) {
  return (await prepared(db, sql, ...args).all()).results ?? [];
}

export function resultRow(db, sql, ...args) {
  return prepared(db, sql, ...args).first();
}

export function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  requireCondition(email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    400, 'invalid-email', 'メールアドレスを確認してください。');
  return email;
}
