// custom: upscaling via the anime-upscaler job API (UpscaleService)
import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export enum UpscaleJobState {
  Queued = 'queued',
  Running = 'running',
  Saving = 'saving',
  Done = 'done',
  Error = 'error',
}

const UpscaleJobStateSchema = z.enum(UpscaleJobState).describe('Upscale job state').meta({ id: 'UpscaleJobState' });

const UpscaleCreateSchema = z
  .object({
    assetId: z.uuidv4().describe('Image to upscale'),
    scale: z
      .int()
      .refine((scale) => scale === 2 || scale === 4, 'scale must be 2 or 4')
      .describe('Upscale factor (2 or 4)'),
  })
  .meta({ id: 'UpscaleCreateDto' });

const UpscaleJobResponseSchema = z
  .object({
    id: z.string().describe('Upscale job ID'),
    assetId: z.string().describe('Image being upscaled'),
    filename: z.string().describe('Original file name'),
    scale: z.int().describe('Upscale factor'),
    state: UpscaleJobStateSchema,
    progress: z.number().describe('Progress from 0 to 1').meta({ format: 'double' }),
    tilesDone: z.int().describe('Finished tiles'),
    tilesTotal: z.int().describe('Total tiles (0 until known)'),
    position: z.int().nullable().describe('Position in the upscaler queue while queued'),
    newAssetId: z.string().nullable().describe('The upscaled image, once done'),
    error: z.string().nullable().describe('Error message if the job failed'),
  })
  .meta({ id: 'UpscaleJobResponseDto' });

export class UpscaleCreateDto extends createZodDto(UpscaleCreateSchema) {}
export class UpscaleJobResponseDto extends createZodDto(UpscaleJobResponseSchema) {}
