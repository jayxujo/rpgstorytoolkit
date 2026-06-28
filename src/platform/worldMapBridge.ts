// Event bridge between the main window (owner of project state) and the
// popped-out world map window (a view + command sender). Desktop-only.
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Document, Collection, WorldMapDocPin, WorldMapLabelPin, WorldNameCtx } from '../types';

export interface WorldMapState {
  imageUrl: string | null;
  worldName: string;
  worldNameCollectionId?: string;
  worldNameEntityId?: string;
  includeInWiki: boolean;
  docPins: WorldMapDocPin[];
  labelPins: WorldMapLabelPin[];
  documents: Document[];
  collections: Collection[];
  savedMaps: { id: string; name: string; hasImage: boolean }[];
  activeMapId: string;
  saveMessage: string | null;
}

export type WorldMapMutation =
  | { kind: 'uploadImage'; fileName: string; base64: string; nameCtx?: WorldNameCtx }
  | { kind: 'setImagePath'; path: string }
  | { kind: 'removeImage' }
  | { kind: 'makeNewMap' }
  | { kind: 'loadMap'; id: string }
  | { kind: 'selectRecord'; collectionId: string; entityId: string; name: string }
  | { kind: 'clearDocPins' }
  | { kind: 'clearLabelPins' }
  | { kind: 'setWorldName'; name: string; collectionId?: string; entityId?: string }
  | { kind: 'setIncludeInWiki'; include: boolean }
  | { kind: 'addDocPin'; docId: string; x: number; y: number }
  | { kind: 'moveDocPin'; pinId: string; x: number; y: number }
  | { kind: 'removeDocPin'; pinId: string }
  | { kind: 'addLabelPin'; collectionId: string; entityId: string; x: number; y: number }
  | { kind: 'moveLabelPin'; pinId: string; x: number; y: number }
  | { kind: 'removeLabelPin'; pinId: string }
  | { kind: 'setDocPinBorder'; pinId: string; border: { x: number; y: number }[] | null }
  | { kind: 'setLabelPinBorder'; pinId: string; border: { x: number; y: number }[] | null }
  | { kind: 'openDoc'; docId: string }
  | { kind: 'openRecord'; collectionId: string; entityId: string }
  | { kind: 'save' };

const STATE_EVENT = 'worldmap:state';
const MUTATION_EVENT = 'worldmap:mutation';
const REQUEST_EVENT = 'worldmap:request-state';

export function emitWorldMapState(state: WorldMapState): Promise<void> {
  return emit(STATE_EVENT, state);
}
export function onWorldMapState(cb: (s: WorldMapState) => void): Promise<UnlistenFn> {
  return listen<WorldMapState>(STATE_EVENT, (e) => cb(e.payload));
}

export function emitWorldMapMutation(m: WorldMapMutation): Promise<void> {
  return emit(MUTATION_EVENT, m);
}
export function onWorldMapMutation(cb: (m: WorldMapMutation) => void): Promise<UnlistenFn> {
  return listen<WorldMapMutation>(MUTATION_EVENT, (e) => cb(e.payload));
}

export function requestWorldMapState(): Promise<void> {
  return emit(REQUEST_EVENT);
}
export function onWorldMapStateRequest(cb: () => void): Promise<UnlistenFn> {
  return listen(REQUEST_EVENT, () => cb());
}
