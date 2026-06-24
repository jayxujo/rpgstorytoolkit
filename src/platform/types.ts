import type { Project } from '../types';

export interface PlatformUser {
  id: string;
  email?: string;
}

export interface PlatformProfile {
  username: string;
  avatarPath: string | null;
  isPro: boolean;
}

export interface LoadedProject {
  project: Project;
  rowId: string; // Supabase row ID on web; vault folder path on desktop
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt?: string;
}

export interface Platform {
  // Auth
  getUser(): Promise<PlatformUser | null>;
  signOut(): Promise<void>;

  // Profile
  loadProfile(userId: string): Promise<PlatformProfile | null>;

  // Project
  // `preferredId` (web) loads that specific project if it belongs to the user.
  loadProject(userId: string, preferredId?: string): Promise<LoadedProject | null>;
  saveProject(rowId: string, project: Project): Promise<void>;
  // Multi-project (web). Desktop is vault-based and stubs these.
  listProjects(userId: string): Promise<ProjectSummary[]>;
  createProject(userId: string, project: Project): Promise<LoadedProject>;
  // Permanently delete the project. Web: deletes the row. Desktop: trashes the vault folder.
  deleteProject(rowId: string): Promise<void>;

  // Immediate rename operations (no-op on web, moves files on desktop).
  // Segments are vault-relative slug paths (folder slugs + leaf slug), no extension.
  renameCollectionFiles(oldSegments: string[], newSegments: string[]): Promise<void>;
  renameEntityFolder(colSegments: string[], oldKey: string, newKey: string): Promise<void>;
  renameDocumentFile(oldSegments: string[], newSegments: string[]): Promise<void>;

  // Immediate delete operations (no-op on web, moves to trash on desktop)
  trashVaultPath(vaultRelativePath: string): Promise<void>;

  // Assets
  uploadAsset(file: File, storagePath: string): Promise<string>;
  getAssetUrl(storagePath: string): Promise<string>;
  deleteAsset(storagePath: string): Promise<void>;
  renameAssetFile(oldStoragePath: string, newStoragePath: string): Promise<void>;
  // Read raw asset bytes (used to bundle assets into a portable project archive).
  // Returns null if the asset can't be found.
  readAssetBytes(storagePath: string): Promise<Uint8Array | null>;
}
