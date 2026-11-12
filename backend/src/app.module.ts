import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/guards/roles.guard';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SessionEventsModule } from './events/session-events.module';
import { SpacesModule } from './spaces/spaces.module';
import { SessionsModule } from './sessions/sessions.module';
import { DrawingModule } from './drawing/drawing.module';
import { RankingModule } from './ranking/ranking.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 300,
      },
    ]),
    PrismaModule,
    RedisModule,
    SessionEventsModule,
    AuthModule,
    SpacesModule,
    RankingModule,
    SessionsModule,
    DrawingModule,
  ],
  controllers: [HealthController],
  providers: [
    // Orden importa: primero autenticación, después autorización por rol.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (process.env.NODE_ENV === 'production' && !secret) {
      throw new Error('Falta JWT_ACCESS_SECRET en producción');
    }
  }
}
