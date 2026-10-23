/** Masking helpers used for public and cross-role views. Pure functions so API and UI agree. */
export function maskFirm(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return '******';
  const first = Array.from(clean)[0]!;
  return `${first.toUpperCase()}******`;
}
export function maskMobile(mobile10: string): string {
  const d = mobile10.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `+91 ******${d.slice(-2)}` : '******';
}
export function maskEmail(email: string): string {
  const [u, d] = email.split('@');
  if (!u || !d) return '******';
  return `${u[0]}******@${d}`;
}
/** Normalise an Indian mobile number to 10 digits, or null when it is not valid. */
export function normaliseMobile(input: string): string | null {
  const d = input.replace(/[\s()-]/g, '');
  // Only a +91 / 91 country prefix on a full 11-12 digit number is stripped. A plain 10-digit number that happens to start with 91 is kept.
  const n = /^(\+91|91|0)\d{10}$/.test(d) ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(n) ? n : null;
}
export function normaliseEmail(input: string): string { return input.trim().toLowerCase(); }
