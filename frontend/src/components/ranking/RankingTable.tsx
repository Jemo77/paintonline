'use client';

import type { RankingEntry } from '@/types';
import { cn } from '@/lib/utils';

/**
 * Tabla de ranking. Se usa tanto para el global como para el de un espacio: lo
 * que cambia es el `space` opcional y el título.
 */
export function RankingTable({
  entries,
  loading,
  highlightUserId,
  className,
}: {
  entries: RankingEntry[];
  loading?: boolean;
  /** Resalta al usuario actual (para ubicarse en la tabla). */
  highlightUserId?: string | null;
  className?: string;
}) {
  if (loading) {
    return <p className="text-sm text-muted">Cargando ranking…</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted">
        Todavía no hay puntos repartidos. Cuando el creador elija ganadores, van a
        aparecer acá.
      </p>
    );
  }

  return (
    <table className={cn('w-full border-collapse text-sm', className)}>
      <thead>
        <tr className="border-b text-left" style={{ borderColor: 'var(--border)' }}>
          <th className="py-2 pr-2 font-medium text-muted">#</th>
          <th className="py-2 pr-2 font-medium text-muted">Persona</th>
          <th className="py-2 pr-2 text-right font-medium text-muted">Oro</th>
          <th className="py-2 pr-2 text-right font-medium text-muted">Plata</th>
          <th className="py-2 pr-2 text-right font-medium text-muted">Bronce</th>
          <th className="py-2 text-right font-medium text-muted">Puntos</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr
            key={entry.user.id}
            className="border-b"
            style={{
              borderColor: 'var(--border)',
              backgroundColor:
                entry.user.id === highlightUserId
                  ? 'color-mix(in srgb, var(--primary) 12%, transparent)'
                  : undefined,
            }}
          >
            <td className="mono py-2 pr-2">
              <Medal position={entry.position} />
            </td>
            <td className="py-2 pr-2 font-medium">
              {entry.user.name}
              {!entry.isMember ? (
                <span className="ml-2 text-xs text-muted">fuera del espacio</span>
              ) : null}
            </td>
            <td className="mono py-2 pr-2 text-right">{entry.goldCount}</td>
            <td className="mono py-2 pr-2 text-right">{entry.silverCount}</td>
            <td className="mono py-2 pr-2 text-right">{entry.bronzeCount}</td>
            <td className="mono py-2 text-right font-semibold">{entry.totalPoints}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Medal({ position }: { position: number }) {
  if (position === 1) return <span title="1º puesto">🥇</span>;
  if (position === 2) return <span title="2º puesto">🥈</span>;
  if (position === 3) return <span title="3º puesto">🥉</span>;
  return <span className="text-muted">{position}</span>;
}

/** Resumen de puntos del usuario actual. */
export function ScoreSummary({
  score,
}: {
  score: { totalPoints: number; goldCount: number; silverCount: number; bronzeCount: number } | null;
}) {
  if (!score) return null;

  return (
    <div className="card flex flex-wrap items-center gap-6">
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted">Puntos</span>
        <span className="mono text-2xl font-bold">{score.totalPoints}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted">Oros</span>
        <span className="mono text-xl font-semibold">{score.goldCount}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted">Platas</span>
        <span className="mono text-xl font-semibold">{score.silverCount}</span>
      </div>
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted">Bronces</span>
        <span className="mono text-xl font-semibold">{score.bronzeCount}</span>
      </div>
    </div>
  );
}
