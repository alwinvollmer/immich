// custom: makes an element (sidebar album, Photos album chip) a drop target for
// files from the desktop; dropped files are uploaded straight into that album.
// While files hover, the element gets a `data-drop-active` attribute for styling.
import { fileDropManager } from '$lib/managers/file-drop-manager.svelte';
import { getFilesFromDataTransfer, hasFiles } from '$lib/utils/file-drop';
import { fileUploadHandler } from '$lib/utils/file-uploader';

export const albumDropTarget = (node: HTMLElement, albumId: string) => {
  let id = albumId;

  const ondragover = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    node.dataset.dropActive = '';
  };

  const ondragleave = (event: DragEvent) => {
    if (!node.contains(event.relatedTarget as Node | null)) {
      delete node.dataset.dropActive;
    }
  };

  const upload = async (dataTransfer: DataTransfer | null) => {
    const files = await getFilesFromDataTransfer(dataTransfer);
    if (files.length > 0) {
      await fileUploadHandler({ files, albumId: id });
    }
  };

  const ondrop = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    delete node.dataset.dropActive;
    fileDropManager.reset();
    void upload(event.dataTransfer);
  };

  node.addEventListener('dragover', ondragover);
  node.addEventListener('dragleave', ondragleave);
  node.addEventListener('drop', ondrop);

  return {
    update(newAlbumId: string) {
      id = newAlbumId;
    },
    destroy() {
      node.removeEventListener('dragover', ondragover);
      node.removeEventListener('dragleave', ondragleave);
      node.removeEventListener('drop', ondrop);
    },
  };
};
