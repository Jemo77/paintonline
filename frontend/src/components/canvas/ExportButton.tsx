'use client';

import { useRef } from 'react';
import type Konva from 'konva';
import { authApi, sessionsApi } from '@/lib/api';
import { downloadAllLayers, downloadLayer, downloadStage, sanitize } from '@/utils/exportCanvas';
import { useCanvasStore } from '@/store/canvasStore';
import type { CanvasStageHandle } from './CanvasStage';

export interface ExportButtonProps {
  stageRef: React.RefObject<CanvasStageHandle | null>;
  /**
   * 'own'  → sólo el canvas propio (modo INDIVIDUAL)
   * 'combined' → el Stage completo, con todas las capas apiladas
   * 'layers' → una PNG por capa, más la combinada
   */
  scope?: 'own' | 'combined' | 'layers';
  disabled?: boolean;
  className?: string;
  pixelRatio?: number;
}

/**
 * Descarga local. El backend nunca participa: el Stage ya está renderizado en
 * el navegador y `toDataURL()` produce la imagen ahí mismo. Al servidor sólo se
 * le avisa el evento, y unicamente para analítica.
 */
export function ExportButton({
  stageRef,
  scope = 'combined',
  disabled = false,
  className,
  pixelRatio = 2,
}: ExportButtonProps) {
  const busyRef = useRef(false);

  const title = useCanvasStore((s) => s.title);
  const mode = useCanvasStore((s) => s.mode);
  const layers = useCanvasStore((s) => s.layers);
  const sessionId = useCanvasStore((s) => s.sessionId);
  const isSpaceOwner = useCanvasStore((s) => s.isSpaceOwner);
  const theme = useCanvasStore((s) => s.theme);

  const baseName = sanitize(`${theme ? `${theme}-` : ''}${title || 'paintonline'}`);

  async function handleExport() {
    if (busyRef.current) return;

    const handle = stageRef.current;
    const stage: Konva.Stage | null = handle?.getStage() ?? null;
    if (!stage) return;

    busyRef.current = true;
    try {
      if (scope === 'layers' && mode !== 'INDIVIDUAL') {
        downloadAllLayers(
          stage,
          layers.map((l) => ({ id: l.id, name: l.name })),
          baseName,
        );
      } else if (scope === 'own' && mode === 'INDIVIDUAL') {
        // Un solo Stage = el canvas propio, sin multiplexado de usuarios.
        downloadStage(stage, { fileName: baseName, pixelRatio, backgroundColor: '#ffffff' });
      } else if (mode !== 'INDIVIDUAL' && scope === 'combined') {
        downloadStage(stage, { fileName: `${baseName}-completo`, pixelRatio, backgroundColor: '#ffffff' });
      } else {
        downloadStage(stage, { fileName: baseName, pixelRatio, backgroundColor: '#ffffff' });
      }

      // Sólo analítica: se registra que hubo una descarga, nunca la imagen.
      if (sessionId) {
        const logScope =
          mode === 'INDIVIDUAL'
            ? 'own_canvas'
            : scope === 'layers'
              ? 'single_layer'
              : 'combined';
        await sessionsApi.logExport(sessionId, logScope).catch(() => undefined);
      }
    } finally {
      busyRef.current = false;
    }
  }

  // El creador puede exportar todo; un participante, sólo lo que le corresponde.
  const defaultScope: ExportButtonProps['scope'] =
    isSpaceOwner && mode !== 'INDIVIDUAL' ? 'layers' : mode === 'INDIVIDUAL' ? 'own' : 'combined';

  return (
    <button
      type="button"
      className={className ?? 'btn btn-secondary btn-sm'}
      onClick={handleExport}
      disabled={disabled}
      title={
        defaultScope === 'layers'
          ? 'Descargar una imagen por capa, más la combinada'
          : 'Descargar imagen (se genera en tu navegador)'
      }
    >
      Descargar PNG
    </button>
  );
}

/**
 * Descarga sólo la capa activa. Se muestra en el panel de capas (FREE) para
 * que quien dibuja se lleve su propio trazo suelto.
 */
export function ExportLayerButton({
  stageRef,
  layerId,
  layerName,
  className,
}: {
  stageRef: React.RefObject<CanvasStageHandle | null>;
  layerId: string;
  layerName: string;
  className?: string;
}) {
  function handleClick() {
    const layer = stageRef.current?.getLayer(layerId);
    if (!layer) return;

    // El nombre de la capa se sanea: puede traer acentos o espacios.
    downloadLayer(layer, { fileName: sanitize(layerName) });
  }

  return (
    <button
      type="button"
      className={className ?? 'btn btn-secondary btn-sm'}
      onClick={handleClick}
      title="Descargar sólo esta capa"
    >
      ↓
    </button>
  );
}
