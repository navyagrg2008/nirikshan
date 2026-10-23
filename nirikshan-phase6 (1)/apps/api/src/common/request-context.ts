import { AsyncLocalStorage } from 'async_hooks';
import type { RoleCode } from '@nirikshan/shared';

export interface SessionUser {
  userId: string;
  role: RoleCode;
  accountStatus: string;
  businessIds: string[];
  areaIds: string[];
  sessionRef: string;
  authAt: number;
  mfa: boolean;
  lang: 'en' | 'hi';
}
export interface RequestCtx { requestId: string; ip: string; ipHash?: Buffer; user?: SessionUser; ua?: string }
export const als = new AsyncLocalStorage<RequestCtx>();
export const ctx = (): RequestCtx | undefined => als.getStore();
