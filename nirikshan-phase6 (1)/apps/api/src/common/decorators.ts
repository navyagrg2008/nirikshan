import { SetMetadata } from '@nestjs/common';
import type { PermissionCode, RoleCode } from '@nirikshan/shared';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ALLOW_PENDING = 'allowPending';
/** Route may be used by accounts that are not ACTIVE yet (pending approval). */
export const AllowPending = () => SetMetadata(ALLOW_PENDING, true);
export const ROLES_KEY = 'roles';
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);
export const PERM_KEY = 'permission';
export const RequirePermission = (...p: PermissionCode[]) => SetMetadata(PERM_KEY, p);
export const STEP_UP = 'stepUp';
/** Requires a successful re-authentication within the last 5 minutes. */
export const StepUp = () => SetMetadata(STEP_UP, true);
export const RATE_LIMIT = 'rateLimit';
export interface RateLimitOpts { name: string; limit: number; windowSec: number; by?: 'ip' | 'user' }
export const RateLimit = (o: RateLimitOpts) => SetMetadata(RATE_LIMIT, o);
export const IDEMPOTENT = 'idempotent';
/** Requires an Idempotency-Key header and replays the stored response on retry. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);
