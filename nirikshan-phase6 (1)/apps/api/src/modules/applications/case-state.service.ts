import { Injectable } from '@nestjs/common';
import { allowedActions, findTransition, type Actor, type ApplicationState } from '@nirikshan/shared';
import type { Tx } from '../../infra/db.service';
import { AuditService } from '../audit/audit.service';
import { conflict, notFound } from '../../common/errors';

export interface CaseRow { id: string; application_no: string; status: ApplicationState; area_id: string; business_id: string; instrument_id: string; version: number; rule_set_id: string }

/**
 * The only place that changes an application's status. The change, its history row and its audit event are written in the
 * caller's transaction, so they commit or roll back together (FR-APP-10). An illegal move is a 409, never a silent no-op.
 */
@Injectable()
export class CaseStateService {
  constructor(private audit: AuditService) {}

  async lock(tx: Tx, appId: string): Promise<CaseRow> {
    const r = (await tx.query(
      'SELECT id, application_no, status, area_id, business_id, instrument_id, version, rule_set_id FROM applications WHERE id=$1 FOR UPDATE', [appId])).rows[0] as CaseRow | undefined;
    if (!r) throw notFound(); // missing and out-of-scope look the same
    return r;
  }

  async transition(tx: Tx, appId: string, action: string, actor: Actor, actorId: string | null, remark?: string, extra?: { set?: string; params?: unknown[] }): Promise<{ from: ApplicationState; to: ApplicationState; row: CaseRow }> {
    const row = await this.lock(tx, appId);
    const t = findTransition(row.status, action, actor);
    if (!t) throw conflict('ILLEGAL_TRANSITION', { from: row.status, action, allowed: allowedActions(row.status, actor) });
    // ready_at starts the scheduling SLA clock every time the case (re)enters a state that waits for an inspector.
    const ready = t.to === 'DOCUMENT_CHECKED' || t.to === 'FAILED_ATTEMPT' ? ', ready_at = now()' : '';
    const params: unknown[] = [t.to, appId, ...(extra?.params ?? [])];
    await tx.query(`UPDATE applications SET status=$1::application_status, version=version+1, updated_at=now()${ready}${extra?.set ? ', ' + extra.set : ''} WHERE id=$2`, params);
    await tx.query('INSERT INTO case_status_history (application_id, from_status, to_status, action, actor_id, remark) VALUES ($1,$2,$3,$4,$5,$6)', [appId, row.status, t.to, action, actorId, remark ?? null]);
    await this.audit.record(tx, { action: `case.${action}`, entityType: 'application', entityId: appId, areaId: row.area_id, details: { from: row.status, to: t.to }, actorId, actorRole: actor });
    return { from: row.status, to: t.to, row: { ...row, status: t.to, version: row.version + 1 } };
  }

  /** History row without a status change (for example a document flagged, a visit rescheduled inside one status). */
  async note(tx: Tx, appId: string, action: string, actorId: string | null, remark: string, status: ApplicationState) {
    await tx.query('INSERT INTO case_status_history (application_id, from_status, to_status, action, actor_id, remark) VALUES ($1,$2,$2,$3,$4,$5)', [appId, status, action, actorId, remark]);
    await tx.query('UPDATE applications SET updated_at=now() WHERE id=$1', [appId]);
  }
}
