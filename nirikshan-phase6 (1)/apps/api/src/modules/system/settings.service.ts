import { Injectable } from '@nestjs/common';
import { DbService } from '../../infra/db.service';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../../common/request-context';

export interface Lifecycle { reminderDays: number[]; dueForRenewalDays: number; applicationExpiryDays: number; visitReminderHours: number; unscheduledAlertHours: number }
export interface Maintenance { enabled: boolean; level: 'info' | 'warn'; textEn: string; textHi: string }
export interface Flags { publicSearch: boolean; tamperReports: boolean; bulkRegister: boolean; selfServiceDataRequests: boolean }
export const SETTING_KEYS = ['maintenance', 'flags', 'lifecycle'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
const DEFAULTS = {
  maintenance: { enabled: false, level: 'info', textEn: '', textHi: '' } as Maintenance,
  flags: { publicSearch: true, tamperReports: true, bulkRegister: true, selfServiceDataRequests: true } as Flags,
  lifecycle: { reminderDays: [60, 30, 15, 7, 1], dueForRenewalDays: 60, applicationExpiryDays: 30, visitReminderHours: 24, unscheduledAlertHours: 24 } as Lifecycle,
};

/** Runtime settings kept in the database so an admin can change them without a deploy. Values are validated by the controller's schema. */
@Injectable()
export class SettingsService {
  constructor(private db: DbService, private audit: AuditService) {}
  async get<K extends SettingKey>(key: K): Promise<(typeof DEFAULTS)[K]> {
    const r = await this.db.system(async (tx) => (await tx.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]);
    return { ...DEFAULTS[key], ...(r?.value ?? {}) } as (typeof DEFAULTS)[K];
  }
  async all() { return { maintenance: await this.get('maintenance'), flags: await this.get('flags'), lifecycle: await this.get('lifecycle') }; }
  async set(user: SessionUser, key: SettingKey, value: unknown) {
    await this.db.forUser(async (tx) => {
      const before = (await tx.query('SELECT value FROM app_settings WHERE key=$1', [key])).rows[0]?.value ?? null;
      await tx.query(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, JSON.stringify(value), user.userId]);
      await this.audit.record(tx, { action: 'settings.changed', entityType: 'app_settings', details: { key, before, after: value } });
    });
    return this.get(key);
  }
}
