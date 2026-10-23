import type { RoleCode } from './enums';

/** Application (case) lifecycle. Phase 1 split: instrument and certificate states live elsewhere. */
export const APPLICATION_STATES = [
  'APPLIED', 'DOCUMENT_CHECKED', 'SCHEDULED', 'INSPECTION_IN_PROGRESS', 'FAILED_ATTEMPT', 'INSPECTED', 'REFERRED', 'APPROVED',
  'REJECTED', 'CERTIFICATE_ISSUED', 'CANCELLED', 'APPLICATION_EXPIRED',
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const TERMINAL_STATES: readonly ApplicationState[] = ['REJECTED', 'CERTIFICATE_ISSUED', 'CANCELLED', 'APPLICATION_EXPIRED'];

export type Actor = RoleCode | 'SYSTEM';
export interface Transition { from: ApplicationState; action: string; to: ApplicationState; roles: Actor[]; reauth?: boolean }

export const TRANSITIONS: Transition[] = [
  { from: 'APPLIED', action: 'documentCheckComplete', to: 'DOCUMENT_CHECKED', roles: ['OFFICER', 'SENIOR_OFFICER', 'ADMIN'] },
  { from: 'APPLIED', action: 'cancel', to: 'CANCELLED', roles: ['OWNER', 'TRADER', 'OFFICER', 'SENIOR_OFFICER'] },
  { from: 'APPLIED', action: 'expire', to: 'APPLICATION_EXPIRED', roles: ['SYSTEM'] },
  { from: 'DOCUMENT_CHECKED', action: 'assign', to: 'SCHEDULED', roles: ['SYSTEM', 'OFFICER', 'SENIOR_OFFICER'] },
  { from: 'SCHEDULED', action: 'startVisit', to: 'INSPECTION_IN_PROGRESS', roles: ['INSPECTOR'] },
  { from: 'SCHEDULED', action: 'reschedule', to: 'DOCUMENT_CHECKED', roles: ['SYSTEM', 'OFFICER', 'SENIOR_OFFICER'] },
  { from: 'SCHEDULED', action: 'noShow', to: 'FAILED_ATTEMPT', roles: ['SYSTEM', 'INSPECTOR', 'OFFICER', 'SENIOR_OFFICER'] },
  { from: 'FAILED_ATTEMPT', action: 'assign', to: 'SCHEDULED', roles: ['SYSTEM', 'OFFICER', 'SENIOR_OFFICER'] },
  { from: 'INSPECTION_IN_PROGRESS', action: 'submit', to: 'INSPECTED', roles: ['INSPECTOR'] },
  { from: 'INSPECTED', action: 'approve', to: 'APPROVED', roles: ['OFFICER', 'SENIOR_OFFICER'], reauth: true },
  { from: 'INSPECTED', action: 'reject', to: 'REJECTED', roles: ['OFFICER', 'SENIOR_OFFICER'], reauth: true },
  { from: 'INSPECTED', action: 'refer', to: 'REFERRED', roles: ['OFFICER'], reauth: true },
  { from: 'INSPECTED', action: 'reinspect', to: 'DOCUMENT_CHECKED', roles: ['OFFICER', 'SENIOR_OFFICER'] },
  { from: 'REFERRED', action: 'approve', to: 'APPROVED', roles: ['SENIOR_OFFICER'], reauth: true },
  { from: 'REFERRED', action: 'reject', to: 'REJECTED', roles: ['SENIOR_OFFICER'], reauth: true },
  { from: 'APPROVED', action: 'issue', to: 'CERTIFICATE_ISSUED', roles: ['SYSTEM', 'OFFICER', 'SENIOR_OFFICER'] },
];

export function findTransition(from: ApplicationState, action: string, actor: Actor): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.action === action && t.roles.includes(actor));
}
export function isTerminal(s: ApplicationState): boolean { return TERMINAL_STATES.includes(s); }
export function allowedActions(from: ApplicationState, actor: Actor): string[] {
  return TRANSITIONS.filter((t) => t.from === from && t.roles.includes(actor)).map((t) => t.action);
}
