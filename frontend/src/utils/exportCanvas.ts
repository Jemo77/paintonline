import Konva from 'konva';
import type { Stroke, StrokePoint } from '@/types';

/**
 * EXPORTACIÓN 100% LOCAL.
 *
 * No hay S3, R2 ni ningún object storage. La imagen existe únicamente en la
 * memoria del navegador: se genera desde el `Konva.Stage` que ya está
 * renderizado en pantalla y se descarga con un `<a download>`. El servidor
 * nunca ve el binario.
 */

/** Aplana los puntos al formato `[x0,y0,x1,y1,...]` que espera Konva.Line. */
export function flattenPoints(points: StrokePoint[]): number[] {
  const flat: number[] = new Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    flat[i * 2] = points[i].x;
    flat[i * 2 + 1] = points[i].y;
  }
  return flat;
}

/**
 * Ancho de línea ponderado por presión.
 *
 * Sin esto, todos los trazos tienen el mismo grosor y se pierde una de las
 * señales que el backend ya persiste (`pressure` en cada punto).
 */
function pressureWidth(
  points: StrokePoint[],
  baseSize: number,
  scale = 1,
): number {
  if (points.length === 0) return baseSize * scale;
  const last = points[points.length - 1];
  const pressure = last.pressure ?? 0.5;
  // Rango [0.6x, 1.4x] alrededor del grosor elegido en la barra de tools.
  return baseSize * scale * (0.6 + pressure * 0.8);
}

export interface RenderStrokeOptions {
  /** Multiplicador de escala: 1 para el canvas real, <1 para miniaturas. */
  scale?: number;
  /** Opacidad global, útil para mostrar las capas ajenas atenuadas. */
  opacity?: number;
}

/**
 * Traduce un trazo del modelo a un `Konva.Line`.
 *
 * Se exponen los atributos del nodo (stroke, strokeWidth, opacity) para poder
 * aplicarles listening y estados visuales desde el componente.
 */
export function buildStrokeNode(
  stroke: Stroke,
  options: RenderStrokeOptions = {},
): Konva.Line {
  const { scale = 1, opacity = 1 } = options;
  const points = flattenPoints(stroke.points);

  // El borrador no pinta de blanco: usa `destination-out`, así que borra de
  // verdad lo que haya debajo en vez de taparlo con el color de fondo.
  const isEraser = stroke.tool === 'eraser';

  return new Konva.Line({
    points,
    stroke: isEraser ? '#ffffff' : stroke.color,
    strokeWidth: pressureWidth(stroke.points, stroke.brushSize, scale),
    lineCap: 'round',
    lineJoin: 'round',
    // `tension: 0` dibuja segmentos rectos entre puntos, o sea que la línea
    // sigue exactamente el movimiento del puntero. Con 0.3 Konva interpola una
    // Bézier y los trazos rapidejos salen "suaavizados", como si el lápiz
    // resbalara. Con el muestreo cada 24 ms no hace falta suavizar.
    tension: 0,
    globalCompositeOperation: isEraser ? 'destination-out' : 'source-over',
    opacity,
    perfectDrawEnabled: false,
    // Un solo punto no dibuja nada: se lo representa como un punto.
    hitStrokeWidth: Math.max(stroke.brushSize * scale * 2, 12),
  });
}

export interface DownloadOptions {
  fileName: string;
  /** 2 = retina. Mayor nitidez, más memoria y PNG más pesado. */
  pixelRatio?: number;
  mimeType?: 'image/png' | 'image/jpeg';
  /** Si es false, devuelve el dataURL sin disparar la descarga. */
  download?: boolean;
  /** Fondo para PNGs transparentes. Sin esto, el PNG sale con alfa. */
  backgroundColor?: string;
}

export interface DownloadResult {
  dataUrl: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
}

/**
 * Descarga el Stage como imagen. Todo ocurre en el navegador: la imagen se
 * serializa a dataURL y el navegador la guarda en el disco del usuario.
 */
export function downloadStage(
  stage: Konva.Stage,
  options: DownloadOptions,
): DownloadResult {
  const {
    fileName,
    pixelRatio = 2,
    mimeType = 'image/png',
    download = true,
    backgroundColor,
  } = options;

  const dataUrl = stage.toDataURL({
    pixelRatio,
    mimeType,
    ...(backgroundColor ? { backgroundColor } : {}),
  });

  const safeName = fileName.endsWith(mimeType === 'image/jpeg' ? '.jpg' : '.png')
    ? fileName
    : `${fileName}${mimeType === 'image/jpeg' ? '.jpg' : '.png'}`;

  if (download) {
    triggerDownload(dataUrl, safeName);
  }

  return {
    dataUrl,
    fileName: safeName,
    // Tamaño aproximado: la dataURL es base64 (4/3 del binario).
    byteSize: Math.round((dataUrl.length * 3) / 4),
    mimeType,
  };
}

/** Descarga una sola capa (modo LAYERED / FREE). */
export function downloadLayer(
  layer: Konva.Layer,
  options: Omit<DownloadOptions, 'fileName'> & { fileName: string },
): DownloadResult {
  const { fileName, pixelRatio = 2, mimeType = 'image/png', download = true } = options;

  const dataUrl = layer.toDataURL({ pixelRatio, mimeType });

  const safeName = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
  if (download) triggerDownload(dataUrl, safeName);

  return {
    dataUrl,
    fileName: safeName,
    byteSize: Math.round((dataUrl.length * 3) / 4),
    mimeType,
  };
}

/**
 * Descarga en capas apiladas: una PNG por layerId, más una combinada.
 * Es lo que necesita el creador para entregar el trabajo de todos.
 */
export function downloadAllLayers(
  stage: Konva.Stage,
  layers: Array<{ id: string; name: string }>,
  baseName: string,
): DownloadResult[] {
  const results: DownloadResult[] = [];

  for (const layer of layers) {
    const konvaLayer = stage.findOne(`.layer-${layer.id}`);
    if (!konvaLayer) continue;

    results.push(
      downloadLayer(konvaLayer as Konva.Layer, {
        fileName: `${baseName}-${sanitize(layer.name)}`,
        pixelRatio: 2,
      }),
    );
  }

  results.push(
    downloadStage(stage, {
      fileName: `${baseName}-completo`,
      pixelRatio: 2,
      backgroundColor: '#ffffff',
    }),
  );

  return results;
}

function triggerDownload(dataUrl: string, fileName: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function sanitize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
}
