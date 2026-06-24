import { webPlatform } from './web';
import {
  desktopPlatform,
  getVaultPath,
  setVaultPath,
  pickVaultFolder,
  createVaultFolder,
  renameVaultFolder,
  NOT_A_VAULT_ERROR,
  getRecentVaults,
  addRecentVault,
  removeRecentVault,
  updateRecentVaultName,
  vaultExists,
  openRecentVault,
  getVaultSyncMeta,
  setVaultSyncMeta,
  type RecentVault,
} from './desktop';

const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const platform = isDesktop ? desktopPlatform : webPlatform;

export {
  getVaultPath,
  setVaultPath,
  pickVaultFolder,
  createVaultFolder,
  renameVaultFolder,
  NOT_A_VAULT_ERROR,
  getRecentVaults,
  addRecentVault,
  removeRecentVault,
  updateRecentVaultName,
  vaultExists,
  openRecentVault,
  getVaultSyncMeta,
  setVaultSyncMeta,
};
export type { RecentVault };
export type { Platform, PlatformUser, PlatformProfile, LoadedProject } from './types';
