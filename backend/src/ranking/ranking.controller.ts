import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { RankingService } from './ranking.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('ranking')
@UseGuards(JwtAuthGuard)
export class RankingController {
  constructor(private readonly rankingService: RankingService) {}

  /**
   * Ranking de un espacio.
   * `?page=1&pageSize=25`. Cacheado en Redis con TTL corto, invalidado al
   * cerrar una sesión o elegir ganadores.
   */
  @Get('space/:spaceId')
  forSpace(
    @Param('spaceId') spaceId: string,
    @CurrentUser('id') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
  ) {
    return this.rankingService.forSpace(spaceId, userId, page, pageSize);
  }

  /** Ranking global. `?spaceId=` lo acota a los miembros de un espacio. */
  @Get('global')
  global(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(25), ParseIntPipe) pageSize: number,
  ) {
    return this.rankingService.global(userId, spaceId, page, pageSize);
  }

  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.rankingService.myScore(userId);
  }

  @Get('history/:userId')
  history(@Param('userId') userId: string) {
    return this.rankingService.historyOf(userId);
  }
}
