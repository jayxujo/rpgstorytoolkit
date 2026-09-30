import { webPlatform } from './web';
import {
  desktopPlatform,
  getVaultPath,
  setVaultPath,
  pickVaultFolder,
  createVaultFolder,
  renameVaultFolder,
  moveVaultFolder,
  NOT_A_VAULT_ERROR,
  getRecentVaults,
  addRecentVault,
  removeRecentVault,
  updateRecentVaultName,
  vaultExists,
  openRecentVault,
  getVaultSyncMeta,
  setVaultSyncMeta,
  getVaultSyncBase,
  setVaultSyncBase,
  writeVaultBackup,
  listVaultBackups,
  readVaultBackup,
  vaultAssetExists,
  type RecentVault,
  type VaultBackup,
} from './desktop';

const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const platform = isDesktop ? desktopPlatform : webPlatform;

export {
  getVaultPath,
  setVaultPath,
  pickVaultFolder,
  createVaultFolder,
  renameVaultFolder,
  moveVaultFolder,
  NOT_A_VAULT_ERROR,
  getRecentVaults,
  addRecentVault,
  removeRecentVault,
  updateRecentVaultName,
  vaultExists,
  openRecentVault,
  getVaultSyncMeta,
  setVaultSyncMeta,
  getVaultSyncBase,
  setVaultSyncBase,
  writeVaultBackup,
  listVaultBackups,
  readVaultBackup,
  vaultAssetExists,
};
export type { RecentVault, VaultBackup };
export type { Platform, PlatformUser, PlatformProfile, LoadedProject } from './types';
