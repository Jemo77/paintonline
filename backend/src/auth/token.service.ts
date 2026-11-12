import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

/** Formato que espera `expiresIn` de jsonwebtoken (p. ej. "15m", "30d"). */
type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: string;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessTtl: Duration;
  private readonly refreshTtl: Duration;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accessTtl = asDuration(config.get<string>('JWT_ACCESS_TTL', '15m'), '15m');
    this.refreshTtl = asDuration(config.get<string>('JWT_REFRESH_TTL', '30d'), '30d');
  }

  async issueAccessToken(user: {
    id: string;
    email: string;
    name: string;
    role: string;
  }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return this.jwt.signAsync(payload, { expiresIn: this.accessTtl });
  }

  /**
   * Refresh tokens stateless (JWT firmado). Para poder revocarlos, guardamos el
   * `jti` de la sesión actual en la tabla `RefreshToken`; si se hace logout o
   * se rota la credencial, el registro se elimina y el token deja de servir.
   */
  async issueRefreshToken(userId: string): Promise<string> {
    const jti = `${userId}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const payload: RefreshTokenPayload = { sub: userId, jti };
    const token = await this.jwt.signAsync(payload, { expiresIn: this.refreshTtl });

    const expiresAt = new Date(Date.now() + this.parseTtlMs(this.refreshTtl));
    await this.prisma.refreshToken.upsert({
      where: { userId },
      create: { userId, jti, expiresAt },
      update: { jti, expiresAt },
    });

    return token;
  }

  /**
   * Verifica el access token. Lo usan tanto el guard REST como el guard del
   * handshake de WebSocket, para que haya una sola validación de credenciales.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { userId: payload.sub },
    });
    if (!stored || stored.jti !== payload.jti) {
      throw new UnauthorizedException('Refresh token revocado');
    }
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expirado');
    }

    return payload;
  }

  async revokeRefreshToken(userId: string): Promise<void> {
    try {
      await this.prisma.refreshToken.deleteMany({ where: { userId } });
    } catch (error) {
      // Un fallo acá no debe impedir el logout: el access token expira solo.
      this.logger.warn(
        `No se pudo revocar el refresh de ${userId}: ${String(error)}`,
      );
    }
  }

  private parseTtlMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2] as 's' | 'm' | 'h' | 'd';
    const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return value * factor;
  }
}

/** Valida el TTL del env y lo tipa como Duration. */
function asDuration(raw: string, fallback: Duration): Duration {
  return /^\d+[smhd]$/.test(raw.trim()) ? (raw.trim() as Duration) : fallback;
}
