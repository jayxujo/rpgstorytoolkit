import { supabase } from '../supabaseClient';
import type { Project } from '../types';
import type { Platform, PlatformUser, PlatformProfile, LoadedProject } from './types';
import { createSeedProject, DEFAULT_PROJECT_NAME } from './seedProject';

const blankProject = () => createSeedProject();

export const webPlatform: Platform = {
  async getUser(): Promise<PlatformUser | null> {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;
    return { id: data.user.id, email: data.user.email };
  },

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  },

  async loadProfile(userId: string): Promise<PlatformProfile | null> {
    const { data } = await supabase
      .from('profiles')
      .select('username, avatar_path, is_pro')
      .eq('id', userId)
      .maybeSingle();
    if (!data) return null;
    return {
      username: data.username ?? '',
      avatarPath: data.avatar_path ?? null,
      isPro: data.is_pro ?? false,
    };
  },

  async loadProject(userId: string, preferredId?: string): Promise<LoadedProject | null> {
    let data: any = null;

    // Prefer the explicitly requested project (e.g. the last one the user opened).
    if (preferredId) {
      const res = await supabase
        .from('projects')
        .select('id, name, data')
        .eq('id', preferredId)
        .eq('user_id', userId)
        .maybeSingle();
      data = res.data ?? null;
    }

    // Otherwise fall back to the earliest project.
    if (!data) {
      const res = await supabase
        .from('projects')
        .select('id, name, data')
        .eq('user_id', userId)
        .order('created_at')
        .limit(1)
        .maybeSingle();
      data = res.data ?? null;
    }

    // First-ever load for this user: seed a starter project.
    if (!data) {
      const fresh = blankProject();
      const { data: inserted } = await supabase
        .from('projects')
        .insert({ user_id: userId, name: DEFAULT_PROJECT_NAME, data: fresh })
        .select('id, name, data')
        .single();
      data = inserted;
    }

    if (!data) return null;
    return { project: data.data as Project, rowId: data.id as string };
  },

  async listProjects(userId: string): Promise<{ id: string; name: string; updatedAt?: string }[]> {
    const { data } = await supabase
      .from('projects')
      .select('id, name, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    return (data ?? []).map((r: any) => ({
      id: r.id as string,
      name: (r.name as string) ?? 'Untitled',
      updatedAt: r.updated_at as string | undefined,
    }));
  },

  async createProject(userId: string, project: Project): Promise<LoadedProject> {
    const { data, error } = await supabase
      .from('projects')
      .insert({ user_id: userId, name: project.name, data: project })
      .select('id, name, data')
      .single();
    if (error || !data) throw error ?? new Error('Failed to create project.');
    return { project: data.data as Project, rowId: data.id as string };
  },

  async renameCollectionFiles(_oldSegments: string[], _newSegments: string[]): Promise<void> {},
  async renameEntityFolder(_colSegments: string[], _oldKey: string, _newKey: string): Promise<void> {},
  async renameDocumentFile(_oldSegments: string[], _newSegments: string[]): Promise<void> {},
  async trashVaultPath(_path: string): Promise<void> {},

  async saveProject(rowId: string, project: Project): Promise<void> {
    await supabase
      .from('projects')
      .update({ name: project.name, data: project, updated_at: new Date().toISOString() })
      .eq('id', rowId);
  },

  async deleteProject(rowId: string): Promise<void> {
    const { error } = await supabase.from('projects').delete().eq('id', rowId);
    if (error) throw error;
  },

  async uploadAsset(file: File, storagePath: string): Promise<string> {
    const { error } = await supabase.storage
      .from('assets')
      .upload(storagePath, file, { upsert: true });
    if (error) throw error;
    return storagePath;
  },

  async getAssetUrl(storagePath: string): Promise<string> {
    const { data } = await supabase.storage
      .from('assets')
      .createSignedUrl(storagePath, 60 * 60);
    return data?.signedUrl ?? '';
  },

  async deleteAsset(storagePath: string): Promise<void> {
    await supabase.storage.from('assets').remove([storagePath]);
  },

  async renameAssetFile(oldStoragePath: string, newStoragePath: string): Promise<void> {
    // Supabase Storage supports move (rename) within a bucket.
    if (oldStoragePath === newStoragePath) return;
    await supabase.storage.from('assets').move(oldStoragePath, newStoragePath);
  },

  async readAssetBytes(storagePath: string): Promise<Uint8Array | null> {
    const { data, error } = await supabase.storage.from('assets').download(storagePath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  },
};
