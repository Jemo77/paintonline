'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { sessionsApi, tokenStore } from '@/lib/api';
import { useCanvasSync } from '@/hooks/useCanvasSync';
import { useCanvasStore } from '@/store/canvasStore';
import { CanvasStage, type CanvasStageHandle } from '@/components/canvas/CanvasStage';
import { ParticipantThumbnailGrid } from '@/components/canvas/ParticipantThumbnailGrid';
import { LayerPanel } from '@/components/canvas/LayerPanel';
import { ExportButton } from '@/components/canvas/ExportButton';
import { StatusBadge } from '@/components/canvas/Toolbar';
import { WinnerPicker } from '@/components/ranking/WinnerPicker';
import { downloadStage, sanitize } from '@/utils/exportCanvas';
import type { SessionDetail } from '@/types';
import { cn } from '@/lib/utils';

/**
 * Vista del creador: monitorear y dirigir la sesión.
 *
 *   INDIVIDUAL → grid de miniaturas en vivo, una por participante. El creador
 *                está suscrito a todos los userId, así que ve todos los canvas
 *                en simultáneo aunque el backend nunca los mezcle.
 *   LAYERED / FREE → el canvas combinado, como cualquier participante pero
 *                    sin dibujar, más los controles de ciclo de vida.
 */
export default function MonitorPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const stageRef = useRef<CanvasStageHandle>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authed = Boolean(tokenStore.access);

  // El creador también entra al socket: en INDIVIDUAL es lo que lo pone en la
  // sala :watch desde donde llegan los trazos de todos.
  useCanvasSync({ sessionId, readOnly: true, onError: setError });

  const mode = useCanvasStore((s) => s.mode);
  const title = useCanvasStore((s) => s.title);
  const status = useCanvasStore((s) => s.status);
  const connected = useCanvasStore((s) => s.connected);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const canvasHeight = useCanvasStore((s) => s.canvasHeight);
  const presence = useCanvasStore((s) => s.presence);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    sessionsApi
      .get(sessionId)
      .then((detail) => {
        if (!cancelled) setSession(detail);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo cargar');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, authed]);

  async function changeStatus(next: string) {
    setBusy(true);
    try {
      const updated = await sessionsApi.update(sessionId, { status: next as never });
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el estado');
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">Necesitás iniciar sesión</h1>
        <Link className="btn btn-primary mx-auto" href="/login">
          Iniciar sesión
        </Link>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header
        className="flex flex-wrap items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex flex-col">
          <h1 className="text-base font-semibold">{title || 'Monitor'}</h1>
          <p className="text-xs text-muted">
            {mode === 'INDIVIDUAL'
              ? 'Viendo el canvas de cada participante'
              : 'Viendo el canvas combinado'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span className={cn('text-xs', connected ? 'text-success' : 'text-muted')}>
            ● {connected ? 'en vivo' : 'sin conexión'}
          </span>
          <span className="text-xs text-muted">{presence.length} en línea</span>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {session?.status === 'DRAFT' ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => changeStatus('OPEN')}>
              Abrir sesión
            </button>
          ) : null}
          {session?.status === 'OPEN' ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => changeStatus('LIVE')}>
              Iniciar
            </button>
          ) : null}
          {session?.status === 'LIVE' ? (
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => changeStatus('CLOSED')}>
              Cerrar y elegir ganadores
            </button>
          ) : null}

          {mode === 'INDIVIDUAL' ? (
            <span className="text-xs text-muted">
              Descargá el PNG de cada miniatura con su botón ↓
            </span>
          ) : (
            <ExportButton stageRef={stageRef} scope={mode === 'FREE' ? 'combined' : 'layers'} />
          )}

          {session ? (
            <Link
              className="btn btn-secondary btn-sm"
              href={`/spaces/${session.spaceId}`}
            >
              Volver
            </Link>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="px-4 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto p-3">
          {mode === 'INDIVIDUAL' ? (
            <ParticipantThumbnailGrid
              onExport={(userId, handle) => {
                // El Stage de la miniatura ya tiene sólo los trazos de ese
                // participante, así que descargarlo es local.
                const stage = handle.getStage();
                if (!stage) return;
                const name =
                  session?.participants.find((p) => p.userId === userId)?.user.name ??
                  userId;
                downloadStage(stage, {
                  fileName: sanitize(name),
                  pixelRatio: 2,
                  backgroundColor: '#ffffff',
                });
              }}
            />
          ) : (
            <div
              className="h-full w-full rounded-lg"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--foreground) 4%, transparent)',
              }}
            >
              <CanvasStage
                ref={stageRef}
                width={canvasWidth}
                height={canvasHeight}
                lockOthers
              />
            </div>
          )}

          {session?.status === 'CLOSED' ? (
            <div className="mt-4">
              {session.mode === 'FREE' ? (
                <p className="text-sm text-muted">
                  El modo libre queda fuera del sistema de premiación.
                </p>
              ) : (
                <WinnerPicker sessionId={sessionId} />
              )}
            </div>
          ) : null}
        </main>

        {mode !== 'INDIVIDUAL' ? <LayerPanel stageRef={stageRef} /> : null}
      </div>
    </div>
  );
}
