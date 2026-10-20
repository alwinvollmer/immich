<script lang="ts">
  import { page } from '$app/state';
  import { shouldIgnoreEvent } from '$lib/actions/shortcut';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { fileDropManager } from '$lib/managers/file-drop-manager.svelte';
  import { dragAndDropFilesStore } from '$lib/stores/drag-and-drop-files.store';
  import { getFilesFromDataTransfer, hasFiles } from '$lib/utils/file-drop';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import { isAlbumsRoute, isLockedFolderRoute } from '$lib/utils/navigation';
  import { Logo } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  // custom: the overlay is a click-through hint instead of a full-screen cover, so
  // drops can land on album drop targets (sidebar albums, Photos album chips).
  // A drop anywhere else uploads as before (into the album when on an album page).

  let albumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  let isInLockedFolder = $derived(isLockedFolderRoute(page.route.id));

  let isInternalDrag = false;

  const onPaste = async (event: ClipboardEvent) => {
    if (shouldIgnoreEvent(event)) {
      return;
    }

    await handleFiles(await getFilesFromDataTransfer(event.clipboardData));
  };

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    if (authManager.isSharedLink) {
      dragAndDropFilesStore.set({ isDragging: true, files });
    } else {
      await fileUploadHandler({ files, albumId, isLockedAssets: isInLockedFolder });
    }
  };

  const ondragstart = () => {
    isInternalDrag = true;
  };

  const ondragend = () => {
    isInternalDrag = false;
    fileDropManager.reset();
  };

  const ondragenter = (e: DragEvent) => {
    if (isInternalDrag || !hasFiles(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    fileDropManager.enter();
  };

  const ondragleave = (e: DragEvent) => {
    if (isInternalDrag || !hasFiles(e.dataTransfer)) {
      return;
    }

    fileDropManager.leave();
  };

  const ondragover = (e: DragEvent) => {
    if (isInternalDrag || !hasFiles(e.dataTransfer)) {
      return;
    }

    // allow dropping anywhere; album drop targets handle (and stop) their own drops
    e.preventDefault();
  };

  const ondrop = async (e: DragEvent) => {
    if (isInternalDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    fileDropManager.reset();
    await handleFiles(await getFilesFromDataTransfer(e.dataTransfer));
  };
</script>

<svelte:window onpaste={onPaste} />

<svelte:body {ondragstart} {ondragend} {ondragenter} {ondragleave} {ondragover} {ondrop} />

{#if fileDropManager.dragging}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center"
    transition:fade={{ duration: 150 }}
  >
    <div
      class="flex items-center gap-4 rounded-2xl bg-gray-100/95 px-6 py-4 text-immich-dark-gray shadow-lg ring-1 ring-primary/30 dark:bg-immich-dark-gray/95 dark:text-immich-gray"
    >
      <Logo variant="icon" size="medium" class="animate-bounce" />
      <div>
        <div class="text-lg font-medium">{$t('drop_files_to_upload')}</div>
        <div class="text-sm opacity-80">
          Drop onto an album in the sidebar or an album chip on Photos to upload into it
        </div>
      </div>
    </div>
  </div>
{/if}
