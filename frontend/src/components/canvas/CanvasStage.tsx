'use client';

import { Stage, Layer as KonvaLayer, Line, Rect } from 'react-konva';
import Konva from 'konva';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useCanvasStore, type LiveStroke } from '@/store/canvasStore';
import { buildStrokeNode } from '@/utils/exportCanvas';
import type { Stroke } from '@/types';
import { cn } from '@/lib/utils';

export interface CanvasStageHandle {
  /** Acceso al Stage para `toDataURL()`. La exportación es 100% local. */
  getStage: () => Konva.Stage | null;
  getLayer: (layerId: string) => Konva.Layer | null;
  clear: () => void;
  /** Ajusta el canvas al contenedor y conserva el punto central. */
  fitToContainer: () => void;
}

export interface CanvasStageProps {
  width: number;
  height: number;
  /**
   * Modo INDIVIDUAL: el Stage muestra sólo los trazos de este usuario.
   * Lo usa el grid de miniaturas del creador (una miniatura por participante).
   */
  targetUserId?: string;
  /** La capa ajena se dibuja atenuada y sin listener. */
  lockOthers?: boolean;
  onDrawStart?: (points: Array<{ x: number; y: number; pressure: number; t: number }>) => void;
  onDrawMove?: (point: { x: number; y: number; pressure: number; t: number }) => void;
  onDrawEnd?: () => void;
  className?: string;
  /** Etiqueta flotante (sólo miniaturas). */
  label?: string;
  showBackground?: boolean;
}

const CURSOR_STYLE = 'crosshair';

/**
 * Konva tipa `onMouseDown` y `onTouchStart` con eventos distintos. Un solo
 * handler para los dos: un `MouseEvent | TouchEvent` acepta ambos.
 */
type StagePointerEvent = Konva.KonvaEventObject<MouseEvent | TouchEvent>;

