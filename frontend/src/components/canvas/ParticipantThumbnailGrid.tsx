'use client';

import { useRef } from 'react';
import { CanvasStage, type CanvasStageHandle } from './CanvasStage';
import { useCanvasStore } from '@/store/canvasStore';
import { useParticipants } from '@/hooks/usePresence';
import { cn } from '@/lib/utils';

/**
 * Grid de miniaturas en vivo para el creador (modo INDIVIDUAL).
 *
 * Cada miniatura es un Stage de Konva propio, pintado con los trazos de un
 * único participante. Por eso el creador ve todos los canvas en simultáneo
 * aunque el backend nunca los mezcle: el aislamiento sigue siendo por usuario,
 * sólo cambia quién recibe el broadcast.
 *
 * Con muchos participantes el costo de N Stages es alto, así que se renderizan
 * sólo los que están visibles o dibujando.
 */
export function ParticipantThumbnailGrid({
  className,
  onExport,
  maxRendered = 12,
}: {
  className?: string;
  onExport?: (userId: string, stage: CanvasStageHandle) => void;
  /** Tope de miniaturas simultáneas para no saturar el navegador. */
  maxRendered?: number;
}) {
  const mode = useCanvasStore((s) => s.mode);
  const visibleUserIds = useCanvasStore((s) => s.visibleUserIds);
  const participants = useParticipants();
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const canvasHeight = useCanvasStore((s) => s.canvasHeight);
  const presence = useCanvasStore((s) => s.presence);

  const drawingUserIds = new Set(
    presence.filter((p) => p.drawing).map((p) => p.userId),
  );

  if (mode !== 'INDIVIDUAL') return null;

  // `visibleUserIds` viene del backend: para el creador es la lista completa
  // de participantes. Si por algún motivo no llegó, se cae a los anotados.
  const userIds = visibleUserIds ?? participants.map((p) => p.userId);
  const byUserId = new Map(participants.map((p) => [p.userId, p]));

  // Prioriza a quien está dibujando: si hay tope, ése se cuela siempre.
  const ordered = [...userIds].sort((a, b) => {
    const da = drawingUserIds.has(a) ? 1 : 0;
    const db = drawingUserIds.has(b) ? 1 : 0;
    return db - da;
  });

  const rendered = ordered.slice(0, maxRendered);
  const hidden = ordered.length - rendered.length;

  if (userIds.length === 0) {
    return (
      <p className="text-sm text-muted" style={{ padding: '1rem' }}>
        Todavía no se anotó nadie a esta sesión.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rendered.map((userId) => (
          <Thumbnail
            key={userId}
            userId={userId}
            name={byUserId.get(userId)?.user.name ?? 'Participante'}
            isDrawing={drawingUserIds.has(userId)}
            isOnline={byUserId.get(userId)?.isOnline ?? false}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            onExport={onExport}
          />
        ))}
      </div>

      {hidden > 0 ? (
        <p className="text-xs text-muted">
          {hidden} participante{hidden === 1 ? '' : 's'} más no se muestra
          {hidden === 1 ? '' : 'n'} para no saturar el navegador.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Una miniatura.
 *
 * Va en su propio componente a propósito: necesita un `useRef` para su Stage, y
 * un hook dentro del `.map()` del grid rompe las Rules of Hooks. La cantidad
 * de hooks de un render tiene que ser siempre la misma, pero acá cambia cada
 * vez que alguien entra o sale de la sesión: React lanzaba "Rendered more
 * hooks than during the previous render" y caía el monitor completo en el
 * momento exacto en que se sumaba un participante.
 *
 * Con un componente por miniatura, React los reconcilia por `key` y cada uno
 * conserva su propio Stage.
 */
function Thumbnail({
  userId,
  name,
  isDrawing,
  isOnline,
  canvasWidth,
  canvasHeight,
  onExport,
}: {
  userId: string;
  name: string;
  isDrawing: boolean;
  isOnline: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onExport?: (userId: string, stage: CanvasStageHandle) => void;
}) {
  const stageRef = useRef<CanvasStageHandle>(null);

  return (
    <figure
      className="card flex flex-col gap-1 p-2"
      style={isDrawing ? { borderColor: 'var(--primary)' } : undefined}
    >
      <figcaption className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">{name}</span>
        <span className="flex items-center gap-1">
          {isDrawing ? (
            <span className="text-[var(--primary)]">dibujando</span>
          ) : isOnline ? (
            <span className="text-success">en línea</span>
          ) : (
            <span className="text-muted">ausente</span>
          )}
          {onExport ? (
            <ExportThumbnailButton userId={userId} stageRef={stageRef} onExport={onExport} />
          ) : null}
        </span>
      </figcaption>

      <div className="aspect-video w-full overflow-hidden rounded">
        <CanvasStage
          ref={stageRef}
          width={canvasWidth}
          height={canvasHeight}
          targetUserId={userId}
          lockOthers
          showBackground
        />
      </div>
    </figure>
  );
}

/**
 * Botón de descarga de una miniatura.
 *
 * Va en su propio componente a propósito: usar un hook dentro del `.map()`
 * rompe las reglas de hooks, porque el número de iteraciones cambia cuando
 * alguien entra o sale de la sesión.
 */
function ExportThumbnailButton({
  userId,
  stageRef,
  onExport,
}: {
  userId: string;
  stageRef: React.RefObject<CanvasStageHandle | null>;
  onExport: (userId: string, stage: CanvasStageHandle) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => {
        if (stageRef.current) onExport(userId, stageRef.current);
      }}
      title="Descargar el canvas de este participante"
    >
      ↓
    </button>
  );
}
