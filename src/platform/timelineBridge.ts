// Event bridge between the main window (owner of project state) and the
// popped-out timeline window (a view + command sender). Desktop-only.
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Document, Collection, TimelineLabel } from '../types';

export interface TimelineState {
  documents: Document[];
  collections: Collection[];
  labels: TimelineLabel[];
  beatCount?: number;
  covers: Record<number, string>;
  sectionTitles?: Record<number, string>;
}

export type TimelineMutation =
  | { kind: 'insertBeat'; beat: number }
  | { kind: 'removeBeat'; beat: number }
  | { kind: 'moveDoc'; docId: string; position: number }
  | { kind: 'openDoc'; docId: string }
  | { kind: 'addEntityLabel'; position: number; collectionId: string; entityId: string }
  | { kind: 'deleteLabel'; labelId: string }
  | { kind: 'uploadCover'; beat: number; fileName: string; base64: string }
  | { kind: 'removeCover'; beat: number }
  | { kind: 'renameSection'; beat: number; title: string }
  | { kind: 'selectEntity'; collectionId: string; entityId: string };

const STATE_EVENT = 'timeline:state';
const MUTATION_EVENT = 'timeline:mutation';
const REQUEST_EVENT = 'timeline:request-state';

// Main → timeline window
export function emitTimelineState(state: TimelineState): Promise<void> {
  return emit(STATE_EVENT, state);
}
export function onTimelineState(cb: (s: TimelineState) => void): Promise<UnlistenFn> {
  return listen<TimelineState>(STATE_EVENT, (e) => cb(e.payload));
}

// Timeline window → main
export function emitTimelineMutation(m: TimelineMutation): Promise<void> {
  return emit(MUTATION_EVENT, m);
}
export function onTimelineMutation(cb: (m: TimelineMutation) => void): Promise<UnlistenFn> {
  return listen<TimelineMutation>(MUTATION_EVENT, (e) => cb(e.payload));
}

// Timeline window asks main to (re)send the current state, e.g. on mount.
export function requestTimelineState(): Promise<void> {
  return emit(REQUEST_EVENT);
}
export function onTimelineStateRequest(cb: () => void): Promise<UnlistenFn> {
  return listen(REQUEST_EVENT, () => cb());
}
