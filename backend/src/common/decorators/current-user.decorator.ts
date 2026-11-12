import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca un endpoint como accesible sin token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Inyecta el usuario autenticado (o una de sus propiedades) en un handler REST. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthUser | undefined;
    return data ? user?.[data] : user;
  },
);
