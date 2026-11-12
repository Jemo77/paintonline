'use client';

import { useEffect, useState } from 'react';
import { sessionsApi } from '@/lib/api';
import { downloadStage, sanitize } from '@/utils/exportCanvas';
import type { CanvasStageHandle } from '@/components/canvas/CanvasStage';
import type { Participant, Winner } from '@/types';

const POSITIONS = [1, 2, 3] as const;

/**
 * Selector de ganadores.
 *
 * Se muestra al creador cuando la sesión está cerrada. Envía los tres puestos
 * al backend, que reparte los puntos según la configuración del espacio y
 * actualiza el `UserScore` de cada ganador.
 */
export function WinnerPicker({ sessionId }: { sessionId: string }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [current, setCurrent] = useState<Winner[]>([]);
  const [selection, setSelection] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      sessionsApi.participants(sessionId),
      fetchCurrentWinners(sessionId).catch(() => [] as Winner[]),
    ])
      .then(([p, w]) => {
        if (cancelled) return;
        setParticipants(p);
        setCurrent(w);
        const preset: Record<number, string> = {};
        for (const winner of w) preset[winner.position] = winner.userId;
        setSelection(preset);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo cargar');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function handleSave() {
    const winners = POSITIONS.filter((p) => selection[p]).map((position) => ({
      position,
      userId: selection[position],
    }));

    if (winners.length === 0) {
      setError('Elegí al menos un ganador');
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await sessionsApi.setWinners(sessionId, winners, true);
      setCurrent(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron guardar los ganadores');
    } finally {
      setBusy(false);
    }
  }

  if (participants.length === 0) {
    return (
      <p className="text-xs text-muted">
        No hay participantes en esta sesión, así que no hay ganador posible.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <h4 className="text-sm font-semibold">Ganadores</h4>

      <div className="grid gap-2 sm:grid-cols-3">
        {POSITIONS.map((position) => (
          <div key={position} className="flex flex-col gap-1">
            <label className="label" htmlFor={`winner-${position}`}>
              {position}º puesto
            </label>
            <select
              id={`winner-${position}`}
              className="input"
              value={selection[position] ?? ''}
              onChange={(e) =>
                setSelection((prev) => ({ ...prev, [position]: e.target.value }))
              }
            >
              <option value="">— sin elegir —</option>
              {participants.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.user.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {current.length > 0 ? (
        <p className="text-xs text-muted">
          Premiación actual:{' '}
          {current
            .sort((a, b) => a.position - b.position)
            .map((w) => `${w.position}º ${w.user.name} (${w.points} pts)`)
            .join(' · ')}
        </p>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {saved ? <p className="text-xs text-success">Ganadores guardados y ranking actualizado.</p> : null}

      <button className="btn btn-primary btn-sm w-fit" onClick={handleSave} disabled={busy}>
        {busy ? 'Guardando…' : 'Guardar ganadores'}
      </button>
    </div>
  );
}

async function fetchCurrentWinners(sessionId: string): Promise<Winner[]> {
  const { sessionsApi: api } = await import('@/lib/api');
  const detail = await api.get(sessionId);
  return detail.winners;
}

/**
 * Botón que descarga un canvas de participante concreto desde el grid del
 * creador. El Stage ya está renderizado: `toDataURL` no toca el servidor.
 */
export function ExportParticipantButton({
  userId,
  stageRef,
  name,
}: {
  userId: string;
  stageRef: React.RefObject<CanvasStageHandle | null>;
  name: string;
}) {
  function handleClick() {
    const stage = stageRef.current?.getStage();
    if (!stage) return;
    downloadStage(stage, {
      fileName: sanitize(name),
      pixelRatio: 2,
      backgroundColor: '#ffffff',
    });
  }

  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={handleClick}
      title={`Descargar el canvas de ${name} (se genera en tu navegador)`}
      data-user-id={userId}
    >
      ↓ PNG
    </button>
  );
}
