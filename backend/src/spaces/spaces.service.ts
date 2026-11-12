import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateSpaceDto, UpdateSpaceDto } from './dto/space.dto';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

@Injectable()
export class SpacesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateSpaceDto) {
    const slug = await this.resolveSlug(dto.slug ?? dto.name);

    return this.prisma.space.create({
      data: {
        name: dto.name.trim(),
        slug,
        description: dto.description?.trim() ?? null,
        isPublic: dto.isPublic ?? true,
        ownerId,
        members: { create: { userId: ownerId, role: 'CREATOR' } },
      },
      include: { _count: { select: { members: true, sessions: true } } },
    });
  }

  /** Espacios donde el usuario es dueño o miembro. */
  async listForUser(userId: string) {
    return this.prisma.space.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: 'desc' },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        _count: { select: { members: true, sessions: true } },
      },
    });
  }

  /** Espacio público, para la pantalla pública de join. */
  async findPublicBySlug(slug: string) {
    const space = await this.prisma.space.findUnique({
      where: { slug },
      include: {
        owner: { select: { id: true, name: true } },
        _count: { select: { members: true, sessions: true } },
        sessions: {
          where: { status: { in: ['OPEN', 'LIVE'] } },
          select: {
            id: true,
            title: true,
            theme: true,
            mode: true,
            status: true,
            canvasWidth: true,
            canvasHeight: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!space) throw new NotFoundException('Espacio no encontrado');
    if (!space.isPublic) throw new ForbiddenException('Este espacio es privado');
    return space;
  }

  async findOne(spaceId: string, userId: string) {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      include: {
        owner: { select: { id: true, name: true, avatarUrl: true } },
        members: {
          where: { userId },
          select: { role: true },
        },
        _count: { select: { members: true, sessions: true } },
      },
    });

    if (!space) throw new NotFoundException('Espacio no encontrado');
    if (!space.isPublic && !space.members.length && space.ownerId !== userId) {
      throw new ForbiddenException('Este espacio es privado');
    }

    return { ...space, membership: space.members[0]?.role ?? null };
  }

  async listMembers(spaceId: string) {
    return this.prisma.spaceMember.findMany({
      where: { spaceId },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: {
          select: { id: true, name: true, avatarUrl: true, score: true },
        },
      },
    });
  }

  /** El creador se une automáticamente; los miembros se registran aparte. */
  async join(spaceId: string, userId: string) {
    const space = await this.prisma.space.findUnique({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Espacio no encontrado');
    if (!space.isPublic) {
      throw new ForbiddenException('Este espacio es privado');
    }

    await this.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      create: { spaceId, userId },
      update: {},
    });

    return this.findOne(spaceId, userId);
  }

  async leave(spaceId: string, userId: string) {
    const space = await this.prisma.space.findUnique({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Espacio no encontrado');
    if (space.ownerId === userId) {
      throw new BadRequestException('El dueño no puede salir de su propio espacio');
    }

    await this.prisma.spaceMember.deleteMany({ where: { spaceId, userId } });
    return { success: true };
  }

  async update(spaceId: string, ownerId: string, dto: UpdateSpaceDto) {
    await this.assertOwner(spaceId, ownerId);

    return this.prisma.space.update({
      where: { id: spaceId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
        ...(dto.scoringConfig !== undefined
          ? { scoringConfig: this.validateScoring(dto.scoringConfig) }
          : {}),
      },
    });
  }

  async remove(spaceId: string, ownerId: string) {
    await this.assertOwner(spaceId, ownerId);
    await this.prisma.space.delete({ where: { id: spaceId } });
    return { success: true };
  }

  async assertMember(spaceId: string, userId: string) {
    const member = await this.prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
    });
    if (!member) {
      throw new ForbiddenException('No pertenecés a este espacio');
    }
    return member;
  }

  /** El dueño del espacio (o un ADMIN) puede administrar sus sesiones. */
  async assertOwner(spaceId: string, userId: string) {
    const space = await this.prisma.space.findUnique({ where: { id: spaceId } });
    if (!space) throw new NotFoundException('Espacio no encontrado');

    if (space.ownerId !== userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (user?.role !== 'ADMIN') {
        throw new ForbiddenException('Sólo el dueño del espacio puede hacer esto');
      }
    }
    return space;
  }

  async getScoringConfig(spaceId: string): Promise<Record<string, number>> {
    const space = await this.prisma.space.findUnique({
      where: { id: spaceId },
      select: { scoringConfig: true },
    });
    if (!space) throw new NotFoundException('Espacio no encontrado');
    return this.validateScoring(
      space.scoringConfig as unknown as Record<string, number>,
    );
  }

  private validateScoring(input: Record<string, number>): Record<string, number> {
    const config: Record<string, number> = { '1': 10, '2': 6, '3': 3 };
    for (const position of ['1', '2', '3'] as const) {
      const value = input?.[position];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new BadRequestException(
          `Los puntos del puesto ${position} deben ser un número >= 0`,
        );
      }
      config[position] = Math.floor(value);
    }
    return config;
  }

  private async resolveSlug(input: string): Promise<string> {
    const base = this.slugify(input);
    if (!base) throw new BadRequestException('El nombre no genera un slug válido');

    let candidate = base;
    let suffix = 1;
    while (await this.prisma.space.findUnique({ where: { slug: candidate } })) {
      candidate = `${base}-${++suffix}`;
    }
    return candidate;
  }

  private slugify(input: string): string {
    return input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }
}
