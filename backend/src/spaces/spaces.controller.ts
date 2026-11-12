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
  UseGuards,
} from '@nestjs/common';
import { SpacesService } from './spaces.service';
import { CreateSpaceDto, UpdateSpaceDto } from './dto/space.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, Public } from '../common/decorators/current-user.decorator';

@Controller('spaces')
export class SpacesController {
  constructor(private readonly spacesService: SpacesService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSpaceDto) {
    return this.spacesService.create(userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.spacesService.listForUser(userId);
  }

  /**
   * Vista pública de un espacio: es la que abre el link de invitación.
   *
   * Es la única ruta sin token, y por eso tiene que llevar `@Public()`
   * explícito: `JwtAuthGuard` está registrado como guard global, así que sin
   * este decorador exigía autenticación y el link no le servía a quien todavía
   * no tenía cuenta. Sólo expone datos que el espacio marca como públicos.
   */
  @Public()
  @Get('public/:slug')
  publicBySlug(@Param('slug') slug: string) {
    return this.spacesService.findPublicBySlug(slug);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':spaceId')
  findOne(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.spacesService.findOne(spaceId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':spaceId')
  update(
    @Param('spaceId') spaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateSpaceDto,
  ) {
    return this.spacesService.update(spaceId, userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':spaceId')
  @HttpCode(HttpStatus.OK)
  remove(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.spacesService.remove(spaceId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':spaceId/members')
  members(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.spacesService
      .assertMember(spaceId, userId)
      .then(() => this.spacesService.listMembers(spaceId));
  }

  @UseGuards(JwtAuthGuard)
  @Post(':spaceId/join')
  @HttpCode(HttpStatus.OK)
  join(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.spacesService.join(spaceId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':spaceId/leave')
  @HttpCode(HttpStatus.OK)
  leave(@Param('spaceId') spaceId: string, @CurrentUser('id') userId: string) {
    return this.spacesService.leave(spaceId, userId);
  }
}
