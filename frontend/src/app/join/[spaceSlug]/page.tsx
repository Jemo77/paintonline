'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { spacesApi, tokenStore } from '@/lib/api';
import type { Space } from '@/types';
import { cn } from '@/lib/utils';

/**
 * Registro/ingreso del espectador a un espacio.
 *
 * Es la puerta de entrada pública: con el slug alcanza. Si ya hay sesión
 * iniciada, se une al espacio solo y lo lista con sus sesiones abiertas.
 */
export default function JoinSpacePage() {
  const params = useParams<{ spaceSlug: string }>();
  const router = useRouter();
  const slug = params.spaceSlug;

  const [space, setSpace] = useState<Space | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    spacesApi
      .publicBySlug(slug)
      .then((data) => {
        if (!cancelled) setSpace(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Espacio no encontrado');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Si el usuario ya está autenticado, lo sumamos al espacio y lo mandamos al
  // dashboard: es el camino con menos pasos.
  useEffect(() => {
    if (!space || !tokenStore.access) return;

    let cancelled = false;
    spacesApi
      .join(space.id)
      .then(() => {
        if (!cancelled) router.replace(`/spaces/${space.id}`);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [space, router]);

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">No encontramos ese espacio</h1>
        <p className="text-sm text-muted">{error}</p>
        <Link className="btn btn-secondary" href="/">
          Volver al inicio
        </Link>
      </main>
    );
  }

  if (!space) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-6">
        <p className="text-muted">Cargando espacio…</p>
      </main>
    );
  }

  const sessions = space.sessions ?? [];

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted">
          Espacio de <span className="font-medium">{space.owner?.name}</span>
        </p>
        <h1 className="text-2xl font-bold">{space.name}</h1>
        {space.description ? (
          <p className="text-sm text-muted">{space.description}</p>
        ) : null}
      </header>

      <section className="card flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Sesiones abiertas</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted">
            Todavía no hay ninguna sesión abierta. Volvé en un rato.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{session.title}</span>
                <ModeBadge mode={session.mode} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-2">
        {tokenStore.access ? (
          <button
            className="btn btn-primary"
            disabled={joining}
            onClick={() => {
              setJoining(true);
              spacesApi
                .join(space.id)
                .then(() => router.push(`/spaces/${space.id}`))
                .catch(() => setJoining(false));
            }}
          >
            {joining ? 'Entrando…' : 'Entrar al espacio'}
          </button>
        ) : (
          <>
            <Link className="btn btn-primary" href={`/register?space=${space.slug}`}>
              Crear cuenta para participar
            </Link>
            <Link
              className="btn btn-secondary"
              href={`/login?next=${encodeURIComponent(`/spaces/${space.id}`)}`}
            >
              Ya tengo cuenta
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const label =
    mode === 'INDIVIDUAL' ? 'individual' : mode === 'LAYERED' ? 'por capas' : 'libre';
  return (
    <span className={cn('badge shrink-0', mode === 'FREE' && 'opacity-60')}>{label}</span>
  );
}
