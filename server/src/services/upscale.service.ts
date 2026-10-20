import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { UpscaleCreateDto, UpscaleJobResponseDto, UpscaleJobState } from 'src/dtos/upscale.dto.js';
import { AssetType, JobName, Permission, StorageFolder } from 'src/enum.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { BaseService } from 'src/services/base.service.js';
import { updateLockedColumns } from 'src/utils/database.js';

/**
 * custom: upscale an image with the anime-upscaler (Real-ESRGAN) job API.
 *
 * The original is sent to the upscaler; its exact per-tile progress is relayed to
 * the user's browsers as `on_upscale_update` websocket events. The result is saved
 * through the normal upload path, gets the original's description, date, location,
 * rating, tags and favourite, and is stacked on top of the original as the new
 * cover (StackAlbumService then moves the albums to it).
 *
 * Jobs live in memory: a server restart forgets running jobs (the upscaler drops
 * unfetched results after an hour).
 */
const UPSCALER_URL = (process.env.IMMICH_UPSCALER_URL || 'https://host.docker.internal:7085').replace(/\/+$/, '');
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const POLL_INTERVAL_MS = 1500;
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;

type UpscaleJob = UpscaleJobResponseDto & { userId: string; finishedAt?: number };

type UpscalerJobStatus = {
  state: 'queued' | 'running' | 'done' | 'error';
  tilesDone: number;
  tilesTotal: number;
  progress: number;
  position: number | null;
  error: string | null;
};

@Injectable()
export class UpscaleService extends BaseService {
  private jobs = new Map<string, UpscaleJob>();

