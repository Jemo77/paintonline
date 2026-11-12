'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { sessionsApi, tokenStore } from '@/lib/api';
import { useCanvasSync } from '@/hooks/useCanvasSync';
import { useCanvasStore } from '@/store/canvasStore';
import { CanvasStage, type CanvasStageHandle } from '@/components/canvas/CanvasStage';
import { LayerPanel } from '@/components/canvas/LayerPanel';
import { ExportButton } from '@/components/canvas/ExportButton';
import { StatusBadge, Toolbar } from '@/components/canvas/Toolbar';
import type { StrokePoint, Winner } from '@/types';
import { cn } from '@/lib/utils';

/**
 * Vista del participante: el canvas.
 *
 * Los tres modos comparten esta misma pantalla; lo que cambia es qué se pinta:
 *
 *   INDIVIDUAL → sólo su canvas privado
 *   LAYERED    → el combinado, con su capa asignada
 *   FREE       → el combinado, eligiendo capa
 *
 * El usuario puede abrir la sesión sin haber iniciado sesión (espectador);
 * en ese caso entra en modo sólo lectura.
 */
export default function SessionCanvasPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const stageRef = useRef<CanvasStageHandle>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [winners, setWinners] = useState<Winner[]>([]);
  const [closedBanner, setClosedBanner] = useState(false);

  const authed = Boolean(tokenStore.access);

  // El socket se abre siempre: sin token el gateway rechaza la conexión, así
  // que se espera a haberlo joined antes de intending.
  const { beginStroke, addPoint, endStroke, undo, redo, switchLayer } = useCanvasSync({
    sessionId,
    onSessionClosed: () => setClosedBanner(true),
    onError: (message) => setError(message),
  });

  const mode = useCanvasStore((s) => s.mode);
  const title = useCanvasStore((s) => s.title);
  const theme = useCanvasStore((s) => s.theme);
  const status = useCanvasStore((s) => s.status);
  const connected = useCanvasStore((s) => s.connected);
  const canDraw = useCanvasStore((s) => s.canDraw);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const canvasHeight = useCanvasStore((s) => s.canvasHeight);
  const undoStack = useCanvasStore((s) => s.undoStack);
  const redoStack = useCanvasStore((s) => s.redoStack);

  /**
   * `CanvasStage` entrega sólo los puntos; la configuración del pincel y la
   * capa activa salen del store en el momento de empezar el trazo, para que
   * un cambio de color a mitad de sesión aplique al trazo siguiente y no al
   * que ya se está dibujando.
   */
  const handleDrawStart = useCallback(
    (points: StrokePoint[]) => {
      const state = useCanvasStore.getState();
      beginStroke(points, {
        color: state.color,
        brushSize: state.brushSize,
        tool: state.tool,
        layerId: state.activeLayerId,
      });
    },
    [beginStroke],
  );

  // El canvas arranca vacío hasta que el socket responde. Antes de dibujar hay
  // que estar anotado a la sesión: es lo que asigna la capa en LAYERED.
  useEffect(() => {
    if (!authed) return;

    let cancelled = false;
    setJoining(true);

    sessionsApi
      .join(sessionId)
      .then((detail) => {
        if (!cancelled) setWinners(detail.winners);
      })
      .catch((err) => {
        // Un espectador sin membresía puede ver, pero no dibujar.
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No podés entrar a esta sesión');
        }
      })
      .finally(() => {
        if (!cancelled) setJoining(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, authed]);

  // Los ganadores los anuncia el servidor por socket al elegirse.
  useEffect(() => {
    if (status !== 'CLOSED' || winners.length > 0) return;
    sessionsApi
      .get(sessionId)
      .then((detail) => setWinners(detail.winners))
      .catch(() => undefined);
  }, [status, sessionId, winners.length]);

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">Necesitás una cuenta para dibujar</h1>
        <p className="text-sm text-muted">
          Podés mirar la sesión, pero para entrar al canvas necesitás iniciar sesión.
        </p>
        <div className="flex justify-center gap-2">
          <Link className="btn btn-primary" href="/login">
            Iniciar sesión
          </Link>
          <Link className="btn btn-secondary" href="/">
            Volver
          </Link>
        </div>
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
          <h1 className="text-base font-semibold">{title || 'Cargando…'}</h1>
          {theme ? <p className="text-xs text-muted">{theme}</p> : null}
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span
            className={cn('text-xs', connected ? 'text-success' : 'text-muted')}
            title={connected ? 'Conectado al servidor' : 'Reconectando…'}
          >
            ● {connected ? 'en vivo' : 'sin conexión'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ExportButton stageRef={stageRef} />
          <Link className="btn btn-secondary btn-sm" href="/spaces">
            Salir
          </Link>
        </div>
      </header>

      <Toolbar
        onUndo={undo}
        onRedo={redo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onLayerSwitch={switchLayer}
      />

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-3">
          {closedBanner || status === 'CLOSED' ? (
            <div
              className="card mb-2 flex flex-col gap-2 border-[var(--danger)]"
              role="status"
            >
              <p className="text-sm font-semibold">La sesión se cerró.</p>
              {winners.length > 0 ? (
                <ul className="flex flex-wrap gap-3 text-sm">
                  {winners.map((w) => (
                    <li key={w.id}>
                      {w.position === 1 ? '🥇' : w.position === 2 ? '🥈' : '🥉'}{' '}
                      {w.user.name} <span className="text-muted">({w.points} pts)</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">
                  El creador todavía no eligió ganadores.
                </p>
              )}
            </div>
          ) : null}

          {error ? <p className="mb-2 text-sm text-danger">{error}</p> : null}

          <div
            className="h-full w-full rounded-lg"
            style={{ backgroundColor: 'color-mix(in srgb, var(--foreground) 4%, transparent)' }}
          >
            <CanvasStage
              ref={stageRef}
              width={canvasWidth}
              height={canvasHeight}
              onDrawStart={handleDrawStart}
              onDrawMove={addPoint}
              onDrawEnd={endStroke}
            />
          </div>

          {joining ? <p className="mt-2 text-xs text-muted">Entrando a la sesión…</p> : null}
          {!canDraw && !joining ? (
            <p className="mt-2 text-xs text-muted">
              Estás mirando en modo sólo lectura. Unite a la sesión para dibujar.
            </p>
          ) : null}
          {mode === 'INDIVIDUAL' ? (
            <p className="mt-2 text-xs text-muted">
              Tu canvas es privado: el creador puede verlo en su monitor, pero los
              demás participantes no.
            </p>
          ) : null}
        </main>

        <LayerPanel stageRef={stageRef} onSelect={switchLayer} />
      </div>
    </div>
  );
}
