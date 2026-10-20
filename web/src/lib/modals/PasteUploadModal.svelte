<script lang="ts">
  // custom: shown on Ctrl+V with images in the clipboard; lets the user optionally
  // pick one album to upload into. onClose() without a result = cancel.
  import SearchButton from '$lib/components/shared-components/search-bar/SearchButton.svelte';
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { Button, Modal, ModalBody, ModalFooter, Text } from '@immich/ui';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    files: File[];
    defaultAlbumId?: string;
    onClose: (result?: { albumId?: string }) => void;
  };

  let { files, defaultAlbumId, onClose }: Props = $props();

  const MAX_PREVIEWS = 4;

  let albums = $state<AlbumResponseDto[]>([]);
  let selectedAlbumId = $state<string | undefined>(defaultAlbumId);
  const previews = files
    .filter((file) => file.type.startsWith('image/'))
    .slice(0, MAX_PREVIEWS)
    .map((file) => URL.createObjectURL(file));

  onMount(async () => {
    const all = await getAllAlbums({});
    albums = [...all].sort((a, b) => a.albumName.localeCompare(b.albumName, undefined, { sensitivity: 'base' }));
  });

  onDestroy(() => {
    for (const url of previews) {
      URL.revokeObjectURL(url);
    }
  });

  const upload = () => onClose({ albumId: selectedAlbumId });

  const onkeydown = (event: KeyboardEvent) => {
    // a focused button (Cancel, an album chip) handles Enter itself
    if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      upload();
    }
  };
</script>

<svelte:window {onkeydown} />

<Modal
  title={files.length === 1 ? 'Upload pasted image' : `Upload ${files.length} pasted files`}
  {onClose}
  size="small"
>
  <ModalBody>
    {#if previews.length > 0}
      <div class="mb-4 flex flex-wrap justify-center gap-2">
        {#each previews as src (src)}
          <img {src} alt="" class="max-h-40 max-w-full rounded-lg object-contain" />
        {/each}
      </div>
    {/if}
    <Text class="pb-2" fontWeight="medium">{$t('albums')}</Text>
    <Text size="small" class="pb-3 opacity-80">Optional: pick an album to upload into.</Text>
    <div class="flex max-h-60 flex-wrap gap-2 overflow-y-auto">
      {#each albums as album (album.id)}
        <SearchButton
          checked
          active={selectedAlbumId === album.id}
          onclick={() => (selectedAlbumId = selectedAlbumId === album.id ? undefined : album.id)}
          >{album.albumName}</SearchButton
        >
      {/each}
    </div>
  </ModalBody>
  <ModalFooter>
    <div class="flex w-full justify-end gap-2">
      <Button shape="round" variant="outline" color="secondary" onclick={() => onClose()}>{$t('cancel')}</Button>
      <Button shape="round" onclick={upload}>{$t('upload')}</Button>
    </div>
  </ModalFooter>
</Modal>
