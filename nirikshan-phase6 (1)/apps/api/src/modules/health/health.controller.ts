import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { DbService } from '../../infra/db.service';
import { RedisService } from '../../infra/redis.service';

@Controller('health')
export class HealthController {
  constructor(private db: DbService, private redis: RedisService) {}
  @Public() @Get('live') live() { return { status: 'ok' }; }
  @Public() @Get('ready')
  async ready() {
    try { await this.db.pool.query('SELECT 1'); await this.redis.ping(); return { status: 'ready' }; }
    catch { throw new ServiceUnavailableException({ code: 'NOT_READY' }); }
  }
}
