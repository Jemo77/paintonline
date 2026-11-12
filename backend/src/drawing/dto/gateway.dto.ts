import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsHexColor,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const TOOLS = ['pen', 'marker', 'eraser', 'line', 'rect', 'ellipse'] as const;
export type Tool = (typeof TOOLS)[number];

/**
 * NOTA DE SEGURIDAD: ningún DTO acepta `userId`.
 * La identidad siempre sale de `client.data.user`, que se validó en el
 * handshake. Aceptarla del cliente permitiría dibujar en nombre de otro.
 */

export class JoinSessionDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;
}

export class StrokeStartDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  /**
   * Opcional. Si el cliente lo manda, se usa tal cual y se ahorra un round-trip
   * antes de enviar el primer punto. Si no, lo genera el servidor.
   */
  @IsOptional()
  @IsString()
  @Length(10, 64)
  strokeId?: string;

  @IsOptional()
  @IsString()
  @Length(10, 64)
  layerId?: string;

  @IsHexColor({ message: 'El color debe ser un hex válido (#rgb o #rrggbb)' })
  color!: string;

  @IsNumber()
  @Min(1, { message: 'El grosor mínimo es 1' })
  @Max(200, { message: 'El grosor máximo es 200' })
  brushSize!: number;

  @IsEnum(TOOLS)
  tool!: Tool;
}

export class PointDto {
  @IsNumber()
  @Min(-20000, { message: 'Coordenada X fuera de rango' })
  @Max(20000)
  x!: number;

  @IsNumber()
  @Min(-20000, { message: 'Coordenada Y fuera de rango' })
  @Max(20000)
  y!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  pressure?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  t?: number;
}

/**
 * Los puntos viajan como array acumulado (el cliente agrupa cada ~16-33ms).
 * Enviar un evento por punto multiplicaría el tráfico y el trabajo del servidor
 * sin ganar fidelidad.
 */
export class StrokePointsDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  @IsString()
  @Length(10, 64)
  strokeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256, { message: 'Máximo 256 puntos por evento' })
  @ValidateNested({ each: true })
  @Type(() => PointDto)
  points!: PointDto[];
}

export class StrokeEndDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  @IsString()
  @Length(10, 64)
  strokeId!: string;
}

export class LayerSwitchDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  @IsString()
  @Length(10, 64)
  layerId!: string;
}

export class LayerLockDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  @IsString()
  @Length(10, 64)
  layerId!: string;
}

export class UndoRedoDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;

  @IsOptional()
  @IsString()
  @Length(10, 64)
  strokeId?: string;

  @IsOptional()
  @IsString()
  @Length(10, 64)
  layerId?: string;
}

export class HeartbeatDto {
  @IsString()
  @Length(10, 64)
  sessionId!: string;
}

/** Los ids de trazo los genera el cliente (UUID) para evitar un round-trip. */
export const STROKE_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;

export function isValidStrokeId(value: string): boolean {
  return STROKE_ID_RE.test(value);
}
