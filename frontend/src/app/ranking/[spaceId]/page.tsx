'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { rankingApi, spacesApi, tokenStore } from '@/lib/api';
import { RankingTable, ScoreSummary } from '@/components/ranking/RankingTable';
import { cn } from '@/lib/utils';
import type { RankingResponse, Space, UserScore } from '@/types';

const PAGE_SIZE = 25;

/**
 * Ranking de un espacio. El caché vive en Redis del lado del servidor, así
 * que esta vista es sólo un `GET`: paginar no toca la base.
 */
export default function RankingPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params.spaceId;

  const [scope, setScope] = useState<'space' | 'global'>('space');
  const [space, setSpace] = useState<Space | null>(null);
  const [data, setData] = useState<RankingResponse | null>(null);
  const [score, setScore] = useState<UserScore | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const authed = Boolean(tokenStore.access);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    spacesApi
      .get(spaceId)
      .then((s) => !cancelled && setSpace(s))
      .catch(() => {
        // El nombre del espacio es cosmético: si falla, seguimos igual.
      });

    return () => {
      cancelled = true;
    };
  }, [spaceId, authed]);

  const load = useCallback(() => {
    if (!authed) return;
    setLoading(true);
    setError(null);

    const request =
      scope === 'space'
        ? rankingApi.forSpace(spaceId, page, PAGE_SIZE)
        : rankingApi.global(spaceId, page, PAGE_SIZE);

    request
      .then((res) => {
        setData(res);
        setTotalPages(Math.max(1, Math.ceil(res.total / res.pageSize)));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'No se pudo cargar el ranking');
      })
      .finally(() => setLoading(false));
  }, [authed, scope, spaceId, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    rankingApi
      .me()
      .then((s) => !cancelled && setScore(s))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [authed]);

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">Necesitás iniciar sesión</h1>
        <p className="text-sm text-muted">El ranking sólo se muestra a miembros del espacio.</p>
        <Link className="btn btn-primary mx-auto" href="/login">
          Iniciar sesión
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link className="text-sm text-muted" href={`/spaces/${spaceId}`}>
            ← {space?.name ?? 'Espacio'}
          </Link>
          <h1 className="text-2xl font-bold">Ranking</h1>
          {data?.cached ? (
            <p className="text-xs text-muted">Servido desde caché</p>
          ) : null}
        </div>

        <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--surface)' }}>
          <ScopeButton active={scope === 'space'} onClick={() => setScope('space')}>
            Del espacio
          </ScopeButton>
          <ScopeButton active={scope === 'global'} onClick={() => setScope('global')}>
            Global
          </ScopeButton>
        </div>
      </header>

      <ScoreSummary score={score} />

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : (
        <section className="card overflow-x-auto">
          <RankingTable
            entries={data?.entries ?? []}
            loading={loading}
            highlightUserId={score?.userId ?? null}
          />
        </section>
      )}

      {data && data.total > data.pageSize ? (
        <nav className="flex items-center justify-between">
          <button
            className="btn btn-secondary btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Anterior
          </button>
          <span className="mono text-xs text-muted">
            página {data.page} de {totalPages}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Siguiente →
          </button>
        </nav>
      ) : null}
    </main>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors')}
      style={{
        backgroundColor: active ? 'var(--primary)' : 'transparent',
        color: active ? '#fff' : 'var(--muted)',
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
