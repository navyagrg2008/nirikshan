import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AllowPending } from '../../common/decorators';
import { DbService } from '../../infra/db.service';
import { ctx } from '../../common/request-context';
import { parse } from '../../common/zod';
import { uuid } from '@nirikshan/shared';

@Controller('notifications')
export class NotificationsController {
  constructor(private db: DbService) {}
  @AllowPending() @Get()
  async list() {
    const u = ctx()!.user!;
    return this.db.system(async (tx) => {
      const rows = (await tx.query('SELECT id, event_code, title, body, deep_link, read_at, created_at FROM in_app_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [u.userId])).rows;
      const unread = (await tx.query('SELECT count(*)::int AS n FROM in_app_notifications WHERE user_id=$1 AND read_at IS NULL', [u.userId])).rows[0].n as number;
      return { unread, items: rows.map((r) => ({ id: r.id, event: r.event_code, title: r.title, body: r.body, deepLink: r.deep_link, readAt: r.read_at, createdAt: r.created_at })) };
    });
  }
  @AllowPending() @HttpCode(200) @Post('read-all')
  async readAll() { await this.db.system((tx) => tx.query('UPDATE in_app_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [ctx()!.user!.userId])); return { ok: true }; }
  @AllowPending() @HttpCode(200) @Post(':id/read')
  async read(@Param('id') id: string) { await this.db.system((tx) => tx.query('UPDATE in_app_notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [parse(uuid, id), ctx()!.user!.userId])); return { ok: true }; }
}
