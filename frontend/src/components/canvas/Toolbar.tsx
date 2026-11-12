'use client';

import { useCanvasStore } from '@/store/canvasStore';
import { usePresence, type ParticipantWithPresence } from '@/hooks/usePresence';
import { cn } from '@/lib/utils';
import type { SessionStatus, Tool } from '@/types';

const COLORS = [
  '#111827',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ffffff',
];

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'pen', label: 'Lápiz', hint: 'Trazo libre' },
  { id: 'marker', label: 'Marcador', hint: 'Trazo grueso translúcido' },
  { id: 'eraser', label: 'Borrador', hint: 'Borra de verdad (no pinta blanco)' },
];

const SIZES = [2, 4, 6, 10, 16, 28];

export function Toolbar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onLayerSwitch,
  className,
}: {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onLayerSwitch?: (layerId: string) => void;
  className?: string;
}) {
  const tool = useCanvasStore((s) => s.tool);
  const color = useCanvasStore((s) => s.color);
  const brushSize = useCanvasStore((s) => s.brushSize);
  const setTool = useCanvasStore((s) => s.setTool);
  const setColor = useCanvasStore((s) => s.setColor);
  const setBrushSize = useCanvasStore((s) => s.setBrushSize);
  const mode = useCanvasStore((s) => s.mode);
  const status = useCanvasStore((s) => s.status);
  const canDraw = useCanvasStore((s) => s.canDraw);
  const layers = useCanvasStore((s) => s.layers);
  const activeLayerId = useCanvasStore((s) => s.activeLayerId);
  const locks = useCanvasStore((s) => s.locks);
  const presence = usePresence(mode);
  const drawingCount = presence.drawingCount;

  const sessionLive = status === 'OPEN' || status === 'LIVE';
  const disabled = !canDraw || !sessionLive;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2',
        className,
      )}
      style={{ borderColor: 'var(--border)' }}
    >
      {/* Herramientas */}
      <div className="flex items-center gap-1">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn('btn btn-sm', tool === t.id ? 'btn-primary' : 'btn-secondary')}
            onClick={() => setTool(t.id)}
            disabled={disabled}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Colores */}
      <div className="flex items-center gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            disabled={disabled}
            aria-label={`Color ${c}`}
            className={cn(
              'h-6 w-6 rounded-full border-2 transition-transform',
              color === c ? 'scale-110 border-[var(--primary)]' : 'border-transparent',
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      {/* Grosor */}
      <div className="flex items-center gap-1.5">
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setBrushSize(s)}
            disabled={disabled}
            aria-label={`Grosor ${s}`}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full',
              brushSize === s ? 'bg-[var(--primary)]' : 'hover:bg-black/10',
            )}
          >
            <span
              className="rounded-full bg-current"
              style={{ width: s + 2, height: s + 2, color: brushSize === s ? 'white' : 'var(--foreground)' }}
            />
          </button>
        ))}
      </div>

      {/* Selector de capa: sólo en FREE tiene sentido elegir */}
      {mode === 'FREE' && layers.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">Capa</span>
          {layers.map((layer) => {
            const lock = locks[layer.id];
            return (
              <button
                key={layer.id}
                type="button"
                onClick={() => onLayerSwitch?.(layer.id)}
                disabled={disabled}
                title={lock ? `En uso por ${lock.name}` : `Dibujar en ${layer.name}`}
                className={cn(
                  'btn btn-sm',
                  activeLayerId === layer.id ? 'btn-primary' : 'btn-secondary',
                )}
              >
                {layer.name}
                {lock ? ' ·' : ''}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Estado */}
      <div className="ml-auto flex items-center gap-2">
        {mode === 'LAYERED' ? (
          <span className="badge" title="Tu capa exclusiva">
            Tu capa
          </span>
        ) : null}

        {mode === 'INDIVIDUAL' ? (
          <span className="badge" title="Tu canvas es privado">
            Privado
          </span>
        ) : null}

        <span className="text-xs text-muted" title="Participantes dibujan ahora mismo">
          {presence.onlineCount} en línea · {drawingCount} dibujando
        </span>

        {/* Undo / redo */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onUndo}
            disabled={disabled || !canUndo}
            title="Deshacer"
          >
            ↶
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRedo}
            disabled={disabled || !canRedo}
            title="Rehacer"
          >
            ↷
          </button>
        </div>
      </div>

      {!sessionLive ? (
        <span className="w-full text-xs text-muted">
          La sesión está {status.toLowerCase()}: el dibujo está bloqueado.
        </span>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  const map: Record<SessionStatus, { label: string; color: string }> = {
    DRAFT: { label: 'Borrador', color: 'var(--muted)' },
    OPEN: { label: 'Abierta', color: 'var(--success)' },
    LIVE: { label: 'En vivo', color: 'var(--primary)' },
    CLOSED: { label: 'Cerrada', color: 'var(--danger)' },
    ARCHIVED: { label: 'Archivada', color: 'var(--muted)' },
  };
  const entry = map[status];
  return (
    <span className="badge" style={{ color: entry.color, borderColor: entry.color }}>
      {entry.label}
    </span>
  );
}

export function ParticipantsList() {
  const participants = useCanvasStore((s) => s.participants);
  const presence = useCanvasStore((s) => s.presence);
  const online = new Set(presence.map((p) => p.userId));

  return (
    <ul className="flex flex-col gap-1 text-sm">
      {participants.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-2">
          <span>{p.user.name}</span>
          <span className={online.has(p.userId) ? 'text-success' : 'text-muted'}>
            {online.has(p.userId) ? 'en línea' : 'ausente'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export type { ParticipantWithPresence };
