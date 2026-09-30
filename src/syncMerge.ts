// Three-way, item-by-item merge of a desktop project with its linked web copy.
//
// Inputs (all the same project, at different points):
//   baseLocal / baseWeb — the project as it was at the last sync, in desktop form
//                         (vault asset paths) and web form (storage asset paths).
//                         null when there's no recorded baseline (older links).
//   local               — the desktop project now.
//   webRaw              — the web project now, exactly as stored on the web.
//   webLocal            — webRaw converted to desktop form (asset paths re-keyed).
//
// Local changes are detected against baseLocal and web changes against baseWeb, so
// each comparison is between the same form and asset-path differences never read as
// edits. Items changed on one side take that side. Items changed on both sides keep
// both versions (the web one as a "(web copy)") so nothing is silently dropped.
// Pure: no Tauri/Supabase imports.
import type { Collection, CollectionRow, Dataset, DatasetEntry, Document, Project } from "./types";

export type MergeConflict = { kind: "document" | "record" | "condition entry"; name: string };

// Per-device UI prefs in `view` — never synced content, always kept from this device.
export const DEVICE_VIEW_KEYS = [
  "uiLayoutMode", "uiFocusView", "uiShowAssetsTree", "uiShowDialogueTree",
  "uiShowLeftPanel", "uiShowMiddlePanel", "uiShowRightPanel",
  "uiPanelSizes", "uiTimelineHeight", "uiCollapsedDocumentGroups",
  "uiCollapsedCollectionGroups", "uiColumnWidths", "activeDatasetId",
];

