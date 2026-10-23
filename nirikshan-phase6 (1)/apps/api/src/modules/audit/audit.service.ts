import { Injectable } from '@nestjs/common';
import { DbService, Tx } from '../../infra/db.service';
import { ctx } from '../../common/request-context';

export interface AuditInput {
  action: string; entityType?: string; entityId?: string; areaId?: string | null;
  details?: Record<string, unknown>; actorId?: string | null; actorRole?: string;
}

@Injectable()
export class AuditService {
  constructor(private db: DbService) {}
  /** Writes inside the caller's transaction so the audit row and the change commit or roll back together. `details` must never hold PII or secrets. */
  async record(tx: Tx, e: AuditInput): Promise<void> {
    const c = ctx();
    await tx.query(
      `INSERT INTO audit_events (actor_id, actor_role, action, entity_type, entity_id, area_id, request_id, ip_hash, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ['actorId' in e ? (e.actorId ?? null) : (c?.user?.userId ?? null), e.actorRole ?? c?.user?.role ?? null, e.action, e.entityType ?? null, e.entityId ?? null,
        e.areaId ?? null, c?.requestId ?? null, c?.ipHash ?? null, JSON.stringify(e.details ?? {})]);
  }
  /** For events that have no business transaction (failed logins, logouts). */
  async recordStandalone(e: AuditInput): Promise<void> { await this.db.system((tx) => this.record(tx, e)); }

  async verifyChain() {
    const r = await this.db.system((tx) => tx.query('SELECT checked, first_bad_id FROM audit_verify_chain()'));
    const row = r.rows[0] as { checked: string; first_bad_id: string | null };
    return { checked: Number(row.checked), intact: row.first_bad_id === null, firstBadId: row.first_bad_id ? Number(row.first_bad_id) : null };
  }
}
