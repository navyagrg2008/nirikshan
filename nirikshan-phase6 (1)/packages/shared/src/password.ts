/** Shared password policy. The API enforces it; the web form uses the same function for instant feedback. */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '123456', '1234567', '12345678', '123456789', '1234567890', 'qwerty',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'admin', 'admin123', 'welcome', 'welcome1', 'letmein', 'abc123', 'india123',
  'india@123', 'nirikshan', 'nirikshan1', 'nirikshan123', 'changeme', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
  'princess', 'master', 'hello123', 'login', 'passw0rd1', 'zaq12wsx', 'trustno1', '111111', '000000', 'aaaaaa',
]);

export interface PasswordCheck { ok: boolean; reasons: PasswordReason[] }
export type PasswordReason = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_SIMPLE' | 'COMMON' | 'REPEATED' | 'CONTAINS_IDENTIFIER';

export function checkPassword(pw: string, identifiers: string[] = []): PasswordCheck {
  const reasons: PasswordReason[] = [];
  if (pw.length < 10) reasons.push('TOO_SHORT');
  if (pw.length > 128) reasons.push('TOO_LONG');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) reasons.push('TOO_SIMPLE');
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) reasons.push('COMMON');
  if (/(.)\1{3,}/.test(pw)) reasons.push('REPEATED');
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pwSquashed = squash(pw);
  outer: for (const id of identifiers) {
    const parts = [id, ...id.split(/[\s@._-]+/)].map(squash).filter((p) => p.length >= 4);
    for (const p of parts) if (pwSquashed.includes(p)) { reasons.push('CONTAINS_IDENTIFIER'); break outer; }
  }
  return { ok: reasons.length === 0, reasons };
}
