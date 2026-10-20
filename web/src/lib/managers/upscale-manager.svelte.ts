// custom: upscale jobs of the current user (server: UpscaleService). Progress
// arrives as `on_upscale_update` websocket events; running jobs are reloaded
// from GET /upscale/jobs so a page reload keeps showing them.
import { createUpscale, getUpscaleJobs, UpscaleJobState, type UpscaleJobResponseDto } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';
import { websocketEvents } from '$lib/stores/websocket';
import { handleError } from '$lib/utils/handle-error';

const ACTIVE = new Set<UpscaleJobState>([UpscaleJobState.Queued, UpscaleJobState.Running, UpscaleJobState.Saving]);

class UpscaleManager {
  jobs = new SvelteMap<string, UpscaleJobResponseDto>();
  #initialized = false;

  get list() {
    return [...this.jobs.values()];
  }

  get activeCount() {
    return this.list.filter((job) => ACTIVE.has(job.state)).length;
  }

  isActive(job: UpscaleJobResponseDto) {
    return ACTIVE.has(job.state);
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    websocketEvents.on('on_upscale_update', (job) => this.jobs.set(job.id, job));
    getUpscaleJobs()
      .then((jobs) => {
        for (const job of jobs) {
          if (ACTIVE.has(job.state)) {
            this.jobs.set(job.id, job);
          }
        }
      })
      .catch(() => {});
  }

  async start(assetId: string, scale: 2 | 4) {
    try {
      const job = await createUpscale({ upscaleCreateDto: { assetId, scale } });
      this.jobs.set(job.id, job);
    } catch (error) {
      handleError(error, 'Could not start the upscale');
    }
  }

  dismiss(id: string) {
    this.jobs.delete(id);
  }
}

export const upscaleManager = new UpscaleManager();
