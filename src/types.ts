export type Id = string;

// what "kind" of collection this is
export type CollectionKind = "generic" | "characters";

export interface CollectionField {
  id: Id;
  label: string;
  type: "string" | "number" | "text" | "bool";
}

export interface AssetFile {
  id: Id;
  name: string;
  mime: string;
  size: number;
  path: string; // Supabase storage path (bucket = "assets")
  createdAt: string; // ISO string
}

// Context passed when uploading a world-map image so the upload can be filed as a
// record asset: either an existing record (entity mode) or a record auto-created
// from a typed name (text mode).
export interface WorldNameCtx {
  mode: "text" | "entity";
  name?: string;
  collectionId?: Id;
  entityId?: Id;
}

export interface CollectionRow {
  id: Id;
  values: Record<string, string | number>;
  assets?: AssetFile[]; // file attachments
  profileAssetId?: Id;  // one of assets[].id

  // Rich body for the record's Description field (edited "as a page"), mirroring how
  // documents store richContent + entityLinks. `values.description` is the plain-text
  // mirror (table preview / export / wiki fallback).
  descriptionRich?: string;            // Lexical JSON
  descriptionLinks?: EntityLink[];     // entity-link chips within the description
}

export interface Collection {
  id: Id;
  name: string;

  // Folder path (display names) this collection lives under. Empty/undefined = root.
  // Supports arbitrary nesting. Decoupled from the name.
  folderPath?: string[];

  color: string; // UI + highlight color
  kind: CollectionKind;
  assetsEnabled?: boolean; // default true; when false, hide asset/profile UI for this collection
  descriptionEnabled?: boolean; // default true; when false, hide the Description column/body
  schema: CollectionField[];
  rows: CollectionRow[];
}

export interface EntityLink {
  id: Id;
  docId: Id;
  collectionId: Id;
  entityId: Id;
  start: number;
  end: number;
}

export interface Document {
  id: Id;
  title: string;
  content: string;

  // Folder path (display names) this document lives under, e.g. ["Act 1", "Scenes"].
  // Empty/undefined = root. Supports arbitrary nesting. Decoupled from the title.
  folderPath?: string[];

  // Rich text editor state (Lexical JSON). Kept separate so existing features
  // that depend on plain-text indexing (entity link ranges, exports, etc.)
  // continue to work against `content`.
  richContent?: string;

  entityLinks: EntityLink[];
  timelinePos?: number; // ✅ NEW (integer slot on timeline)
}

// ── Datasets ───────────────────────────────────────────────────────────────
// A "dataset" generalizes the old Dialogue feature: a set of user-defined fields
// (e.g. Stage, Interaction) that index into a result. The default project ships a
// "Dialogue" dataset whose results are text lines, but a dataset's result can also
// be a plain typed value or a value coupled to a record's column.

export type DatasetFieldType = "number" | "string" | "bool";

// User-configurable dataset index fields (Dialogue defaults: Stage, Interaction).
export interface DatasetFieldDef {
  id: Id; // stable key used in saved entry.fields
  label: string; // user-facing label (e.g. "Stage", "Scene", "Chapter")
  type: DatasetFieldType;
  defaultValue?: number | string;
}

// Per-entry result. Chosen independently per entry.
//  - "text":   free text (a dialogue line)
//  - "value":  a plain typed value (no record coupling)
//  - "column": a value written to a specific record's column; its type follows
//              that column (string/number/bool). Reads like "<record>.<field> = value".
export type DatasetResult =
  | { kind: "text"; value: string }
  | { kind: "value"; valueType: DatasetFieldType; value: string | number }
  | { kind: "column"; collectionId: Id; entityId: Id; fieldId: Id; value: string | number };

export interface DatasetEntry {
  id: Id;
  // Optional subject entity (for the Dialogue dataset this is the speaker).
  subjectCollectionId?: Id;
  subjectEntityId?: Id;
  fields: Record<string, string | number>;
  result: DatasetResult;
}

export interface Dataset {
  id: Id;
  name: string;
  fieldDefs: DatasetFieldDef[];
  entries: DatasetEntry[];
}

// Back-compat alias: existing imports referenced DialogueFieldDef.
export type DialogueFieldDef = DatasetFieldDef;

// Legacy dialogue entry shape (older saves / pre-dataset). Only read during
// migration in normalizeLoadedProject — not used as a live model anymore.
export interface DialogueEntry {
  id: Id;
  linkId?: Id;
  speakerCollectionId?: Id;
  speakerEntityId?: Id;
  characterId?: Id;
  documentId: Id;
  fields: Record<string, string | number>;
  text: string;
}

export interface TimelineLabel {
  id: Id;
  position: number;

  // Labels now reference an entity from a collection (collection -> entity)
  collectionId: Id;
  entityId: Id;
}

// ── Line-style (Gantt) timeline ──────────────────────────────────────────────
// An alternative timeline layout: a single horizontal line where docs occupy a
// start..end span and records can be pinned as points or spans. Positions are
// abstract fractions of the line (0–100), independent of the section-style data.
export interface TimelineLineDoc {
  docId: Id;
  start: number; // 0–100
  end?: number;  // 0–100 (>= start); when unset the doc is a pin, not a range
  order?: number; // vertical lane order (sorted ascending); fractional values allowed
}

export interface TimelineLinePin {
  id: Id;
  collectionId: Id;
  entityId: Id;
  start: number;  // 0–100
  end?: number;   // when set, the pin is a range; otherwise a single point
  order?: number; // vertical lane order (sorted ascending); fractional values allowed
}