// Key-order-independent serialization (the web store may reorder JSON keys).
export function stableStringify(v: unknown): string {
  if (v === undefined) return "";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;

// One side's view of an item at the baseline vs now.
type Sides<T> = { hasBase: boolean; b?: T; bw?: T; l?: T; w?: T; wl?: T };

// Whole-value three-way merge. Both changed → keep local.
function merge3<T>(s: Sides<T>): T | undefined {
  const localChanged = s.hasBase ? !same(s.l, s.b) : s.l !== undefined;
  const webChanged = s.hasBase ? !same(s.w, s.bw) : s.w !== undefined;
  if (webChanged && !localChanged) return s.wl;
  return s.l;
}

// Three-way merge of an id-keyed list. Order: local order, then web-only additions
// in web order. `onBoth` resolves an item edited on both sides (default: keep local).
function mergeById<T>(
  hasBase: boolean,
  lists: { b?: T[]; bw?: T[]; l?: T[]; w?: T[]; wl?: T[] },
  key: (t: T) => string,
  onBoth: (s: Required<Pick<Sides<T>, "l" | "wl">> & Sides<T>) => T[] = (s) => [s.l]
): T[] {
  const index = (arr?: T[]) => new Map((arr ?? []).map((t) => [key(t), t] as const));
  const B = index(lists.b), BW = index(lists.bw), L = index(lists.l), W = index(lists.w), WL = index(lists.wl);

  const resolve = (k: string): T[] => {
    const s: Sides<T> = { hasBase: hasBase && B.has(k), b: B.get(k), bw: BW.get(k), l: L.get(k), w: W.get(k), wl: WL.get(k) };
    const localChanged = s.hasBase ? !same(s.l, s.b) : s.l !== undefined;
    const webChanged = s.hasBase ? !same(s.w, s.bw) : s.w !== undefined;
    if (!webChanged) return s.l !== undefined ? [s.l] : [];
    if (!localChanged) return s.wl !== undefined ? [s.wl] : [];
    // Both changed. A deletion never beats an edit.
    if (s.l === undefined) return s.wl !== undefined ? [s.wl] : [];
    if (s.wl === undefined) return [s.l];
    if (same(s.l, s.wl)) return [s.l]; // same edit on both sides
    return onBoth(s as Required<Pick<Sides<T>, "l" | "wl">> & Sides<T>);
  };

  const out: T[] = [];
  for (const t of lists.l ?? []) out.push(...resolve(key(t)));
  for (const t of lists.wl ?? []) if (!L.has(key(t))) out.push(...resolve(key(t)));
  return out;
}

// Folder lists (arrays of path segments): local set, minus web deletions, plus web additions.
function mergeFolders(hasBase: boolean, b?: string[][], w?: string[][], l?: string[][]): string[][] {
  const k = (f: string[]) => JSON.stringify(f);
  const W = new Set((w ?? []).map(k));
  const BW = new Set((b ?? []).map(k));
  const out = new Map((l ?? []).map((f) => [k(f), f] as const));
  if (hasBase) for (const f of b ?? []) if (!W.has(k(f))) out.delete(k(f));
  for (const f of w ?? []) if (!hasBase || !BW.has(k(f))) out.set(k(f), f);
  return [...out.values()];
}

export function mergeProjects(args: {
  baseLocal: Project | null;
  baseWeb: Project | null;
  local: Project;
  webRaw: Project;
  webLocal: Project;
}): { merged: Project; conflicts: MergeConflict[] } {
  const { baseLocal: b, baseWeb: bw, local: l, webRaw: w, webLocal: wl } = args;
  const hasBase = !!b && !!bw;
  const conflicts: MergeConflict[] = [];
  const at = <K extends keyof Project>(k: K) => ({ b: b?.[k], bw: bw?.[k], l: l[k], w: w[k], wl: wl[k] });

  // ── Documents ──
  const documents = mergeById<Document>(hasBase, at("documents"), (d) => d.id, ({ l: ld, wl: wd }) => {
    conflicts.push({ kind: "document", name: ld.title });
    const id = newId("doc");
    const copy: Document = {
      ...structuredClone(wd),
      id,
      title: `${wd.title} (web copy)`,
      entityLinks: (wd.entityLinks ?? []).map((x) => ({ ...x, docId: id })),
      timelinePos: undefined, // don't double-place it on the timeline
    };
    return [ld, copy];
  });

  // ── Tables: metadata per key, schema + rows merged by id ──
  const colsB = new Map((b?.collections ?? []).map((c) => [c.id, c] as const));
  const colsBW = new Map((bw?.collections ?? []).map((c) => [c.id, c] as const));
  const colsW = new Map((w.collections ?? []).map((c) => [c.id, c] as const));
  const collections = mergeById<Collection>(hasBase, at("collections"), (c) => c.id, ({ l: lc, wl: wc }) => {
    const cb = colsB.get(lc.id), cbw = colsBW.get(lc.id), cw = colsW.get(lc.id);
    const has = hasBase && !!cb;
    const out: Collection = { ...lc };
    for (const k of ["name", "folderPath", "color", "kind", "assetsEnabled", "descriptionEnabled"] as const) {
      (out as unknown as Record<string, unknown>)[k] = merge3<unknown>({ hasBase: has, b: cb?.[k], bw: cbw?.[k], l: lc[k], w: cw?.[k], wl: wc[k] });
    }
    out.schema = mergeById(has, { b: cb?.schema, bw: cbw?.schema, l: lc.schema, w: cw?.schema, wl: wc.schema }, (f) => f.id);
    const usedIds = new Set<string>();
    out.rows = mergeById<CollectionRow>(has, { b: cb?.rows, bw: cbw?.rows, l: lc.rows, w: cw?.rows, wl: wc.rows }, (r) => r.id, ({ l: lr, wl: wr }) => {
      const label = String(lr.values?.name || lr.values?.id || lr.id);
      conflicts.push({ kind: "record", name: `${lc.name} / ${label}` });
      const copy: CollectionRow = structuredClone(wr);
      copy.id = newId("row");
      const baseKey = `${String(wr.values?.id || "RECORD")}_WEB`;
      let key = baseKey;
      for (let n = 2; usedIds.has(key) || lc.rows.some((r) => String(r.values?.id) === key); n++) key = `${baseKey}_${n}`;
      usedIds.add(key);
      copy.values = { ...copy.values, id: key };
      if (copy.values.name) copy.values.name = `${copy.values.name} (web copy)`;
      copy.descriptionLinks = copy.descriptionLinks?.map((x) => ({ ...x, docId: copy.id }));
      // Don't share asset files with the original: deleting either record deletes its
      // files. The copy keeps only images the original doesn't already have.
      const localAssetIds = new Set((lr.assets ?? []).map((a) => a.id));
      copy.assets = (copy.assets ?? []).filter((a) => !localAssetIds.has(a.id));
      if (copy.profileAssetId && !copy.assets.some((a) => a.id === copy.profileAssetId)) delete copy.profileAssetId;
      return [lr, copy];
    });
    return [out];
  });

  // ── Conditions: name per key, field defs + entries merged by id ──
  const dsB = new Map((b?.datasets ?? []).map((d) => [d.id, d] as const));
  const dsBW = new Map((bw?.datasets ?? []).map((d) => [d.id, d] as const));
  const dsW = new Map((w.datasets ?? []).map((d) => [d.id, d] as const));
  const datasets = mergeById<Dataset>(hasBase, at("datasets"), (d) => d.id, ({ l: ld, wl: wd }) => {
    const db = dsB.get(ld.id), dbw = dsBW.get(ld.id), dw = dsW.get(ld.id);
    const has = hasBase && !!db;
    return [{
      ...ld,
      name: merge3({ hasBase: has, b: db?.name, bw: dbw?.name, l: ld.name, w: dw?.name, wl: wd.name }) ?? ld.name,
      fieldDefs: mergeById(has, { b: db?.fieldDefs, bw: dbw?.fieldDefs, l: ld.fieldDefs, w: dw?.fieldDefs, wl: wd.fieldDefs }, (f) => f.id),
      entries: mergeById<DatasetEntry>(has, { b: db?.entries, bw: dbw?.entries, l: ld.entries, w: dw?.entries, wl: wd.entries }, (e) => e.id, ({ l: le, wl: we }) => {
        conflicts.push({ kind: "condition entry", name: ld.name });
        return [le, { ...structuredClone(we), id: newId("entry") }];
      }),
    }];
  });

  // ── Simple id-keyed lists (both-edited → keep this device's) ──
  const byId = <T extends { id: string }>(k: "timelineLabels" | "worldMapDocPins" | "worldMapLabelPins" | "worldMaps") =>
    mergeById<T>(hasBase, at(k) as unknown as { b?: T[]; bw?: T[]; l?: T[]; w?: T[]; wl?: T[] }, (x) => x.id);

  const tl = { b: b?.timelineLine, bw: bw?.timelineLine, l: l.timelineLine, w: w.timelineLine, wl: wl.timelineLine };
  const timelineLine = tl.l || tl.wl
    ? {
        docs: mergeById(hasBase, { b: tl.b?.docs, bw: tl.bw?.docs, l: tl.l?.docs, w: tl.w?.docs, wl: tl.wl?.docs }, (d) => d.docId),
        pins: mergeById(hasBase, { b: tl.b?.pins, bw: tl.bw?.pins, l: tl.l?.pins, w: tl.w?.pins, wl: tl.wl?.pins }, (p) => p.id),
      }
    : undefined;

  // ── View: device prefs stay local; content settings merged per key ──
  const view: Record<string, unknown> = {};
  const vKeys = new Set([...Object.keys(l.view ?? {}), ...Object.keys(wl.view ?? {})]);
  for (const k of vKeys) {
    const g = (p?: Project | null) => (p?.view as Record<string, unknown> | undefined)?.[k];
    const v = DEVICE_VIEW_KEYS.includes(k) ? g(l) : merge3({ hasBase, b: g(b), bw: g(bw), l: g(l), w: g(w), wl: g(wl) });
    if (v !== undefined) view[k] = v;
  }

  const handled = new Set([
    "id", "documents", "collections", "datasets", "documentFolders", "collectionFolders", "view",
    "timelineLabels", "timelineLine", "worldMapDocPins", "worldMapLabelPins", "worldMaps",
  ]);
  const merged: Record<string, unknown> = {};
  // Anything else top-level (name, future fields): whole-value three-way.
  for (const k of new Set([...Object.keys(l), ...Object.keys(wl)])) {
    if (handled.has(k)) continue;
    const g = (p?: Project | null) => (p as Record<string, unknown> | null | undefined)?.[k];
    const v = merge3({ hasBase, b: g(b), bw: g(bw), l: g(l), w: g(w), wl: g(wl) });
    if (v !== undefined) merged[k] = v;
  }

  Object.assign(merged, {
    id: l.id,
    documents,
    collections,
    datasets,
    documentFolders: mergeFolders(hasBase, bw?.documentFolders, w.documentFolders, l.documentFolders),
    collectionFolders: mergeFolders(hasBase, bw?.collectionFolders, w.collectionFolders, l.collectionFolders),
    view,
    timelineLabels: byId("timelineLabels"),
    worldMapDocPins: byId("worldMapDocPins"),
    worldMapLabelPins: byId("worldMapLabelPins"),
    worldMaps: byId("worldMaps"),
    ...(timelineLine ? { timelineLine } : {}),
  });

  return { merged: merged as unknown as Project, conflicts };
}
