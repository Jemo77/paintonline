import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CreateSpaceDto {
  @IsString()
  @Length(2, 60)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(10, 80)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  slug?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateSpaceDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(10, 300)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /** { "1": 10, "2": 6, "3": 3 } */
  @IsOptional()
  scoringConfig?: Record<string, number>;
}
