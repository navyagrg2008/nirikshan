import type { RoleCode } from './enums';

/** Permission codes. Seeded into `permissions`; the API guards check these, the UI only hides things. */
export const PERMISSIONS = {
  'public.validate': 'Validate a certificate',
  'instrument.create.own': 'Register own instruments',
  'instrument.create.behalf': 'Register instruments on behalf of a customer',
  'instrument.bulk': 'Bulk register instruments',
  'instrument.read.own': 'Read own instruments',
  'instrument.read.area': 'Read instruments in assigned areas',
  'instrument.read.all': 'Read all instruments',
  'instrument.update.own': 'Edit own instruments',
  'instrument.duplicate.override': 'Approve duplicate instrument registrations',
  'account.approve.area': 'Approve accounts in assigned areas',
  'account.approve.all': 'Approve any account',
  'user.manage': 'Manage users and invites',
  'masterdata.read': 'Read master data',
  'masterdata.write': 'Change master data',
  'rules.read': 'Read rules',
  'rules.write': 'Change rules',
  'audit.read.own': 'Read own audit trail',
  'audit.read.area': 'Read audit trail for assigned areas',
  'audit.read.all': 'Read all audit events',
  'case.read.area': 'Read cases in assigned areas',
  'visit.work': 'Work on assigned inspection visits',
  'application.apply': 'Apply for verification',
  'application.read.own': 'Read and manage own applications',
  'case.read.all': 'Read all cases',
  'case.review': 'Check documents, assign and reschedule inspections',
  'schedule.manage': 'Manage inspector calendars and bulk reschedule',
  'decision.make': 'Approve, reject or refer inspected cases',
  'certificate.read.own': 'Read own certificates',
  'certificate.read.area': 'Read certificates in assigned areas',
  'certificate.read.all': 'Read all certificates',
  'certificate.manage': 'Revoke, suspend, reinstate and re-issue certificates',
  'system.manage': 'Change system settings, maintenance banner and run jobs',
  'privacy.manage': 'Handle data-subject requests and view consent records',
  'enforcement.manage': 'Run enforcement drives and send notices',
  'request.review': 'Decide transfer, address-change and de-registration requests',
  'complaint.handle': 'Handle tamper reports and grievances',
  'report.run.area': 'Run reports for assigned areas',
  'report.run.all': 'Run reports for every area',
  'service.manage': 'Manage repair jobs for customers',
  'grievance.raise': 'Raise a grievance',
  'data.request.own': 'Ask for access, correction or erasure of own data',
  'migration.run': 'Import legacy instrument data',
} as const;
export type PermissionCode = keyof typeof PERMISSIONS;

export const ROLE_PERMISSIONS: Record<RoleCode, PermissionCode[]> = {
  OWNER: ['public.validate', 'instrument.create.own', 'instrument.read.own', 'instrument.update.own', 'audit.read.own', 'application.apply', 'application.read.own', 'certificate.read.own', 'grievance.raise', 'data.request.own'],
  TRADER: [
    'public.validate', 'instrument.create.own', 'instrument.create.behalf', 'instrument.bulk',
    'instrument.read.own', 'instrument.update.own', 'audit.read.own', 'application.apply', 'application.read.own', 'certificate.read.own',
    'service.manage', 'grievance.raise', 'data.request.own',
  ],
  INSPECTOR: ['public.validate', 'visit.work', 'audit.read.own', 'masterdata.read', 'rules.read'],
  OFFICER: [
    'public.validate', 'instrument.read.area', 'instrument.duplicate.override', 'account.approve.area',
    'case.read.area', 'case.review', 'schedule.manage', 'audit.read.area', 'masterdata.read', 'rules.read',
    'decision.make', 'certificate.read.area', 'certificate.manage',
    'enforcement.manage', 'request.review', 'complaint.handle', 'report.run.area',
  ],
  SENIOR_OFFICER: [
    'public.validate', 'instrument.read.area', 'instrument.duplicate.override', 'account.approve.area',
    'case.read.area', 'case.review', 'schedule.manage', 'audit.read.area', 'masterdata.read', 'rules.read',
    'decision.make', 'certificate.read.area', 'certificate.manage',
    'enforcement.manage', 'request.review', 'complaint.handle', 'report.run.area',
  ],
  ADMIN: [
    'public.validate', 'instrument.read.all', 'account.approve.all', 'user.manage', 'masterdata.read', 'masterdata.write',
    'rules.read', 'rules.write', 'audit.read.all', 'instrument.duplicate.override', 'case.read.all', 'certificate.read.all', 'certificate.manage',
    'system.manage', 'privacy.manage', 'report.run.all', 'enforcement.manage', 'migration.run', 'complaint.handle',
  ],
};

export function roleHas(role: RoleCode, perm: PermissionCode): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}
