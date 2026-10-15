// Minimal typings for the File System Access API pieces this app uses (not in TS's DOM lib).
export interface DirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  queryPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' }): Promise<PermissionState>;
}

export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

type PickerWindow = Window & { showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirHandle> };

export function hasDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

export function pickDirectory(id: string): Promise<DirHandle> {
  return (window as PickerWindow).showDirectoryPicker!({ mode: 'read', id });
}

const notFound = (name: string) => Object.assign(new Error(`找不到「${name}」`), { name: 'NotFoundError' });

/** getDirectoryHandle with a case-insensitive fallback (osu! folders come from Windows). */
export async function getDir(dir: DirHandle, name: string): Promise<DirHandle> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (e) {
    if ((e as Error).name !== 'NotFoundError' && (e as Error).name !== 'TypeError') throw e;
  }
  const lower = name.toLowerCase();
  for await (const [n, h] of dir.entries()) if (h.kind === 'directory' && n.toLowerCase() === lower) return h;
  throw notFound(name);
}

export async function getFileIn(dir: DirHandle, name: string): Promise<File> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if ((e as Error).name !== 'NotFoundError' && (e as Error).name !== 'TypeError') throw e;
  }
  const lower = name.toLowerCase();
  for await (const [n, h] of dir.entries()) if (h.kind === 'file' && n.toLowerCase() === lower) return h.getFile();
  throw notFound(name);
}

export async function tryGetDir(dir: DirHandle, path: string[]): Promise<DirHandle | null> {
  let d = dir;
  try {
    for (const p of path) d = await getDir(d, p);
    return d;
  } catch (e) {
    if ((e as Error).name === 'NotFoundError') return null;
    throw e;
  }
}
