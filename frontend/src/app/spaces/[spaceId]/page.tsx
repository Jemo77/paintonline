'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { rankingApi, sessionsApi, spacesApi, tokenStore } from '@/lib/api';
import { StatusBadge } from '@/components/canvas/Toolbar';
import { WinnerPicker } from '@/components/ranking/WinnerPicker';
import { InviteLink } from '@/components/spaces/InviteLink';
import { useAuth } from '@/lib/useAuth';
import type { RankingResponse, SessionDetail, Space } from '@/types';

export default function SpaceDetailPage() {
  const params = useParams<{ spaceId: string }>();
  const router = useRouter();
  const spaceId = params.spaceId;
  const { user } = useAuth();

  const [space, setSpace] = useState<Space | null>(null);
  const [sessions, setSessions] = useState<SessionDetail[]>([]);
  const [ranking, setRanking] = useState<RankingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!tokenStore.access) {
      router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    if (typeof window === 'undefined' || !tokenStore.access) return;

    let cancelled = false;

    async function load() {
      try {
        const [spaceData, sessionData] = await Promise.all([
          spacesApi.get(spaceId),
          sessionsApi.list(spaceId),
        ]);
        if (cancelled) return;
        setSpace(spaceData);
        setSessions(sessionData);

        if (spaceData.owner?.id) {
          rankingApi
            .forSpace(spaceId, 1, 10)
            .then((r) => !cancelled && setRanking(r))
            .catch(() => undefined);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el espacio');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  // Sólo el creador del espacio administra sesiones y reparte premios.
  const isSpaceOwner = Boolean(user && space && space.ownerId === user.id);

  async function handleStatusChange(sessionId: string, status: string) {
    await sessionsApi.update(sessionId, { status: status as never });
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, status: status as never } : s)));
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <p className="text-muted">Cargando…</p>
      </main>
    );
  }

  if (error || !space) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-12">
        <p className="text-danger">{error ?? 'Espacio no encontrado'}</p>
        <Link className="btn btn-secondary w-fit" href="/spaces">
          Volver
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link className="text-sm text-muted" href="/spaces">
            ← Espacios
          </Link>
          <h1 className="text-2xl font-bold">{space.name}</h1>
          {space.description ? (
            <p className="text-sm text-muted">{space.description}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-secondary btn-sm" href={`/ranking/${space.id}`}>
            Ranking
          </Link>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowNew((v) => !v)}
            title="Crear una sesión nueva"
          >
            + Nueva sesión
          </button>
        </div>
      </header>

      <InviteLink slug={space.slug} />

      {showNew ? (
        <NewSessionForm
          spaceId={space.id}
          onCreated={(session) => {
            setShowNew(false);
            setSessions((prev) => [session, ...prev]);
          }}
        />
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Sesiones
        </h2>

        {sessions.length === 0 ? (
          <p className="text-muted">Este espacio todavía no tiene sesiones.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {sessions.map((session) => (
              <li key={session.id} className="card flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold">{session.title}</h3>
                      <StatusBadge status={session.status} />
                      <ModeBadge mode={session.mode} />
                    </div>
                    {session.theme ? (
                      <p className="text-sm text-muted">Tema: {session.theme}</p>
                    ) : null}
                    <p className="text-xs text-muted">
                      {session._count?.participants ?? 0} participantes ·{' '}
                      {session._count?.strokes ?? 0} trazos
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {isSpaceOwner ? (
                      <>
                        {session.status === 'DRAFT' ? (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleStatusChange(session.id, 'OPEN')}
                          >
                            Abrir
                          </button>
                        ) : null}
                        {session.status === 'OPEN' ? (
                          <>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleStatusChange(session.id, 'LIVE')}
                            >
                              Iniciar
                            </button>
                            <Link
                              className="btn btn-secondary btn-sm"
                              href={`/spaces/${space.id}/sessions/${session.id}/monitor`}
                            >
                              Monitorear
                            </Link>
                          </>
                        ) : null}
                        {session.status === 'LIVE' ? (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleStatusChange(session.id, 'CLOSED')}
                          >
                            Cerrar
                          </button>
                        ) : null}
                      </>
                    ) : null}

                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/s/${session.id}`}
                      title={
                        session.status === 'OPEN' || session.status === 'LIVE'
                          ? 'Entrar a dibujar'
                          : 'Ver el resultado'
                      }
                    >
                      {session.status === 'OPEN' || session.status === 'LIVE'
                        ? 'Entrar'
                        : 'Ver'}
                    </Link>
                  </div>
                </div>

                {/* El creador elige los 3 ganadores al cerrar una sesión
                    premiable. En modo FREE no hay premiación. */}
                {isSpaceOwner && session.status === 'CLOSED' ? (
                  session.mode === 'FREE' ? (
                    <p className="text-xs text-muted">
                      El modo libre no participa del sistema de premios.
                    </p>
                  ) : (
                    <WinnerPicker sessionId={session.id} />
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ranking ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Ranking del espacio
          </h2>
          <p className="text-sm text-muted">
            {ranking.entries.length === 0
              ? 'Todavía no hay puntos repartidos.'
              : `${ranking.entries[0].user.name} lidera con ${ranking.entries[0].totalPoints} puntos.`}
          </p>
        </section>
      ) : null}
    </main>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const label =
    mode === 'INDIVIDUAL' ? 'individual' : mode === 'LAYERED' ? 'por capas' : 'libre';
  return <span className="badge">{label}</span>;
}

function NewSessionForm({
  spaceId,
  onCreated,
}: {
  spaceId: string;
  onCreated: (session: SessionDetail) => void;
}) {
  const [title, setTitle] = useState('');
  const [theme, setTheme] = useState('');
  const [mode, setMode] = useState<'INDIVIDUAL' | 'LAYERED' | 'FREE'>('INDIVIDUAL');
  const [layerCount, setLayerCount] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await sessionsApi.create(spaceId, {
        title: title.trim(),
        theme: theme.trim() || undefined,
        mode,
        ...(mode === 'INDIVIDUAL' ? {} : { layerCount }),
      });
      setTitle('');
      setTheme('');
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la sesión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card flex flex-col gap-3" onSubmit={handleSubmit}>
      <h2 className="text-sm font-semibold">Nueva sesión</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="title">
            Título
          </label>
          <input
            id="title"
            className="input"
            required
            minLength={2}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="theme">
            Tema (opcional)
          </label>
          <input
            id="theme"
            className="input"
            placeholder="Ej: un paisaje de montaña"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="label">Modo de sesión</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ['INDIVIDUAL', 'Individual', 'Canvas privado por persona. El creador ve todos en un grid.'],
              ['LAYERED', 'Por capas', 'Un canvas compartido, cada quien con su capa.'],
              ['FREE', 'Libre', 'Capas compartidas, cualquiera dibuja donde quiere.'],
            ] as const
          ).map(([value, label, help]) => (
            <label
              key={value}
              className="card flex cursor-pointer flex-col gap-1 p-3"
              style={mode === value ? { borderColor: 'var(--primary)' } : undefined}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {label}
              </span>
              <span className="text-xs text-muted">{help}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode !== 'INDIVIDUAL' ? (
        <div>
          <label className="label" htmlFor="layers">
            {mode === 'LAYERED' ? 'Capas (una por participante)' : 'Capas iniciales'}
          </label>
          <input
            id="layers"
            className="input"
            type="number"
            min={1}
            max={24}
            value={layerCount}
            onChange={(e) => setLayerCount(Number(e.target.value))}
          />
          <p className="mt-1 text-xs text-muted">
            {mode === 'LAYERED'
              ? 'Cada participante que entra toma una capa libre. Si se llenan, no entran más.'
              : 'Las capas se comparten y cualquiera puede dibujar en cualquiera.'}
          </p>
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <button className="btn btn-primary w-fit" type="submit" disabled={busy}>
        {busy ? 'Creando…' : 'Crear sesión'}
      </button>
    </form>
  );
}
