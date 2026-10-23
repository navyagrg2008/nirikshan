export const ROLES = ['OWNER', 'TRADER', 'INSPECTOR', 'OFFICER', 'SENIOR_OFFICER', 'ADMIN'] as const;
export type RoleCode = (typeof ROLES)[number];
export const STAFF_ROLES = ['INSPECTOR', 'OFFICER', 'SENIOR_OFFICER', 'ADMIN'] as const;
export const MFA_REQUIRED_ROLES: readonly RoleCode[] = STAFF_ROLES;

export const ACCOUNT_STATUS = ['INVITED', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUS)[number];

export const BUSINESS_TYPES = ['OWNER', 'MANUFACTURER', 'DEALER', 'REPAIRER'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const INSTRUMENT_STATUS = ['REGISTERED', 'ACTIVE', 'DUE_FOR_RENEWAL', 'EXPIRED', 'DEREGISTERED'] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUS)[number];

export const AREA_LEVELS = ['DIVISION', 'ZONE', 'CIRCLE', 'WARD'] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

export const OTP_PURPOSES = ['REGISTER', 'LOGIN', 'CONFIRM'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const LANGS = ['en', 'hi'] as const;
export type Lang = (typeof LANGS)[number];

/** Role that lands where after login. */
export const ROLE_HOME: Record<RoleCode, string> = {
  OWNER: '/owner/dashboard',
  TRADER: '/owner/dashboard',
  INSPECTOR: '/inspector/dashboard',
  OFFICER: '/officer/dashboard',
  SENIOR_OFFICER: '/officer/dashboard',
  ADMIN: '/admin/dashboard',
};

export function businessTypeToRole(t: BusinessType): RoleCode {
  return t === 'OWNER' ? 'OWNER' : 'TRADER';
}
