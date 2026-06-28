import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { Platform, PlatformUser, PlatformProfile, LoadedProject } from './types';
import type { Project, Collection } from '../types';
import { toSlug, docVaultSegments, colVaultSegments } from './slugify';
import { richContentToMarkdown, type ResolvedLink } from './docMarkdown';
import { buildDatasetFile } from '../dialogueExport';
import { createSeedProject, DEFAULT_PROJECT_NAME } from './seedProject';
import { getExperience } from '../persona';
import type { EntityLink } from '../types';

const VAULT_KEY = 'evenstory_vault_path';
const RECENT_KEY = 'evenstory_recent_vaults';
const LOCAL_USER: PlatformUser = { id: 'local', email: undefined };

// ── Vault path helpers (exported so App.tsx can use them) ──────────────────

export function getVaultPath(): string | null {
  return localStorage.getItem(VAULT_KEY);
}

export function setVaultPath(path: string): void {
  localStorage.setItem(VAULT_KEY, path);
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

// Turn a project name into a safe single folder segment (keeps spaces/case).
function safeFolderName(name: string): string {
  const cleaned = (name || '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || DEFAULT_PROJECT_NAME;
}

// ── Recent vaults ──────────────────────────────────────────────────────────

export interface RecentVault {
  path: string;
  name: string;
  lastOpened: number;
}

export function getRecentVaults(): RecentVault[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((v) => v && typeof v.path === 'string')
      .map((v) => ({ path: v.path, name: typeof v.name === 'string' ? v.name : basename(v.path), lastOpened: Number(v.lastOpened) || 0 }))
      .sort((a, b) => b.lastOpened - a.lastOpened);
  } catch {
    return [];
  }
}

function saveRecentVaults(list: RecentVault[]): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}

export function addRecentVault(path: string, name?: string): void {
  const clean = path.replace(/[/\\]+$/, '');
  const rest = getRecentVaults().filter((v) => v.path !== clean);
  const prevName = getRecentVaults().find((v) => v.path === clean)?.name;
  saveRecentVaults([{ path: clean, name: name || prevName || basename(clean), lastOpened: Date.now() }, ...rest]);
}

export function updateRecentVaultName(path: string, name: string | undefined | null): void {
  if (!name) return;
  const clean = path.replace(/[/\\]+$/, '');
  const list = getRecentVaults().map((v) => (v.path === clean ? { ...v, name } : v));
  saveRecentVaults(list);
}

export function removeRecentVault(path: string): void {
  saveRecentVaults(getRecentVaults().filter((v) => v.path !== path));
}

// True if a folder actually contains a vault (.evenstory/project.json).
export async function vaultExists(path: string): Promise<boolean> {
  try {
    return await fsExists(projectFilePath(path));
  } catch {
    return false;
  }
}

// Walk UP from a picked folder looking for an existing vault (handles the user
// drilling too deep). Returns the vault root if found within a few levels, else null.
export async function resolveVaultRoot(picked: string): Promise<string | null> {
  let dir = picked.replace(/[/\\]+$/, '');
  for (let i = 0; i < 6; i++) {
    if (await vaultExists(dir)) return dir;
    const idx = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    if (idx <= 0) break;
    const parent = dir.slice(0, idx);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Open an EXISTING vault. Returns null if cancelled. Throws NOT_A_VAULT_ERROR
// if the picked folder isn't (and isn't inside) a vault — we never adopt an
// arbitrary folder as a vault here; use createVaultFolder() to make a new one.
export const NOT_A_VAULT_ERROR = 'NOT_A_VAULT';

export async function pickVaultFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  const raw = (selected as string).replace(/[/\\]+$/, '');
  // If they picked somewhere inside an existing vault, snap to the vault root.
  const existing = await resolveVaultRoot(raw);
  if (!existing) throw new Error(NOT_A_VAULT_ERROR);
  setVaultPath(existing);
  addRecentVault(existing);
  return existing;
}

// Create a NEW vault. The user picks a PARENT folder and we create a dedicated
// vault subfolder inside it — we never adopt the picked folder itself as the
// vault root. This is a safety measure: deleting a project trashes the whole
// vault folder, so turning e.g. Downloads into the vault root would trash
// everything in Downloads. Returns the new vault root, or null if cancelled.
export async function createVaultFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  const parent = (selected as string).replace(/[/\\]+$/, '');

  // If they picked an existing vault (or somewhere inside one), just open it
  // rather than nesting a new vault within it.
  const existing = await resolveVaultRoot(parent);
  if (existing) {
    setVaultPath(existing);
    addRecentVault(existing);
    return existing;
  }

  // Pick a unique subfolder name inside the chosen parent.
  const base = DEFAULT_PROJECT_NAME;
  let name = base;
  for (let n = 2; await fsExists(joinPath(parent, name)); n++) {
    name = `${base} ${n}`;
  }
  const root = joinPath(parent, name);
  await fsMkdir(evenstoryDir(root)); // creates the vault root + .evenstory
  setVaultPath(root);
  addRecentVault(root);
  return root;
}

