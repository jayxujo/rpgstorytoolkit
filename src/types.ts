export type Id = string;

// what "kind" of collection this is
export type CollectionKind = "generic" | "characters";

export interface CollectionField {
  id: Id;
  label: string;
  type: "string" | "number" | "text";
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

// User-configurable dialogue metadata fields (defaults: Stage, Interaction)
export interface DialogueFieldDef {
  id: Id; // stable key used in saved dialogue entry fields
  label: string; // user-facing label (e.g. "Stage", "Scene", "Chapter")
  type: "number" | "string" | "bool";
  defaultValue?: number | string;
}

export interface DialogueEntry {
  id: Id;
  linkId?: Id;

  // New (generic speaker reference)
  speakerCollectionId?: Id;
  speakerEntityId?: Id;

  // Legacy (older saves): keep for backward compatibility
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

export type TimelineCoversMap = Record<number, string>; // beat -> Supabase storage path (bucket "assets")

export interface TimelineCover {
  position: number; // timeline beat index
  path: string;     // Supabase storage path (bucket "assets")
}

export interface WorldMapDocPin {
  id: Id;
  docId: Id;
  x: number; // 0–100, percentage of map image width
  y: number; // 0–100, percentage of map image height
}

export interface WorldMapLabelPin {
  id: Id;
  collectionId: Id;
  entityId: Id;
  x: number;
  y: number;
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

  // ✅ Public wiki publishing settings
  wiki?: WikiSettings;

  // ✅ Persist UI layout
  uiShowLeftPanel?: boolean;   // legacy (panel visibility) — kept for back-compat
  uiShowMiddlePanel?: boolean; // legacy
  uiShowRightPanel?: boolean;  // legacy
  uiLayoutMode?: "focus" | "dual";        // sidebar + one editor, or both side-by-side
  uiFocusView?: "doc" | "collection";     // which editor focus mode shows
  uiShowAssetsTree?: boolean;  // Assets tree in the left sidebar
  uiShowDialogueTree?: boolean; // Dialogue tree in the left sidebar

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

  dialogueEntries: DialogueEntry[];

  // Defines which dialogue fields exist + their labels (user-editable under File menu)
  dialogueFieldDefs?: DialogueFieldDef[];

  view?: ProjectViewSettings;

  timelineLabels?: TimelineLabel[];
  worldMapDocPins?: WorldMapDocPin[];
  worldMapLabelPins?: WorldMapLabelPin[];
  worldMaps?: WorldMapEntry[]; // archive of all saved maps (incl. the active one)
}

export type Profile = {
  id: string;
  is_pro: boolean;
};