export interface TimelineLine {
  docs: TimelineLineDoc[];
  pins: TimelineLinePin[];
}

export type TimelineCoversMap = Record<number, string>; // beat -> Supabase storage path (bucket "assets")

export interface TimelineCover {
  position: number; // timeline beat index
  path: string;     // Supabase storage path (bucket "assets")
}

// A drawn region (polygonal lasso) attached to a pin. Percentage points of the map.
export interface MapBorderPoint { x: number; y: number }

export interface WorldMapDocPin {
  id: Id;
  docId: Id;
  x: number; // 0–100, percentage of map image width
  y: number; // 0–100, percentage of map image height
  border?: MapBorderPoint[]; // optional drawn region linked to this pin
}

export interface WorldMapLabelPin {
  id: Id;
  collectionId: Id;
  entityId: Id;
  x: number;
  y: number;
  border?: MapBorderPoint[];
}

// A saved world map = a record + its image + its own pins. The currently-open map's
// live data lives in the legacy view.worldMap* + project.worldMap*Pins fields; this
// array is the archive of all maps (incl. the active one) used for "Load map".
export interface WorldMapEntry {
  id: Id;
  collectionId: Id;
  entityId: Id;
  name: string;
  imagePath?: string;
  docPins: WorldMapDocPin[];
  labelPins: WorldMapLabelPin[];
  includeInWiki?: boolean;
}

export interface WikiSettings {
  published?: boolean;
  slug?: string;

  // If true, changing project name will NOT auto-update slug
  slugOverride?: boolean;

  includedDocumentIds?: Id[];
  includedCollectionIds?: Id[];

  // Home page (document id)
  homeDocumentId?: Id;

  // ✅ SEO / indexing
  seoTitle?: string;         // <title> and og:title
  seoDescription?: string;   // meta description and og:description
  seoImageUrl?: string;      // og:image (optional)
  allowIndexing?: boolean;   // true => index/follow, false => noindex/nofollow
}

export interface ProjectViewSettings {
  timelineEnabled?: boolean;
  timelineBeatCount?: number;

  // ✅ Cover image per timeline section/beat
  timelineCovers?: TimelineCoversMap;

  // ✅ Custom title per timeline section/beat (beat index -> title)
  timelineSectionTitles?: Record<number, string>;

  // ✅ Timeline layout: classic sections, or a single Gantt-style line. Default "section".
  timelineStyle?: "section" | "line";

  // ✅ Public wiki publishing settings
  wiki?: WikiSettings;

  // ✅ Persist UI layout
  uiShowLeftPanel?: boolean;   // legacy (panel visibility) — kept for back-compat
  uiShowMiddlePanel?: boolean; // legacy
  uiShowRightPanel?: boolean;  // legacy
  uiLayoutMode?: "focus" | "dual";        // sidebar + one editor, or both side-by-side
  uiFocusView?: "doc" | "collection" | "dataset"; // which editor focus mode shows
  uiShowAssetsTree?: boolean;  // Assets tree in the left sidebar
  uiShowDialogueTree?: boolean; // Datasets tree in the left sidebar
  activeDatasetId?: Id;        // selected dataset for the Dataset view

  // Dual-view tool side (web only): when set, one side of Dual view shows the
  // Timeline or World Map; the other side acts like focus mode (doc/database/conditions).
  uiDualTool?: "timeline" | "worldmap" | null;
  uiDualToolSide?: "left" | "right"; // which side hosts the tool

  // ✅ Persist timeline overlay height
  uiTimelineHeight?: number;

  // ✅ Persist sidebar folder collapse state
  uiCollapsedDocumentGroups?: Record<string, boolean>;
  uiCollapsedCollectionGroups?: Record<string, boolean>;

  // ✅ Persist collection column widths (key = "collectionId:fieldId")
  uiColumnWidths?: Record<string, number>;

  // ✅ Persist panel sizes (percentages, as returned by react-resizable-panels onLayout)
  uiPanelSizes?: number[]; // [left, middle, right] — only includes visible panels

  // ✅ World Map
  worldMapImagePath?: string; // Supabase storage path (bucket "assets")
  worldMapName?: string;
  worldMapNameCollectionId?: Id;
  worldMapNameEntityId?: Id;
  worldMapIncludeInWiki?: boolean;
  activeWorldMapId?: Id; // which saved map (project.worldMaps) is currently open
}


export interface Project {
  id: Id;
  name: string;

  documents: Document[];
  collections: Collection[];

  // Explicit folder paths (display-name segments) so empty folders persist even
  // when they contain no documents/collections yet. e.g. [["Act 1","Scenes"]].
  documentFolders?: string[][];
  collectionFolders?: string[][];

  // Canonical store for the generalized Dialogue/Datasets feature. The first
  // dataset (id "dialogue") is the default Dialogue dataset.
  datasets: Dataset[];

  // Legacy fields — only present on old saves; migrated into `datasets` on load.
  dialogueEntries?: DialogueEntry[];
  dialogueFieldDefs?: DialogueFieldDef[];

  view?: ProjectViewSettings;

  timelineLabels?: TimelineLabel[];
  timelineLine?: TimelineLine; // line-style (Gantt) data; independent of section data
  worldMapDocPins?: WorldMapDocPin[];
  worldMapLabelPins?: WorldMapLabelPin[];
  worldMaps?: WorldMapEntry[]; // archive of all saved maps (incl. the active one)
}

export type Profile = {
  id: string;
  is_pro: boolean;
};
