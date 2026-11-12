import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { SessionMode, SessionStatus } from '@prisma/client';

const MODES: SessionMode[] = ['INDIVIDUAL', 'LAYERED', 'FREE'];

export class CreateSessionDto {
  @IsString()
  @Length(2, 80)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  theme?: string;

  @IsEnum(MODES, {
    message: `El modo debe ser uno de: ${MODES.join(', ')}`,
  })
  mode!: SessionMode;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(500)
  maxParticipants?: number;

  @IsOptional()
  @IsInt()
  @Min(320)
  @Max(4096)
  canvasWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(240)
  @Max(4096)
  canvasHeight?: number;

  /**
   * Número de capas iniciales. Sólo tiene efecto en LAYERED (una por
   * participante) y FREE (bandeja compartida). En INDIVIDUAL se ignoran.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  layerCount?: number;
}

export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  theme?: string;

  @IsOptional()
  @IsEnum(['DRAFT', 'OPEN', 'LIVE', 'CLOSED', 'ARCHIVED'])
  status?: SessionStatus;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(500)
  maxParticipants?: number;
}

export class StrokeQueryDto {
  /** Modo INDIVIDUAL: limita a un participant. */
  @IsOptional()
  @IsString()
  userId?: string;

  /** Limita a una capa concreta. */
  @IsOptional()
  @IsString()
  layerId?: string;

  /** Paginación por cursor temporal. */
  @IsOptional()
  @IsString()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

export class UpdateLayerDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  visible?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  opacity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  order?: number;
}

export class LogExportDto {
  /** Sólo analítica: se registra *que* hubo una descarga, nunca el archivo. */
  @IsEnum(['own_canvas', 'combined', 'single_layer'])
  scope!: 'own_canvas' | 'combined' | 'single_layer';
}

export class WinnerEntryDto {
  @IsString()
  userId!: string;

  @IsInt()
  @Min(1)
  @Max(3)
  position!: number;
}

export class SetWinnersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WinnerEntryDto)
  winners!: WinnerEntryDto[];

  @IsOptional()
  @IsBoolean()
  /** Vuelve a repartir los puntos si ya había ganadores. */
  replace?: boolean;
}