  async create(auth: AuthDto, dto: UpscaleCreateDto): Promise<UpscaleJobResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.assetId] });

    const asset = await this.assetRepository.getById(dto.assetId, { exifInfo: true, tags: true });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (asset.type !== AssetType.Image) {
      throw new BadRequestException('Only images can be upscaled');
    }
    const extension = extname(asset.originalPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new BadRequestException(`Unsupported format for upscaling: ${extension || 'unknown'}`);
    }

    const job: UpscaleJob = {
      id: randomUUID(),
      userId: auth.user.id,
      assetId: asset.id,
      filename: asset.originalFileName,
      scale: dto.scale,
      state: UpscaleJobState.Queued,
      progress: 0,
      tilesDone: 0,
      tilesTotal: 0,
      position: null,
      newAssetId: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.send(job);

    void this.run(auth, job, asset, extension);
    return this.toResponse(job);
  }

  getJobs(auth: AuthDto): UpscaleJobResponseDto[] {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
    return this.jobs
      .values()
      .filter((job) => job.userId === auth.user.id)
      .map((job) => this.toResponse(job))
      .toArray();
  }

  private async run(
    auth: AuthDto,
    job: UpscaleJob,
    asset: NonNullable<Awaited<ReturnType<typeof this.assetRepository.getById>>>,
    extension: string,
  ) {
    let upscalerJobId: string | undefined;
    try {
      const form = new FormData();
      form.append('image', new Blob([await readFile(asset.originalPath)]), `image${extension}`);
      form.append('outscale', String(job.scale));
      const created = (await this.upscaler('POST', '/jobs', form)) as { id: string };
      upscalerJobId = created.id;

      for (;;) {
        const status = (await this.upscaler('GET', `/jobs/${upscalerJobId}`)) as UpscalerJobStatus;
        if (status.state === 'error') {
          throw new Error(status.error || 'upscaler failed');
        }
        const state = status.state === 'queued' ? UpscaleJobState.Queued : UpscaleJobState.Running;
        if (
          state !== job.state ||
          status.tilesDone !== job.tilesDone ||
          status.tilesTotal !== job.tilesTotal ||
          status.position !== job.position
        ) {
          Object.assign(job, {
            state,
            tilesDone: status.tilesDone,
            tilesTotal: status.tilesTotal,
            position: status.position,
            progress: status.progress,
          });
          this.send(job);
        }
        if (status.state === 'done') {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      const result = Buffer.from(
        (await this.upscaler('GET', `/jobs/${upscalerJobId}/result`, undefined, true)) as ArrayBuffer,
      );
      await this.upscaler('DELETE', `/jobs/${upscalerJobId}`).catch(() => {});
      upscalerJobId = undefined;

      Object.assign(job, { state: UpscaleJobState.Saving, progress: 1 });
      this.send(job);

      job.newAssetId = await this.save(auth, asset, extension, result);
      Object.assign(job, { state: UpscaleJobState.Done });
    } catch (error) {
      this.logger.error(`Upscale of ${asset.id} failed: ${error}`);
      Object.assign(job, {
        state: UpscaleJobState.Error,
        error: error instanceof Error ? error.message : String(error),
      });
      if (upscalerJobId) {
        await this.upscaler('DELETE', `/jobs/${upscalerJobId}`).catch(() => {});
      }
    } finally {
      job.finishedAt = Date.now();
      this.send(job);
    }
  }

  private async save(
    auth: AuthDto,
    asset: NonNullable<Awaited<ReturnType<typeof this.assetRepository.getById>>>,
    extension: string,
    data: Buffer,
  ): Promise<string> {
    const uuid = randomUUID();
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, uuid);
    this.storageRepository.mkdirSync(folder);
    const originalPath = `${folder}/${uuid}${extension}`;
    await writeFile(originalPath, data);

    const dto = {
      fileCreatedAt: asset.fileCreatedAt,
      fileModifiedAt: asset.fileModifiedAt,
      filename: asset.originalFileName,
      isFavorite: asset.isFavorite,
      visibility: asset.visibility,
    } as AssetMediaCreateDto;
    const file = {
      uuid,
      checksum: createHash('sha1').update(data).digest(),
      originalPath,
      originalName: asset.originalFileName,
      size: data.length,
    };
    const response = await BaseService.create(AssetMediaService, this).uploadAsset(auth, dto, file);
    if (response.status === AssetMediaStatus.DUPLICATE) {
      throw new Error('The upscaled image already exists');
    }
    const newAssetId = response.id;

    // keep the original's metadata; locked so the metadata extraction does not overwrite it
    const exif = asset.exifInfo;
    if (exif) {
      const writes = Object.fromEntries(
        Object.entries({
          description: exif.description || undefined,
          dateTimeOriginal: exif.dateTimeOriginal ?? undefined,
          timeZone: exif.timeZone ?? undefined,
          latitude: exif.latitude ?? undefined,
          longitude: exif.longitude ?? undefined,
          rating: exif.rating ?? undefined,
        }).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(writes).length > 0) {
        await this.assetRepository.upsertExif({
          exif: updateLockedColumns({ assetId: newAssetId, ...writes }),
          lockedPropertiesBehavior: 'append',
        });
        await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: newAssetId } });
      }
    }

    if (asset.tags?.length) {
      await this.tagRepository.upsertAssetIds(asset.tags.map((tag) => ({ tagId: tag.id, assetId: newAssetId })));
    }

    const stack = await this.stackRepository.create({ ownerId: asset.ownerId }, [newAssetId, asset.id]);
    await this.eventRepository.emit('StackCreate', { stackId: stack.id, userId: auth.user.id });

    return newAssetId;
  }

  private async upscaler(method: string, path: string, body?: FormData, binary = false): Promise<unknown> {
    const response = await fetch(`${UPSCALER_URL}${path}`, { method, body });
    if (!response.ok) {
      throw new Error(`upscaler ${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    }
    return binary ? response.arrayBuffer() : response.json();
  }

  private send(job: UpscaleJob) {
    this.websocketRepository.clientSend('on_upscale_update', job.userId, this.toResponse(job));
  }

  private toResponse({ userId: _userId, finishedAt: _finishedAt, ...job }: UpscaleJob): UpscaleJobResponseDto {
    return job;
  }
}
