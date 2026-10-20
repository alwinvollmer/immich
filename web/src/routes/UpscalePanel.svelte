<script lang="ts">
  // custom: upscale progress, in the same style and place as the upload panel
  // (moves left of it while uploads are shown).
  import { upscaleManager } from '$lib/managers/upscale-manager.svelte';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { getAssetMediaUrl } from '$lib/utils';
  import { UpscaleJobState, type UpscaleJobResponseDto } from '@immich/sdk';
  import { Icon, IconButton } from '@immich/ui';
  import {
    mdiAlertCircle,
    mdiArrowExpandAll,
    mdiCheckCircle,
    mdiClose,
    mdiCircleOutline,
    mdiLoading,
    mdiOpenInNew,
    mdiWindowMinimize,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { quartInOut } from 'svelte/easing';
  import { fade, scale } from 'svelte/transition';

  let showDetail = $state(true);
  const { isUploading } = uploadAssetsStore;

  const jobs = $derived(upscaleManager.list);
  const activeCount = $derived(upscaleManager.activeCount);

  onMount(() => upscaleManager.init());

  $effect(() => {
    if (activeCount > 0) {
      showDetail = true;
    }
  });

  const label = (job: UpscaleJobResponseDto) => {
    switch (job.state) {
      case UpscaleJobState.Queued: {
        return job.position ? `Waiting for the upscaler (#${job.position})` : 'Waiting for the upscaler';
      }
      case UpscaleJobState.Running: {
        return job.tilesTotal
          ? `×${job.scale} · ${Math.floor(job.progress * 100)}% · ${job.tilesDone}/${job.tilesTotal} tiles`
          : `×${job.scale} · starting`;
      }
      case UpscaleJobState.Saving: {
        return 'Saving';
      }
      default: {
        return '';
      }
    }
  };
</script>

{#if jobs.length > 0}
  <div
    in:fade={{ duration: 250 }}
    out:fade={{ duration: 250 }}
    class="fixed bottom-6 z-60 {$isUploading ? 'inset-e-104' : 'inset-e-16'}"
  >
    {#if showDetail}
      <div
        in:scale={{ duration: 250, easing: quartInOut }}
        class="w-81 rounded-xl border border-gray-200 bg-subtle p-4 text-sm shadow-xs dark:border-subtle"
      >
        <div class="mb-4 flex items-center justify-between">
          <p class="text-xm immich-form-label">
            Upscaling {activeCount} of {jobs.length}
          </p>
          <IconButton
            variant="ghost"
            shape="round"
            color="secondary"
            aria-label="Minimize"
            icon={mdiWindowMinimize}
            size="small"
            onclick={() => (showDetail = false)}
          />
        </div>
        <div class="flex max-h-[400px] immich-scrollbar flex-col gap-2 overflow-y-auto rounded-lg">
          {#each jobs as job (job.id)}
            <div
              in:fade={{ duration: 250 }}
              class="flex flex-col gap-1 rounded-xl border border-gray-300 bg-primary/10 p-2 text-xs dark:border-subtle"
            >
              <div class="flex items-center gap-2">
                <div class="flex items-center justify-center">
                  {#if job.state === UpscaleJobState.Queued}
                    <Icon icon={mdiCircleOutline} size="24" class="text-primary" />
                  {:else if job.state === UpscaleJobState.Error}
                    <Icon icon={mdiAlertCircle} size="24" class="text-danger" />
                  {:else if job.state === UpscaleJobState.Done}
                    <Icon icon={mdiCheckCircle} size="24" class="text-success" />
                  {:else}
                    <Icon icon={mdiLoading} size="24" spin class="text-primary" />
                  {/if}
                </div>
                <img
                  src={getAssetMediaUrl({ id: job.assetId })}
                  alt=""
                  class="size-8 shrink-0 rounded-sm object-cover"
                />
                <span class="grow break-all">{job.filename} · ×{job.scale}</span>
                {#if job.state === UpscaleJobState.Done && job.newAssetId}
                  <a href={Route.viewAsset({ id: job.newAssetId })} aria-label="Open the upscaled image">
                    <Icon icon={mdiOpenInNew} size="20" />
                  </a>
                {/if}
                {#if !upscaleManager.isActive(job)}
                  <button type="button" onclick={() => upscaleManager.dismiss(job.id)} aria-label="Dismiss">
                    <Icon icon={mdiClose} size="20" />
                  </button>
                {/if}
              </div>

              {#if upscaleManager.isActive(job)}
                <div class="relative mt-[5px] h-4.5 w-full rounded-md bg-gray-300 text-black dark:bg-gray-700">
                  <div
                    class="h-4.5 rounded-md bg-immich-primary transition-all"
                    style={`width: ${Math.floor(job.progress * 100)}%`}
                  ></div>
                  <p class="absolute top-0.5 size-full text-center text-[10px] text-white">{label(job)}</p>
                </div>
              {/if}

              {#if job.state === UpscaleJobState.Error}
                <p class="w-full rounded-md text-justify text-danger">{job.error}</p>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="rounded-full">
        {#if activeCount > 0}
          <button
            type="button"
            in:scale={{ duration: 250, easing: quartInOut }}
            onclick={() => (showDetail = true)}
            class="absolute -inset-s-4 -top-4 flex size-10 place-content-center place-items-center rounded-full bg-primary p-5 text-xs text-light"
          >
            {activeCount}
          </button>
        {/if}
        <button
          type="button"
          in:scale={{ duration: 250, easing: quartInOut }}
          onclick={() => (showDetail = true)}
          aria-label="Show upscaling"
          class="flex size-16 place-content-center place-items-center rounded-full bg-subtle p-5 text-sm text-primary shadow-lg"
        >
          <div class:animate-pulse={activeCount > 0}>
            <Icon icon={mdiArrowExpandAll} size="30" />
          </div>
        </button>
      </div>
    {/if}
  </div>
{/if}