export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(
  function CanvasStage(
    {
      width,
      height,
      targetUserId,
      lockOthers = false,
      onDrawStart,
      onDrawMove,
      onDrawEnd,
      className,
      label,
      showBackground = true,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<Konva.Stage | null>(null);
    const [size, setSize] = useState({ width, height });

    const mode = useCanvasStore((s) => s.mode);
    const layers = useCanvasStore((s) => s.layers);
    const strokes = useCanvasStore((s) => s.strokes);
    const strokeOrder = useCanvasStore((s) => s.strokeOrder);
    const live = useCanvasStore((s) => s.live);
    const activeLayerId = useCanvasStore((s) => s.activeLayerId);
    const assignedLayerId = useCanvasStore((s) => s.assignedLayerId);
    const canDraw = useCanvasStore((s) => s.canDraw);

    // ── Ajuste al contenedor ─────────────────────────────────────────────
    useEffect(() => {
      const element = containerRef.current;
      if (!element) return;

      const resize = () => {
        const parent = element.parentElement;
        if (!parent) return;
        const available = {
          width: Math.max(240, parent.clientWidth),
          height: Math.max(180, parent.clientHeight),
        };
        setSize(available);
      };

      resize();
      const observer = new ResizeObserver(resize);
      if (element.parentElement) observer.observe(element.parentElement);
      window.addEventListener('resize', resize);

      return () => {
        observer.disconnect();
        window.removeEventListener('resize', resize);
      };
    }, []);

    // ── Escala para que el canvas lógico entre en el espacio disponible ──
    const scale = useMemo(
      () => Math.min(size.width / width, size.height / height),
      [size.width, size.height, width, height],
    );

    const displayedWidth = width * scale;
    const displayedHeight = height * scale;

    // ── Trazos que se pintan en este Stage ───────────────────────────────
    //
    // En INDIVIDUAL el backend ya aísla: al participante le llega sólo su
    // trazo y al creador todos. Por eso `targetUserId` es opcional y su
    // ausencia no puede vaciar el canvas:
    //   - si viene, este Stage dibuja a ese usuario (miniaturas del monitor);
    //   - si no viene, dibuja todo lo que llegó, que en el canvas personal
    //     ya es sólo lo propio.
    const visibleStrokes = useMemo<Stroke[]>(() => {
      const all = strokeOrder.map((id) => strokes[id]).filter(Boolean);
      if (mode === 'INDIVIDUAL' && targetUserId) {
        return all.filter((s) => s.userId === targetUserId);
      }
      return all;
    }, [mode, targetUserId, strokes, strokeOrder]);

    const visibleLive = useMemo<LiveStroke[]>(() => {
      const all = Object.values(live);
      if (mode === 'INDIVIDUAL' && targetUserId) {
        return all.filter((s) => s.userId === targetUserId);
      }
      return all;
    }, [mode, targetUserId, live]);

    // Agrupar por capa: un Konva.Layer por Layer de Prisma.
    const strokesByLayer = useMemo(() => {
      const map = new Map<string, Stroke[]>();
      const orphan: Stroke[] = [];

      for (const stroke of visibleStrokes) {
        if (stroke.layerId) {
          const bucket = map.get(stroke.layerId) ?? [];
          bucket.push(stroke);
          map.set(stroke.layerId, bucket);
        } else {
          // INDIVIDUAL: los trazos no tienen capa, van a un layer propio.
          orphan.push(stroke);
        }
      }
      return { map, orphan };
    }, [visibleStrokes]);

    // ── API imperativa para la exportación ────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        getStage: () => stageRef.current,
        getLayer: (layerId: string) => {
          const node = stageRef.current?.findOne(`.layer-${layerId}`);
          return (node as Konva.Layer) ?? null;
        },
        clear: () => {
          stageRef.current?.destroyChildren();
        },
        fitToContainer: () => {
          const stage = stageRef.current;
          if (!stage) return;
          const next = Math.min(
            (containerRef.current?.clientWidth ?? width) / width,
            (containerRef.current?.clientHeight ?? height) / height,
          );
          stage.scale({ x: next, y: next });
          stage.position({
            x: ((containerRef.current?.clientWidth ?? 0) - width * next) / 2,
            y: ((containerRef.current?.clientHeight ?? 0) - height * next) / 2,
          });
        },
      }),
      [width, height],
    );

    // ── Dibujo ───────────────────────────────────────────────────────────
    const isDrawingEnabled = Boolean(onDrawStart) && canDraw && !lockOthers;

    const toCanvasPoint = useCallback((): { x: number; y: number; pressure: number; t: number } | null => {
      const stage = stageRef.current;
      if (!stage) return null;

      const pointer = stage.getPointerPosition();
      if (!pointer) return null;

      // Se invierte la escala del Stage para mandar al servidor las
      // coordenadas del canvas lógico, no de la pantalla.
      const transform = stage.getAbsoluteTransform().copy().invert();
      const pos = transform.point(pointer);

      return {
        x: Math.round(pos.x * 100) / 100,
        y: Math.round(pos.y * 100) / 100,
        pressure: 0.5,
        t: Date.now(),
      };
    }, []);

    const handlePointerDown = useCallback(
      (event: StagePointerEvent) => {
        if (!isDrawingEnabled) return;
        // El preventDefault evita que Konva seleccione el texto de la página.
        event.evt.preventDefault();

        const point = toCanvasPoint();
        if (!point) return;
        onDrawStart?.([point]);
      },
      [isDrawingEnabled, onDrawStart, toCanvasPoint],
    );

    const handlePointerMove = useCallback(
      (_event: StagePointerEvent) => {
        if (!isDrawingEnabled) return;
        const point = toCanvasPoint();
        if (!point) return;
        onDrawMove?.(point);
      },
      [isDrawingEnabled, onDrawMove, toCanvasPoint],
    );

    const handlePointerUp = useCallback(() => {
      if (!isDrawingEnabled) return;
      onDrawEnd?.();
    }, [isDrawingEnabled, onDrawEnd]);

    // ── Qué capas se renderizan ──────────────────────────────────────────
    const renderableLayers = useMemo(() => {
      if (mode === 'INDIVIDUAL') return [];
      return layers
        .filter((l) => l.visible)
        .sort((a, b) => a.order - b.order);
    }, [layers, mode]);

    const backgroundLayer = (
      <KonvaLayer key="background" listening={false}>
        {showBackground ? (
          <Rect
            width={width}
            height={height}
            fill="#ffffff"
            shadowColor="#000"
            shadowBlur={12}
            shadowOpacity={0.12}
            shadowOffsetY={2}
          />
        ) : (
          <Rect width={width} height={height} fill="transparent" />
        )}
      </KonvaLayer>
    );

    return (
      <div
        ref={containerRef}
        className={cn('relative h-full w-full overflow-hidden', className)}
      >
        <Stage
          ref={stageRef}
          width={displayedWidth}
          height={displayedHeight}
          scaleX={scale}
          scaleY={scale}
          listening={showBackground}
          style={{ cursor: isDrawingEnabled ? CURSOR_STYLE : 'default' }}
          onMouseDown={handlePointerDown}
          onTouchStart={handlePointerDown}
          onMouseMove={handlePointerMove}
          onTouchMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onTouchEnd={handlePointerUp}
          onMouseLeave={handlePointerUp}
        >
          {backgroundLayer}

          {mode === 'INDIVIDUAL' ? (
            // Un único layer Konva: el aislamiento por usuario ya lo aplica
            // `visibleStrokes`, no hace falta una capa física por participante.
            <KonvaLayer key="individual">
              {strokesByLayer.orphan.map((stroke) => (
                <ShapeFromStroke key={stroke.id} stroke={stroke} />
              ))}
              {visibleLive.map((s) => (
                <LiveShape key={s.strokeId} live={s} />
              ))}
            </KonvaLayer>
          ) : (
            <>
              {renderableLayers.map((layer) => {
                const ownLayer = layer.id === activeLayerId;
                const isOwnAssigned =
                  mode === 'LAYERED' && layer.id === assignedLayerId;

                // En LAYERED se dibuja atenuado todo lo que no sea la capa
                // propia: comunica el candado sin bloquear la vista.
                const dimmed = lockOthers && !isOwnAssigned && mode === 'LAYERED';

                return (
                  <KonvaLayer
                    key={layer.id}
                    name={`layer-${layer.id}`}
                    opacity={dimmed ? 0.35 : layer.opacity}
                    listening={false}
                  >
                    {(strokesByLayer.map.get(layer.id) ?? []).map((stroke) => (
                      <ShapeFromStroke key={stroke.id} stroke={stroke} />
                    ))}
                    {ownLayer
                      ? visibleLive
                          .filter((s) => s.layerId === layer.id)
                          .map((s) => <LiveShape key={s.strokeId} live={s} />)
                      : null}
                  </KonvaLayer>
                );
              })}

              {/*
                En FREE también hay trazos en vuelo sin capa activa visible
                (el usuario puede haber cambiado de capa a mitad de trazo).
              */}
              {visibleLive
                .filter(
                  (s) =>
                    s.layerId && !renderableLayers.some((l) => l.id === s.layerId),
                )
                .map((s) => (
                  <KonvaLayer key={`live-${s.strokeId}`} listening={false}>
                    <LiveShape live={s} />
                  </KonvaLayer>
                ))}
            </>
          )}
        </Stage>

        {label ? (
          <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {label}
          </div>
        ) : null}
      </div>
    );
  },
);

/**
 * Nodo Konva a partir de un trazo persistido.
 *
 * Se reutiliza `buildStrokeNode` — el mismo que usa la exportación — para que
 * lo que se ve sea exactamente lo que se descarga.
 */
function ShapeFromStroke({ stroke }: { stroke: Stroke }) {
  const node = useMemo(() => buildStrokeNode(stroke), [stroke]);
  return <Line {...node.getAttrs()} listening={false} />;
}

function LiveShape({ live }: { live: LiveStroke }) {
  // Se reutiliza `buildStrokeNode` —el mismo que el trazo guardado y el que
  // usa la exportación— para que el trazo en vivo sea byte a byte el mismo
  // que queda al soltar. Si el "en vivo" se dibuja con otras reglas (grosor
  // plano vs. modulado por presión), se ve un salto al soltar el mouse.
  const node = useMemo(
    () =>
      buildStrokeNode({
        points: live.points,
        color: live.color,
        brushSize: live.brushSize,
        tool: live.tool,
      } as Stroke),
    [live.points, live.color, live.brushSize, live.tool],
  );

  if (live.points.length === 0) return null;

  return <Line {...node.getAttrs()} listening={false} />;
}
