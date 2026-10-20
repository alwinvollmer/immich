// custom: reading dropped/pasted files (incl. folders), shared by the global drop
// overlay and the album drop targets. Moved unchanged from DragAndDropUploadOverlay.

export const hasFiles = (dataTransfer?: DataTransfer | null) => !!dataTransfer?.types.includes('Files');

const browserSupportsDirectoryUpload = () => typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';

const isFileSystemDirectoryEntry = (entry?: FileSystemEntry): entry is FileSystemDirectoryEntry =>
  !!entry && entry.isDirectory;
const isFileSystemFileEntry = (entry?: FileSystemEntry): entry is FileSystemFileEntry => !!entry && entry.isFile;

const getFileFromFileSystemEntry = async (fileSystemFileEntry: FileSystemFileEntry): Promise<File> => {
  return new Promise((resolve, reject) => {
    fileSystemFileEntry.file(resolve, reject);
  });
};

const readEntriesAsync = (reader: FileSystemDirectoryReader) => {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
};

const getContentsFromFileSystemDirectoryEntry = async (
  fileSystemDirectoryEntry: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> => {
  const reader = fileSystemDirectoryEntry.createReader();
  const files: FileSystemEntry[] = [];
  let entries: FileSystemEntry[];

  do {
    entries = await readEntriesAsync(reader);
    files.push(...entries);
  } while (entries.length > 0);

  return files;
};

const getAllFilesFromTransferEntries = async (transferEntries: FileSystemEntry[]): Promise<File[]> => {
  const allFiles: File[] = [];
  let entriesToCheckForSubDirectories = [...transferEntries];
  while (entriesToCheckForSubDirectories.length > 0) {
    const currentEntry = entriesToCheckForSubDirectories.pop();

    if (isFileSystemDirectoryEntry(currentEntry)) {
      entriesToCheckForSubDirectories = entriesToCheckForSubDirectories.concat(
        await getContentsFromFileSystemDirectoryEntry(currentEntry),
      );
    } else if (isFileSystemFileEntry(currentEntry)) {
      allFiles.push(await getFileFromFileSystemEntry(currentEntry));
    }
  }

  return allFiles;
};

/** All files of a drop or paste, folders expanded recursively where the browser supports it */
export const getFilesFromDataTransfer = async (dataTransfer?: DataTransfer | null): Promise<File[]> => {
  if (!dataTransfer) {
    return [];
  }

  if (!browserSupportsDirectoryUpload()) {
    return Array.from(dataTransfer.files);
  }

  const entries: FileSystemEntry[] = [];
  const files: File[] = [];
  for (const item of dataTransfer.items) {
    const entry = item.webkitGetAsEntry();
    if (entry) {
      entries.push(entry);
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }

  const directoryFiles = await getAllFilesFromTransferEntries(entries);
  return [...files, ...directoryFiles];
};
