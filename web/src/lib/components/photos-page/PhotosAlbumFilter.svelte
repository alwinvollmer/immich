<script lang="ts">
  // custom: album chips above the Photos timeline; the timeline shows assets in
  // ANY ticked album, or everything when none is ticked.
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { albumDropTarget } from '$lib/actions/album-drop-target';
  import SearchButton from '$lib/components/shared-components/search-bar/SearchButton.svelte';
  import { photosAlbumFilter } from '$lib/managers/photos-album-filter.svelte';

  const DEFAULT_ALBUM_NAMES = new Set(['camera']);

  let albums = $state<AlbumResponseDto[]>([]);

  onMount(async () => {
    const all = await getAllAlbums({});
    albums = [...all].sort((a, b) => a.albumName.localeCompare(b.albumName, undefined, { sensitivity: 'base' }));

    if (!photosAlbumFilter.hasSaved) {
      photosAlbumFilter.set(
        albums.filter((album) => DEFAULT_ALBUM_NAMES.has(album.albumName.toLowerCase())).map((album) => album.id),
      );
      return;
    }

    // drop albums that were deleted since the selection was saved
    const existing = new Set(albums.map((album) => album.id));
    const selected = photosAlbumFilter.albumIds;
    if (selected.some((id) => !existing.has(id))) {
      photosAlbumFilter.set(selected.filter((id) => existing.has(id)));
    }
  });
</script>

{#if albums.length > 0}
  <div id="photos-album-filter" class="flex flex-wrap gap-2 px-2 pt-2 pb-4">
    {#each albums as album (album.id)}
      <!-- files dropped on a chip are uploaded into that album -->
      <span
        use:albumDropTarget={album.id}
        class="rounded-full data-drop-active:ring-2 data-drop-active:ring-primary data-drop-active:ring-offset-2"
      >
        <SearchButton
          checked
          active={photosAlbumFilter.albumIds.includes(album.id)}
          onclick={() => photosAlbumFilter.toggle(album.id)}>{album.albumName}</SearchButton
        >
      </span>
    {/each}
  </div>
{/if}
