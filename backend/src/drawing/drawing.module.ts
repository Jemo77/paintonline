import { Module } from '@nestjs/common';
import { DrawingGateway } from './drawing.gateway';
import { DrawingService } from './drawing.service';
import { PresenceService } from './presence.service';
import { LayerLockService } from './layer-lock.service';
import { SessionsModule } from '../sessions/sessions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SessionsModule, AuthModule],
  providers: [DrawingGateway, DrawingService, PresenceService, LayerLockService],
  exports: [DrawingService, PresenceService, LayerLockService],
})
export class DrawingModule {}
