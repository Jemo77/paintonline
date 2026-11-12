'use client';

import { useState } from 'react';
import type { CanvasStageHandle } from './CanvasStage';
import { ExportLayerButton } from './ExportButton';
import { sessionsApi } from '@/lib/api';
import { useCanvasStore } from '@/store/canvasStore';
import { cn } from '@/lib/utils';

/**
 * Panel de capas. Sólo tiene sentido en LAYERED y FREE:
 *
 *  LAYERED → las capas ya están asignadas; el panel muestra cuál es la tuya y
 *             el resto aparece bloqueado.
 *  FREE    → el usuario elige en qué capa dibuja. El candado avisa que otra
 *             persona la está usando en este momento.
 */
export function LayerPanel({
  stageRef,
  className,
  onSelect,
}: {
  stageRef?: React.RefObject<CanvasStageHandle | null>;
  className?: string;
  onSelect?: (layerId: string) => void;
}) {
  const mode = useCanvasStore((s) => s.mode);
  const layers = useCanvasStore((s) => s.layers);
  const activeLayerId = useCanvasStore((s) => s.activeLayerId);
  const assignedLayerId = useCanvasStore((s) => s.assignedLayerId);
  const locks = useCanvasStore((s) => s.locks);
  const isSpaceOwner = useCanvasStore((s) => s.isSpaceOwner);
  const sessionId = useCanvasStore((s) => s.sessionId);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (mode === 'INDIVIDUAL') return null;

  async function toggleVisible(layerId: string, visible: boolean) {
    if (!sessionId) return;
    setBusyId(layerId);
    try {
      await sessionsApi.updateLayer(sessionId, layerId, { visible });
    } catch {
      // El error se refleja en el refetch; acá sólo se evita el estado colgado.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside
      className={cn('flex w-full flex-col gap-2 p-3 md:w-56', className)}
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Capas</h3>
        {mode === 'LAYERED' ? (
          <span className="text-[11px] text-muted">asignadas</span>
        ) : (
          <span className="text-[11px] text-muted">libres</span>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {layers.map((layer) => {
          const lock = locks[layer.id];
          const isMine = layer.id === assignedLayerId;
          const isActive = layer.id === activeLayerId;
          const heldByOther = lock && lock.userId !== assignedLayerId;

          return (
            <li key={layer.id}>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
                  isActive && 'border-[var(--primary)]',
                  !layer.visible && 'opacity-50',
                )}
                style={{ borderColor: isActive ? 'var(--primary)' : 'var(--border)' }}
              >
                <button
                  type="button"
                  className="flex flex-1 items-center gap-1.5 text-left"
                  onClick={() => onSelect?.(layer.id)}
                  disabled={mode === 'LAYERED' && !isMine}
                  title={
                    mode === 'LAYERED'
                      ? isMine
                        ? 'Tu capa'
                        : 'Capa de otro participante'
                      : 'Seleccionar capa'
                  }
                >
                  <span aria-hidden>
                    {mode === 'LAYERED' ? (isMine ? '🔓' : '🔒') : '🖌'}
                  </span>
                  <span className="truncate">{layer.name}</span>
                </button>

                {heldByOther ? (
                  <span className="text-[10px] text-muted" title={lock?.name}>
                    {lock?.name?.split(' ')[0]}
                  </span>
                ) : null}

                {stageRef && isSpaceOwner ? (
                  <ExportLayerButton
                    stageRef={stageRef}
                    layerId={layer.id}
                    layerName={layer.name}
                  />
                ) : null}

                {isSpaceOwner ? (
                  <button
                    type="button"
                    className="text-xs"
                    onClick={() => toggleVisible(layer.id, !layer.visible)}
                    disabled={busyId === layer.id}
                    title={layer.visible ? 'Ocultar' : 'Mostrar'}
                  >
                    {layer.visible ? '👁' : '🚫'}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-1 text-[11px] leading-snug text-muted">
        {mode === 'LAYERED'
          ? 'Cada participante dibuja en su capa asignada. Todos ven el combinado en vivo.'
          : 'Elegí la capa en la que vas a dibujar. El candado avisa si alguien la está usando.'}
      </p>
    </aside>
  );
}
