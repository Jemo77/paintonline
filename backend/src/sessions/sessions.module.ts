import { Module } from '@nestjs/common';
import { SessionItemsController, SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SpacesModule } from '../spaces/spaces.module';
import { RankingModule } from '../ranking/ranking.module';

@Module({
  imports: [SpacesModule, RankingModule],
  controllers: [SessionsController, SessionItemsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
