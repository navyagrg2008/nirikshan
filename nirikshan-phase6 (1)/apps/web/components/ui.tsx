'use client';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';
import { errorText, useI18n } from '@/lib/i18n';

const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(' ');

export function Button({ variant = 'primary', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  const v = { primary: 'bg-primary text-primary-ink hover:shadow-md', secondary: 'border border-line bg-surface hover:bg-primary-soft', danger: 'bg-danger text-primary-ink hover:shadow-md', ghost: 'hover:bg-primary-soft' }[variant];
  return <button {...p} disabled={p.disabled || loading} aria-busy={loading} className={cx('inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition disabled:opacity-50', v, className)}>{loading && <Spinner />}{children}</button>;
}
export function Spinner() { return <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />; }

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode }) {
  const id = useId(); const d = [hint && `${id}-h`, error && `${id}-e`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children({ id, 'aria-describedby': d, 'aria-invalid': error ? true : undefined })}
      {hint && <p id={`${id}-h`} className="text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-e`} role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}
const inputCls = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base placeholder:text-muted aria-[invalid=true]:border-danger';
export function Input({ label, hint, error, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}>{(a) => <input {...p} {...a} className={cx(inputCls, p.className)} />}</Field>;
}
export function Select({ label, hint, error, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}>{(a) => <select {...p} {...a} className={cx(inputCls, p.className)}>{children}</select>}</Field>;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) { return <section className={cx('rounded-xl border border-line bg-surface p-5', className)}>{children}</section>; }
export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const c = { danger: 'border-danger text-danger', ok: 'border-ok text-ok', warn: 'border-warn text-warn', info: 'border-primary text-ink' }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-lg border-l-4 bg-surface px-4 py-3 text-sm', c)}>{children}</div>;
}
export function Badge({ tone = 'muted', children }: { tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'info'; children: ReactNode }) {
  const c = { ok: 'text-ok border-ok', warn: 'text-warn border-warn', danger: 'text-danger border-danger', muted: 'text-muted border-line', info: 'text-primary border-primary' }[tone];
  return <span className={cx('inline-block rounded-full border px-2 py-0.5 text-xs font-medium', c)}>{children}</span>;
}
export function ErrorNote({ error }: { error: unknown }) {
  const { lang } = useI18n(); if (!error) return null;
  const code = error instanceof ApiError ? error.code : 'NETWORK';
  const wait = error instanceof ApiError && error.retryAfter ? ` (${error.retryAfter}s)` : '';
  return <Alert>{code === 'NETWORK' ? (lang === 'hi' ? 'सर्वर तक नहीं पहुँच पाए।' : 'Could not reach the server.') : errorText(code, lang)}{wait}</Alert>;
}
export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold tracking-tight">{children}</h1>{actions}</div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="rounded-xl border border-dashed border-line p-10 text-center text-muted">{children}</div>; }
export function Loading() { const { t } = useI18n(); return <div role="status" className="flex items-center gap-2 p-6 text-muted"><Spinner />{t('common.loading')}</div>; }

/** The Verified Seal. Draws itself once; static when the person prefers reduced motion. */
export function Seal({ size = 56, label }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="32" cy="32" r="29" fill="none" stroke="var(--brass)" strokeWidth="3" className="seal-ring" />
      <circle cx="32" cy="32" r="22" fill="var(--primary-soft)" />
      <path d="M21 33l8 8 14-17" fill="none" stroke="var(--primary)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="seal-tick" />
    </svg>
  );
}

/** Simple modal dialog: Escape closes, first field is focused, focus returns to the opener. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId(); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button'); first?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); prev?.focus(); };
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={id} className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4">
      <div ref={ref} className="w-full max-w-lg space-y-4 rounded-xl border border-line bg-surface p-6 shadow-xl"><h2 id={id} className="text-lg font-semibold">{title}</h2>{children}</div>
    </div>
  );
}
export function Textarea({ label, hint, error, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}>{(a) => <textarea {...p} {...a} rows={p.rows ?? 3} className={cx('w-full rounded-lg border border-line bg-surface px-3 py-2 text-base aria-[invalid=true]:border-danger', p.className)} />}</Field>;
}
