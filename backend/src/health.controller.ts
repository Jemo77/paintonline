import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/current-user.decorator';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { DrawingService } from './drawing/drawing.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly drawingService: DrawingService,
  ) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Public()
  @Get()
  live() {
    return {
      status: 'ok',
      service: 'paintonline-api',
      time: new Date().toISOString(),
    };
  }

  /** Readiness: ¿puede atender tráfico? Verifica Postgres y Redis. */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'error'> = { postgres: 'ok', redis: 'ok' };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      checks.postgres = 'error';
    }

    try {
      await this.redis.client.ping();
    } catch {
      checks.redis = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');
    return {
      status: healthy ? 'ok' : 'degraded',
      checks,
      activeStrokes: await this.drawingService.countActiveStrokes().catch(() => 0),
      time: new Date().toISOString(),
    };
  }
}