// Rename the on-disk vault folder to match a new project name, keeping it inside
// the same parent. Updates the stored vault path + recents entry. Returns the new
// vault root path. Best-effort: on any failure it leaves things untouched and
// returns the current path. (No-op on the web.)
export async function renameVaultFolder(newName: string): Promise<string | null> {
  const current = getVaultPath();
  if (!current) return null;

  try {
    const parent = parentDir(current);
    const desired = safeFolderName(newName);
    if (desired === basename(current)) return current; // already matches

    // Find a unique target name within the parent folder.
    let target = desired;
    for (let n = 2; await fsExists(joinPath(parent, target)); n++) {
      target = `${desired} ${n}`;
    }
    const newPath = joinPath(parent, target);
    if (newPath === current) return current;

    await fsRename(current, newPath);

    // Move the localStorage pointers from the old path to the new one.
    const prevName = getRecentVaults().find((v) => v.path === current)?.name;
    removeRecentVault(current);
    setVaultPath(newPath);
    addRecentVault(newPath, newName || prevName);
    return newPath;
  } catch (e) {
    console.warn('renameVaultFolder failed:', e);
    return current;
  }
}

// Open a previously-used vault. Returns false if it can no longer be found.
export async function openRecentVault(path: string): Promise<boolean> {
  if (!(await vaultExists(path))) return false;
  setVaultPath(path);
  addRecentVault(path);
  return true;
}

// ── Path helpers ───────────────────────────────────────────────────────────

// Join path segments with "/" (Windows accepts forward slashes, and our Rust
// fs commands pass straight to std::fs which handles mixed separators). Trims
// stray separators so we never produce "a//b". Keeps the first segment's root
// (e.g. "C:\\Users\\x" or "/Users/x") intact.
function joinPath(...parts: Array<string | undefined>): string {
  const segs = parts.map((p) => String(p ?? "")).filter((p, i) => p.length > 0 || i === 0);
  return segs
    .map((s, i) => {
      if (i > 0) s = s.replace(/^[/\\]+/, "");
      if (i < segs.length - 1) s = s.replace(/[/\\]+$/, "");
      return s;
    })
    .join("/");
}

function evenstoryDir(vault: string): string {
  return joinPath(vault, ".evenstory");
}

function projectFilePath(vault: string): string {
  return joinPath(vault, ".evenstory", "project.json");
}

// ── Rust command wrappers ──────────────────────────────────────────────────

async function fsExists(path: string): Promise<boolean> {
  return invoke<boolean>('file_exists', { path });
}

