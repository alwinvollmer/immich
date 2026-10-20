// custom: the Photos page album filter, kept in localStorage. null = never set
// (the filter bar then applies its default); [] = no filter (all photos).
import { PersistedLocalStorage } from '$lib/utils/persisted';

const isAlbumIds = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.every((id) => typeof id === 'string'));

class PhotosAlbumFilter {
  #saved = new PersistedLocalStorage<string[] | null>('photos-album-ids', null, { valid: isAlbumIds });

  get albumIds(): string[] {
    return this.#saved.current ?? [];
  }

  get hasSaved() {
    return this.#saved.current !== null;
  }

  set(albumIds: string[]) {
    this.#saved.current = albumIds;
  }

  toggle(albumId: string) {
    const current = this.albumIds;
    this.#saved.current = current.includes(albumId) ? current.filter((id) => id !== albumId) : [...current, albumId];
  }
}

export const photosAlbumFilter = new PhotosAlbumFilter();
