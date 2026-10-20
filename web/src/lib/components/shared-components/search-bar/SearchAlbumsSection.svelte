<script lang="ts">
  // custom: always-visible album checklist for search. The selection is saved
  // (search-manager) and sent as albumIds, which the fork matches as ANY album.
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import SearchButton from './SearchButton.svelte';

  const DEFAULT_ALBUM_NAMES = new Set(['camera']);

  let albums = $state<AlbumResponseDto[]>([]);
  let selected = $derived(searchManager.filter.albumIds);

  onMount(async () => {
    const all = await getAllAlbums({});
    albums = [...all].sort((a, b) => a.albumName.localeCompare(b.albumName, undefined, { sensitivity: 'base' }));

    if (!searchManager.hasSavedAlbumIds) {
      searchManager.setAlbumIds(
        albums.filter((album) => DEFAULT_ALBUM_NAMES.has(album.albumName.toLowerCase())).map((album) => album.id),
      );
      return;
    }

    // drop albums that were deleted since the selection was saved
    const existing = new Set(albums.map((album) => album.id));
    if ([...selected].some((id) => !existing.has(id))) {
      searchManager.setAlbumIds([...selected].filter((id) => existing.has(id)));
    }
  });
</script>

{#if albums.length > 0}
  <div id="album-selection" class="px-5 pt-5">
    <fieldset>
      <Text class="pb-3" fontWeight="medium">{$t('albums')}</Text>
      <div class="flex flex-wrap gap-2">
        {#each albums as album (album.id)}
          <SearchButton checked active={selected.has(album.id)} onclick={() => searchManager.toggleAlbum(album.id)}
            >{album.albumName}</SearchButton
          >
        {/each}
      </div>
    </fieldset>
  </div>
{/if}