async function fsRead(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

async function fsWrite(path: string, content: string): Promise<void> {
  return invoke('write_file', { path, content });
}

async function fsMkdir(path: string): Promise<void> {
  return invoke('create_dir_all', { path });
}

async function fsRename(from: string, to: string): Promise<void> {
  return invoke('rename_path', { from, to });
}

// ── Sync link metadata (vault <-> web project) ──────────────────────────────
export interface VaultSyncMeta {
  webProjectId: string;
  accountId: string;
  lastSyncedAt?: string;
  // Hash of the project as it was at the last sync, so we can detect local edits
  // made since (even across app restarts).
  syncedHash?: string;
  // Web storage paths of assets already uploaded at the last sync, so a push only
  // re-uploads new/changed assets instead of every asset every time.
  syncedAssetPaths?: string[];
}

export async function getVaultSyncMeta(vault?: string): Promise<VaultSyncMeta | null> {
  const v = vault ?? getVaultPath();
  if (!v) return null;
  const path = joinPath(evenstoryDir(v), "sync.json");
  try {
    if (!(await fsExists(path))) return null;
    return JSON.parse(await fsRead(path)) as VaultSyncMeta;
  } catch {
    return null;
  }
}

export async function setVaultSyncMeta(meta: VaultSyncMeta, vault?: string): Promise<void> {
  const v = vault ?? getVaultPath();
  if (!v) return;
  await fsMkdir(evenstoryDir(v));
  await fsWrite(joinPath(evenstoryDir(v), "sync.json"), JSON.stringify(meta, null, 2));
}

// ── Asset helpers ──────────────────────────────────────────────────────────

function vaultAssetPath(vault: string, storagePath: string): string {
  return joinPath(vault, "assets", storagePath);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

// ── Export builders ────────────────────────────────────────────────────────

// Builds a link resolver bound to a document's folder depth, so relative paths
// back to collections/ are correct for grouped (nested) documents.
function makeLinkResolver(project: Project, doc: Project['documents'][number]) {
  const upToRoot = '../'.repeat(docVaultSegments(doc.folderPath, doc.title).length);
  return (collectionId: string, entityId: string): ResolvedLink | null => {
    const col = project.collections.find(c => c.id === collectionId);
    if (!col) return null;
    const row = col.rows.find(r => r.id === entityId);
    const anchor = String(row?.values['id'] ?? entityId);
    return { path: `${upToRoot}tables/${colVaultSegments(col.folderPath, col.name).join('/')}.json`, anchor };
  };
}

// Fallback for documents with no rich content: inject links into plain text.
function injectEntityLinksPlain(
  content: string,
  links: EntityLink[],
  resolve: (c: string, e: string) => ResolvedLink | null,
): string {
  const ordered = links
    .filter(l => l.start >= 0 && l.end <= content.length && l.start < l.end)
    .slice()
    .sort((a, b) => b.start - a.start); // right-to-left so offsets stay valid
  let result = content;
  for (const link of ordered) {
    const resolved = resolve(link.collectionId, link.entityId);
    if (!resolved) continue;
    const text = content.slice(link.start, link.end);
    const md = `[${text}](${resolved.path}#${resolved.anchor})`;
    result = result.slice(0, link.start) + md + result.slice(link.end);
  }
  return result;
}

function buildDocumentMarkdown(project: Project, doc: Project['documents'][number]): string {
  const lines: string[] = [];
  if (doc.title) lines.push(`# ${doc.title}`, '');

  const resolve = makeLinkResolver(project, doc);
  const links = doc.entityLinks ?? [];

  // Prefer rich content (preserves headings/bold/italic/lists); fall back to plain text.
  let body = richContentToMarkdown(doc.richContent, links, resolve);
  if (body === null) body = injectEntityLinksPlain(doc.content ?? '', links, resolve);

  if (body) lines.push(body);
  return lines.join('\n');
}

function buildCollectionExport(collection: Collection): Record<string, unknown>[] {
  return collection.rows.map(row => {
    const obj: Record<string, unknown> = {};
    for (const field of collection.schema) {
      obj[field.label] = row.values[field.id] ?? '';
    }
    return obj;
  });
}

async function syncRenames(vault: string, prev: Project, next: Project): Promise<void> {
  for (const nextCol of next.collections) {
    const prevCol = prev.collections.find(c => c.id === nextCol.id);
    if (!prevCol) continue;

    const oldColParts = colVaultSegments(prevCol.folderPath, prevCol.name);
    const newColParts = colVaultSegments(nextCol.folderPath, nextCol.name);
    const oldColSlug = oldColParts.join('/');
    const newColSlug = newColParts.join('/');

    // Entity key renames — do inside old collection folder first
    for (const nextRow of nextCol.rows) {
      const prevRow = prevCol.rows.find(r => r.id === nextRow.id);
      if (!prevRow) continue;
      const oldKey = String(prevRow.values['id'] ?? '');
      const newKey = String(nextRow.values['id'] ?? '');
      if (oldKey && newKey && oldKey !== newKey) {
        await fsRename(
          joinPath(vault, "assets", oldColSlug, oldKey),
          joinPath(vault, "assets", oldColSlug, newKey),
        ).catch((e) => console.warn('entity folder rename failed:', e));
      }
    }

    // Collection rename / regroup / move
    if (oldColSlug !== newColSlug) {
      if (newColParts.length > 1) {
        const parent = newColParts.slice(0, -1).join('/');
        await fsMkdir(joinPath(vault, "assets", parent)).catch(() => {});
        await fsMkdir(joinPath(vault, "tables", parent)).catch(() => {});
      }
      await fsRename(joinPath(vault, "assets", oldColSlug), joinPath(vault, "assets", newColSlug))
        .catch((e) => console.warn('collection assets rename failed:', e));
      await fsRename(joinPath(vault, "tables", `${oldColSlug}.json`), joinPath(vault, "tables", `${newColSlug}.json`))
        .catch((e) => console.warn('collection json rename failed:', e));
    }
  }

  // Document renames/moves (folder path or leaf name changes)
  for (const nextDoc of next.documents) {
    const prevDoc = prev.documents.find(d => d.id === nextDoc.id);
    if (!prevDoc) continue;
    const oldParts = docVaultSegments(prevDoc.folderPath, prevDoc.title);
    const newParts = docVaultSegments(nextDoc.folderPath, nextDoc.title);
    if (oldParts.join('/') !== newParts.join('/')) {
      if (newParts.length > 1) {
        await fsMkdir(joinPath(vault, "documents", newParts.slice(0, -1).join('/'))).catch(() => {});
      }
      await fsRename(joinPath(vault, "documents", `${oldParts.join('/')}.md`), joinPath(vault, "documents", `${newParts.join('/')}.md`))
        .catch((e) => console.warn('document rename failed:', e));
    }
  }
}

async function writeGameFiles(vault: string, project: Project): Promise<void> {
  // Every condition (incl. Dialogue) is written to conditions/<slug>.json.
  const datasets = project.datasets ?? [];
  await fsMkdir(joinPath(vault, "conditions"));
  const usedFiles = new Set<string>();
  for (const ds of datasets) {
    let slug = toSlug(ds.name) || ds.id;
    while (usedFiles.has(`${slug}.json`)) slug = `${slug}_2`;
    usedFiles.add(`${slug}.json`);
    await fsWrite(joinPath(vault, "conditions", `${slug}.json`), JSON.stringify(buildDatasetFile(project, ds), null, 2));
  }

  // Prune stale condition files (from renamed/deleted conditions) so the folder mirrors state.
  try {
    const existing = await invoke<string[]>('list_dir', { path: joinPath(vault, "conditions") });
    for (const name of existing) {
      if (name.endsWith('.json') && !usedFiles.has(name)) {
        await invoke('delete_file', { path: joinPath(vault, "conditions", name) }).catch(() => {});
      }
    }
  } catch { /* list_dir unavailable on older desktop builds */ }

  // Migrate away from the old folder names (dialogue/ and the earlier datasets/).
  for (const old of ["dialogue", "datasets"]) {
    if (await fsExists(joinPath(vault, old))) {
      await invoke('trash_path', { path: joinPath(vault, old) }).catch(() => {});
    }
  }

  // One-time migration: the tables folder was previously named "collections".
  if ((await fsExists(joinPath(vault, "collections"))) && !(await fsExists(joinPath(vault, "tables")))) {
    await fsRename(joinPath(vault, "collections"), joinPath(vault, "tables")).catch(() => {});
  }

  await fsMkdir(joinPath(vault, "tables"));
  for (const collection of project.collections) {
    const parts = colVaultSegments(collection.folderPath, collection.name);
    if (parts.length > 1) {
      await fsMkdir(joinPath(vault, "tables", parts.slice(0, -1).join('/')));
    }
    await fsWrite(
      joinPath(vault, "tables", `${parts.join('/')}.json`),
      JSON.stringify(buildCollectionExport(collection), null, 2),
    );
  }

  await fsMkdir(joinPath(vault, "documents"));
  for (const doc of project.documents) {
    const parts = docVaultSegments(doc.folderPath, doc.title);
    if (parts.length > 1) {
      await fsMkdir(joinPath(vault, "documents", parts.slice(0, -1).join('/')));
    }
    await fsWrite(
      joinPath(vault, "documents", `${parts.join('/')}.md`),
      buildDocumentMarkdown(project, doc),
    );
  }

  // Clean up any empty folders left behind by renames/regroups
  await invoke('prune_empty_dirs', { path: joinPath(vault, "assets") }).catch(() => {});
  await invoke('prune_empty_dirs', { path: joinPath(vault, "tables") }).catch(() => {});
  await invoke('prune_empty_dirs', { path: joinPath(vault, "documents") }).catch(() => {});

  // Recreate explicitly-created (possibly empty) folders so they persist on disk.
  for (const folder of project.documentFolders ?? []) {
    if (folder.length) await fsMkdir(joinPath(vault, "documents", folder.map(toSlug).join('/'))).catch(() => {});
  }
  for (const folder of project.collectionFolders ?? []) {
    if (folder.length) await fsMkdir(joinPath(vault, "tables", folder.map(toSlug).join('/'))).catch(() => {});
  }
}

// ── Platform implementation ────────────────────────────────────────────────

export const desktopPlatform: Platform = {
  async openExternal(url: string): Promise<void> {
    await invoke('open_url', { url });
  },

  async getUser(): Promise<PlatformUser | null> {
    return LOCAL_USER;
  },

  async signOut(): Promise<void> {},

  async loadProfile(_userId: string): Promise<PlatformProfile | null> {
    return { username: 'Local', avatarPath: null, isPro: true };
  },

  // Desktop is vault-based; multi-project is a web concept. These keep the
  // Platform interface satisfied.
  async listProjects(): Promise<{ id: string; name: string; updatedAt?: string }[]> {
    const vault = getVaultPath();
    return vault ? [{ id: vault, name: basename(vault) }] : [];
  },
  async createProject(_userId: string, _project: Project): Promise<LoadedProject> {
    throw new Error('createProject is not supported on desktop (use the vault flow).');
  },

  async loadProject(_userId: string, _preferredId?: string): Promise<LoadedProject | null> {
    const vault = getVaultPath();
    if (!vault) return null;

    try {
      // If the vault folder itself is gone, clear the stale path
      if (!(await fsExists(vault))) {
        localStorage.removeItem(VAULT_KEY);
        return null;
      }

      const filePath = projectFilePath(vault);
      const fileExists = await fsExists(filePath);

      if (!fileExists) {
        const blank = createSeedProject(DEFAULT_PROJECT_NAME, getExperience());
        await fsMkdir(evenstoryDir(vault));
        await fsWrite(filePath, JSON.stringify(blank, null, 2));
        // Also write the engine-readable files (documents/, tables/, dialogue/) immediately.
        await writeGameFiles(vault, blank).catch((e) => console.warn('seed writeGameFiles failed:', e));
        return { project: blank, rowId: vault };
      }

      const json = await fsRead(filePath);
      const project = JSON.parse(json) as Project;
      return { project, rowId: vault };
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as any)?.message ?? String(e);
      throw new Error(`Vault read failed: ${msg}`);
    }
  },

  async renameCollectionFiles(oldSegments: string[], newSegments: string[]): Promise<void> {
    const vault = getVaultPath();
    if (!vault) return;
    const oldSlug = oldSegments.join('/');
    const newSlug = newSegments.join('/');
    if (oldSlug === newSlug) return;
    if (newSegments.length > 1) {
      const parent = newSegments.slice(0, -1).join('/');
      await fsMkdir(joinPath(vault, "assets", parent)).catch(() => {});
      await fsMkdir(joinPath(vault, "tables", parent)).catch(() => {});
    }
    await fsRename(joinPath(vault, "assets", oldSlug), joinPath(vault, "assets", newSlug)).catch(() => {});
    await fsRename(joinPath(vault, "tables", `${oldSlug}.json`), joinPath(vault, "tables", `${newSlug}.json`)).catch(() => {});
  },

  async renameEntityFolder(colSegments: string[], oldKey: string, newKey: string): Promise<void> {
    const vault = getVaultPath();
    if (!vault) return;
    const colSlug = colSegments.join('/');
    await fsRename(
      joinPath(vault, "assets", colSlug, oldKey),
      joinPath(vault, "assets", colSlug, newKey),
    ).catch(() => {});
  },

  async renameDocumentFile(oldSegments: string[], newSegments: string[]): Promise<void> {
    const vault = getVaultPath();
    if (!vault) return;
    const oldPath = oldSegments.join('/');
    const newPath = newSegments.join('/');
    if (oldPath === newPath) return;
    if (newSegments.length > 1) {
      await fsMkdir(joinPath(vault, "documents", newSegments.slice(0, -1).join('/'))).catch(() => {});
    }
    await fsRename(
      joinPath(vault, "documents", `${oldPath}.md`),
      joinPath(vault, "documents", `${newPath}.md`),
    ).catch(() => {});
  },

  async trashVaultPath(relativePath: string): Promise<void> {
    const vault = getVaultPath();
    if (!vault) return;
    await invoke('trash_path', { path: joinPath(vault, relativePath) }).catch(console.warn);
  },

  async saveProject(rowId: string, project: Project): Promise<void> {
    const vault = rowId;
    try {
      await fsMkdir(evenstoryDir(vault));

      // Diff against the previously saved project to catch any renames
      const filePath = projectFilePath(vault);
      if (await fsExists(filePath)) {
        try {
          const prev = JSON.parse(await fsRead(filePath)) as Project;
          await syncRenames(vault, prev, project);
        } catch (e) {
          console.warn('syncRenames failed:', e);
        }
      }

      await fsWrite(filePath, JSON.stringify(project, null, 2));
      await writeGameFiles(vault, project);
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as any)?.message ?? String(e);
      throw new Error(`Vault write failed: ${msg}`);
    }
  },

  // Moves the entire vault folder to the system Trash and forgets it.
  async deleteProject(rowId: string): Promise<void> {
    const vault = rowId || getVaultPath();
    if (!vault) return;
    await invoke('trash_path', { path: vault });
    removeRecentVault(vault);
    if (getVaultPath() === vault) localStorage.removeItem(VAULT_KEY);
  },

  async uploadAsset(file: File, storagePath: string): Promise<string> {
    const vault = getVaultPath();
    if (!vault) throw new Error('No vault set');
    const absPath = vaultAssetPath(vault, storagePath);
    const base64 = await fileToBase64(file);
    await invoke('write_file_base64', { path: absPath, data: base64 });
    return storagePath;
  },

  async getAssetUrl(storagePath: string): Promise<string> {
    const vault = getVaultPath();
    if (!vault) return '';
    const absPath = vaultAssetPath(vault, storagePath);
    try {
      const base64 = await invoke<string>('read_file_base64', { path: absPath });
      return `data:${guessMime(storagePath)};base64,${base64}`;
    } catch {
      return '';
    }
  },

  async deleteAsset(storagePath: string): Promise<void> {
    const vault = getVaultPath();
    if (!vault) return;
    await invoke('trash_path', { path: vaultAssetPath(vault, storagePath) });
  },

  async readAssetBytes(storagePath: string): Promise<Uint8Array | null> {
    const vault = getVaultPath();
    if (!vault) return null;
    try {
      const base64 = await invoke<string>('read_file_base64', { path: vaultAssetPath(vault, storagePath) });
      return base64ToBytes(base64);
    } catch {
      return null;
    }
  },

  async renameAssetFile(oldStoragePath: string, newStoragePath: string): Promise<void> {
    const vault = getVaultPath();
    if (!vault || oldStoragePath === newStoragePath) return;
    const from = vaultAssetPath(vault, oldStoragePath);
    const exists = await invoke<boolean>('file_exists', { path: from });
    if (!exists) {
      throw new Error(`File not found in vault: assets/${oldStoragePath}`);
    }
    await invoke('rename_path', { from, to: vaultAssetPath(vault, newStoragePath) });
  },
};
