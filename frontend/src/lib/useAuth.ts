'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, setUnauthorizedHandler, tokenStore } from '@/lib/api';
import type { User } from '@/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    name: string;
    spaceSlug?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

let cachedUser: User | null = null;
const listeners = new Set<(user: User | null) => void>();

function emit(user: User | null): void {
  cachedUser = user;
  listeners.forEach((fn) => fn(user));
}

function getUser(): User | null {
  return cachedUser;
}

/**
 * Auth sobre JWT propio (access + refresh), guardada en localStorage.
 *
 * El mismo access token que se manda por REST se pasa al handshake de
 * WebSocket, así que hay una sola credencial que revocar en el logout.
 */
export function useAuth() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(getUser());
  const [loading, setLoading] = useState(!cachedUser && Boolean(tokenStore.access));

  useEffect(() => {
    const listener = (next: User | null) => setUser(next);
    listeners.add(listener);

    // Si expiró el refresh durante una request, la API limpia los tokens.
    setUnauthorizedHandler(() => emit(null));

    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (cachedUser || !tokenStore.access) return;

    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (!cancelled) emit(me);
      })
      .catch(() => {
        tokenStore.clear();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await authApi.login(email, password);
      tokenStore.set(result.accessToken, result.refreshToken);
      emit(result.user);
    },
    [],
  );

  const register = useCallback(
    async (input: { email: string; password: string; name: string; spaceSlug?: string }) => {
      const result = await authApi.register(input);
      tokenStore.set(result.accessToken, result.refreshToken);
      emit(result.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Si el logout remoto falla, igual se limpian los tokens locales.
    }
    tokenStore.clear();
    emit(null);
    router.push('/');
  }, [router]);

  return { user, loading, login, register, logout };
}
