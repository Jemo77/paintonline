import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import {
  CreateSessionDto,
  LogExportDto,
  SetWinnersDto,
  StrokeQueryDto,
  UpdateLayerDto,
  UpdateSessionDto,
} from './dto/session.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Rutas que arrancan por el espacio. Sólo listing y creación: lo que ocurre
 * *dentro* de una sesión vive en `SessionItemsController`, montado en
 * `/sessions/:sessionId`, para no obligar al cliente a conocer el `spaceId`
 * cuando ya tiene el `sessionId` en la URL.
 */
@Controller('spaces/:spaceId/sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  create(
    @Param('spaceId') spaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessionsService.create(spaceId, userId, dto);
  }

  @Get()
  list(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.sessionsService.findAll(spaceId, userId);
  }
}

/** Todo lo que cuelga de una sesión concreta. */
@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionItemsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Get(':sessionId')
  findOne(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.findOne(sessionId, userId);
  }

  @Patch(':sessionId')
  update(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessionsService.update(sessionId, userId, dto);
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.remove(sessionId, userId);
  }

  // ── Participants ─────────────────────────────────────────────────────────

  @Post(':sessionId/join')
  @HttpCode(HttpStatus.OK)
  join(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.joinSession(sessionId, userId);
  }

  @Post(':sessionId/leave')
  @HttpCode(HttpStatus.OK)
  leave(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.leaveSession(sessionId, userId);
  }

  @Get(':sessionId/participants')
  participants(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.listParticipants(sessionId, userId);
  }

  // ── Layers ───────────────────────────────────────────────────────────────

  @Post(':sessionId/layers')
  createLayer(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.createLayer(sessionId, userId);
  }

  @Put(':sessionId/layers/:layerId')
  updateLayer(
    @Param('sessionId') sessionId: string,
    @Param('layerId') layerId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateLayerDto,
  ) {
    return this.sessionsService.updateLayer(sessionId, layerId, userId, dto);
  }

  @Delete(':sessionId/layers/:layerId')
  @HttpCode(HttpStatus.OK)
  deleteLayer(
    @Param('sessionId') sessionId: string,
    @Param('layerId') layerId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.sessionsService.deleteLayer(sessionId, layerId, userId);
  }

  // ── Strokes ──────────────────────────────────────────────────────────────

  /**
   * Historial vectorial. El cliente lo re-renderiza en Konva y de ahí sale el
   * PNG cuando el usuario lo descarga: el servidor nunca genera imágenes.
   */
  @Get(':sessionId/strokes')
  strokes(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
    @Query() query: StrokeQueryDto,
  ) {
    return this.sessionsService.listStrokes(sessionId, userId, query);
  }

  @Get(':sessionId/strokes/count')
  strokeCount(@Param('sessionId') sessionId: string) {
    return this.sessionsService.countStrokes(sessionId);
  }

  @Post(':sessionId/exports')
  @HttpCode(HttpStatus.CREATED)
  logExport(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: LogExportDto,
  ) {
    return this.sessionsService.logExport(sessionId, userId, dto.scope);
  }

  // ── Winners ──────────────────────────────────────────────────────────────

  @Put(':sessionId/winners')
  setWinners(
    @Param('sessionId') sessionId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SetWinnersDto,
  ) {
    return this.sessionsService.setWinners(sessionId, userId, dto);
  }
}
