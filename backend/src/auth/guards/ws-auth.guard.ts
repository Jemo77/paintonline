import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { TokenService } from '../token.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Autenticación para el gateway de WebSocket.
 *
 * El cliente manda el access token en el handshake:
 *   io(SOCKET_URL, { auth: { token: '<accessToken>' } })
 *
 * El mismo token que se usa en REST: una sola credencial, dos transportes.
 * Verificarlo en `handleConnection` (y no por evento) evita que un socket sin
 * token válido llegue a tocar la sala de ninguna sesión.
 */
@Injectable()
export class WsAuthGuard {
  constructor(private readonly tokenService: TokenService) {}

  /** Extrae el bearer del handshake: `auth.token` o `Authorization`. */
  static extractToken(handshake: {
    auth?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
  }): string | null {
    const fromAuth = handshake?.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) {
      return fromAuth.replace(/^Bearer\s+/i, '');
    }

    const header = handshake?.headers?.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw.replace(/^Bearer\s+/i, '');
    }

    return null;
  }

  async validate(handshake: {
    auth?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
  }): Promise<AuthUser> {
    const token = WsAuthGuard.extractToken(handshake);
    if (!token) {
      throw new UnauthorizedException('Falta el token en el handshake');
    }

    const payload = await this.tokenService.verifyAccessToken(token);

    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role as Role,
    };
  }

  /** Variante para usar como CanActivate si algún handler WS lo necesita. */
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
