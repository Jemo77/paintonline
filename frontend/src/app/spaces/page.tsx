'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { spacesApi, tokenStore } from '@/lib/api';
import { useAuth } from '@/lib/useAuth';
import type { Space } from '@/types';

export default function SpacesPage() {
  const router = useRouter();
  const { loading: authLoading } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!tokenStore.access) {
      router.replace('/login');
      return;
    }
  }, [router, authLoading]);

  useEffect(() => {
    if (typeof window === 'undefined' || !tokenStore.access) return;

    let cancelled = false;
    spacesApi
      .list()
      .then((data) => {
        if (!cancelled) setSpaces(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo cargar');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const space = await spacesApi.create({ name: name.trim() });
      router.push(`/spaces/${space.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el espacio');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mis espacios</h1>
        <Link className="btn btn-secondary btn-sm" href="/">
          Inicio
        </Link>
      </header>

      <form className="card flex flex-col gap-3" onSubmit={handleCreate}>
        <h2 className="text-sm font-semibold">Crear un espacio</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder="Nombre del espacio"
            required
            minLength={2}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Creando…' : 'Crear'}
          </button>
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </form>

      {loading ? (
        <p className="text-muted">Cargando…</p>
      ) : spaces.length === 0 ? (
        <p className="text-muted">
          Todavía no tenés espacios. Creá el primero con el formulario de arriba.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {spaces.map((space) => (
            <li key={space.id} className="card flex flex-col gap-2">
              <Link className="text-lg font-semibold" href={`/spaces/${space.id}`}>
                {space.name}
              </Link>
              {space.description ? (
                <p className="text-sm text-muted">{space.description}</p>
              ) : null}
              <p className="text-xs text-muted">
                {space._count?.sessions ?? 0} sesiones ·{' '}
                {space._count?.members ?? 0} miembros
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
