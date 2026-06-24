import JSZip from 'jszip';
import type { Project } from './types';

// A portable project archive (.rpgproject) is a zip containing:
//   manifest.json   — format/version metadata
//   project.json    — the full Project object (asset references kept as-is)
//   assets/<path>   — the raw bytes of every referenced asset, keyed by its
//                     storage path (the same string used in project.json)
// This lets a project move between the web app (Supabase) and the desktop app
// (local vault); assets are re-keyed into the target's scheme on import.

export const PROJECT_FILE_EXT = 'rpgproject';
const MANIFEST = 'manifest.json';
const PROJECT_JSON = 'project.json';
const ASSET_DIR = 'assets';

export interface ProjectManifest {
  format: string;
  version: number;
  exportedFrom?: 'web' | 'desktop';
  exportedAt?: string;
  appName?: string;
}

export interface ProjectArchive {
  project: Project;
  manifest: ProjectManifest;
  assetBytes: Map<string, Uint8Array>;
}

// Every place a Project stores an asset storage path.
export function collectAssetPaths(project: Project): string[] {
  const set = new Set<string>();
  for (const c of project.collections ?? []) {
    for (const r of c.rows ?? []) {
      for (const a of r.assets ?? []) if (a?.path) set.add(a.path);
    }
  }
  const covers = project.view?.timelineCovers ?? {};
  for (const k of Object.keys(covers)) {
    const p = covers[Number(k)];
    if (p) set.add(p);
  }
  for (const m of project.worldMaps ?? []) if (m?.imagePath) set.add(m.imagePath);
  if (project.view?.worldMapImagePath) set.add(project.view.worldMapImagePath);
  return [...set];
}

export async function buildProjectArchive(
  project: Project,
  exportedFrom: 'web' | 'desktop',
  readBytes: (storagePath: string) => Promise<Uint8Array | null>,
): Promise<{ blob: Blob; missing: string[] }> {
  const zip = new JSZip();

  const manifest: ProjectManifest = {
    format: 'rpgst-project',
    version: 1,
    exportedFrom,
    exportedAt: new Date().toISOString(),
    appName: 'RPG Story Toolkit',
  };
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2));
  zip.file(PROJECT_JSON, JSON.stringify(project, null, 2));

  const assets = zip.folder(ASSET_DIR)!;
  const missing: string[] = [];
  for (const path of collectAssetPaths(project)) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await readBytes(path);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      missing.push(path);
      continue;
    }
    assets.file(path, bytes);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, missing };
}

export async function readProjectArchive(file: Blob): Promise<ProjectArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("That file isn't a valid project archive.");
  }

  const projFile = zip.file(PROJECT_JSON);
  if (!projFile) throw new Error('Not a valid project file (missing project.json).');

  let project: Project;
  try {
    project = JSON.parse(await projFile.async('string')) as Project;
  } catch {
    throw new Error('The project file is corrupted (invalid project.json).');
  }

  let manifest: ProjectManifest = { format: 'rpgst-project', version: 1 };
  const mf = zip.file(MANIFEST);
  if (mf) {
    try {
      manifest = JSON.parse(await mf.async('string')) as ProjectManifest;
    } catch {
      /* keep default */
    }
  }

  const assetBytes = new Map<string, Uint8Array>();
  const entries: JSZip.JSZipObject[] = [];
  zip.forEach((relPath, entry) => {
    if (!entry.dir && relPath.startsWith(ASSET_DIR + '/')) entries.push(entry);
  });
  for (const entry of entries) {
    const rel = entry.name.slice(ASSET_DIR.length + 1);
    assetBytes.set(rel, await entry.async('uint8array'));
  }

  return { project, manifest, assetBytes };
}
