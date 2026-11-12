import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import type { AccessTokenPayload } from './token.service';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'CREATOR' | 'VIEWER' | 'ADMIN';
  avatarUrl: string | null;
}

export interface AuthResult {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
}

const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    name: string;
    spaceSlug?: string;
  }): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Ya existe un usuario con ese email');
    }

    // Si viene de /join/[spaceSlug], la cuenta se une al espacio al crearse.
    let spaceId: string | undefined;
    if (input.spaceSlug) {
      const space = await this.prisma.space.findUnique({
        where: { slug: input.spaceSlug },
      });
      if (!space) {
        throw new ConflictException('El espacio solicitado no existe');
      }
      spaceId = space.id;
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await this.hashPassword(input.password),
        name: input.name.trim(),
        score: { create: {} },
        ...(spaceId
          ? { memberships: { create: { spaceId, role: 'VIEWER' as const } } }
          : {}),
      },
    });

    this.logger.log(`Usuario registrado: ${user.email}`);

    const tokens = await this.issueFor(user.id);
    return { user: toSessionUser(user), ...tokens };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Comparamos siempre, exista o no el email, para no filtrar por timing.
    const valid = await this.comparePassword(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );

    if (!user || !valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const tokens = await this.issueFor(user.id);
    return { user: toSessionUser(user), ...tokens };
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const payload = await this.tokenService.verifyRefreshToken(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');

    // `issueFor` reescribe el jti: el refresh anterior queda invalidado (rotación).
    const tokens = await this.issueFor(user.id);
    return { user: toSessionUser(user), ...tokens };
  }

  async logout(userId: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(userId);
  }

  async me(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    return toSessionUser(user);
  }

  async validateAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.tokenService.verifyAccessToken(token);
  }

  private async issueFor(userId: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const [accessToken, refreshToken] = await Promise.all([
      this.tokenService.issueAccessToken(user),
      this.tokenService.issueRefreshToken(user.id),
    ]);
    return { accessToken, refreshToken };
  }

  private hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, Number(process.env.BCRYPT_ROUNDS ?? 10));
  }

  private comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as SessionUser['role'],
    avatarUrl: user.avatarUrl,
  };
}
