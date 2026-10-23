/** PostgreSQL error classes we handle on purpose. */
const code = (e: unknown) => (e as { code?: string } | null)?.code;
export const isUniqueViolation = (e: unknown, constraint?: string) => code(e) === '23505' && (!constraint || (e as { constraint?: string }).constraint === constraint);
export const isExclusionViolation = (e: unknown) => code(e) === '23P01';
/** Post-commit side effect (notification). Collected inside a transaction and run only after it commits. */
export type Note = () => Promise<void>;
export async function runNotes(notes: Note[]): Promise<void> { for (const n of notes) { try { await n(); } catch { /* a failed message must never undo a committed case change; it is logged by the provider */ } } }
