import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal, flushSync } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  Project,
  Document as Doc,
  Collection,
  CollectionRow,
  CollectionField,
  AssetFile,
  Id,
  EntityLink,
  DialogueFieldDef,
  Dataset,
  DatasetEntry,
  DatasetResult,
  DatasetFieldType,
  WorldMapDocPin,
  WorldMapLabelPin,
  WorldMapEntry,
  WorldNameCtx,
} from "./types";
import StoryEditor from "./StoryEditor";
import Timeline from "./Timeline";
import WorldMap from "./WorldMap";
import { supabase } from "./supabaseClient";
import {
  platform,
  getVaultPath,
  pickVaultFolder,
  createVaultFolder,
  renameVaultFolder,
  NOT_A_VAULT_ERROR,
  getRecentVaults,
  removeRecentVault,
  updateRecentVaultName,
  openRecentVault,
  vaultExists,
  getVaultSyncMeta,
  setVaultSyncMeta,
  type RecentVault,
} from "./platform";
import { webPlatform } from "./platform/web";
import { createSeedProject } from "./platform/seedProject";
import type { ProjectSummary } from "./platform/types";
import { openTimelineWindow } from "./platform/timelineWindow";
import {
  emitTimelineState,
  onTimelineMutation,
  onTimelineStateRequest,
} from "./platform/timelineBridge";
import { openWorldMapWindow } from "./platform/worldMapWindow";
import {
  emitWorldMapState,
  onWorldMapMutation,
  onWorldMapStateRequest,
} from "./platform/worldMapBridge";
import { parseTitlePath, docVaultSegments, colVaultSegments, toSlug } from "./platform/slugify";
import { richContentToMarkdown } from "./platform/docMarkdown";
import {
  buildDatasetFile,
  datasetSubjectKey,
  DIALOGUE_DATASET_ID,
} from "./dialogueExport";
import DatasetView from "./DatasetView";
import type { LinkEditorApi } from "./StoryEditor";
import {
  migrateDocToChips,
  reconcileDocChips,
  richContentHasChips,
  isSingleWord,
  type LabelResolver,
} from "./editor/linkEngine";
import {
  DEFAULT_DIALOGUE_FIELD_DEFS,
  ensureFieldValues as ensureDialogueFieldValues,
  summarizeResult,
} from "./datasetFields";
import JSZip from "jszip";
import { buildProjectArchive, readProjectArchive, collectAssetPaths, PROJECT_FILE_EXT } from "./projectTransfer";

const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import { useAppModal } from "./AppModal";

/** =========================
 *  Colors / starter data
 *  ========================= */

const COLOR_PALETTE = [
  { value: "#4f8cff", label: "Blue" },
  { value: "#e67e22", label: "Orange" },
  { value: "#27ae60", label: "Green" },
  { value: "#9b59b6", label: "Purple" },
  { value: "#e74c3c", label: "Red" },
  { value: "#f1c40f", label: "Yellow" },
];

const getDefaultColor = (index: number): string =>
  COLOR_PALETTE[index % COLOR_PALETTE.length].value;

// Upsert the currently-open world map (legacy live fields) into project.worldMaps.
// Returns the updated maps array + the active map's id (generating one if needed).
const archiveActiveWorldMap = (p: Project): { worldMaps: WorldMapEntry[]; activeId: string } => {
  const v = p.view ?? {};
  const hasActive = !!(
    v.worldMapImagePath ||
    v.worldMapName ||
    (p.worldMapDocPins?.length ?? 0) > 0 ||
    (p.worldMapLabelPins?.length ?? 0) > 0
  );
  const maps = [...(p.worldMaps ?? [])];
  let activeId = v.activeWorldMapId ?? "";
  if (hasActive) {
    if (!activeId) activeId = "wm_" + Date.now();
    const entry: WorldMapEntry = {
      id: activeId,
      collectionId: v.worldMapNameCollectionId ?? "",
      entityId: v.worldMapNameEntityId ?? "",
      name: v.worldMapName ?? "",
      imagePath: v.worldMapImagePath,
      docPins: p.worldMapDocPins ?? [],
      labelPins: p.worldMapLabelPins ?? [],
      includeInWiki: v.worldMapIncludeInWiki ?? false,
    };
    const idx = maps.findIndex((m) => m.id === activeId);
    if (idx >= 0) maps[idx] = entry;
    else maps.push(entry);
  }
  return { worldMaps: maps, activeId };
};


// Free (non-Pro) plan: number of documents allowed before Pro/account is required.
const FREE_DOC_LIMIT = 3;

// Free (non-Pro) plan: number of uploaded images allowed PER PROJECT on the web
// (across record assets, world-map images, and timeline covers) before Pro is
// required. Desktop is always unlimited. Change this single number to taste.
const FREE_PROJECT_ASSET_LIMIT = 3;

// Transparency widget (web, free tier): rough monthly running costs + current
// earnings. Edit these as the real numbers change.
const MONTHLY_COSTS: { label: string; amount: number; color: string; note?: string }[] = [
  { label: "Hosting", amount: 20, color: "#4f8cff" },
  { label: "Database & backend", amount: 25, color: "#22b07d" },
  { label: "Domain", amount: 2, color: "#b070ff" },
  // The gap above bare running costs goes to the solo dev who keeps it alive.
  { label: "For my work and coffee", amount: 33, color: "#e8a33d", note: "Funds ongoing updates, new features, fixes, and yes, my coffee." },
];
const MONTHLY_EARNINGS = 5; // current monthly recurring revenue from Pro subscriptions

// A small "are we breaking even yet?" bar. The full width is the monthly goal
// (sum of costs, shown as faded color-coded segments); the fill is current
// earnings, going red -> green as it approaches the goal.
const BreakEvenBar: React.FC<{
  costs: { label: string; amount: number; color: string; note?: string }[];
  earnings: number;
}> = ({ costs, earnings }) => {
  const goal = Math.max(1, costs.reduce((s, c) => s + c.amount, 0));
  const ratio = Math.max(0, Math.min(1, earnings / goal));
  const hue = Math.round(ratio * 120); // 0 = red, 120 = green
  const earnColor = `hsl(${hue}, 90%, 50%)`; // vivid red -> green

  return (
    <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
        Help keep RPG Story Toolkit running
      </div>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10, lineHeight: 1.45 }}>
        We keep our costs transparent. Going Pro fills the bar toward our monthly goal.
      </div>

      {/* Wrapper is not clipped, so the radar rings can spill past the bar */}
      <div style={{ position: "relative" }} title={`Our earnings: $${earnings}/mo of a $${goal}/mo goal`}>
        <div
          style={{
            position: "relative",
            height: 40,
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid var(--border-2)",
            display: "flex",
          }}
        >
          {/* Cost breakdown: faded, color-coded segments summing to the goal */}
          {costs.map((c) => (
            <div
              key={c.label}
              title={`${c.label}: $${c.amount}/mo`}
              style={{ flexGrow: c.amount, flexBasis: 0, background: c.color, opacity: 0.26 }}
            />
          ))}
          {/* Earnings fill (vivid red -> green) */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${ratio * 100}%`,
              background: earnColor,
              transition: "width 700ms ease, background 700ms ease",
            }}
          />
        </div>
        {/* Radar "ping" at the leading edge of current earnings (outside the clip) */}
        {earnings > 0 && (
          <div
            className="breakEvenPing"
            style={{ left: `${ratio * 100}%`, top: 20, color: earnColor }}
          />
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, opacity: 0.85 }}>
        <span>Our current earnings: <b style={{ color: earnColor }}>${earnings}/mo</b></span>
        <span>Goal (${goal}/mo)</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {costs.map((c) => (
          <span
            key={c.label}
            title={c.note ?? `${c.label}: $${c.amount}/mo`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, opacity: 0.9 }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 2, background: c.color, opacity: 0.55, flexShrink: 0 }} />
            {c.label} ${c.amount}
          </span>
        ))}
      </div>
    </div>
  );
};

const downloadJson = (filename: string, data: unknown) => {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// Base64-encode a Blob (no data: prefix) — used to hand bytes to the Tauri
// write_file_base64 command when saving an exported archive on desktop.
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Fast non-cryptographic string hash (cyrb53) for cheap change detection.
const hashString = (str: string): string => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

// Serialize a project for the "unpushed changes" detector. Per-device UI prefs in
// `view` (layout mode, panel sizes, collapse state, active dataset, etc.) are NOT
// content and shouldn't flag a project as out of sync — strip them so a freshly
// created/synced project reads as clean and local UI tweaks don't nag. Everything
// content-bearing (docs, tables, conditions, world maps, timeline, wiki, …) stays.
const syncContentString = (p: Project): string => {
  const { view, ...rest } = p as any;
  let v = view;
  if (view && typeof view === "object") {
    v = { ...view };
    for (const k of [
      "uiLayoutMode", "uiFocusView", "uiShowAssetsTree", "uiShowDialogueTree",
      "uiShowLeftPanel", "uiShowMiddlePanel", "uiShowRightPanel",
      "uiPanelSizes", "uiTimelineHeight", "uiCollapsedDocumentGroups",
      "uiCollapsedCollectionGroups", "uiColumnWidths", "activeDatasetId",
    ]) delete (v as any)[k];
  }
  return JSON.stringify({ ...rest, view: v });
};

// Compress/resize an image for WEB storage only (cuts Supabase storage + egress).
// Keeps the original filename, never enlarges, skips non-raster/animated formats,
// and falls back to the original on any failure. Not used for desktop vaults or
// sync (so full-res originals are preserved and round-trip intact).
const compressImageForWeb = async (file: File, maxDim = 2048, quality = 0.85): Promise<File> => {
  if (!file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDim / longest);
    // Already small and not oversized → leave it.
    if (scale >= 1 && file.size < 500_000) { bitmap.close?.(); return file; }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
    if (!blob || blob.size >= file.size) return file; // never make it bigger
    return new File([blob], file.name, { type: "image/webp" });
  } catch {
    return file;
  }
};

const guessImageMime = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  };
  return map[ext] ?? "image/*";
};

const getDatasets = (p?: Project | null): Dataset[] => (Array.isArray(p?.datasets) ? p!.datasets : []);

const newDatasetId = () => `ds_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const newDatasetEntryId = () => `de_${Date.now()}_${Math.random().toString(16).slice(2)}`;

// Keep dataset entries referentially clean when a collection or record is deleted:
// drop entries whose column-result target was deleted, and clear dangling subject refs.
const scrubDatasetRefs = (datasets: Dataset[], del: { collectionId?: Id; rowId?: Id }): Dataset[] =>
  (datasets ?? []).map((ds) => ({
    ...ds,
    entries: ds.entries
      .filter((e) => {
        if (e.result.kind !== "column") return true;
        if (del.collectionId && e.result.collectionId === del.collectionId) return false;
        if (del.rowId && e.result.entityId === del.rowId) return false;
        return true;
      })
      .map((e) => {
        const subjGone =
          (del.collectionId && e.subjectCollectionId === del.collectionId) ||
          (del.rowId && e.subjectEntityId === del.rowId);
        return subjGone ? { ...e, subjectCollectionId: undefined, subjectEntityId: undefined } : e;
      }),
  }));

/** =========================
 *  Profile types
 *  ========================= */
type ProfileRow = {
  id: string;
  username: string | null;
  avatar_path: string | null;
  is_pro: boolean;

  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_current_period_end: string | null;

  subscription_cancel_at_period_end: boolean;
  subscription_cancel_at: string | null;
};




const Modal: React.FC<{
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  title?: string;
}> = ({ onClose, children, width = 860, title = "Assets" }) => {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "var(--overlay)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 110,
        padding: 16,
      }}
      onMouseDown={(e) => {
        // click outside closes
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 12,
          padding: 14,
          boxShadow: "0 12px 30px var(--overlay-2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              borderRadius: 8,
              border: "1px solid var(--border-3)",
              backgroundColor: "transparent",
              color: "var(--text-2)",
              cursor: "pointer",
              padding: "6px 10px",
              height: 34,
            }}
          >
            Close
          </button>
        </div>

        {children}
      </div>
    </div>
  );
};

const emailToDefaultUsername = (email?: string | null) => {
  if (!email) return "player";
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
};

const normalizeWikiSlug = (raw: string): string => {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return t || "project";
};

const slugFromProjectName = (name: string): string => normalizeWikiSlug(name);

/** =========================
 *  Sortable sidebar item
 *  ========================= */
// Lucide-style line icons for the sidebar header actions.
const svgProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const IconNewNote: React.FC = () => (
  <svg {...svgProps}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
  </svg>
);
const IconNewCollection: React.FC = () => (
  <svg {...svgProps}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18" />
    <path d="M3 15h18" />
    <path d="M12 3v18" />
  </svg>
);
const IconNewFolder: React.FC = () => (
  <svg {...svgProps}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <line x1="12" x2="12" y1="10" y2="16" />
    <line x1="9" x2="15" y1="13" y2="13" />
  </svg>
);
const IconFolder: React.FC = () => (
  <svg {...svgProps} width={14} height={14}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
);
const IconFile: React.FC = () => (
  <svg {...svgProps} width={13} height={13}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v5h5" />
    <path d="M10 12h4" />
    <path d="M10 16h4" />
  </svg>
);
// Small monospace chip showing an asset's file type (PNG, GIF, MP4, …).
const AssetTypeBadge: React.FC<{ name: string; mime: string; size?: number }> = ({ name, mime, size = 9 }) => {
  const dot = name.lastIndexOf(".");
  let ext = dot >= 0 ? name.slice(dot + 1) : (mime.split("/")[1] || "file");
  ext = ext.toUpperCase().slice(0, 4);
  return (
    <span style={{ fontSize: size - 1, fontWeight: 800, letterSpacing: 0.3, color: "var(--text-3)", border: "1px solid var(--border-2)", borderRadius: 3, padding: "1px 3px", lineHeight: 1.1, fontFamily: "ui-monospace, SFMono-Regular, monospace", whiteSpace: "nowrap" }}>
      {ext}
    </span>
  );
};
const IconChat: React.FC = () => (
  <svg {...svgProps} width={14} height={14}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const IconNewDataset: React.FC = () => (
  <svg {...svgProps}>
    <line x1="3" x2="13" y1="6" y2="6" />
    <line x1="3" x2="13" y1="12" y2="12" />
    <line x1="3" x2="9" y1="18" y2="18" />
    <line x1="17" x2="17" y1="14" y2="20" />
    <line x1="14" x2="20" y1="17" y2="17" />
  </svg>
);
const IconAddColumn: React.FC = () => (
  <svg {...svgProps} width={14} height={14}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="M14 9h4" />
    <path d="M16 7v4" />
  </svg>
);
const IconAddRow: React.FC = () => (
  <svg {...svgProps} width={14} height={14}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 14h4" />
    <path d="M9 12v4" />
  </svg>
);

// Folder-tree drag-and-drop row: draggable, and (for folders) a droppable target.
const TreeRow: React.FC<{
  dragId: string;
  dropId?: string;
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ dragId, dropId, selected, onClick, onContextMenu, style, children }) => {
  const drag = useDraggable({ id: dragId });
  const drop = useDroppable({ id: dropId ?? `__nodrop__${dragId}`, disabled: !dropId });
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    if (dropId) drop.setNodeRef(el);
  };
  return (
    <div
      ref={setRef}
      {...drag.attributes}
      {...drag.listeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={selected ? "treeRow is-selected" : "treeRow"}
      style={{
        ...style,
        opacity: drag.isDragging ? 0.4 : style?.opacity ?? 1,
        outline: dropId && drop.isOver ? "2px solid var(--accent)" : undefined,
        outlineOffset: -2,
      }}
    >
      {children}
    </div>
  );
};

// Droppable container representing the root (drop here to move to top level).
const TreeRootDroppable: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        marginTop: 10,
        minHeight: 40,
        borderRadius: 8,
        outline: isOver ? "2px dashed var(--accent)" : undefined,
        outlineOffset: -2,
      }}
    >
      {children}
    </div>
  );
};


/** =========================
 *  App
 *  ========================= */
const App: React.FC<{ isGuest?: boolean; onRequestSignup?: () => void }> = ({
  isGuest = false,
  onRequestSignup,
}) => {
  const appModal = useAppModal();

  // Prompt a guest to make an account, with a button that opens the sign-up screen.
  const promptCreateAccount = (message: string) => {
    void appModal
      .confirm({
        title: "Create an account",
        message,
        confirmText: "Create account",
        cancelText: "Not now",
      })
      .then((ok) => {
        if (ok) onRequestSignup?.();
      });
  };

  // Free/guest tier (web, no account yet): some actions require an account.
  // Returns true if allowed; otherwise prompts to create one and returns false.
  const requireAccount = (action: string): boolean => {
    if (!isGuest) return true;
    promptCreateAccount(`You'll need to create a free account to ${action}.`);
    return false;
  };

  // Gate image uploads on the free web plan: total uploaded images per project
  // (record assets + world-map images + timeline covers) is capped; over the cap we
  // prompt to upgrade. Desktop and Pro are unlimited. Pass `incoming` = 0 for a
  // replacement (no net new asset). Returns true if the upload may proceed.
  const requireAssetCapacity = async (incoming: number): Promise<boolean> => {
    if (isDesktop || incoming <= 0 || profile?.is_pro || !project) return true;
    let current = 0;
    for (const c of project.collections ?? []) {
      for (const r of c.rows ?? []) current += r.assets?.length ?? 0;
    }
    current += Object.keys((project.view as any)?.timelineCovers ?? {}).length;
    if (current + incoming <= FREE_PROJECT_ASSET_LIMIT) return true;
    const ok = await appModal.confirm({
      title: "Pro feature",
      message: `The free plan includes up to ${FREE_PROJECT_ASSET_LIMIT} uploaded images per project. Upgrade to Pro for unlimited uploads on the web, or use the desktop app, which is always free and unlimited.`,
      confirmText: "Upgrade to Pro",
      cancelText: "Not now",
    });
    if (ok) goPro();
    return false;
  };

  /** ---------- Theme ---------- */
  type ThemeMode = "dark" | "light" | "system";
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem("themeMode") as ThemeMode) ?? "dark";
  });

  // Apply data-theme to <html> whenever themeMode changes
  useEffect(() => {
    const root = document.documentElement;
    if (themeMode === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", prefersDark ? "dark" : "light");

      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        root.setAttribute("data-theme", e.matches ? "dark" : "light");
      };
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    } else {
      root.setAttribute("data-theme", themeMode);
    }
  }, [themeMode]);

  const cycleTheme = () => {
    setThemeMode((prev) => {
      const next = prev === "dark" ? "light" : prev === "light" ? "system" : "dark";
      localStorage.setItem("themeMode", next);
      return next;
    });
  };

  const themeIcon = themeMode === "dark" ? "🌙" : themeMode === "light" ? "☀️" : "⚙️";
  const themeLabel = themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "System";

  // Shared style for View/Tools dropdown menu items
  const viewMenuItemStyle: React.CSSProperties = {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--border-3)",
    backgroundColor: "transparent",
    color: "var(--text-2)",
    cursor: "pointer",
    padding: "8px 10px",
    fontSize: 13,
    textAlign: "left",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
  };

  /** ---------- Auth/user ---------- */
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Desktop only: an optional web-account session used for syncing a vault to
  // the web app. Login is free; actual syncing requires Pro.
  const [syncSession, setSyncSession] = useState<import("@supabase/supabase-js").Session | null>(null);
  const [syncIsPro, setSyncIsPro] = useState(false);
  const [signInModalOpen, setSignInModalOpen] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // "linkedOpen" = prompted automatically when opening a linked project while signed out.
  const [signInContext, setSignInContext] = useState<"default" | "linkedOpen">("default");
  const [webPickerOpen, setWebPickerOpen] = useState(false);
  const [webPickerProjects, setWebPickerProjects] = useState<ProjectSummary[]>([]);
  const [importChooserOpen, setImportChooserOpen] = useState(false);
  // Launcher: the signed-in account's web projects + which web ids are already local.
  const [launcherWebProjects, setLauncherWebProjects] = useState<ProjectSummary[]>([]);
  const [linkedWebIds, setLinkedWebIds] = useState<Set<string>>(new Set());
  const [allProjectsModalOpen, setAllProjectsModalOpen] = useState(false);
  // The current vault's web-sync link (desktop), if any.
  const [syncMeta, setSyncMeta] = useState<{ webProjectId: string; accountId: string; lastSyncedAt?: string; syncedHash?: string } | null>(null);
  // Per-recent-vault sync status (desktop switcher labels).
  const [vaultSyncStatus, setVaultSyncStatus] = useState<Record<string, boolean>>({});
  const [isOffline, setIsOffline] = useState(typeof navigator !== "undefined" && !navigator.onLine);
  // True when the linked web project has been updated more recently than our last sync.
  const [webHasNewer, setWebHasNewer] = useState(false);

  /** ---------- Profile ---------- */
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  // Transparency widget: free web users see a "1" notification on their profile
  // until they open the menu once (persisted so it doesn't nag on every load).
  const [supportSeen, setSupportSeen] = useState(() => {
    try { return localStorage.getItem("breakeven_seen") === "1"; } catch { return false; }
  });
  const markSupportSeen = () => {
    setSupportSeen(true);
    try { localStorage.setItem("breakeven_seen", "1"); } catch { /* ignore */ }
  };
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [cancelScheduledAt, setCancelScheduledAt] = useState<string | null>(null);

  // Derive scheduled-cancel state from the persisted profile fields (survives refresh)
  useEffect(() => {
    if (!profile?.is_pro) {
      setCancelScheduledAt(null);
      return;
    }

    const scheduled = !!profile.subscription_cancel_at_period_end;
    const cancelAtIso = scheduled
      ? (profile.subscription_cancel_at ??
        profile.subscription_current_period_end ??
        null)
      : null;

    setCancelScheduledAt(cancelAtIso);
  }, [
    profile?.is_pro,
    profile?.subscription_cancel_at_period_end,
    profile?.subscription_cancel_at,
    profile?.subscription_current_period_end,
  ]);

  const [cancelSubModalOpen, setCancelSubModalOpen] = useState(false);

  const [deleteAccountModalOpen, setDeleteAccountModalOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteProjectModalOpen, setDeleteProjectModalOpen] = useState(false);
  const [deleteProjectConfirmText, setDeleteProjectConfirmText] = useState("");
  const [isDeletingProject, setIsDeletingProject] = useState(false);


  const [editUsername, setEditUsername] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [savedUsername, setSavedUsername] = useState(""); // original value when modal opened
  const [savedEmail, setSavedEmail] = useState("");       // original value when modal opened
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  // Panel sizes (percentages) — persisted across reloads
  const [panelSizes, setPanelSizes] = useState<number[]>([]);
  const panelGroupRef = useRef<ImperativePanelGroupHandle | null>(null);

  /** ---------- View menu (Timeline toggle) ---------- */
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement | null>(null);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement | null>(null);

  /** ---------- World Map ---------- */
  const [worldMapOpen, setWorldMapOpen] = useState(false);
  const [worldMapImageUrl, setWorldMapImageUrl] = useState<string | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!fileMenuOpen) setExportMenuOpen(false);
  }, [fileMenuOpen]);


  /** ---------- Export dialogue (settings modal) ---------- */
  const [exportDialogueModalOpen, setExportDialogueModalOpen] = useState(false);
  const [exportDatasetIds, setExportDatasetIds] = useState<Id[]>([]);

  /** ---------- Export collections/documents (format modals) ---------- */
  const [exportCollectionsModalOpen, setExportCollectionsModalOpen] = useState(false);
  const [exportCollectionsFormat, setExportCollectionsFormat] = useState<"csv" | "tsv" | "json" | "md">("csv");
  const [exportCollectionsSelection, setExportCollectionsSelection] = useState<Id[]>([]);
  const [exportDocumentsModalOpen, setExportDocumentsModalOpen] = useState(false);
  const [exportDocumentsFormat, setExportDocumentsFormat] = useState<"txt" | "doc" | "json" | "md">("txt");
  const [exportDocumentsSelection, setExportDocumentsSelection] = useState<Id[]>([]);
  const [exportAssetsModalOpen, setExportAssetsModalOpen] = useState(false);
  const [exportAssetsSelection, setExportAssetsSelection] = useState<Id[]>([]);


  /** ---------- Wiki publish ---------- */
  const [wikiModalOpen, setWikiModalOpen] = useState(false);
  const [wikiBusy, setWikiBusy] = useState(false);
  const [wikiErr, setWikiErr] = useState<string | null>(null);
  const [wikiInfo, setWikiInfo] = useState<string | null>(null);
  const [wikiRowId, setWikiRowId] = useState<string | null>(null);

  const [wikiDraftSlug, setWikiDraftSlug] = useState("");
  const [wikiDraftSlugOverride, setWikiDraftSlugOverride] = useState(false);
  const [wikiDraftHomeDocId, setWikiDraftHomeDocId] = useState<Id>("");
  const [wikiDraftDocIds, setWikiDraftDocIds] = useState<Id[]>([]);
  const [wikiDraftColIds, setWikiDraftColIds] = useState<Id[]>([]);

  // ✅ SEO / indexing drafts
  const [wikiDraftSeoTitle, setWikiDraftSeoTitle] = useState("");
  const [wikiDraftSeoDescription, setWikiDraftSeoDescription] = useState("");
  const [wikiDraftSeoImageUrl, setWikiDraftSeoImageUrl] = useState("");
  const [wikiDraftAllowIndexing, setWikiDraftAllowIndexing] = useState(true);

  /** ---------- Project persistence ---------- */
  const [project, setProject] = useState<Project | null>(null);
  const [projectRowId, setProjectRowId] = useState<string | null>(null);
  const [loadingInit, setLoadingInit] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [needsVaultPicker, setNeedsVaultPicker] = useState(false);
  const [vaultPickerBusy, setVaultPickerBusy] = useState(false);
  const [recentVaults, setRecentVaults] = useState<RecentVault[]>([]);
  // path -> exists? (undefined while still checking)
  const [vaultStatus, setVaultStatus] = useState<Record<string, boolean>>({});

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Autosave (debounced)
  const AUTO_SAVE_DELAY_MS = 10000;
  // Auto-sync fires a bit after a save settles, so a burst of edits pushes once.
  const AUTO_SYNC_DELAY_MS = 5000;

  const [isDirty, _setIsDirty] = useState(false);
  const dirtyRef = useRef(false);
  const setIsDirty = (v: boolean) => {
    dirtyRef.current = v;
    _setIsDirty(v);
  };

  const lastSavedJsonRef = useRef<string | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingAutoSaveRef = useRef(false);

  // Desktop: auto-push to the linked web project shortly after each save (Pro only).
  // Per-device preference (applies to all synced projects on this machine).
  // On by default (per device); only off if the user explicitly turned it off.
  const [autoSyncOnSave, setAutoSyncOnSave] = useState<boolean>(() => {
    try { return localStorage.getItem("evenstory_autosync") !== "0"; } catch { return true; }
  });
  const autoSyncTimerRef = useRef<number | null>(null);
  const autoSyncingRef = useRef(false);

  const projectRef = useRef<Project | null>(null);
  useLayoutEffect(() => {
    projectRef.current = project;
  }, [project]);

  const savingRef = useRef(false);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  // Reset autosave baseline when switching projects
  useEffect(() => {
    lastSavedJsonRef.current = null;
    setIsDirty(false);

    if (autoSaveTimerRef.current != null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    pendingAutoSaveRef.current = false;
  }, [projectRowId]);

  /** ---------- UI state ---------- */
  const [activeDocId, setActiveDocId] = useState<Id>("");
  const [activeCollectionId, setActiveCollectionId] = useState<Id>("");
  const [activeRowId, setActiveRowId] = useState<Id>(""); // ✅ selected entity row in the right panel
  const [idSuggestionByCell, setIdSuggestionByCell] = useState<Record<string, string>>({});


  // ✅ Fix: keep focus in collection cell inputs while typing (prevents the editor from stealing focus on rerenders)
  const pendingCellFocusRestoreRef = useRef<{
    key: string;
    selectionStart: number | null;
    selectionEnd: number | null;
    t: number;
  } | null>(null);

  useEffect(() => {
    const info = pendingCellFocusRestoreRef.current;
    if (!info) return;

    // Only restore immediately after the change that set this baton.
    if (Date.now() - info.t > 1000) {
      pendingCellFocusRestoreRef.current = null;
      return;
    }

    requestAnimationFrame(() => {
      const key = info.key.replace(/"/g, '\\"');
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `input[data-cellkey="${key}"], textarea[data-cellkey="${key}"]`
      );

      if (el && document.activeElement !== el) {
        el.focus();
        if (info.selectionStart != null && info.selectionEnd != null) {
          try {
            el.setSelectionRange(info.selectionStart, info.selectionEnd);
          } catch (_err) {
            // ignore (some input types may not support selection range)
          }
        }
      }

      pendingCellFocusRestoreRef.current = null;
    });
  }, [project]);

  /** ---------- Per-item kebab menus (Docs/Collections) ---------- */
  const [openDocMenuId, setOpenDocMenuId] = useState<Id | null>(null);
  const [openColMenuId, setOpenColMenuId] = useState<Id | null>(null);
  const [treeCtxMenu, setTreeCtxMenu] = useState<{
    x: number;
    y: number;
    kind: "doc" | "col";
    targetType: "folder" | "item";
    path?: string[];
    id?: Id;
  } | null>(null);
  const [dragLabel, setDragLabel] = useState<{ icon: React.ReactNode; text: string } | null>(null);
  const [treeSelection, setTreeSelection] = useState<Set<string>>(new Set());
  const treeAnchorRef = useRef<string | null>(null);

  /** ---------- Sidebar grouping (visual only) ---------- */
  const [collapsedDocumentGroups, setCollapsedDocumentGroups] = useState<Record<string, boolean>>({});
  const [collapsedCollectionGroups, setCollapsedCollectionGroups] = useState<Record<string, boolean>>({});
  const sidebarGroupPrefsLoadedForProject = useRef<Id | null>(null);

  /** =========================
 *  Entity assets
 *  ========================= */
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  const [assetModalCollectionId, setAssetModalCollectionId] = useState<Id>("");
  const [assetModalRowId, setAssetModalRowId] = useState<Id>("");
  // Unified asset/entity actions menu (used by the modal and the sidebar Assets tree)
  const [assetCtxMenu, setAssetCtxMenu] = useState<{ kind: "entity" | "asset"; colId: Id; rowId: Id; assetId?: Id; x: number; y: number } | null>(null);
  const [assetUploadMsg, setAssetUploadMsg] = useState<string | null>(null);
  const [showAssetsTree, setShowAssetsTree] = useState(false);
  const [collapsedAssetGroups, setCollapsedAssetGroups] = useState<Record<string, boolean>>({});
  const [showDialogueTree, setShowDialogueTree] = useState(false);
  const [collapsedDialogueGroups, setCollapsedDialogueGroups] = useState<Record<string, boolean>>({});
  const assetUploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadTargetRef = useRef<{ colId: Id; rowId: Id } | null>(null);

  // cache signed URLs so thumbnails don’t constantly re-sign
  const [assetUrlCache, setAssetUrlCache] = useState<Record<string, string>>({});

  const [uploadingCount, setUploadingCount] = useState(0);

  const sanitizeSegment = (s: string) =>
    (s || "")
      .trim()
      .replace(/[\/\\?%*:|"<>]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 80);

  const getSignedAssetUrl = async (path: string) => {
    // cache hit
    const cached = assetUrlCache[path];
    if (cached) return cached;

    const url = await platform.getAssetUrl(path);
    if (!url) return null;
    setAssetUrlCache((prev) => ({ ...prev, [path]: url }));
    return url;
  };

  // ✅ Ensure entity profile images show up after reload:
  // Pre-sign URLs for any row.profileAssetId image so assetUrlCache gets populated.
  useEffect(() => {
    if (!project) return;

    const run = async () => {
      const paths = new Set<string>();

      for (const col of project.collections) {
        for (const row of col.rows) {
          const pid = (row as any).profileAssetId as string | undefined;
          const assets = ((row as any).assets ?? []) as Array<any>;
          if (!pid || assets.length === 0) continue;

          const a = assets.find((x) => x.id === pid);
          if (!a) continue;

          const mime = String(a.mime ?? "");
          const path = String(a.path ?? "");
          if (path && mime.startsWith("image/")) paths.add(path);
        }
      }

      for (const p of paths) {
        await getSignedAssetUrl(p);
      }
    };

    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const openAssetsForEntity = (collectionId: Id, rowId: Id) => {
    const col = project?.collections.find((c) => c.id === collectionId);
    if (!col || col.assetsEnabled === false) return;

    setAssetModalCollectionId(collectionId);
    setAssetModalRowId(rowId);
    setAssetModalOpen(true);
  };

  const addAssetsToEntity = async (collectionId: Id, rowId: Id, files: FileList | null) => {
    if (!files || !project || !projectRowId || !userId) return;
    if (!requireAccount("upload assets")) return;
    if (!(await requireAssetCapacity(files.length))) return;

    // Reveal the Assets sidebar once the user has assets to see.
    if (files.length > 0) setShowAssetsTree(true);

    setUploadingCount((c) => c + files.length);

    const col = project.collections.find((c) => c.id === collectionId);
    const row = col?.rows.find((r) => r.id === rowId);
    if (!col || !row) {
      setUploadingCount((c) => Math.max(0, c - files.length));
      return;
    }

    // Upload sequentially to keep it simple (and nicer error behavior)
    const nextProject: Project = structuredClone(project);

    const nextCol = nextProject.collections.find((c) => c.id === collectionId)!;
    const nextRow = nextCol.rows.find((r) => r.id === rowId)!;
    nextRow.assets = nextRow.assets ?? [];

    for (const f of Array.from(files)) {
      const assetId = crypto.randomUUID();
      const safeName = sanitizeSegment(f.name) || "file";
      // Compress images for web storage; desktop vaults keep full-res originals.
      const uploadFile = isDesktop ? f : await compressImageForWeb(f);

      let path: string;
      if (isDesktop) {
        const colSlug = colVaultSegments(nextCol.folderPath, nextCol.name).join("/");
        const firstField = nextCol.schema[0];
        const entityKey = firstField
          ? String(nextRow.values[firstField.id] ?? "") || rowId
          : rowId;
        path = `${colSlug}/${entityKey}/${safeName}`;
      } else {
        path = `${userId}/${nextProject.id}/${collectionId}/${rowId}/${assetId}_${safeName}`;
      }

      try {
        await platform.uploadAsset(uploadFile, path);
      } catch (uploadErr: any) {
        setUploadingCount((c) => Math.max(0, c - 1));
        await appModal.alert(`Upload failed for "${f.name}": ${uploadErr.message}`, { title: "Upload failed" });
        continue;
      }

      nextRow.assets.push({
        id: assetId,
        name: f.name,
        mime: uploadFile.type || f.type || "application/octet-stream",
        size: uploadFile.size,
        path,
        createdAt: new Date().toISOString(),
      });

      // Pre-sign image URLs immediately so thumbnails load without clicking "Open"
      if ((f.type || "").startsWith("image/")) {
        getSignedAssetUrl(path);
        if (!nextRow.profileAssetId) {
          nextRow.profileAssetId = assetId;
        }
      }

      setUploadingCount((c) => Math.max(0, c - 1));
    }

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  const deleteEntityAsset = async (collectionId: Id, rowId: Id, assetId: Id) => {
    if (!project || !projectRowId) return;

    const col = project.collections.find((c) => c.id === collectionId);
    const row = col?.rows.find((r) => r.id === rowId);
    const asset = row?.assets?.find((a) => a.id === assetId);
    if (!col || !row || !asset) return;

    try {
      await platform.deleteAsset(asset.path);
    } catch (removeErr: any) {
      await appModal.alert(`Delete failed: ${removeErr.message}`, { title: "Delete failed" });
      return;
    }

    const nextProject: Project = structuredClone(project);
    const nextCol = nextProject.collections.find((c) => c.id === collectionId)!;
    const nextRow = nextCol.rows.find((r) => r.id === rowId)!;

    nextRow.assets = (nextRow.assets ?? []).filter((a) => a.id !== assetId);
    if (nextRow.profileAssetId === assetId) {
      nextRow.profileAssetId = nextRow.assets.find((a) => (a.mime || "").startsWith("image/"))?.id ?? undefined;
    }

    // If this asset was used as a world map's image, drop the now-dead reference so
    // nothing stale is persisted. The map shows its "image missing — replace it" prompt.
    if (nextProject.view?.worldMapImagePath === asset.path) {
      delete nextProject.view.worldMapImagePath;
    }
    for (const m of nextProject.worldMaps ?? []) {
      if (m.imagePath === asset.path) delete m.imagePath;
    }

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  const renameEntityAsset = async (collectionId: Id, rowId: Id, assetId: Id) => {
    if (!project || !projectRowId) return;
    const col = project.collections.find((c) => c.id === collectionId);
    const row = col?.rows.find((r) => r.id === rowId);
    const asset = row?.assets?.find((a) => a.id === assetId);
    if (!col || !row || !asset) return;

    // Preserve the file extension.
    const dot = asset.name.lastIndexOf(".");
    const ext = dot >= 0 ? asset.name.slice(dot) : "";
    const currentBase = dot >= 0 ? asset.name.slice(0, dot) : asset.name;

    const input = await appModal.prompt({
      title: "Rename asset",
      message: "Enter a new file name.",
      defaultValue: currentBase,
      placeholder: "File name",
      confirmText: "Rename",
      cancelText: "Cancel",
    });
    if (!input) return;
    let base = input.trim();
    if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
    const newName = (sanitizeSegment(base) || "file") + ext;
    if (newName === asset.name) return;

    // New storage path = same directory, new filename.
    const slash = asset.path.lastIndexOf("/");
    const dir = slash >= 0 ? asset.path.slice(0, slash) : "";
    const newPath = (dir ? dir + "/" : "") + newName;

    try {
      await platform.renameAssetFile(asset.path, newPath);
    } catch (e: any) {
      await appModal.alert(`Rename failed: ${e?.message ?? e}`, { title: "Rename failed" });
      return;
    }

    const nextProject: Project = structuredClone(project);
    const nextAsset = nextProject.collections
      .find((c) => c.id === collectionId)!
      .rows.find((r) => r.id === rowId)!
      .assets!.find((a) => a.id === assetId)!;
    nextAsset.name = newName;
    nextAsset.path = newPath;

    // Update cached signed URL key if present.
    setAssetUrlCache((prev) => {
      if (!prev[asset.path]) return prev;
      const { [asset.path]: url, ...rest } = prev;
      return { ...rest, [newPath]: url };
    });

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  const setEntityProfileAsset = async (collectionId: Id, rowId: Id, assetId: Id) => {
    if (!project || !projectRowId) return;

    const nextProject: Project = structuredClone(project);
    const nextCol = nextProject.collections.find((c) => c.id === collectionId);
    const nextRow = nextCol?.rows.find((r) => r.id === rowId);
    if (!nextCol || !nextRow) return;

    nextRow.profileAssetId = assetId;

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  // Rename an entity from the Assets tree (renames its ID — the asset folder name —
  // which updateCollectionCell reflects into the collection + moves the vault folder).
  const renameEntity = async (collectionId: Id, rowId: Id) => {
    const col = project?.collections.find((c) => c.id === collectionId);
    const row = col?.rows.find((r) => r.id === rowId);
    if (!col || !row) return;
    const current = String(row.values["id"] ?? "");
    const next = await appModal.prompt({
      title: "Rename record",
      message: "Enter a new ID for this record.",
      defaultValue: current,
      placeholder: "Record ID",
      confirmText: "Rename",
      cancelText: "Cancel",
    });
    if (!next || next.trim() === current) return;
    updateCollectionCell(collectionId, rowId, "id", next.trim());
  };

  const exportAssetsZip = async (collectionIds?: Id[]) => {
    if (!project || !userId) return;

    const zip = new JSZip();
    const cols = collectionIds ? project.collections.filter((c) => collectionIds.includes(c.id)) : project.collections;

    for (const col of cols) {
      const colFolder = zip.folder(sanitizeSegment(col.name) || sanitizeSegment(col.id) || "Table")!;
      for (const row of col.rows) {
        const entityName = getRowLabel(row) || row.id;
        const entityFolder = colFolder.folder(sanitizeSegment(entityName) || sanitizeSegment(row.id) || "Record")!;

        const assets = row.assets ?? [];
        for (const asset of assets) {
          const url = await getSignedAssetUrl(asset.path);
          if (!url) continue;

          const res = await fetch(url);
          if (!res.ok) continue;

          const blob = await res.blob();
          const fileName = sanitizeSegment(asset.name) || `${asset.id}`;
          entityFolder.file(fileName, blob);
        }
      }
    }

    const outBlob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(outBlob);
    a.download = `${sanitizeSegment(project.name) || "project"}_assets.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  };

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const columnWidthsLoadedForProject = useRef<Id | null>(null);
  const activeResizeRef = useRef<{ fieldKey: string; startX: number; startWidth: number } | null>(null);

  const [draggingRowId, setDraggingRowId] = useState<Id | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<Id | null>(null);

  // Layout: "focus" shows the sidebar + one editor (story OR collection); "dual"
  // shows both side by side. The sidebar is always present.
  const [layoutMode, setLayoutMode] = useState<"focus" | "dual">("focus");
  const [focusView, setFocusView] = useState<"doc" | "collection" | "dataset">("doc");
  const [layoutModalOpen, setLayoutModalOpen] = useState(false);
  const [activeDatasetId, setActiveDatasetId] = useState<Id | null>(null);
  const showLeftPanel = true;
  const showMiddlePanel = layoutMode === "dual" || focusView === "doc";
  // The right panel hosts either the table/database editor or the Dataset view.
  const rightShowsDataset = focusView === "dataset";
  const showRightPanel = layoutMode === "dual" || focusView === "collection" || focusView === "dataset";

  // ✅ Timeline overlay height (draggable)
  const defaultTimelineHeight = useMemo(() => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    return Math.max(240, Math.min(420, Math.round(vh * 0.35)));
  }, []);
  const [timelineHeight, setTimelineHeight] = useState<number>(defaultTimelineHeight);
  const timelineDragRef = useRef<{ startY: number; startH: number } | null>(null);

  const clampTimelineHeight = useCallback((h: number) => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    // leave room for top bar / browser chrome, prevent going off-screen
    const max = Math.max(260, Math.min(900, vh - 120));
    return Math.max(220, Math.min(max, h));
  }, []);

  // ✅ Load saved panel visibility + timeline height from project.view (once per project)
  const panelPrefsLoadedForProject = useRef<Id | null>(null);
  useEffect(() => {
    if (!project?.id) return;
    if (panelPrefsLoadedForProject.current === project.id) return;
    panelPrefsLoadedForProject.current = project.id;

    const v = project.view ?? {};
    const mode = v.uiLayoutMode === "dual" ? "dual" : "focus";
    setLayoutMode(mode);
    setFocusView(v.uiFocusView === "collection" ? "collection" : v.uiFocusView === "dataset" ? "dataset" : "doc");
    setActiveDatasetId(v.activeDatasetId ?? null);
    setShowAssetsTree(v.uiShowAssetsTree === true);
    setShowDialogueTree(v.uiShowDialogueTree === true);

    const savedH = (v as any).uiTimelineHeight;
    if (typeof savedH === "number" && Number.isFinite(savedH)) {
      setTimelineHeight(clampTimelineHeight(savedH));
    } else {
      setTimelineHeight(clampTimelineHeight(defaultTimelineHeight));
    }

    // Restore saved panel sizes only when the count matches the current mode
    // (focus = 2 panels, dual = 3), or react-resizable-panels will mis-apply them.
    const savedSizes = (v as any).uiPanelSizes;
    const expected = mode === "dual" ? 3 : 2;
    if (Array.isArray(savedSizes) && savedSizes.length === expected) {
      setPanelSizes(savedSizes);
      requestAnimationFrame(() => {
        panelGroupRef.current?.setLayout(savedSizes);
      });
    } else {
      setPanelSizes([]);
    }
  }, [project?.id, clampTimelineHeight, defaultTimelineHeight]);

  // ✅ Persist panel visibility + timeline height into project.view so it survives reloads
  useEffect(() => {
    if (!project) return;

    setProject((prev) => {
      if (!prev) return prev;
      const v = prev.view ?? {};
      const nextH = clampTimelineHeight(timelineHeight);

      if (
        v.uiLayoutMode === layoutMode &&
        v.uiFocusView === focusView &&
        v.uiShowAssetsTree === showAssetsTree &&
        v.uiShowDialogueTree === showDialogueTree &&
        (v.activeDatasetId ?? null) === (activeDatasetId ?? null) &&
        (v as any).uiTimelineHeight === nextH &&
        JSON.stringify((v as any).uiPanelSizes) === JSON.stringify(panelSizes)
      ) {
        return prev;
      }

      return {
        ...prev,
        view: {
          ...v,
          uiLayoutMode: layoutMode,
          uiFocusView: focusView,
          uiShowAssetsTree: showAssetsTree,
          uiShowDialogueTree: showDialogueTree,
          activeDatasetId: activeDatasetId ?? undefined,
          uiTimelineHeight: nextH,
          uiPanelSizes: panelSizes.length > 0 ? panelSizes : (v as any).uiPanelSizes,
        },
      };
    });
  }, [project?.id, layoutMode, focusView, showAssetsTree, showDialogueTree, activeDatasetId, timelineHeight, panelSizes, clampTimelineHeight]);

  // ✅ Keep timeline height within the viewport on window resize
  useEffect(() => {
    const onResize = () => setTimelineHeight((h) => clampTimelineHeight(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampTimelineHeight]);

  // ✅ Load saved sidebar folder collapse state from project.view (once per project)
  useEffect(() => {
    if (!project?.id) return;
    if (sidebarGroupPrefsLoadedForProject.current === project.id) return;
    sidebarGroupPrefsLoadedForProject.current = project.id;

    const v = project.view ?? {};

    setCollapsedDocumentGroups(
      v.uiCollapsedDocumentGroups && typeof v.uiCollapsedDocumentGroups === "object"
        ? v.uiCollapsedDocumentGroups
        : {}
    );

    setCollapsedCollectionGroups(
      v.uiCollapsedCollectionGroups && typeof v.uiCollapsedCollectionGroups === "object"
        ? v.uiCollapsedCollectionGroups
        : {}
    );
  }, [project?.id]);

  // ✅ Persist sidebar folder collapse state into project.view so it survives reloads
  useEffect(() => {
    if (!project) return;
    if (sidebarGroupPrefsLoadedForProject.current !== project.id) return;

    setProject((prev) => {
      if (!prev) return prev;

      const v = prev.view ?? {};
      const prevDocGroups = v.uiCollapsedDocumentGroups ?? {};
      const prevColGroups = v.uiCollapsedCollectionGroups ?? {};

      if (
        JSON.stringify(prevDocGroups) === JSON.stringify(collapsedDocumentGroups) &&
        JSON.stringify(prevColGroups) === JSON.stringify(collapsedCollectionGroups)
      ) {
        return prev;
      }

      return {
        ...prev,
        view: {
          ...v,
          uiCollapsedDocumentGroups: collapsedDocumentGroups,
          uiCollapsedCollectionGroups: collapsedCollectionGroups,
        },
      };
    });
  }, [project?.id, collapsedDocumentGroups, collapsedCollectionGroups]);

  // ✅ Load saved column widths from project.view (once per project)
  useEffect(() => {
    if (!project?.id) return;
    if (columnWidthsLoadedForProject.current === project.id) return;
    columnWidthsLoadedForProject.current = project.id;

    const saved = (project.view as any)?.uiColumnWidths;
    if (saved && typeof saved === "object") {
      setColumnWidths(saved);
    } else {
      setColumnWidths({});
    }
  }, [project?.id]);

  // ✅ Persist column widths into project.view
  useEffect(() => {
    if (!project) return;
    if (columnWidthsLoadedForProject.current !== project.id) return;

    setProject((prev) => {
      if (!prev) return prev;
      const v = prev.view ?? {};
      const existing = (v as any).uiColumnWidths ?? {};
      if (JSON.stringify(existing) === JSON.stringify(columnWidths)) return prev;
      return { ...prev, view: { ...v, uiColumnWidths: columnWidths } };
    });
  }, [project?.id, columnWidths]);

  const [timelineCoverUrls, setTimelineCoverUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;

    const buildCoverUrls = async () => {
      if (!project) {
        setTimelineCoverUrls({});
        return;
      }

      const raw = (project.view as any)?.timelineCovers;

      // Support BOTH shapes (in case your file still has the older array type):
      // - Record<number, string> where value = storage path
      // - TimelineCover[] where each item has { position, asset { path } } OR { position, path }
      const pathByBeat: Record<number, string> = {};

      if (Array.isArray(raw)) {
        for (const item of raw) {
          const beat = Number(item?.position);
          const path = String(item?.path ?? item?.asset?.path ?? "");
          if (!Number.isFinite(beat) || !path) continue;
          pathByBeat[beat] = path;
        }
      } else if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          const beat = Number(k);
          const path = String(v ?? "");
          if (!Number.isFinite(beat) || !path) continue;
          pathByBeat[beat] = path;
        }
      }

      const out: Record<number, string> = {};
      for (const [beatStr, path] of Object.entries(pathByBeat)) {
        const url = await getSignedAssetUrl(path);
        if (url) out[Number(beatStr)] = url;
      }

      if (!cancelled) setTimelineCoverUrls(out);
    };

    buildCoverUrls();

    return () => {
      cancelled = true;
    };
  }, [project]);


  // Sign world map image URL whenever the storage path changes
  useEffect(() => {
    let cancelled = false;
    const path = project?.view?.worldMapImagePath;
    if (!path) { setWorldMapImageUrl(null); return; }
    getSignedAssetUrl(path).then((url) => {
      if (!cancelled) setWorldMapImageUrl(url ?? null);
    });
    return () => { cancelled = true; };
  }, [project?.view?.worldMapImagePath]);

  const beginTimelineResize = (e: React.MouseEvent) => {
    e.preventDefault();
    timelineDragRef.current = { startY: e.clientY, startH: timelineHeight };

    const onMove = (ev: MouseEvent) => {
      if (!timelineDragRef.current) return;
      const dy = timelineDragRef.current.startY - ev.clientY; // drag up increases height
      const next = clampTimelineHeight(timelineDragRef.current.startH + dy);
      setTimelineHeight(next);
    };

    const onUp = () => {
      timelineDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };


  /** ---------- Project name editing (✅ #5) ---------- */
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");

  // Web multi-project switcher
  const [webProjects, setWebProjects] = useState<ProjectSummary[]>([]);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const projectNameInputRef = useRef<HTMLInputElement | null>(null);

  /** ---------- Linking flow ---------- */
  type AnchorRect = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };

  const [linkingSelection, setLinkingSelection] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);

  const [linkPopoverAnchorRect, setLinkPopoverAnchorRect] = useState<AnchorRect | null>(null);
  const [caretLinkId, setCaretLinkId] = useState<Id | null>(null);

  const [linkingCollectionId, setLinkingCollectionId] = useState<Id | "">("");
  const [linkingEntityId, setLinkingEntityId] = useState<Id | "">("");
  const [editingLinkId, setEditingLinkId] = useState<Id | null>(null);

  const [linkingNotice, setLinkingNotice] = useState<string | null>(null);

  // Imperative handle into the live editor for creating/updating/removing link chips.
  const linkApiRef = useRef<LinkEditorApi | null>(null);

  // Resolve a record's display label (name, id fallback) for link chips.
  const labelResolver = useCallback<LabelResolver>((collectionId, entityId) => {
    const col = projectRef.current?.collections.find((c) => c.id === collectionId);
    const row = col?.rows.find((r) => r.id === entityId);
    if (!row) return null;
    return String(row.values["name"] || row.values["id"] || row.id);
  }, []);
  const colorResolver = useCallback((collectionId: Id) =>
    projectRef.current?.collections.find((c) => c.id === collectionId)?.color, []);

  /** ---------- Derived ---------- */
  const activeDoc = project?.documents.find((d) => d.id === activeDocId) ?? null;

  const editingLink =
    editingLinkId && activeDoc
      ? activeDoc.entityLinks.find((l) => l.id === editingLinkId) ?? null
      : null;

  const selectedDisplayText =
    editingLink && activeDoc
      ? activeDoc.content.slice(editingLink.start, editingLink.end)
      : linkingSelection?.text ?? "";

  // ✅ Disable "Create link" when the current selection overlaps any existing link.
  // (User should click the highlighted link to edit/unlink instead.)
  const selectionOverlapsExistingLink =
    !!activeDoc &&
    !!linkingSelection &&
    !editingLinkId &&
    activeDoc.entityLinks.some(
      (l) => !(linkingSelection.end <= l.start || linkingSelection.start >= l.end)
    );

  const activeCollection = project?.collections.find((c) => c.id === activeCollectionId) ?? null;
  const timelineEnabled = project?.view?.timelineEnabled ?? false;
  const timelineLabels = project?.timelineLabels ?? [];
  const datasets = getDatasets(project);
  const activeDataset = datasets.find((d) => d.id === activeDatasetId) ?? datasets[0] ?? null;

  const wikiSettings = project?.view?.wiki;
  // The public wiki is web-only; on desktop, treat it as not-published so no
  // wiki UI (Public badges, etc.) shows even for imported projects that had one.
  const wikiIsPublished = !isDesktop && !!wikiSettings?.published;

  // Free plan caps document count; Pro is unlimited. (Desktop has no Pro gate.)
  const atFreeDocLimit =
    !isDesktop && !profile?.is_pro && (project?.documents.length ?? 0) >= FREE_DOC_LIMIT;

  const publicDocIdSet = useMemo(() => {
    if (!project || !wikiIsPublished) return new Set<Id>();

    const ids = Array.isArray(wikiSettings?.includedDocumentIds)
      ? wikiSettings.includedDocumentIds
      : project.documents.map((d) => d.id);

    return new Set(ids);
  }, [project, wikiIsPublished, wikiSettings?.includedDocumentIds]);

  const publicCollectionIdSet = useMemo(() => {
    if (!project || !wikiIsPublished) return new Set<Id>();

    const ids = Array.isArray(wikiSettings?.includedCollectionIds)
      ? wikiSettings.includedCollectionIds
      : project.collections.map((c) => c.id);

    return new Set(ids);
  }, [project, wikiIsPublished, wikiSettings?.includedCollectionIds]);


  /** =========================
   *  Helpers
   *  ========================= */
  const getRowLabel = useCallback((row: CollectionRow): string => {
    return String(row.values["name"] || row.values["id"] || row.id);
  }, []);



  const slashItems = useMemo(() => {
    if (!project) return [];
    const out: Array<{
      collectionId: Id;
      collectionName: string;
      collectionColor?: string;
      entityId: Id;
      displayId?: string;
      label: string;
    }> = [];

    for (const col of project.collections) {
      for (const row of col.rows) {
        out.push({
          collectionId: col.id,
          collectionName: col.name,
          collectionColor: col.color,
          entityId: row.id,
          displayId: String(row.values["id"] ?? row.id),
          label: getRowLabel(row),
        });
      }
    }

    return out;
  }, [project, getRowLabel]);

  // ✅ Timeline label click → open entity in right panel (collection + highlight + scroll)
  const openEntityInCollection = useCallback(
    (collectionId: Id, rowId: Id) => {
      // Ensure the collection editor is visible (focus mode → switch to it).
      setFocusView("collection");

      setActiveCollectionId(collectionId);
      setActiveRowId(rowId);

      // Make the collection the highlighted item (clear any prior doc selection).
      setTreeSelection(new Set(["colitem:" + collectionId]));
      treeAnchorRef.current = "colitem:" + collectionId;

      // Expand the collection's ancestor folders so it's visible in the sidebar.
      const col = projectRef.current?.collections.find((c) => c.id === collectionId);
      const fp = col?.folderPath ?? [];
      if (fp.length) {
        setCollapsedCollectionGroups((prev) => {
          const next = { ...prev };
          for (let i = 1; i <= fp.length; i++) next[fp.slice(0, i).join("/")] = false;
          return next;
        });
      }

      // Wait a moment for the right panel table to render the new collection,
      // then scroll the row into view.
      setTimeout(() => {
        const el = document.querySelector(
          `[data-rowkey="${collectionId}:${rowId}"]`
        ) as HTMLElement | null;

        el?.scrollIntoView({ block: "nearest" });
      }, 50);
    },
    [setFocusView, setActiveCollectionId, setActiveRowId]
  );

  // Open a dataset in the dedicated Dataset view (focus mode swaps to it; dual mode
  // shows it in the right panel in place of the table editor).
  const openDataset = useCallback((id: Id) => {
    setActiveDatasetId(id);
    setFocusView("dataset");
    setTreeSelection(new Set(["dataset:" + id]));
    treeAnchorRef.current = "dataset:" + id;
  }, []);

  const updateDataset = useCallback((next: Dataset) => {
    setProject((prev) =>
      prev ? { ...prev, datasets: getDatasets(prev).map((d) => (d.id === next.id ? next : d)) } : prev
    );
  }, []);

  const addDataset = useCallback(async () => {
    const name = await appModal.prompt({
      title: "New condition",
      message: "Condition name:",
      defaultValue: "New condition",
      placeholder: "Condition name",
      confirmText: "Create",
      cancelText: "Cancel",
    });
    if (!name || !name.trim()) return;
    const ds: Dataset = {
      id: newDatasetId(),
      name: name.trim(),
      fieldDefs: DEFAULT_DIALOGUE_FIELD_DEFS.map((d) => ({ ...d })),
      entries: [],
    };
    setProject((prev) => (prev ? { ...prev, datasets: [...getDatasets(prev), ds] } : prev));
    setActiveDatasetId(ds.id);
    setFocusView("dataset");
  }, [appModal]);

  const renameDataset = useCallback(
    async (id: Id) => {
      const ds = getDatasets(projectRef.current).find((d) => d.id === id);
      const name = await appModal.prompt({
        title: "Rename condition",
        message: "Condition name:",
        defaultValue: ds?.name ?? "",
        confirmText: "Rename",
        cancelText: "Cancel",
      });
      if (!name || !name.trim()) return;
      setProject((prev) =>
        prev ? { ...prev, datasets: getDatasets(prev).map((d) => (d.id === id ? { ...d, name: name.trim() } : d)) } : prev
      );
    },
    [appModal]
  );

  const deleteDataset = useCallback(
    async (id: Id) => {
      const ds = getDatasets(projectRef.current).find((d) => d.id === id);
      const ok = await appModal.confirm({
        title: "Delete condition?",
        message: `Delete "${ds?.name ?? "this condition"}" and all its entries? This can't be undone.`,
        confirmText: "Delete",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      setProject((prev) => (prev ? { ...prev, datasets: getDatasets(prev).filter((d) => d.id !== id) } : prev));
      setActiveDatasetId((cur) => (cur === id ? null : cur));
      setFocusView((fv) => (fv === "dataset" ? "doc" : fv));
    },
    [appModal]
  );

  const getCollectionColor = useCallback(
    (collectionId: Id): string | undefined => {
      const col = project?.collections.find((c) => c.id === collectionId);
      return col?.color;
    },
    [project]
  );

  const normalizeEntityDisplayId = useCallback((raw: string): string => {
    return String(raw ?? "")
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+/g, "")
      .toUpperCase();
  }, []);

  const finalizeEntityDisplayId = useCallback((raw: string): string => {
    return normalizeEntityDisplayId(raw).replace(/_+$/g, "");
  }, [normalizeEntityDisplayId]);

  const getUniqueDisplayIdSuggestion = useCallback(
    (collectionId: Id, rowId: Id, rawValue: string): string => {
      const normalized = finalizeEntityDisplayId(rawValue);
      if (!project) return normalized;

      const col = project.collections.find((c) => c.id === collectionId);
      if (!col) return normalized;

      const used = new Set(
        col.rows
          .filter((r) => r.id !== rowId)
          .map((r) => String(r.values["id"] ?? ""))
          .map((v) => finalizeEntityDisplayId(v))
          .filter(Boolean)
      );

      if (!normalized) return "";
      if (!used.has(normalized)) return normalized;

      let n = 1;
      let next = `${normalized}_${n}`;
      while (used.has(next)) {
        n++;
        next = `${normalized}_${n}`;
      }
      return next;
    },
    [project, finalizeEntityDisplayId]
  );

  const toggleCollectionAssetsEnabled = useCallback((collectionId: Id) => {
    setProject((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        collections: prev.collections.map((c) =>
          c.id === collectionId
            ? { ...c, assetsEnabled: !(c.assetsEnabled !== false) }
            : c
        ),
      };
    });
  }, []);

  // Recursive folder tree for documents, flattened to visible rows (respects collapse).
  const documentTreeRows = useMemo(() => {
    type DocTreeRow =
      | { kind: "folder"; path: string[]; name: string; depth: number; count: number; collapsed: boolean }
      | { kind: "doc"; doc: Doc; depth: number };
    if (!project) return [] as DocTreeRow[];

    type Node = { folders: Map<string, Node>; order: string[]; docs: Doc[] };
    const makeNode = (): Node => ({ folders: new Map(), order: [], docs: [] });
    const root = makeNode();

    for (const d of project.documents) {
      let node = root;
      for (const seg of d.folderPath ?? []) {
        if (!node.folders.has(seg)) {
          node.folders.set(seg, makeNode());
          node.order.push(seg);
        }
        node = node.folders.get(seg)!;
      }
      node.docs.push(d);
    }

    // Seed explicit (possibly empty) folders so they persist in the tree.
    for (const folder of project.documentFolders ?? []) {
      let node = root;
      for (const seg of folder) {
        if (!node.folders.has(seg)) {
          node.folders.set(seg, makeNode());
          node.order.push(seg);
        }
        node = node.folders.get(seg)!;
      }
    }

    const countDescendants = (node: Node): number => {
      let n = node.docs.length;
      for (const name of node.order) n += countDescendants(node.folders.get(name)!);
      return n;
    };

    const rows: DocTreeRow[] = [];
    const walk = (node: Node, pathSoFar: string[], depth: number) => {
      for (const name of node.order) {
        const child = node.folders.get(name)!;
        const path = [...pathSoFar, name];
        const collapsed = !!collapsedDocumentGroups[path.join("/")];
        rows.push({ kind: "folder", path, name, depth, count: countDescendants(child), collapsed });
        if (!collapsed) walk(child, path, depth + 1);
      }
      for (const d of node.docs) rows.push({ kind: "doc", doc: d, depth });
    };
    walk(root, [], 0);
    return rows;
  }, [project, collapsedDocumentGroups]);

  // Recursive folder tree for collections, flattened to visible rows (respects collapse).
  const collectionTreeRows = useMemo(() => {
    type ColTreeRow =
      | { kind: "folder"; path: string[]; name: string; depth: number; count: number; collapsed: boolean }
      | { kind: "collection"; collection: Collection; depth: number };
    if (!project) return [] as ColTreeRow[];

    type Node = { folders: Map<string, Node>; order: string[]; cols: Collection[] };
    const makeNode = (): Node => ({ folders: new Map(), order: [], cols: [] });
    const root = makeNode();

    for (const c of project.collections) {
      let node = root;
      for (const seg of c.folderPath ?? []) {
        if (!node.folders.has(seg)) {
          node.folders.set(seg, makeNode());
          node.order.push(seg);
        }
        node = node.folders.get(seg)!;
      }
      node.cols.push(c);
    }

    // Seed explicit (possibly empty) folders so they persist in the tree.
    for (const folder of project.collectionFolders ?? []) {
      let node = root;
      for (const seg of folder) {
        if (!node.folders.has(seg)) {
          node.folders.set(seg, makeNode());
          node.order.push(seg);
        }
        node = node.folders.get(seg)!;
      }
    }

    const countDescendants = (node: Node): number => {
      let n = node.cols.length;
      for (const name of node.order) n += countDescendants(node.folders.get(name)!);
      return n;
    };

    const rows: ColTreeRow[] = [];
    const walk = (node: Node, pathSoFar: string[], depth: number) => {
      for (const name of node.order) {
        const child = node.folders.get(name)!;
        const path = [...pathSoFar, name];
        const collapsed = !!collapsedCollectionGroups[path.join("/")];
        rows.push({ kind: "folder", path, name, depth, count: countDescendants(child), collapsed });
        if (!collapsed) walk(child, path, depth + 1);
      }
      for (const c of node.cols) rows.push({ kind: "collection", collection: c, depth });
    };
    walk(root, [], 0);
    return rows;
  }, [project, collapsedCollectionGroups]);

  // Read-only tree for the sidebar Assets panel: collection -> entity (with assets) -> assets.
  const assetsTreeRows = useMemo(() => {
    type AssetRow =
      | { kind: "collection"; colId: Id; name: string; collapsed: boolean; count: number }
      | { kind: "entity"; colId: Id; rowId: Id; label: string; iconPath: string | null; collapsed: boolean; count: number }
      | { kind: "asset"; colId: Id; rowId: Id; asset: AssetFile };
    if (!project) return [] as AssetRow[];

    const rows: AssetRow[] = [];
    for (const col of project.collections) {
      const entitiesWithAssets = col.rows.filter((r) => (r.assets?.length ?? 0) > 0);
      if (entitiesWithAssets.length === 0) continue;

      const colKey = `col:${col.id}`;
      const colCollapsed = collapsedAssetGroups[colKey] ?? true; // collapsed by default
      const colCount = entitiesWithAssets.reduce((n, r) => n + (r.assets?.length ?? 0), 0);
      rows.push({ kind: "collection", colId: col.id, name: col.name, collapsed: colCollapsed, count: colCount });
      if (colCollapsed) continue;

      for (const r of entitiesWithAssets) {
        const entKey = `ent:${col.id}:${r.id}`;
        const entCollapsed = collapsedAssetGroups[entKey] ?? true; // collapsed by default
        const profile = r.assets?.find((a) => a.id === r.profileAssetId);
        rows.push({
          kind: "entity",
          colId: col.id,
          rowId: r.id,
          label: String(r.values["id"] || getRowLabel(r) || r.id),
          iconPath: profile && (profile.mime || "").startsWith("image/") ? profile.path : null,
          collapsed: entCollapsed,
          count: r.assets?.length ?? 0,
        });
        if (entCollapsed) continue;
        for (const a of r.assets ?? []) {
          rows.push({ kind: "asset", colId: col.id, rowId: r.id, asset: a });
        }
      }
    }
    return rows;
  }, [project, collapsedAssetGroups, getRowLabel]);

  // Sidebar Datasets tree: each dataset is a top-level row; expanding it shows the
  // entries grouped by subject (if any) then field values, with result summaries at
  // the leaves. Collapse keys are namespaced by dataset id.
  const datasetTreeRows = useMemo(() => {
    type Row =
      | { kind: "dataset"; datasetId: Id; name: string; collapsed: boolean; count: number }
      | { kind: "group"; datasetId: Id; label: string; fieldLabel?: string; key: string; depth: number; collapsed: boolean; count: number }
      | { kind: "leaf"; datasetId: Id; text: string; depth: number; key: string; entryId: string };
    if (!project) return [] as Row[];

    const rows: Row[] = [];
    for (const ds of getDatasets(project)) {
      const dsKey = "ds:" + ds.id;
      const dsCollapsed = collapsedDialogueGroups[dsKey] ?? true;
      rows.push({ kind: "dataset", datasetId: ds.id, name: ds.name, collapsed: dsCollapsed, count: ds.entries.length });
      if (dsCollapsed) continue;

      const fieldDefs = ds.fieldDefs ?? [];
      const hasSubject = ds.entries.some((e) => e.subjectEntityId);

      // Build a nested grouping that keeps the entry at each leaf.
      const nested: Record<string, any> = {};
      for (const entry of ds.entries) {
        const levels: string[] = [];
        if (hasSubject) levels.push(datasetSubjectKey(project, entry));
        for (const def of fieldDefs) levels.push(String(entry.fields?.[def.id] ?? ""));

        if (levels.length === 0) {
          if (!Array.isArray(nested["_"])) nested["_"] = [];
          nested["_"].push(entry);
          continue;
        }
        let node: any = nested;
        for (let i = 0; i < levels.length; i++) {
          const k = levels[i];
          if (i === levels.length - 1) {
            if (!Array.isArray(node[k])) node[k] = [];
            node[k].push(entry);
          } else {
            if (!node[k] || Array.isArray(node[k])) node[k] = {};
            node = node[k];
          }
        }
      }

      const countLeaves = (node: any): number =>
        Array.isArray(node) ? node.length : Object.values(node).reduce((n: number, c) => n + countLeaves(c), 0);

      const walk = (node: any, pathSoFar: string[], depth: number) => {
        if (Array.isArray(node)) {
          node.forEach((entry: DatasetEntry, i: number) =>
            rows.push({
              kind: "leaf",
              datasetId: ds.id,
              text: summarizeResult(project.collections, entry.result),
              depth: depth + 1,
              key: ds.id + "/" + pathSoFar.join("/") + ":" + i,
              entryId: String(entry.id),
            })
          );
          return;
        }
        for (const key of Object.keys(node)) {
          const path = [...pathSoFar, key];
          const fullKey = ds.id + "::" + path.join("/");
          const collapsed = collapsedDialogueGroups[fullKey] ?? true;
          // depth 0 = subject (when present); otherwise the field at this level.
          const fieldIdx = hasSubject ? depth - 1 : depth;
          const fieldLabel = !(hasSubject && depth === 0) ? fieldDefs[fieldIdx]?.label : undefined;
          rows.push({
            kind: "group",
            datasetId: ds.id,
            label: key === "_" ? "(all)" : key,
            fieldLabel,
            key: fullKey,
            depth: depth + 1,
            collapsed,
            count: countLeaves(node[key]),
          });
          if (!collapsed) walk(node[key], path, depth + 1);
        }
      };
      walk(nested, [], 0);
    }
    return rows;
  }, [project, collapsedDialogueGroups]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  /** =========================
 *  Close menus on outside click
 *  ========================= */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;

      if (profileMenuOpen) {
        const el = profileMenuRef.current;
        if (el && e.target instanceof Node && !el.contains(e.target)) {
          setProfileMenuOpen(false);
        }
      }

      if (viewMenuOpen) {
        const el = viewMenuRef.current;
        if (el && e.target instanceof Node && !el.contains(e.target)) {
          setViewMenuOpen(false);
        }
      }

      if (toolsMenuOpen) {
        const el = toolsMenuRef.current;
        if (el && e.target instanceof Node && !el.contains(e.target)) {
          setToolsMenuOpen(false);
        }
      }

      if (fileMenuOpen) {
        const el = fileMenuRef.current;
        if (el && e.target instanceof Node && !el.contains(e.target)) {
          setFileMenuOpen(false);
        }
      }

      // Close doc kebab menu if click outside
      if (openDocMenuId && target && !target.closest(`[data-docmenu="${openDocMenuId}"]`)) {
        setOpenDocMenuId(null);
      }

      // Close collection kebab menu if click outside
      if (openColMenuId && target && !target.closest(`[data-colmenu="${openColMenuId}"]`)) {
        setOpenColMenuId(null);
      }

      // Close asset/entity actions menu if click outside
      if (assetCtxMenu && target && !target.closest("[data-assetkebab]") && !target.closest("[data-assetmenupopup]")) {
        setAssetCtxMenu(null);
      }
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [profileMenuOpen, viewMenuOpen, toolsMenuOpen, fileMenuOpen, openDocMenuId, openColMenuId, assetCtxMenu]);

  /** =========================
   *  Load profile + project
   *  ========================= */
  const setFavicon = (href: string) => {
    const head = document.head || document.getElementsByTagName("head")[0];
    let link = document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      head.appendChild(link);
    }
    link.type = "image/png";
    link.href = href;
  };

  const refreshAvatarSignedUrl = async (path: string | null) => {
    if (!path) {
      setAvatarUrl(null);
      return;
    }
    const { data, error } = await supabase.storage.from("avatars").createSignedUrl(path, 60 * 60);
    if (error || !data?.signedUrl) {
      setAvatarUrl(null);
      return;
    }
    setAvatarUrl(data.signedUrl);
  };

  // Use the user's profile picture as the favicon (fallback to /rpst_logo.png)
  useEffect(() => {
    setFavicon(avatarUrl || "/rpgst_logo.png");
  }, [avatarUrl]);

  const loadOrCreateProfile = async (uid: string, email: string | null) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, username, avatar_path, is_pro, stripe_subscription_id, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end, subscription_cancel_at")
      .eq("id", uid)
      .maybeSingle();

    if (error) {
      console.warn("Profile load error:", error.message);
      setProfile({
        id: uid,
        username: emailToDefaultUsername(email),
        avatar_path: null,
        is_pro: false,

        stripe_subscription_id: null,
        subscription_status: null,
        subscription_current_period_end: null,

        subscription_cancel_at_period_end: false,
        subscription_cancel_at: null,
      });
      setAvatarUrl(null);
      return;
    }

    if (!data) {
      const username = emailToDefaultUsername(email);
      const { data: inserted, error: insErr } = await supabase
        .from("profiles")
        .insert({ id: uid, username })
        .select("id, username, avatar_path, is_pro, stripe_subscription_id, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end, subscription_cancel_at")
        .single();

      if (insErr) {
        console.warn("Profile create error:", insErr.message);
        setProfile({
          id: uid,
          username,
          avatar_path: null,
          is_pro: false,

          stripe_subscription_id: null,
          subscription_status: null,
          subscription_current_period_end: null,

          subscription_cancel_at_period_end: false,
          subscription_cancel_at: null,
        });
        setAvatarUrl(null);
        return;
      }

      setProfile(inserted as ProfileRow);
      await refreshAvatarSignedUrl((inserted as ProfileRow).avatar_path ?? null);
      return;
    }

    setProfile(data as ProfileRow);
    await refreshAvatarSignedUrl((data as ProfileRow).avatar_path ?? null);
  };
  // --- Newline normalization helpers (prevents link offsets shifting on reload) ---
  const normalizeNewlines = (s: string): string => String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Builds a mapping from OLD indices -> NEW indices after normalization.
  // Only removes/changes newline sequences, so we can safely remap EntityLink.start/end.
  const normalizeNewlinesWithIndexMap = (rawText: string): { text: string; mapOldToNew: number[] } => {
    const raw = String(rawText ?? "");
    const mapOldToNew: number[] = new Array(raw.length + 1);

    let out = "";
    let newIdx = 0;

    for (let i = 0; i < raw.length; i++) {
      mapOldToNew[i] = newIdx;

      const ch = raw[i];

      // Convert CRLF -> LF (treat as single "\n")
      if (ch === "\r") {
        if (raw[i + 1] === "\n") {
          out += "\n";
          newIdx += 1;
          i += 1; // skip the "\n" in CRLF
          continue;
        }

        // Lone CR -> LF
        out += "\n";
        newIdx += 1;
        continue;
      }

      out += ch;
      newIdx += 1;
    }

    mapOldToNew[raw.length] = newIdx;
    return { text: out, mapOldToNew };
  };

  const remapLinkIndex = (idx: number, mapOldToNew: number[]) => {
    const i = Math.max(0, Math.min(Number(idx) || 0, mapOldToNew.length - 1));
    return mapOldToNew[i] ?? 0;
  };

  // --- Build plain text from Lexical JSON (mirrors root.getTextContent separators) ---
  const lexicalTextFromRichContent = (richJson: string): string | null => {
    if (!richJson || typeof richJson !== "string") return null;

    let parsed: any;
    try {
      parsed = JSON.parse(richJson);
    } catch {
      return null;
    }

    const root = parsed?.root;
    if (!root || typeof root !== "object") return null;

    const nodeType = (n: any) => String(n?.type ?? "");

    const textOf = (n: any): string => {
      const t = nodeType(n);

      // Text nodes (entity-link chips are TextNode subclasses: same text payload)
      if (t === "text" || t === "entity-link") return String(n?.text ?? "");

      // Line breaks (Lexical sometimes uses "linebreak")
      if (t === "linebreak") return "\n";

      const children: any[] = Array.isArray(n?.children) ? n.children : [];

      // list node: "\n" between list items
      if (t === "list") {
        return children.map((c) => textOf(c)).join("\n");
      }

      // root: "\n\n" between top-level blocks
      if (t === "root") {
        return children.map((c) => textOf(c)).join("\n\n");
      }

      // Everything else: concatenate children (paragraph, heading, listitem, etc.)
      return children.map((c) => textOf(c)).join("");
    };

    return normalizeNewlines(textOf(root));
  };

  const lexicalRichContentToRTF = (richJson?: string | null): string | null => {
    if (!richJson || typeof richJson !== "string") return null;

    let parsed: any;
    try {
      parsed = JSON.parse(richJson);
    } catch {
      return null;
    }

    const root = parsed?.root;
    if (!root || typeof root !== "object") return null;

    const esc = (s: string) =>
      String(s ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/{/g, "\\{")
        .replace(/}/g, "\\}");

    const hasFormat = (node: any, flag: number, name: string) => {
      const f = node?.format;

      if (typeof f === "number") return (f & flag) !== 0;
      if (typeof f === "string") {
        const parts = f.split(/\s+/).map((x) => x.trim().toLowerCase());
        return parts.includes(name);
      }

      return node?.[name] === true;
    };

    const renderInline = (node: any): string => {
      const t = String(node?.type ?? "");

      if (t === "text" || t === "entity-link") {
        const text = esc(String(node?.text ?? "").replace(/\u200B/g, ""));
        const bold = hasFormat(node, 1, "bold");
        const italic = hasFormat(node, 2, "italic");

        let prefix = "";
        let suffix = "";

        if (bold) {
          prefix += "\\b ";
          suffix = "\\b0 " + suffix;
        }

        if (italic) {
          prefix += "\\i ";
          suffix = "\\i0 " + suffix;
        }

        return `${prefix}${text}${suffix}`;
      }

      if (t === "linebreak") {
        return "\\line ";
      }

      const children: any[] = Array.isArray(node?.children) ? node.children : [];
      return children.map(renderInline).join("");
    };

    const renderBlock = (node: any): string => {
      const t = String(node?.type ?? "");
      const children: any[] = Array.isArray(node?.children) ? node.children : [];

      if (t === "heading") {
        const tag = String(node?.tag ?? "h1").toLowerCase();
        const size =
          tag === "h1" ? "\\fs40 " :
            tag === "h2" ? "\\fs34 " :
              "\\fs30 ";

        const txt = children.map(renderInline).join("").trim();
        return `\\par ${size}\\b ${txt}\\b0 \\fs24\\par `;
      }

      if (t === "paragraph") {
        return `\\par ${children.map(renderInline).join("")}`;
      }

      if (t === "list") {
        return children
          .map((child: any, i: number) => {
            const text = renderBlock(child).trim();
            const prefix = node?.listType === "number" ? `${i + 1}. ` : "• ";
            return `\\par ${prefix}${text}`;
          })
          .join("");
      }

      if (t === "listitem") {
        return children.map(renderInline).join("");
      }

      return children.map(renderInline).join("");
    };

    const blocks: any[] = Array.isArray(root.children) ? root.children : [];
    const body = blocks.map(renderBlock).join("");

    return body;
  };

  // --- Build an index remapper for oldText -> newText using the same diff model as updateDocumentContent ---
  const makeIndexRemapperForTextChange = (oldText: string, newText: string) => {
    if (oldText === newText) return (idx: number) => idx;

    const oldLen = oldText.length;
    const newLen = newText.length;

    let diffStart = 0;
    while (diffStart < oldLen && diffStart < newLen && oldText[diffStart] === newText[diffStart]) {
      diffStart++;
    }

    let oldEnd = oldLen;
    let newEnd = newLen;
    while (oldEnd > diffStart && newEnd > diffStart && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    const removedCount = oldEnd - diffStart;
    const insertedCount = newEnd - diffStart;

    const delStart = diffStart;
    const delEnd = oldEnd;

    const mapIndexAfterDeletion = (idx: number): number => {
      if (removedCount <= 0) return idx;
      if (idx <= delStart) return idx;
      if (idx >= delEnd) return idx - removedCount;
      return delStart;
    };

    const adjustForInsertion = (idx: number): number => {
      if (insertedCount <= 0) return idx;
      const p = diffStart;
      if (idx < p) return idx;
      return idx + insertedCount;
    };

    return (idxRaw: number) => {
      const idx = Math.max(0, Math.min(Number(idxRaw) || 0, oldLen));
      const afterDel = mapIndexAfterDeletion(idx);
      const afterIns = adjustForInsertion(afterDel);
      return Math.max(0, Math.min(afterIns, newLen));
    };
  };

  // --- Greedy old->new index map (handles multiple diffs; robust for long blank-line runs) ---
  const buildGreedyOldToNewIndexMap = (oldText: string, newText: string) => {
    const oldLen = oldText.length;
    const newLen = newText.length;
    const mapOldToNew: number[] = new Array(oldLen + 1);

    let i = 0;
    let j = 0;
    const LOOKAHEAD = 80;

    while (i < oldLen && j < newLen) {
      mapOldToNew[i] = j;

      if (oldText[i] === newText[j]) {
        i++;
        j++;
        continue;
      }

      // Look ahead in new for old[i] (insertion in new)
      let insAt = -1;
      for (let jj = j + 1; jj < Math.min(newLen, j + 1 + LOOKAHEAD); jj++) {
        if (newText[jj] === oldText[i]) {
          insAt = jj;
          break;
        }
      }

      // Look ahead in old for new[j] (deletion from old)
      let delAt = -1;
      for (let ii = i + 1; ii < Math.min(oldLen, i + 1 + LOOKAHEAD); ii++) {
        if (oldText[ii] === newText[j]) {
          delAt = ii;
          break;
        }
      }

      if (insAt !== -1 && (delAt === -1 || insAt - j <= delAt - i)) {
        // Treat as insertion(s): advance new pointer to the match
        j = insAt;
        continue;
      }

      if (delAt !== -1) {
        // Treat as deletion(s): map deleted old chars to current new index
        while (i < delAt) {
          mapOldToNew[i] = j;
          i++;
        }
        continue;
      }

      // Fallback: advance both
      i++;
      j++;
    }

    // Finish mapping remaining old indices to current/new end
    while (i < oldLen) {
      mapOldToNew[i] = j;
      i++;
    }
    mapOldToNew[oldLen] = newLen;

    return mapOldToNew;
  };

  const mapOldIndex = (idxRaw: number, mapOldToNew: number[]) => {
    const idx = Math.max(0, Math.min(Number(idxRaw) || 0, mapOldToNew.length - 1));
    return mapOldToNew[idx] ?? 0;
  };

  const normalizeLoadedProject = (raw: any): Project => {
    const rawDefs = Array.isArray(raw?.dialogueFieldDefs) ? raw.dialogueFieldDefs : [];
    const dialogueFieldDefs: DialogueFieldDef[] =
      rawDefs.length > 0
        ? rawDefs
          .map((d: any) => ({
            id: String(d?.id ?? "").trim(),
            label: String(d?.label ?? "Field").trim() || "Field",
            type: (d?.type === "string" || d?.type === "bool" ? d.type : "number") as "string" | "number" | "bool",
            defaultValue: d?.defaultValue,
          }))
          .filter((d: DialogueFieldDef) => !!d.id)
        : DEFAULT_DIALOGUE_FIELD_DEFS;

    const p: Project = {
      id: String(raw?.id ?? "project_1"),
      name: String(raw?.name ?? "Sample Story"),
      documents: Array.isArray(raw?.documents) ? raw.documents : [],
      collections: Array.isArray(raw?.collections) ? raw.collections : [],
      datasets: Array.isArray(raw?.datasets) ? raw.datasets : [],
      // Legacy fields kept temporarily for migration; stripped before return.
      dialogueEntries: Array.isArray(raw?.dialogueEntries) ? raw.dialogueEntries : [],
      dialogueFieldDefs,

      // ✅ keep view + timeline labels (so beats, enabled/disabled, labels persist)
      view: raw?.view ?? undefined,
      timelineLabels: Array.isArray(raw?.timelineLabels) ? raw.timelineLabels : [],

      // ✅ keep explicit (empty) folders and world-map pins across reloads
      documentFolders: Array.isArray(raw?.documentFolders) ? raw.documentFolders : [],
      collectionFolders: Array.isArray(raw?.collectionFolders) ? raw.collectionFolders : [],
      worldMapDocPins: Array.isArray(raw?.worldMapDocPins) ? raw.worldMapDocPins : [],
      worldMapLabelPins: Array.isArray(raw?.worldMapLabelPins) ? raw.worldMapLabelPins : [],
      worldMaps: Array.isArray(raw?.worldMaps) ? raw.worldMaps : [],
    };

    // Ensure the currently-open map is represented in the worldMaps archive (migrates
    // older single-map saves and refreshes the active entry from the live fields).
    {
      const { worldMaps, activeId } = archiveActiveWorldMap(p);
      p.worldMaps = worldMaps;
      if (activeId) {
        p.view = { ...(p.view ?? {}), activeWorldMapId: activeId };
      }
    }

    p.documents = p.documents.map((d: any) => {
      const rawContent = String(d?.content ?? "");
      const { text: storedContentNorm, mapOldToNew } = normalizeNewlinesWithIndexMap(rawContent);

      const rich = typeof d?.richContent === "string" ? d.richContent : undefined;

      // If richContent exists, rebuild plain text from it so empty paragraphs/newlines match Lexical on reload.
      const derived = rich ? lexicalTextFromRichContent(rich) : null;

      // Source of truth: prefer derived text when available, else stored content.
      const finalContent = derived != null ? derived : storedContentNorm;

      const base: any = {
        ...d, // preserve folderPath, timelinePos, and any other doc fields
        id: String(d?.id ?? `doc_${Date.now()}`),
        title: String(d?.title ?? "Untitled"),
        content: finalContent,
        richContent: rich,
        entityLinks: Array.isArray(d?.entityLinks) ? d.entityLinks : [],
        __newlineIndexMap: mapOldToNew, // temp: CRLF -> LF remap
        __storedContentNorm: storedContentNorm, // temp: for link remap when finalContent differs
      };

      // ✅ timeline position persists
      if (typeof d?.timelinePos === "number") base.timelinePos = d.timelinePos;

      return base as any;
    });

    p.collections = p.collections.map((c: any) => {
      // Folder migration: derive folderPath from the legacy "Folder: Name" name
      // convention when not already set, and clean the name to the leaf.
      let migratedName = String(c?.name ?? "Collection");
      let migratedFolderPath: string[] = Array.isArray(c?.folderPath) ? c.folderPath.map(String) : [];
      if (!Array.isArray(c?.folderPath)) {
        const parsed = parseTitlePath(migratedName);
        migratedFolderPath = parsed.folderPath;
        migratedName = parsed.name || migratedName;
      }
      return {
        id: String(c?.id ?? `col_${Date.now()}`),
        name: migratedName,
        folderPath: migratedFolderPath,
        color: String(c?.color ?? getDefaultColor(0)),
        kind: (c?.kind === "characters" ? "characters" : "generic") as "characters" | "generic",
        assetsEnabled: c?.assetsEnabled !== false,
        schema: Array.isArray(c?.schema) ? c.schema : [],
        rows: Array.isArray(c?.rows) ? c.rows : [],
      };
    });

    // Desktop only: self-heal asset paths whose collection-slug prefix has drifted
    // (e.g. a collection was moved into a folder). The canonical desktop path is
    // `<collectionSlug>/<entityId>/<filename>`, matching where the vault keeps files.
    if (isDesktop) {
      p.collections = p.collections.map((c: any) => {
        const colSlug = colVaultSegments(c.folderPath, c.name).join("/");
        return {
          ...c,
          rows: (c.rows ?? []).map((r: any) => {
            if (!(r?.assets?.length)) return r;
            const entityKey = String(r.values?.["id"] ?? "") || String(r.id ?? "");
            return {
              ...r,
              assets: r.assets.map((a: any) => {
                const filename = String(a?.path ?? "").split("/").pop() ?? "";
                return { ...a, path: `${colSlug}/${entityKey}/${filename}` };
              }),
            };
          }),
        };
      });
    }

    // ── Datasets migration ──────────────────────────────────────────────────
    // Normalize each dataset's fieldDefs + entries, and (for old saves with no
    // `datasets`) build the default Dialogue dataset from legacy dialogueEntries.
    const coerceFieldDefs = (defs: any): DialogueFieldDef[] =>
      (Array.isArray(defs) ? defs : [])
        .map((d: any) => ({
          id: String(d?.id ?? "").trim(),
          label: String(d?.label ?? "Field").trim() || "Field",
          type: (d?.type === "string" || d?.type === "bool" ? d.type : "number") as DatasetFieldType,
          defaultValue: d?.defaultValue,
        }))
        .filter((d: DialogueFieldDef) => !!d.id);

    const coerceResult = (raw: any, fallbackText: string): DatasetResult => {
      const r = raw && typeof raw === "object" ? raw : null;
      if (r?.kind === "value") {
        const vt: DatasetFieldType = r.valueType === "number" || r.valueType === "bool" ? r.valueType : "string";
        return { kind: "value", valueType: vt, value: vt === "number" ? Number(r.value) || 0 : String(r.value ?? "") };
      }
      if (r?.kind === "column" && r.collectionId && r.entityId && r.fieldId) {
        return { kind: "column", collectionId: String(r.collectionId), entityId: String(r.entityId), fieldId: String(r.fieldId), value: r.value ?? "" };
      }
      return { kind: "text", value: r?.kind === "text" ? String(r.value ?? "") : fallbackText };
    };

    const coerceEntry = (e: any, defs: DialogueFieldDef[]): DatasetEntry => ({
      id: String(e?.id ?? newDatasetEntryId()),
      subjectCollectionId: String(e?.subjectCollectionId ?? e?.speakerCollectionId ?? e?.collectionId ?? "") || undefined,
      subjectEntityId: String(e?.subjectEntityId ?? e?.speakerEntityId ?? e?.entityId ?? e?.characterId ?? "") || undefined,
      fields: ensureDialogueFieldValues(defs, e?.fields),
      result: coerceResult(e?.result, String(e?.text ?? "")),
    });

    if (Array.isArray(p.datasets) && p.datasets.length > 0) {
      p.datasets = p.datasets.map((ds: any) => {
        const defs = coerceFieldDefs(ds?.fieldDefs);
        return {
          id: String(ds?.id ?? newDatasetId()),
          name: String(ds?.name ?? "Dataset").trim() || "Dataset",
          fieldDefs: defs,
          entries: (Array.isArray(ds?.entries) ? ds.entries : []).map((e: any) => coerceEntry(e, defs)),
        };
      });
    } else {
      // Legacy save (or empty): construct the Dialogue dataset from dialogueEntries.
      const legacyEntries = (p.dialogueEntries ?? []).map((e: any) => {
        const incomingFields =
          e?.fields && typeof e.fields === "object"
            ? e.fields
            : { stage: Math.max(1, Number(e?.stage ?? 1) || 1), interaction: Math.max(1, Number(e?.interaction ?? 1) || 1) };
        return coerceEntry({ ...e, fields: incomingFields }, dialogueFieldDefs);
      });
      p.datasets = [
        { id: DIALOGUE_DATASET_ID, name: "Dialogue", fieldDefs: dialogueFieldDefs, entries: legacyEntries },
      ];
    }

    // Legacy fields are now fully migrated into `datasets`; drop them.
    delete (p as any).dialogueEntries;
    delete (p as any).dialogueFieldDefs;

    const docIdSet = new Set(p.documents.map((d) => d.id));
    p.documents = p.documents.map((d: any) => {
      const mapOldToNew: number[] | null = Array.isArray(d.__newlineIndexMap) ? d.__newlineIndexMap : null;

      // Step 1: CRLF/CR -> LF remap (old raw indices -> normalized stored indices)
      const remapNewlinesOnly = (n: number) =>
        mapOldToNew ? remapLinkIndex(n, mapOldToNew) : Number(n) || 0;

      // Step 2: if we rebuilt content from richContent, remap indices from storedContentNorm -> final content
      const storedNorm =
        typeof d.__storedContentNorm === "string" ? d.__storedContentNorm : String(d.content ?? "");
      const finalText = String(d.content ?? "");
      const remapToFinal = makeIndexRemapperForTextChange(storedNorm, finalText);

      const remap = (n: number) => remapToFinal(remapNewlinesOnly(n));

      // Folder migration: derive folderPath from the legacy "Folder: Name" title
      // convention when not already set, and clean the title to the leaf name.
      let migratedTitle = String(d.title ?? "");
      let migratedFolderPath: string[] = Array.isArray(d.folderPath) ? d.folderPath.map(String) : [];
      if (!Array.isArray(d.folderPath)) {
        const parsed = parseTitlePath(migratedTitle);
        migratedFolderPath = parsed.folderPath;
        migratedTitle = parsed.name;
      }

      const next = {
        ...d,
        title: migratedTitle,
        folderPath: migratedFolderPath,
        entityLinks: (d.entityLinks ?? [])
          .map((l: any) => {
            const startRaw = Number(l?.start ?? 0);
            const endRaw = Number(l?.end ?? 0);

            const start = remap(startRaw);
            const end = remap(endRaw);

            return {
              id: String(l?.id ?? `link_${Date.now()}_${Math.random().toString(16).slice(2)}`),
              docId: String(l?.docId ?? d.id),
              collectionId: String(l?.collectionId ?? ""),
              entityId: String(l?.entityId ?? ""),
              start,
              end,
            };
          })
          .filter(
            (l: EntityLink) =>
              docIdSet.has(l.docId) &&
              l.collectionId &&
              l.entityId &&
              Number.isFinite(l.start) &&
              Number.isFinite(l.end) &&
              l.end > l.start
          ),
      };

      // remove temp
      const { __newlineIndexMap: _omit1, __storedContentNorm: _omit2, ...clean } = next as any;
      return clean;
    });

    // ✅ Migrate legacy offset-based links into EntityLink chips inside richContent.
    // (Docs that already use chips are left alone.) This converges imports, sync, and
    // old saves onto the chip model so renames can keep linked text current.
    {
      const labelOf: LabelResolver = (cid, eid) => {
        const col = p.collections.find((c) => c.id === cid);
        const row = col?.rows.find((r) => r.id === eid);
        return row ? String(row.values["name"] || row.values["id"] || row.id) : null;
      };
      const colorOf = (cid: string) => p.collections.find((c) => c.id === cid)?.color;
      p.documents = p.documents.map((d) => {
        if (richContentHasChips(d.richContent)) return d;
        if (!d.entityLinks || d.entityLinks.length === 0) return d;
        try {
          const res = migrateDocToChips(d, labelOf, colorOf);
          return { ...d, richContent: res.richContent, content: res.content, entityLinks: res.entityLinks };
        } catch {
          return d;
        }
      });
    }

    // ✅ normalize timeline labels (entity-based)
    p.timelineLabels = (p.timelineLabels ?? [])
      .map((l: any) => {
        const id = String(l?.id ?? `tl_${Date.now()}_${Math.random().toString(16).slice(2)}`);
        const position = Number(l?.position ?? 0);

        const collectionId = typeof l?.collectionId === "string" ? l.collectionId : "";
        const entityId = typeof l?.entityId === "string" ? l.entityId : "";

        if (!collectionId || !entityId) return null;

        return { id, position, collectionId, entityId };
      })
      .filter(Boolean) as any;

    return p;
  };

  const loadOrCreateProject = async (uid: string): Promise<Project | null> => {
    // On web, reopen whichever project the user last had open.
    const preferred = !isDesktop && uid ? (localStorage.getItem(`web_active_project_${uid}`) ?? undefined) : undefined;
    const result = await platform.loadProject(uid, preferred);
    if (!result) {
      if (isDesktop) {
        setNeedsVaultPicker(true);
        return null;
      }
      throw new Error("Failed to load project.");
    }

    const { project: loaded, rowId } = result;
    const normalized = normalizeLoadedProject(loaded);
    normalized.name = loaded.name ?? normalized.name;

    setProject(normalized);
    setProjectRowId(rowId);
    if (!isDesktop && uid) {
      localStorage.setItem(`web_active_project_${uid}`, rowId);
      platform.listProjects(uid).then(setWebProjects).catch(() => {});
    }

    const savedDocId = localStorage.getItem(`lastDocId:${normalized.id}`);
    const savedColId = localStorage.getItem(`lastCollectionId:${normalized.id}`);
    const restoredDocId =
      savedDocId && normalized.documents.some((d) => d.id === savedDocId)
        ? savedDocId
        : normalized.documents[0]?.id ?? "";
    const restoredColId =
      savedColId && normalized.collections.some((c) => c.id === savedColId)
        ? savedColId
        : normalized.collections[0]?.id ?? "";
    setActiveDocId(restoredDocId);
    setActiveCollectionId(restoredColId);

    // Keep the recent-vaults entry's display name in sync with the project name.
    if (isDesktop) {
      const vp = getVaultPath();
      if (vp) updateRecentVaultName(vp, normalized.name);
      // Loads the saved sync link (incl. syncedHash) so unpushed local edits are
      // detected even across restarts. If the project is linked but we're signed
      // out and online, prompt to sign in so it can sync.
      getVaultSyncMeta()
        .then(async (m) => {
          setSyncMeta(m);
          if (m && typeof navigator !== "undefined" && navigator.onLine) {
            const { data } = await supabase.auth.getSession();
            if (!data.session) {
              setSignInContext("linkedOpen");
              setSignInModalOpen(true);
            }
          }
        })
        .catch(() => setSyncMeta(null));
    }

    return normalized;
  };

  // ── Web multi-project switcher ──────────────────────────────────────────
  const applyLoadedProject = (loaded: Project, rowId: string, uid: string) => {
    const normalized = normalizeLoadedProject(loaded);
    normalized.name = loaded.name ?? normalized.name;
    setProject(normalized);
    setProjectRowId(rowId);
    localStorage.setItem(`web_active_project_${uid}`, rowId);
    lastSavedJsonRef.current = JSON.stringify(normalized);
    setIsDirty(false);
    setActiveDocId(normalized.documents[0]?.id ?? "");
    setActiveCollectionId(normalized.collections[0]?.id ?? "");
  };

  const switchToProject = async (rowId: string) => {
    setProjectSwitcherOpen(false);
    if (!userId || rowId === projectRowId) return;
    if (isDirty) await saveProjectToSupabase();
    setLoadingInit(true);
    try {
      const result = await platform.loadProject(userId, rowId);
      if (!result) throw new Error("Couldn't open that project.");
      applyLoadedProject(result.project, result.rowId, userId);
      setWebProjects(await platform.listProjects(userId));
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to open project.", { title: "Open project" });
    } finally {
      setLoadingInit(false);
    }
  };

  const createNewWebProject = async () => {
    setProjectSwitcherOpen(false);
    if (isGuest) {
      promptCreateAccount("create more than one project");
      return;
    }
    if (!profile?.is_pro) {
      const ok = await appModal.confirm({
        title: "Pro feature",
        message: "Multiple projects are part of Pro. Upgrade to create and manage more than one project on the web.",
        confirmText: "Upgrade to Pro",
        cancelText: "Not now",
      });
      if (ok) goPro();
      return;
    }
    if (isDirty) await saveProjectToSupabase();
    setLoadingInit(true);
    try {
      const result = await platform.createProject(userId!, createSeedProject("Untitled Story"));
      applyLoadedProject(result.project, result.rowId, userId!);
      setWebProjects(await platform.listProjects(userId!));
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to create project.", { title: "New project" });
    } finally {
      setLoadingInit(false);
    }
  };

  // Close the project switcher on outside click.
  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!projectSwitcherRef.current?.contains(e.target as Node)) setProjectSwitcherOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [projectSwitcherOpen]);

  // Track online/offline so we can warn before anything that needs the network.
  useEffect(() => {
    const update = () => setIsOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Web: a "?upgrade=1" deep link (e.g. from the desktop upgrade prompt) opens
  // the profile modal so the user can go Pro.
  useEffect(() => {
    if (isDesktop) return;
    if (/[?&]upgrade=1\b/.test(window.location.search || "")) {
      const t = setTimeout(() => openProfileModal(), 300);
      return () => clearTimeout(t);
    }
  }, []);

  const requireOnline = (): boolean => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      appModal.alert("You appear to be offline. Connect to the internet and try again.", { title: "Offline" });
      return false;
    }
    return true;
  };

  // ── Desktop: optional web-account session for syncing ───────────────────
  useEffect(() => {
    if (!isDesktop) return;
    supabase.auth.getSession().then(({ data }) => setSyncSession(data.session ?? null)).catch(() => {});
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSyncSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Track whether the signed-in web account is Pro (sync requires Pro). Re-checks
  // on window focus too, so it picks up an upgrade made in the browser.
  useEffect(() => {
    if (!isDesktop) return;
    const uid = syncSession?.user?.id;
    if (!uid) { setSyncIsPro(false); return; }
    let cancelled = false;
    const refresh = () => {
      supabase
        .from("profiles")
        .select("is_pro")
        .eq("id", uid)
        .maybeSingle()
        .then(({ data }) => { if (!cancelled) setSyncIsPro(!!data?.is_pro); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); };
  }, [syncSession?.user?.id]);

  const desktopSignIn = async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setSignInError("You appear to be offline. Connect to the internet to sign in.");
      return;
    }
    setSignInBusy(true);
    setSignInError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: signInEmail.trim(),
        password: signInPassword,
      });
      if (error) throw error;
      setSignInModalOpen(false);
      setSignInContext("default");
      setSignInPassword("");
    } catch (e: any) {
      setSignInError(e?.message ?? "Sign in failed.");
    } finally {
      setSignInBusy(false);
    }
  };

  const desktopSignOut = async () => {
    try { await supabase.auth.signOut(); } catch { /* ignore */ }
    setSyncSession(null);
  };

  // Gate a sync action behind a signed-in Pro web account.
  const requireSyncPro = (): boolean => {
    if (!requireOnline()) return false;
    if (!syncSession) {
      setSignInModalOpen(true);
      return false;
    }
    if (!syncIsPro) {
      void appModal
        .confirm({
          title: "Pro required",
          message: "Syncing between desktop and web is a Pro feature. Upgrade to Pro to enable it. We'll open the upgrade page in your browser.",
          confirmText: "Upgrade to Pro",
          cancelText: "Not now",
        })
        .then((ok) => {
          if (ok) platform.openExternal("https://app.rpgstorytoolkit.com/?upgrade=1");
        });
      return false;
    }
    return true;
  };

  // Record a successful sync using the web row's authoritative updated_at, so the
  // staleness check below compares like-for-like (no client/server clock skew).
  const stampSynced = async (
    webProjectId: string,
    accountId: string,
    syncedProject: Project | null | undefined,
    vault?: string,
    assetPaths?: string[],
    serverUpdatedAt?: string | null
  ) => {
    // Prefer the authoritative updated_at returned by the write; only fetch if absent.
    let ts = serverUpdatedAt ?? "";
    if (!ts) {
      ts = new Date().toISOString();
      try {
        const { data } = await supabase.from("projects").select("updated_at").eq("id", webProjectId).maybeSingle();
        if (data?.updated_at) ts = data.updated_at as string;
      } catch { /* ignore */ }
    }
    const syncedHash = syncedProject ? hashString(syncContentString(syncedProject)) : undefined;
    const meta = { webProjectId, accountId, lastSyncedAt: ts, syncedHash, syncedAssetPaths: assetPaths };
    await setVaultSyncMeta(meta, vault);
    setSyncMeta(meta);
    setWebHasNewer(false);
    return meta;
  };

  // Quietly check whether the linked web project is newer than our last sync.
  const checkWebNewer = useCallback(async () => {
    if (!isDesktop) return;
    if (!syncMeta || !syncSession || syncSession.user?.id !== syncMeta.accountId) { setWebHasNewer(false); return; }
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    try {
      const { data } = await supabase.from("projects").select("updated_at").eq("id", syncMeta.webProjectId).maybeSingle();
      const webTs = data?.updated_at ? new Date(data.updated_at as string).getTime() : 0;
      const localTs = syncMeta.lastSyncedAt ? new Date(syncMeta.lastSyncedAt).getTime() : 0;
      setWebHasNewer(webTs > localTs + 1000); // 1s tolerance
    } catch { /* ignore */ }
  }, [syncMeta, syncSession]);

  // Re-check when the link changes, when the window regains focus, and periodically.
  useEffect(() => {
    if (!isDesktop || !syncMeta) { setWebHasNewer(false); return; }
    checkWebNewer();
    const onFocus = () => checkWebNewer();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(checkWebNewer, 60000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(id); };
  }, [checkWebNewer, syncMeta]);

  // Pull: open a picker of the web account's projects.
  const pullProjectFromWeb = async () => {
    if (!requireSyncPro()) return;
    const uid = syncSession!.user.id;
    setTransferBusy(true);
    try {
      setWebPickerProjects(await webPlatform.listProjects(uid));
      setWebPickerOpen(true);
    } catch (e: any) {
      appModal.alert(e?.message ?? "Couldn't list your web projects.", { title: "Sync" });
    } finally {
      setTransferBusy(false);
    }
  };

  // Pull a specific web project into a brand-new local vault and link them.
  const doPullProject = async (projectId: string) => {
    setWebPickerOpen(false);
    if (!requireSyncPro()) return;
    const uid = syncSession!.user.id;
    const picked = await createVaultFolder();
    if (!picked) return;
    setLoadingInit(true);
    await resizeForLauncher(false);
    try {
      const result = await webPlatform.loadProject(uid, projectId);
      if (!result) throw new Error("Project not found on your web account.");
      const proj = normalizeLoadedProject(result.project);
      proj.name = result.project.name ?? proj.name;

      const vault = (await renameVaultFolder(proj.name)) ?? picked;

      // Download the project's assets from the web, then re-key them into the
      // vault's engine-readable scheme and write everything locally.
      const bytes = new Map<string, Uint8Array>();
      for (const p of collectAssetPaths(proj)) {
        const b = await webPlatform.readAssetBytes(p).catch(() => null);
        if (b) bytes.set(p, b);
      }
      await rekeyAndUploadAssets(proj, bytes);
      await platform.saveProject(vault, proj);
      await stampSynced(projectId, uid, proj, vault, webAssetPathsFor(proj, uid));

      setProjectRowId(vault);
      updateRecentVaultName(vault, proj.name);
      setRecentVaults(getRecentVaults());
      setNeedsVaultPicker(false);
      setProject(proj);
      setActiveDocId(proj.documents[0]?.id ?? "");
      setActiveCollectionId(proj.collections[0]?.id ?? "");
      lastSavedJsonRef.current = JSON.stringify(proj);
      setIsDirty(false);
      await appModal.alert("Imported from your web account and linked for sync.", { title: "Imported" });
    } catch (e: any) {
      appModal.alert(e?.message ?? "Import failed.", { title: "Sync" });
    } finally {
      setLoadingInit(false);
    }
  };

  // Create a new local vault that also creates a linked project on the web account.
  const createSyncedVault = async () => {
    if (!requireSyncPro()) return;
    const uid = syncSession!.user.id;
    const picked = await createVaultFolder();
    if (!picked) return;
    setLoadingInit(true);
    await resizeForLauncher(false);
    try {
      const seed = createSeedProject("Untitled Story");
      const norm = normalizeLoadedProject(seed);
      const vault = (await renameVaultFolder(norm.name)) ?? picked;
      await platform.saveProject(vault, norm);
      const created = await webPlatform.createProject(uid, norm);
      await stampSynced(created.rowId, uid, norm, vault, webAssetPathsFor(norm, uid));

      setProjectRowId(vault);
      updateRecentVaultName(vault, seed.name);
      setRecentVaults(getRecentVaults());
      setNeedsVaultPicker(false);
      setProject(norm);
      setActiveDocId(norm.documents[0]?.id ?? "");
      setActiveCollectionId(norm.collections[0]?.id ?? "");
      lastSavedJsonRef.current = JSON.stringify(norm);
      setIsDirty(false);
      await appModal.alert("New synced vault created and linked to a new project on your web account.", { title: "Synced vault" });
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to create synced project.", { title: "Sync" });
    } finally {
      setLoadingInit(false);
    }
  };

  // Launcher "Create new project": a signed-in Pro account creates a synced
  // project (local + web); otherwise it's a plain local project.
  const handleCreateNewProject = () => {
    if (syncSession && syncIsPro) createSyncedVault();
    else openVaultAndLoad(null, { create: true });
  };

  // Launcher "Import project": signed-in users choose web vs file; otherwise file.
  const handleLauncherImport = () => {
    if (syncSession) setImportChooserOpen(true);
    else importFileInputRef.current?.click();
  };

  // Re-key a project's assets into the WEB storage scheme (mutates `proj`, which
  // must be a clone). Returns the uploads to perform plus `allWebPaths` (every
  // asset's web path). When `alreadySynced` is given, assets already on the web are
  // re-keyed (so the saved JSON points at them) but skipped from the upload list.
  const rekeyForWeb = (proj: Project, accountId: string, alreadySynced?: Set<string>) => {
    const pathMap = new Map<string, string>();
    const uploads: { oldPath: string; newPath: string; name: string; mime: string }[] = [];
    const allWebPaths = new Set<string>();
    const rekey = (oldPath: string, newPath: string, name: string, mime: string): string => {
      if (!oldPath) return oldPath;
      const ex = pathMap.get(oldPath);
      if (ex) return ex;
      pathMap.set(oldPath, newPath);
      allWebPaths.add(newPath);
      if (!alreadySynced || !alreadySynced.has(newPath)) {
        uploads.push({ oldPath, newPath, name, mime });
      }
      return newPath;
    };
    for (const col of proj.collections ?? []) {
      for (const row of col.rows ?? []) {
        for (const a of row.assets ?? []) {
          if (!a?.path) continue;
          const safeName = sanitizeSegment(a.name) || "file";
          a.path = rekey(a.path, `${accountId}/${proj.id}/${col.id}/${row.id}/${a.id}_${safeName}`, a.name, a.mime || "application/octet-stream");
        }
      }
    }
    const covers = proj.view?.timelineCovers;
    if (covers) {
      for (const k of Object.keys(covers)) {
        const beat = Number(k);
        const oldP = covers[beat];
        if (!oldP) continue;
        const base = sanitizeSegment(oldP.split("/").pop() || `cover_${beat}`) || `cover_${beat}`;
        covers[beat] = rekey(oldP, `${accountId}/${proj.id}/timeline/${beat}_${base}`, base, guessImageMime(base));
      }
    }
    const remap = (oldPath?: string): string | undefined => {
      if (!oldPath) return oldPath;
      const known = pathMap.get(oldPath);
      if (known) return known;
      const base = sanitizeSegment(oldPath.split("/").pop() || "map") || "map";
      return rekey(oldPath, `${accountId}/${proj.id}/worldmaps/${Date.now()}_${base}`, base, guessImageMime(base));
    };
    for (const m of proj.worldMaps ?? []) m.imagePath = remap(m.imagePath);
    if (proj.view) proj.view.worldMapImagePath = remap(proj.view.worldMapImagePath);
    return { uploads, allWebPaths: [...allWebPaths] };
  };

  // Every web asset path for a project (no upload) — used to record the synced asset
  // set after a pull, so a subsequent push knows those bytes are already on the web.
  const webAssetPathsFor = (proj: Project, accountId: string): string[] =>
    rekeyForWeb(structuredClone(proj), accountId).allWebPaths;

  // Push the current local project (+ assets) up to its linked web project. Only
  // assets not already on the web are uploaded. Returns the synced baseline project
  // and the full set of web asset paths (to stamp into sync.json).
  // Raised when a safe (non-forced) push finds the web copy changed since our baseline.
  const WEB_CONFLICT = "WEB_CONFLICT";

  const syncPushToWeb = async (
    webProjectId: string,
    accountId: string,
    opts?: { incremental?: boolean; force?: boolean }
  ): Promise<{ project: Project; assetPaths: string[]; updatedAt: string | null }> => {
    const live = (projectRef.current ?? project) as Project;
    const clone = structuredClone(live) as Project;
    const meta = await getVaultSyncMeta(getVaultPath() ?? undefined);

    // Safe pushes use optimistic concurrency against our last-synced timestamp; forced
    // pushes (explicit "Sync now → Push") overwrite unconditionally.
    const expected = opts?.force ? null : meta?.lastSyncedAt ?? null;

    // Manual/forced pushes re-upload everything (authoritative); auto-sync only new assets.
    const already = opts?.incremental ? new Set(meta?.syncedAssetPaths ?? []) : new Set<string>();
    const { uploads, allWebPaths } = rekeyForWeb(clone, accountId, already);

    // Upload new assets first. Track which actually landed so a failed upload is never
    // recorded as synced (it'll retry next time). A thrown upload aborts the whole push
    // so the web row never points at missing bytes.
    const uploadedNew = new Set<string>();
    for (const u of uploads) {
      const data = await platform.readAssetBytes(u.oldPath).catch(() => null);
      if (!data) continue; // can't read locally — skip, do NOT mark as synced
      const file = new File([data as unknown as BlobPart], u.name, { type: u.mime });
      await webPlatform.uploadAsset(file, u.newPath);
      uploadedNew.add(u.newPath);
    }

    const result = await webPlatform.saveProjectIfUnchanged!(webProjectId, clone, expected);
    if (!result.ok) {
      setWebHasNewer(true);
      throw new Error(WEB_CONFLICT);
    }

    // Synced asset set = previously-synced (still present) + newly uploaded; never the
    // ones we couldn't read.
    const syncedAssets = allWebPaths.filter((p) => already.has(p) || uploadedNew.has(p));
    return { project: live, assetPaths: syncedAssets, updatedAt: result.updatedAt };
  };

  // Pull the linked web project (+ assets) down, overwriting the local vault.
  // Returns the project that is now the synced baseline.
  const syncPullFromWeb = async (webProjectId: string, accountId: string): Promise<Project> => {
    const result = await webPlatform.loadProject(accountId, webProjectId);
    if (!result) throw new Error("The linked web project no longer exists.");
    const proj = normalizeLoadedProject(result.project);
    proj.name = result.project.name ?? proj.name;
    const bytes = new Map<string, Uint8Array>();
    for (const p of collectAssetPaths(proj)) {
      const b = await webPlatform.readAssetBytes(p).catch(() => null);
      if (b) bytes.set(p, b);
    }
    await rekeyAndUploadAssets(proj, bytes);
    const vault = getVaultPath();
    if (vault) await platform.saveProject(vault, proj);
    setProject(proj);
    setActiveDocId(proj.documents[0]?.id ?? "");
    setActiveCollectionId(proj.collections[0]?.id ?? "");
    lastSavedJsonRef.current = JSON.stringify(proj);
    setIsDirty(false);
    return proj;
  };

  // "Sync now": always ask which direction to sync (the other side is overwritten).
  const syncNow = async () => {
    setFileMenuOpen(false);
    if (!syncMeta) return;
    if (!requireSyncPro()) return;
    if (syncSession!.user.id !== syncMeta.accountId) {
      const relink = await appModal.confirm({
        title: "Different account",
        message: "This project is linked to a different web account. Create a copy on your current account and sync to that instead? (The original link is replaced.)",
        confirmText: "Sync to this account",
        cancelText: "Cancel",
      });
      if (relink) await syncExistingToWeb({ skipConfirm: true });
      return;
    }

    let webUpdated = "unknown";
    try {
      const { data } = await supabase.from("projects").select("updated_at").eq("id", syncMeta.webProjectId).maybeSingle();
      if (data?.updated_at) webUpdated = new Date(data.updated_at as string).toLocaleString();
    } catch { /* ignore */ }
    const localInfo = isDirty
      ? "has unsaved changes right now"
      : syncMeta.lastSyncedAt
        ? `last synced ${new Date(syncMeta.lastSyncedAt).toLocaleString()}`
        : "not synced yet";

    const pullOpt = { value: "pull", label: "Pull: web → this device (overwrite local)" };
    const pushOpt = { value: "push", label: "Push: this device → web (overwrite web)" };
    const choice = await appModal.select({
      title: "Sync project",
      message: `Web copy last updated: ${webUpdated}\nThis device: ${localInfo}\n\nChoose a direction. The other side will be overwritten.`,
      // When the web copy is newer, default to pulling it down.
      options: webHasNewer ? [pullOpt, pushOpt] : [pushOpt, pullOpt],
      defaultValue: webHasNewer ? "pull" : "push",
      confirmText: "Sync",
    });
    if (!choice) return;

    setLoadingInit(true);
    try {
      let syncedProj: Project;
      let assetPaths: string[];
      let serverTs: string | null = null;
      if (choice === "push") {
        if (isDirty) await saveProjectToSupabase();
        const res = await syncPushToWeb(syncMeta.webProjectId, syncMeta.accountId, { force: true });
        syncedProj = res.project;
        assetPaths = res.assetPaths;
        serverTs = res.updatedAt;
      } else {
        syncedProj = await syncPullFromWeb(syncMeta.webProjectId, syncMeta.accountId);
        assetPaths = webAssetPathsFor(syncedProj, syncMeta.accountId);
      }
      await stampSynced(syncMeta.webProjectId, syncMeta.accountId, syncedProj, undefined, assetPaths, serverTs);
      await appModal.alert(choice === "push" ? "Pushed to your web account." : "Pulled from your web account.", { title: "Synced" });
    } catch (e: any) {
      appModal.alert(e?.message ?? "Sync failed.", { title: "Sync" });
    } finally {
      setLoadingInit(false);
    }
  };

  // Link an existing local-only project to a NEW web project (first-time sync).
  const syncExistingToWeb = async (opts?: { skipConfirm?: boolean }) => {
    setFileMenuOpen(false);
    if (!requireSyncPro()) return;
    const uid = syncSession!.user.id;
    if (!opts?.skipConfirm) {
      const ok = await appModal.confirm({
        title: "Sync to web",
        message: "This creates a copy of this project on your web account and links them so you can sync. Continue?",
        confirmText: "Sync to web",
        cancelText: "Cancel",
      });
      if (!ok) return;
    }
    setLoadingInit(true);
    try {
      if (isDirty) await saveProjectToSupabase();
      const live = projectRef.current ?? project;
      if (!live) throw new Error("No project loaded.");
      // Create the web row first to get its id, then push assets + data.
      const created = await webPlatform.createProject(uid, structuredClone(live) as Project);
      const clone = structuredClone(live) as Project;
      clone.id = created.project.id ?? clone.id;
      const { uploads, allWebPaths } = rekeyForWeb(clone, uid);
      for (const u of uploads) {
        const data = await platform.readAssetBytes(u.oldPath).catch(() => null);
        if (!data) continue;
        const file = new File([data as unknown as BlobPart], u.name, { type: u.mime });
        await webPlatform.uploadAsset(file, u.newPath);
      }
      await webPlatform.saveProject(created.rowId, clone);
      await stampSynced(created.rowId, uid, live, undefined, allWebPaths);
      await appModal.alert("This project is now synced to your web account.", { title: "Synced" });
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to sync this project.", { title: "Sync" });
    } finally {
      setLoadingInit(false);
    }
  };

  // ── Auto-sync on save (desktop, Pro) ────────────────────────────────────────
  // Snapshot the values runAutoSync needs so the debounced callback reads them fresh.
  const autoSyncStateRef = useRef<{
    enabled: boolean;
    meta: typeof syncMeta;
    pro: boolean;
    webNewer: boolean;
    offline: boolean;
    accountId: string;
  }>({ enabled: false, meta: null, pro: false, webNewer: false, offline: false, accountId: "" });
  useEffect(() => {
    autoSyncStateRef.current = {
      enabled: autoSyncOnSave,
      meta: syncMeta,
      pro: syncIsPro,
      webNewer: webHasNewer,
      offline: isOffline,
      accountId: syncSession?.user.id ?? "",
    };
  });

  const runAutoSync = async () => {
    const s = autoSyncStateRef.current;
    if (!isDesktop || !s.enabled || !s.pro || !s.meta || s.offline) return;
    if (s.meta.accountId !== s.accountId) return; // signed into a different account
    if (s.webNewer) return; // web is ahead — don't auto-overwrite; user resolves via Sync now
    const live = projectRef.current;
    if (!live) return;
    const unpushed = !!s.meta.syncedHash && hashString(syncContentString(live)) !== s.meta.syncedHash;
    if (!unpushed) return;
    if (savingRef.current || autoSyncingRef.current) {
      scheduleAutoSync(); // a save/sync is in flight; try again shortly
      return;
    }
    autoSyncingRef.current = true;
    try {
      const res = await syncPushToWeb(s.meta.webProjectId, s.meta.accountId, { incremental: true });
      await stampSynced(s.meta.webProjectId, s.meta.accountId, res.project, undefined, res.assetPaths, res.updatedAt);
    } catch (e: any) {
      // WEB_CONFLICT: the web changed since our baseline — leave it for the user to
      // resolve (the chip already flips to "newer on web" / "both changed"). Any other
      // failure is silent and retried after the next save.
      if (e?.message !== WEB_CONFLICT) checkWebNewer();
    } finally {
      autoSyncingRef.current = false;
    }
  };

  const scheduleAutoSync = () => {
    if (!autoSyncStateRef.current.enabled) return;
    if (autoSyncTimerRef.current != null) window.clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = window.setTimeout(() => {
      autoSyncTimerRef.current = null;
      void runAutoSync();
    }, AUTO_SYNC_DELAY_MS);
  };

  // Auto-pull: when the web copy is newer AND we have nothing local to lose, bring it
  // down automatically so devices converge. Never pulls with unsaved/unpushed local
  // edits (that's a "Both changed" conflict the user resolves via Sync now).
  const doAutoPull = async () => {
    const s = autoSyncStateRef.current;
    if (!isDesktop || !s.enabled || !s.pro || !s.meta || s.offline) return;
    if (s.meta.accountId !== s.accountId) return;
    if (dirtyRef.current || savingRef.current || autoSyncingRef.current) return;
    const live = projectRef.current;
    const unpushed = !!s.meta?.syncedHash && !!live && hashString(syncContentString(live)) !== s.meta.syncedHash;
    if (unpushed) return; // both sides changed → leave for manual resolution
    autoSyncingRef.current = true;
    try {
      const proj = await syncPullFromWeb(s.meta.webProjectId, s.meta.accountId);
      await stampSynced(s.meta.webProjectId, s.meta.accountId, proj, undefined, webAssetPathsFor(proj, s.meta.accountId));
    } catch {
      /* silent — chip stays "newer on web" for manual pull */
    } finally {
      autoSyncingRef.current = false;
    }
  };

  useEffect(() => {
    if (webHasNewer) void doAutoPull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webHasNewer]);

  // Reconnecting: re-check the web (may auto-pull) and flush any unpushed local edits.
  useEffect(() => {
    const onOnline = () => { checkWebNewer(); scheduleAutoSync(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkWebNewer]);

  // Desktop: switch to another local project (recent vault), guarding unsaved work.
  const switchToVault = async (path: string) => {
    setProjectSwitcherOpen(false);
    if (path === projectRowId) return;
    if (isDirty) await saveProjectToSupabase();
    setLoadingInit(true);
    try {
      const ok = await openRecentVault(path);
      if (!ok) {
        setVaultStatus((s) => ({ ...s, [path]: false }));
        appModal.alert("Can't find that project. It may have been moved or deleted.", { title: "Open project" });
        return;
      }
      await loadOrCreateProject(userId ?? "local");
      setRecentVaults(getRecentVaults());
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to open project.", { title: "Open project" });
    } finally {
      setLoadingInit(false);
    }
  };

  // Load sync badges for recent vaults when the desktop switcher opens.
  const refreshVaultSyncStatus = async () => {
    const recents = getRecentVaults();
    const metas = await Promise.all(
      recents.map(async (v) => [v.path, await getVaultSyncMeta(v.path)] as const)
    );
    const status: Record<string, boolean> = {};
    const linked = new Set<string>();
    for (const [path, meta] of metas) {
      status[path] = !!meta;
      if (meta?.webProjectId) linked.add(meta.webProjectId);
    }
    setVaultSyncStatus(status);
    setLinkedWebIds(linked);
    // Refresh the web-account project list so the switcher can offer them too.
    if (syncSession) {
      webPlatform.listProjects(syncSession.user.id).then(setLauncherWebProjects).catch(() => {});
    } else {
      setLauncherWebProjects([]);
    }
  };

  // When the launcher is open, load recent vaults and verify each still exists.
  useEffect(() => {
    if (!needsVaultPicker || !isDesktop) return;
    const recents = getRecentVaults();
    setRecentVaults(recents);
    setVaultStatus({});
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        recents.map(async (v) => [v.path, await vaultExists(v.path)] as const)
      );
      if (!cancelled) setVaultStatus(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [needsVaultPicker]);

  // Launcher: load each recent project's sync link (for labels + dedupe) and,
  // when signed in, the account's web projects (to surface web-only ones).
  useEffect(() => {
    if (!needsVaultPicker || !isDesktop) return;
    let cancelled = false;
    (async () => {
      const recents = getRecentVaults();
      const metas = await Promise.all(recents.map(async (v) => [v.path, await getVaultSyncMeta(v.path)] as const));
      if (cancelled) return;
      const status: Record<string, boolean> = {};
      const linked = new Set<string>();
      for (const [path, meta] of metas) {
        status[path] = !!meta;
        if (meta?.webProjectId) linked.add(meta.webProjectId);
      }
      setVaultSyncStatus(status);
      setLinkedWebIds(linked);
    })();
    if (syncSession) {
      webPlatform.listProjects(syncSession.user.id).then((ps) => { if (!cancelled) setLauncherWebProjects(ps); }).catch(() => {});
    } else {
      setLauncherWebProjects([]);
    }
    return () => { cancelled = true; };
  }, [needsVaultPicker, syncSession]);

  // Open a vault (recent path, or null = pick a folder) then load its project.
  // With { create: true }, picking a folder creates a fresh vault subfolder
  // inside it instead of adopting the picked folder as the vault root.
  const openVaultAndLoad = async (path: string | null, opts?: { create?: boolean }) => {
    setVaultPickerBusy(true);
    setInitError(null);
    try {
      let resolved: string | null = null;
      if (path) {
        const ok = await openRecentVault(path);
        if (!ok) {
          setVaultStatus((s) => ({ ...s, [path]: false }));
          return;
        }
        resolved = path;
      } else {
        resolved = opts?.create ? await createVaultFolder() : await pickVaultFolder();
        if (!resolved) return;
      }
      setNeedsVaultPicker(false);
      setLoadingInit(true);
      await resizeForLauncher(false);
      await loadOrCreateProject(userId ?? "local");
      setRecentVaults(getRecentVaults());
    } catch (e: any) {
      if (e?.message === NOT_A_VAULT_ERROR) {
        // Stay on the launcher and explain instead of bailing to an error screen.
        appModal.alert(
          "That folder isn't a project. Pick a folder that already contains a project, or use Create new project to start one.",
          { title: "Not a project" }
        );
        return;
      }
      setInitError(e?.message ?? "Failed to open vault.");
      setNeedsVaultPicker(false);
    } finally {
      setVaultPickerBusy(false);
      setLoadingInit(false);
    }
  };

  const handleRemoveRecent = (path: string) => {
    removeRecentVault(path);
    setRecentVaults(getRecentVaults());
  };

  // Create a brand-new vault: pick a parent folder and make a dedicated vault
  // subfolder inside it, then load it.
  const pickAndSwitchVault = async () => {
    setFileMenuOpen(false);
    if (isDirty) {
      const ok = await appModal.confirm({
        title: "Unsaved changes",
        message: "You have unsaved changes. Save before creating a new project?",
        confirmText: "Save & Create",
        cancelText: "Create without saving",
      });
      if (ok) await saveProjectToSupabase();
    }
    setVaultPickerBusy(true);
    try {
      const chosen = await createVaultFolder();
      if (!chosen) return;
      setLoadingInit(true);
      await loadOrCreateProject(userId ?? "local");
      setRecentVaults(getRecentVaults());
    } catch (e: any) {
      appModal.alert(e?.message ?? "Failed to load project from vault.", { title: "Vault error" });
    } finally {
      setVaultPickerBusy(false);
      setLoadingInit(false);
    }
  };

  // Return to the launcher (recent vaults + open/create) from within the app.
  const returnToLauncher = async () => {
    setFileMenuOpen(false);
    if (isDirty) {
      const ok = await appModal.confirm({
        title: "Unsaved changes",
        message: "You have unsaved changes. Save before switching project?",
        confirmText: "Save & Continue",
        cancelText: "Continue without saving",
      });
      if (ok) await saveProjectToSupabase();
    }
    setNeedsVaultPicker(true);
  };

  /** =========================
   *  Portable project export / import (.rpgproject)
   *  ========================= */
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  // Bundle the whole project (+ its assets) into a single portable file that can
  // be imported on the other platform.
  const exportProjectArchive = async () => {
    setFileMenuOpen(false);
    if (!requireAccount("export projects")) return;
    if (!project || !projectRowId) {
      appModal.alert("No project loaded.", { title: "Export failed" });
      return;
    }
    setTransferBusy(true);
    try {
      // Flush pending edits so the archive matches what's stored.
      if (isDirty) await saveProjectToSupabase();
      const src = projectRef.current ?? project;
      const { blob, missing } = await buildProjectArchive(
        src,
        isDesktop ? "desktop" : "web",
        (p) => platform.readAssetBytes(p)
      );
      const filename = `${sanitizeSegment(src.name) || "project"}.${PROJECT_FILE_EXT}`;

      if (isDesktop) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const dest = await save({
          defaultPath: filename,
          filters: [{ name: "RPG Story Project", extensions: [PROJECT_FILE_EXT] }],
        });
        if (!dest) return;
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("write_file_base64", { path: dest, data: await blobToBase64(blob) });
      } else {
        downloadBlob(filename, blob);
      }

      if (missing.length) {
        await appModal.alert(
          `Project exported. ${missing.length} asset file(s) could not be found and were skipped.`,
          { title: "Export complete" }
        );
      }
    } catch (e: any) {
      appModal.alert(e?.message ?? "Export failed.", { title: "Export failed" });
    } finally {
      setTransferBusy(false);
    }
  };

  // Re-key every asset in an imported project into the current platform's storage
  // scheme, then upload the bytes. Mutates `proj` in place.
  const rekeyAndUploadAssets = async (proj: Project, bytes: Map<string, Uint8Array>) => {
    const pathMap = new Map<string, string>();
    const uploads: { oldPath: string; newPath: string; name: string; mime: string }[] = [];

    const rekey = (oldPath: string, newPath: string, name: string, mime: string): string => {
      if (!oldPath) return oldPath;
      const existing = pathMap.get(oldPath);
      if (existing) return existing;
      pathMap.set(oldPath, newPath);
      uploads.push({ oldPath, newPath, name, mime });
      return newPath;
    };

    // Row assets (world-map images are row assets, so they're covered here too).
    for (const col of proj.collections ?? []) {
      const firstField = col.schema?.[0];
      for (const row of col.rows ?? []) {
        const entityKey = firstField
          ? String(row.values?.[firstField.id] ?? "") || row.id
          : row.id;
        for (const a of row.assets ?? []) {
          if (!a?.path) continue;
          const safeName = sanitizeSegment(a.name) || "file";
          const newPath = isDesktop
            ? `${colVaultSegments(col.folderPath, col.name).join("/")}/${entityKey}/${safeName}`
            : `${userId}/${proj.id}/${col.id}/${row.id}/${a.id}_${safeName}`;
          a.path = rekey(a.path, newPath, a.name, a.mime || "application/octet-stream");
        }
      }
    }

    // Timeline covers (their own path scheme).
    const covers = proj.view?.timelineCovers;
    if (covers) {
      for (const k of Object.keys(covers)) {
        const beat = Number(k);
        const oldPath = covers[beat];
        if (!oldPath) continue;
        const base = sanitizeSegment(oldPath.split("/").pop() || `cover_${beat}`) || `cover_${beat}`;
        const newPath = isDesktop
          ? `timeline/${beat}/${base}`
          : `${userId}/${proj.id}/timeline/${beat}_${base}`;
        covers[beat] = rekey(oldPath, newPath, base, guessImageMime(base));
      }
    }

    // World-map image references: usually already re-keyed as row assets; bring
    // anything else over generically.
    const remap = (oldPath?: string): string | undefined => {
      if (!oldPath) return oldPath;
      const known = pathMap.get(oldPath);
      if (known) return known;
      const base = sanitizeSegment(oldPath.split("/").pop() || "map") || "map";
      const newPath = isDesktop
        ? `worldmaps/${base}`
        : `${userId}/${proj.id}/worldmaps/${Date.now()}_${base}`;
      return rekey(oldPath, newPath, base, guessImageMime(base));
    };
    for (const m of proj.worldMaps ?? []) m.imagePath = remap(m.imagePath);
    if (proj.view) proj.view.worldMapImagePath = remap(proj.view.worldMapImagePath);

    // Upload the bytes for each unique asset.
    for (const u of uploads) {
      const data = bytes.get(u.oldPath);
      if (!data) continue; // missing in archive — skip rather than fail the import
      const file = new File([data as unknown as BlobPart], u.name, { type: u.mime });
      await platform.uploadAsset(file, u.newPath);
    }
  };

  const triggerImportProject = async () => {
    setFileMenuOpen(false);
    if (!requireAccount("import projects")) return;
    importFileInputRef.current?.click();
  };

  const importProjectArchive = async (file: File) => {
    setTransferBusy(true);
    try {
      const archive = await readProjectArchive(file);
      const imported = normalizeLoadedProject(archive.project);
      imported.name = archive.project.name ?? imported.name;
      imported.id = crypto.randomUUID(); // fresh id to avoid clashing with the current project

      if (isDesktop) {
        // Desktop: import lands in a brand-new vault the user chooses.
        if (isDirty) {
          const ok = await appModal.confirm({
            title: "Unsaved changes",
            message: "Importing opens a different project. Save your current changes first?",
            confirmText: "Save first",
            cancelText: "Discard",
          });
          if (ok) await saveProjectToSupabase();
        }
        const picked = await createVaultFolder();
        if (!picked) return; // cancelled folder pick
        setLoadingInit(true);
        await resizeForLauncher(false);
        // Name the vault folder after the imported project, not the default "My Story".
        const vault = (await renameVaultFolder(imported.name)) ?? picked;
        await rekeyAndUploadAssets(imported, archive.assetBytes);
        await platform.saveProject(vault, imported);
        setProjectRowId(vault);
        updateRecentVaultName(vault, imported.name); // createVaultFolder already added the entry
        setRecentVaults(getRecentVaults());
        setNeedsVaultPicker(false);
      } else {
        // Web is single-project: importing replaces the current project.
        const ok = await appModal.confirm({
          title: "Replace current project?",
          message:
            "Importing will replace your current project with the imported one. This can't be undone.",
          confirmText: "Replace",
          cancelText: "Cancel",
        });
        if (!ok) return;
        setLoadingInit(true);
        await rekeyAndUploadAssets(imported, archive.assetBytes);
        if (!projectRowId) throw new Error("No project to replace.");
        await platform.saveProject(projectRowId, imported);
      }

      // Swap the in-memory state over to the imported project.
      setProject(imported);
      setActiveDocId(imported.documents[0]?.id ?? "");
      setActiveCollectionId(imported.collections[0]?.id ?? "");
      lastSavedJsonRef.current = JSON.stringify(imported);
      setIsDirty(false);
      await appModal.alert("Project imported.", { title: "Import complete" });
    } catch (e: any) {
      appModal.alert(e?.message ?? "Import failed.", { title: "Import failed" });
    } finally {
      setTransferBusy(false);
      setLoadingInit(false);
    }
  };

  // Shrink the window into a compact launcher, or restore it to full working size.
  const resizeForLauncher = async (small: boolean) => {
    if (!isDesktop) return;
    try {
      const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (small) {
        await win.setResizable(false);
        await win.setMinSize(new LogicalSize(560, 560));
        await win.setSize(new LogicalSize(800, 820));
        await win.center();
      } else {
        await win.setResizable(true);
        await win.setMinSize(new LogicalSize(940, 600));
        await win.setSize(new LogicalSize(1400, 900));
        await win.center();
      }
    } catch {
      // Window API not available / not permitted — fall back to the in-window launcher.
    }
  };

  // Drive the window size off whether the launcher is showing.
  useEffect(() => {
    if (!isDesktop) return;
    if (needsVaultPicker) resizeForLauncher(true);
  }, [needsVaultPicker]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        setLoadingInit(true);
        setInitError(null);

        const user = await platform.getUser();
        if (cancelled) return;

        if (!user) {
          setInitError("Not authenticated. Please log in again.");
          setLoadingInit(false);
          return;
        }

        const uid = user.id;
        const email = user.email ?? null;
        setUserId(uid);
        setUserEmail(email);

        if (!isDesktop) {
          await loadOrCreateProfile(uid, email);
        } else {
          setProfile({
            id: uid,
            username: 'Local',
            avatar_path: null,
            is_pro: true,
            stripe_subscription_id: null,
            subscription_status: null,
            subscription_current_period_end: null,
            subscription_cancel_at_period_end: false,
            subscription_cancel_at: null,
          });
        }

        // On desktop, always open the launcher so the user can choose which vault to work on.
        if (isDesktop) {
          setNeedsVaultPicker(true);
          setLoadingInit(false);
          return;
        }

        await loadOrCreateProject(uid);
      } catch (e: any) {
        const msg = typeof e === "string" ? e : (e?.message ?? JSON.stringify(e) ?? "Failed to initialize.");
        setInitError(msg);
      } finally {
        if (!cancelled) setLoadingInit(false);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist last-viewed doc + collection so they survive reloads
  useEffect(() => {
    if (!project?.id || !activeDocId) return;
    localStorage.setItem(`lastDocId:${project.id}`, activeDocId);
  }, [project?.id, activeDocId]);

  useEffect(() => {
    if (!project?.id || !activeCollectionId) return;
    localStorage.setItem(`lastCollectionId:${project.id}`, activeCollectionId);
  }, [project?.id, activeCollectionId]);

  /** =========================
   *  Wiki status (public publishing)
   *  ========================= */
  useEffect(() => {
    if (!userId || !projectRowId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const { data, error } = await supabase
          .from("public_wikis")
          .select("id, slug, published, settings")
          .eq("owner_id", userId)
          .eq("project_row_id", projectRowId)
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        if (error) throw error;

        if (!data) {
          setWikiRowId(null);
          return;
        }

        setWikiRowId((data as any).id);

        setProject((prev) => {
          if (!prev) return prev;
          const next: Project = structuredClone(prev);
          next.view = next.view ?? {};
          const s = ((data as any).settings ?? {}) as any;

          next.view.wiki = {
            published: !!(data as any).published,
            slug: String((data as any).slug ?? ""),
            slugOverride: !!s.slugOverride,
            includedDocumentIds: Array.isArray(s.includedDocumentIds) ? s.includedDocumentIds : undefined,
            includedCollectionIds: Array.isArray(s.includedCollectionIds) ? s.includedCollectionIds : undefined,
            homeDocumentId: typeof s.homeDocumentId === "string" ? s.homeDocumentId : undefined,

            // ✅ SEO / indexing
            seoTitle: typeof s.seoTitle === "string" ? s.seoTitle : undefined,
            seoDescription: typeof s.seoDescription === "string" ? s.seoDescription : undefined,
            seoImageUrl: typeof s.seoImageUrl === "string" ? s.seoImageUrl : undefined,
            allowIndexing: typeof s.allowIndexing === "boolean" ? s.allowIndexing : undefined,
          };

          return next;
        });
      } catch {
        // ignore load failures; publishing UI can still be used
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, projectRowId]);

  /** =========================
   *  Save project
   *  ========================= */
  // When the project is published as a wiki, keep the public snapshot updated whenever the user saves.
  // Queued/debounced to avoid writing on every tiny state change.
  const wikiSnapshotSyncTimerRef = useRef<number | null>(null);
  const pendingWikiSnapshotRef = useRef<Project | null>(null);
  // Hash of the last snapshot we wrote, so we can skip redundant DB writes.
  const lastWikiSnapshotHashRef = useRef<string | null>(null);

  const queueWikiSnapshotSync = (p: Project) => {
    const w = p.view?.wiki;
    if (!wikiRowId || !w?.published) return;

    pendingWikiSnapshotRef.current = p;
    if (wikiSnapshotSyncTimerRef.current != null) return;

    wikiSnapshotSyncTimerRef.current = window.setTimeout(async () => {
      wikiSnapshotSyncTimerRef.current = null;
      const latest = pendingWikiSnapshotRef.current;
      pendingWikiSnapshotRef.current = null;
      if (!latest) return;
      await syncPublishedWikiSnapshot(latest);
    }, 750);
  };

  const saveProjectToSupabase = async (projectOverride?: Project, rowIdOverride?: string) => {
    const p = projectOverride ?? projectRef.current;
    const rowId = rowIdOverride ?? projectRowId;
    if (!p || !rowId) return;

    setSaving(true);
    setSaveMessage(null);

    try {
      await platform.saveProject(rowId, p);

      // Keep published wiki snapshot in sync with saved changes (entities, collections, pages, etc.)
      queueWikiSnapshotSync(p);

      // Update autosave baseline to exactly what we saved
      const savedJson = JSON.stringify(p);
      lastSavedJsonRef.current = savedJson;

      // If user changed more while save was in-flight, remain dirty
      const current = projectRef.current;
      const stillDirty = !!current && JSON.stringify(current) !== savedJson;
      setIsDirty(stillDirty);

      setSaveMessage("Saved.");
      setTimeout(() => setSaveMessage(null), 2000);

      // Desktop Pro: quietly push to the linked web project shortly after saving.
      if (isDesktop) scheduleAutoSync();
    } catch (e: any) {
      setSaveMessage(`Save failed: ${e?.message ?? "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const scheduleAutoSave = () => {
    if (!projectRowId) return;

    if (autoSaveTimerRef.current != null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(async () => {
      autoSaveTimerRef.current = null;

      if (!dirtyRef.current) return;

      // If a save is already happening, defer once.
      if (savingRef.current) {
        pendingAutoSaveRef.current = true;
        return;
      }

      await saveProjectToSupabase(projectRef.current ?? undefined);
    }, AUTO_SAVE_DELAY_MS);
  };

  // Detect changes and autosave after debounce
  useEffect(() => {
    if (!project || !projectRowId) return;

    let json: string;
    try {
      json = JSON.stringify(project);
    } catch {
      return;
    }

    // First time we have a project loaded: treat it as baseline (don’t autosave immediately)
    if (lastSavedJsonRef.current == null) {
      lastSavedJsonRef.current = json;
      setIsDirty(false);
      return;
    }

    const dirty = json !== lastSavedJsonRef.current;
    setIsDirty(dirty);

    if (dirty) scheduleAutoSave();
  }, [project, projectRowId]);

  // If an autosave was requested while saving, run it right after save completes
  useEffect(() => {
    if (saving) return;

    if (pendingAutoSaveRef.current) {
      pendingAutoSaveRef.current = false;
      if (dirtyRef.current) scheduleAutoSave();
    }
  }, [saving]);

  // Cmd/Ctrl+S manual save
  useEffect(() => {
    const opts: AddEventListenerOptions = { capture: true };

    const onKeyDown = (e: KeyboardEvent) => {
      const key = (e.key || "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "s") {
        e.preventDefault();

        // Cancel any pending autosave and save immediately
        if (autoSaveTimerRef.current != null) {
          window.clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        pendingAutoSaveRef.current = false;

        // Commit any in-progress cell edit before saving
        const active = document.activeElement as HTMLElement | null;
        if (active && active.tagName === "INPUT" || active?.tagName === "TEXTAREA") {
          flushSync(() => active.blur());
        }

        void saveProjectToSupabase();
      }
    };

    window.addEventListener("keydown", onKeyDown, opts);
    return () => window.removeEventListener("keydown", onKeyDown, opts);
  }, [projectRowId]);


  /** =========================
   *  Wiki publish helpers
   *  ========================= */

  const buildWikiSnapshot = (p: Project, docIds: Id[], colIds: Id[]) => {
    const docSet = new Set(docIds);
    const colSet = new Set(colIds);

    const collections = (p.collections ?? [])
      .filter((c) => colSet.has(c.id))
      .map((c) => {
        const rows = (c.rows ?? []).map((r) => {
          const coverAsset = (r.assets ?? []).find((a) => a.id === r.profileAssetId);
          const cover = coverAsset
            ? { path: coverAsset.path, mime: coverAsset.mime, name: coverAsset.name, size: coverAsset.size }
            : null;

          const values: Record<string, any> = {};
          for (const [k, v] of Object.entries(r.values ?? {})) {
            if (k === "id") continue; // do not expose ID field
            values[k] = v as any;
          }

          return {
            id: r.id, // internal id (not rendered publicly)
            values,
            cover, // only cover image is preserved
          };
        });

        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          color: c.color,
          folderPath: c.folderPath ?? [],
          schema: (c.schema ?? []).filter((f) => f.id !== "id"),
          rows,
        };
      });

    const includedDocs = (p.documents ?? []).filter((d) => docSet.has(d.id));
    const documents = includedDocs.map((d) => ({
      id: d.id,
      title: d.title,
      folderPath: d.folderPath ?? [],
      content: d.content,
      richContent: (d as any).richContent ?? "",
      // Keep all links — they resolve against linkedEntities below (so a link works
      // even if its record's table isn't published as its own page).
      entityLinks: d.entityLinks ?? [],
    }));

    // Lightweight lookup of every record referenced by an included document's links.
    const linkedEntities: Record<string, any> = {};
    for (const d of includedDocs) {
      for (const l of d.entityLinks ?? []) {
        const k = `${l.collectionId}:${l.entityId}`;
        if (linkedEntities[k]) continue;
        const col = (p.collections ?? []).find((c) => c.id === l.collectionId);
        const row = col?.rows.find((r) => r.id === l.entityId);
        if (!col || !row) continue;
        const coverAsset = (row.assets ?? []).find((a) => a.id === row.profileAssetId);
        const values: Record<string, any> = {};
        for (const [vk, vv] of Object.entries(row.values ?? {})) {
          if (vk === "id") continue;
          values[vk] = vv as any;
        }
        linkedEntities[k] = {
          collectionId: col.id,
          entityId: row.id,
          collectionName: col.name,
          color: col.color,
          published: colSet.has(col.id),
          schema: (col.schema ?? []).filter((f) => f.id !== "id"),
          values,
          cover: coverAsset ? { path: coverAsset.path, mime: coverAsset.mime, name: coverAsset.name, size: coverAsset.size } : null,
        };
      }
    }

    const worldMap = p.view?.worldMapIncludeInWiki
      ? {
          imagePath: p.view?.worldMapImagePath ?? null,
          name: p.view?.worldMapName ?? "",
          docPins: (p.worldMapDocPins ?? []),
          labelPins: (p.worldMapLabelPins ?? []),
        }
      : null;

    return {
      name: p.name,
      documents,
      collections,
      linkedEntities,
      worldMap,
    };
  };

  const syncPublishedWikiSnapshot = async (p: Project) => {
    const w = p.view?.wiki;
    if (!wikiRowId || !w?.published) return;

    try {
      const docIds: Id[] =
        Array.isArray(w.includedDocumentIds)
          ? w.includedDocumentIds
          : (p.documents ?? []).map((d) => d.id);

      const colIds: Id[] =
        Array.isArray(w.includedCollectionIds)
          ? w.includedCollectionIds
          : (p.collections ?? []).map((c) => c.id);

      if (docIds.length === 0) return;

      const homeDocId =
        typeof w.homeDocumentId === "string" && docIds.includes(w.homeDocumentId) ? w.homeDocumentId : (docIds[0] ?? "");

      const settings = {
        slugOverride: !!w.slugOverride,
        includedDocumentIds: docIds,
        includedCollectionIds: colIds,
        homeDocumentId: homeDocId,

        seoTitle: (w.seoTitle ?? "").trim(),
        seoDescription: (w.seoDescription ?? "").trim(),
        seoImageUrl: (w.seoImageUrl ?? "").trim(),
        allowIndexing: w.allowIndexing !== false,
      };

      const snapshot = buildWikiSnapshot(p, docIds, colIds);

      // Skip the write if nothing in the published snapshot/settings actually changed.
      const hash = hashString(JSON.stringify({ settings, snapshot }));
      if (hash === lastWikiSnapshotHashRef.current) return;

      const { error } = await supabase
        .from("public_wikis")
        .update({ settings, snapshot, updated_at: new Date().toISOString() })
        .eq("id", wikiRowId);

      if (error) throw error;
      lastWikiSnapshotHashRef.current = hash;
    } catch {
      // Best-effort: project saving should still succeed even if snapshot sync fails.
    }
  };

  const ensureUniqueWikiSlug = async (desiredRaw: string, selfWikiId?: string | null) => {
    const base = normalizeWikiSlug(desiredRaw || (project?.name ?? "project"));

    for (let i = 0; i < 100; i++) {
      const candidate = i === 0 ? base : `${base}-${i}`;

      const { data, error } = await supabase
        .from("public_wikis")
        .select("id")
        .eq("slug", candidate)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (!data || (selfWikiId && (data as any).id === selfWikiId)) return candidate;
    }

    return `${base}-${Date.now()}`;
  };

  const openWikiModal = () => {
    if (!project) return;
    if (!requireAccount("publish a wiki")) return;

    setWikiErr(null);
    setWikiInfo(null);

    const w = project.view?.wiki;
    const allDocIds = project.documents.map((d) => d.id);
    const allColIds = project.collections.map((c) => c.id);

    const docIds =
      Array.isArray(w?.includedDocumentIds) ? w!.includedDocumentIds! : allDocIds;

    const colIds =
      Array.isArray(w?.includedCollectionIds) ? w!.includedCollectionIds! : allColIds;

    const home =
      w?.homeDocumentId && docIds.includes(w.homeDocumentId) ? w.homeDocumentId : (docIds[0] ?? allDocIds[0] ?? "");

    const slug = w?.slug && w.slug.trim().length ? w.slug : slugFromProjectName(project.name);

    // Defaults if user hasn’t set SEO yet
    const defaultTitle = project.name || "Story Wiki";
    const defaultDescription = "Public wiki for this story project.";

    setWikiDraftDocIds(docIds);
    setWikiDraftColIds(colIds);
    setWikiDraftHomeDocId(home);
    setWikiDraftSlug(slug);
    setWikiDraftSlugOverride(!!w?.slugOverride);

    // ✅ SEO / indexing drafts
    setWikiDraftSeoTitle((w?.seoTitle ?? "").trim() || defaultTitle);
    setWikiDraftSeoDescription((w?.seoDescription ?? "").trim() || defaultDescription);
    setWikiDraftSeoImageUrl((w?.seoImageUrl ?? "").trim());
    setWikiDraftAllowIndexing(w?.allowIndexing !== false); // default true

    setWikiModalOpen(true);
  };

  const publishOrUpdateWiki = async () => {
    if (!project || !projectRowId || !userId) return;

    setWikiBusy(true);
    setWikiErr(null);
    setWikiInfo(null);

    try {
      const docIds = Array.isArray(wikiDraftDocIds) ? wikiDraftDocIds : project.documents.map((d) => d.id);
      const colIds = Array.isArray(wikiDraftColIds) ? wikiDraftColIds : project.collections.map((c) => c.id);

      if (docIds.length === 0) throw new Error("Select at least one page (document) to publish.");

      let homeDocId = wikiDraftHomeDocId;
      if (!homeDocId || !docIds.includes(homeDocId)) homeDocId = docIds[0];

      const desired = normalizeWikiSlug(wikiDraftSlug || slugFromProjectName(project.name));
      const finalSlug = await ensureUniqueWikiSlug(desired, wikiRowId);

      if (finalSlug !== desired) setWikiInfo(`That URL was taken. Using "${finalSlug}" instead.`);

      const settings = {
        slugOverride: wikiDraftSlugOverride,
        includedDocumentIds: docIds,
        includedCollectionIds: colIds,
        homeDocumentId: homeDocId,

        // ✅ SEO / indexing
        seoTitle: (wikiDraftSeoTitle || "").trim(),
        seoDescription: (wikiDraftSeoDescription || "").trim(),
        seoImageUrl: (wikiDraftSeoImageUrl || "").trim(),
        allowIndexing: !!wikiDraftAllowIndexing,
      };

      const snapshot = buildWikiSnapshot(project, docIds, colIds);

      if (!wikiRowId) {
        const { data, error } = await supabase
          .from("public_wikis")
          .insert({
            owner_id: userId,
            project_row_id: projectRowId,
            slug: finalSlug,
            published: true,
            settings,
            snapshot,
            updated_at: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (error) throw error;
        setWikiRowId((data as any).id);
      } else {
        const { error } = await supabase
          .from("public_wikis")
          .update({
            slug: finalSlug,
            published: true,
            settings,
            snapshot,
            updated_at: new Date().toISOString(),
          })
          .eq("id", wikiRowId);

        if (error) throw error;
      }

      const nextProject: Project = structuredClone(project);
      nextProject.view = nextProject.view ?? {};
      nextProject.view.wiki = {
        published: true,
        slug: finalSlug,
        slugOverride: wikiDraftSlugOverride,
        includedDocumentIds: docIds,
        includedCollectionIds: colIds,
        homeDocumentId: homeDocId,

        // ✅ SEO / indexing
        seoTitle: (wikiDraftSeoTitle || "").trim(),
        seoDescription: (wikiDraftSeoDescription || "").trim(),
        seoImageUrl: (wikiDraftSeoImageUrl || "").trim(),
        allowIndexing: !!wikiDraftAllowIndexing,
      };

      setProject(nextProject);
      await saveProjectToSupabase(nextProject);

      setWikiModalOpen(false);
    } catch (e: any) {
      setWikiErr(e?.message ?? "Failed to publish wiki.");
    } finally {
      setWikiBusy(false);
    }
  };

  const unpublishWiki = async () => {
    if (!wikiRowId || !project) return;

    setWikiBusy(true);
    setWikiErr(null);
    setWikiInfo(null);

    try {
      const { error } = await supabase
        .from("public_wikis")
        .update({ published: false, updated_at: new Date().toISOString() })
        .eq("id", wikiRowId);

      if (error) throw error;

      const nextProject: Project = structuredClone(project);
      nextProject.view = nextProject.view ?? {};
      nextProject.view.wiki = { ...(nextProject.view.wiki ?? {}), published: false };

      setProject(nextProject);
      await saveProjectToSupabase(nextProject);
    } catch (e: any) {
      setWikiErr(e?.message ?? "Failed to unpublish wiki.");
    } finally {
      setWikiBusy(false);
    }
  };

  const syncWikiSlugToProjectNameIfAuto = async (p: Project) => {
    const w = p.view?.wiki;
    if (!wikiRowId || !w?.published) return;
    if (w.slugOverride) return;

    const desired = slugFromProjectName(p.name);
    const current = String(w.slug ?? "");
    if (!desired || desired === current) return;

    try {
      const finalSlug = await ensureUniqueWikiSlug(desired, wikiRowId);
      if (finalSlug === current) return;

      const docIds = Array.isArray(w.includedDocumentIds) ? w.includedDocumentIds : p.documents.map((d) => d.id);
      const colIds = Array.isArray(w.includedCollectionIds) ? w.includedCollectionIds : p.collections.map((c) => c.id);
      const homeDocId = w.homeDocumentId && docIds.includes(w.homeDocumentId) ? w.homeDocumentId : (docIds[0] ?? "");

      const settings = {
        slugOverride: false,
        includedDocumentIds: docIds,
        includedCollectionIds: colIds,
        homeDocumentId: homeDocId,
      };

      const snapshot = buildWikiSnapshot(p, docIds, colIds);

      const { error } = await supabase
        .from("public_wikis")
        .update({ slug: finalSlug, settings, snapshot, updated_at: new Date().toISOString() })
        .eq("id", wikiRowId);

      if (error) throw error;

      const nextProject: Project = structuredClone(p);
      nextProject.view = nextProject.view ?? {};
      nextProject.view.wiki = {
        ...(nextProject.view.wiki ?? {}),
        published: true,
        slug: finalSlug,
        slugOverride: false,
        includedDocumentIds: docIds,
        includedCollectionIds: colIds,
        homeDocumentId: homeDocId,
      };

      setProject(nextProject);
      await saveProjectToSupabase(nextProject);
    } catch {
      // ignore; keep prior slug if update fails
    }
  };

  /** =========================
   *  Project name editing (✅ #5)
   *  ========================= */
  const commitProjectName = async (nextNameRaw: string) => {
    if (!project || !projectRowId) return;

    const nextName = nextNameRaw.trim();
    if (!nextName) return;

    const nextProject: Project = { ...project, name: nextName };
    setProject(nextProject);

    // On desktop, rename the vault folder on disk to match the new project name
    // (the vault path is also the save/delete target, so update projectRowId too).
    let rowId = projectRowId ?? undefined;
    if (isDesktop) {
      const newPath = await renameVaultFolder(nextName);
      if (newPath && newPath !== rowId) {
        rowId = newPath;
        setProjectRowId(newPath);
      }
      setRecentVaults(getRecentVaults());
    }

    // Persist immediately (use the new vault path if the folder was renamed)
    await saveProjectToSupabase(nextProject, rowId);

    // If wiki is published and slug is not overridden, keep URL in sync with project name
    await syncWikiSlugToProjectNameIfAuto(nextProject);
  };

  useEffect(() => {
    if (!editingProjectName) return;
    requestAnimationFrame(() => {
      projectNameInputRef.current?.focus();
      projectNameInputRef.current?.select();
    });
  }, [editingProjectName]);

  /** =========================
   *  Profile actions
   *  ========================= */
  const avatarLabel = useMemo(() => {
    const name = (profile?.username ?? userEmail ?? "U").trim();
    return name.length ? name[0].toUpperCase() : "U";
  }, [profile?.username, userEmail]);

  const openProfileModal = () => {
    setProfileErr(null);
    setProfileMsg(null);
    const username = profile?.username ?? emailToDefaultUsername(userEmail);
    const email = userEmail ?? "";
    setEditUsername(username);
    setSavedUsername(username);
    setEditEmail(email);
    setSavedEmail(email);
    setProfileModalOpen(true);
    setProfileMenuOpen(false);
  };

  const updateUsername = async () => {
    if (!userId) return;
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);
    try {
      const username = editUsername.trim();
      const { data, error } = await supabase
        .from("profiles")
        .update({ username })
        .eq("id", userId)
        .select("id, username, avatar_path, is_pro, stripe_subscription_id, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end, subscription_cancel_at")
        .single();

      if (error) throw error;
      setProfile(data as ProfileRow);
      setSavedUsername(editUsername.trim());
      setProfileMsg("Username updated.");
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to update username");
    } finally {
      setProfileBusy(false);
    }
  };

  const updateEmail = async () => {
    const next = editEmail.trim();
    if (!next) {
      setProfileErr("Email cannot be empty.");
      return;
    }
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);
    try {
      const { data, error } = await supabase.auth.updateUser({ email: next });
      if (error) throw error;
      setProfileMsg("Email update requested. Check your inbox to confirm the change.");
      setSavedEmail(next);
      setUserEmail(data.user?.email ?? userEmail);
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to update email");
    } finally {
      setProfileBusy(false);
    }
  };


  const sendPasswordResetEmail = async () => {
    setProfileErr(null);
    setProfileMsg(null);

    const email = userEmail ?? editEmail.trim();
    if (!email) {
      setProfileErr("No email address available.");
      return;
    }

    setProfileBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (error) throw error;
      setProfileMsg("Password reset email sent. Check your inbox.");
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to send reset email");
    } finally {
      setProfileBusy(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    if (!userId) return;
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);

    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${userId}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, {
        upsert: true,
        contentType: file.type || "image/png",
        cacheControl: "3600",
      });
      if (uploadError) throw uploadError;

      const { data, error } = await supabase
        .from("profiles")
        .update({ avatar_path: path })
        .eq("id", userId)
        .select("id, username, avatar_path, is_pro, stripe_subscription_id, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end, subscription_cancel_at")
        .single();

      if (error) throw error;
      setProfile(data as ProfileRow);
      await refreshAvatarSignedUrl((data as ProfileRow).avatar_path ?? null);
      setProfileMsg("Profile picture updated.");
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to upload avatar");
    } finally {
      setProfileBusy(false);
    }
  };

  const removeAvatar = async () => {
    if (!userId) return;
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);

    try {
      const path = profile?.avatar_path ?? null;
      if (path) {
        const { error } = await supabase.storage.from("avatars").remove([path]);
        if (error) console.warn("Avatar remove warning:", error.message);
      }

      const { data, error } = await supabase
        .from("profiles")
        .update({ avatar_path: null })
        .eq("id", userId)
        .select("id, username, avatar_path, is_pro, stripe_subscription_id, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end, subscription_cancel_at")
        .single();

      if (error) throw error;

      setProfile(data as ProfileRow);
      setAvatarUrl(null);
      setProfileMsg("Profile picture removed.");
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to remove avatar");
    } finally {
      setProfileBusy(false);
    }
  };

  const logout = async () => {
    await platform.signOut();
  };

  const goPro = async () => {
    if (!profile || isUpgrading) return;

    setIsUpgrading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout");
      if (error || !data?.url) throw error ?? new Error("No checkout URL returned.");
      window.location.href = data.url;
    } catch {
      appModal.alert("Failed to start checkout.", { title: "Upgrade failed" });
      setIsUpgrading(false);
    }
  };

  const openCancelSubscriptionModal = () => {
    if (!profile?.is_pro) return;
    setProfileErr(null);
    setProfileMsg(null);
    setCancelSubModalOpen(true);
  };

  const cancelSubscriptionConfirmed = async () => {
    if (!profile?.is_pro || isCancelling) return;

    setIsCancelling(true);
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);

    try {
      const { data, error } = await supabase.functions.invoke("cancel-subscription");
      if (error) throw error;

      // Update UI immediately (don’t wait for webhook / re-fetch)
      const nextCancelAtIso: string | null =
        data?.subscription_cancel_at ??
        data?.subscription_current_period_end ??
        profile.subscription_cancel_at ??
        profile.subscription_current_period_end ??
        null;

      setCancelScheduledAt(nextCancelAtIso);

      setProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          subscription_status: data?.subscription_status ?? prev.subscription_status,
          subscription_current_period_end:
            data?.subscription_current_period_end ?? prev.subscription_current_period_end,
          subscription_cancel_at_period_end:
            typeof data?.subscription_cancel_at_period_end === "boolean"
              ? data.subscription_cancel_at_period_end
              : true,
          subscription_cancel_at: nextCancelAtIso,
        };
      });

      // Optional: still refresh in background for correctness
      if (userId) {
        await loadOrCreateProfile(userId, userEmail ?? null);
      }

      const endNice = nextCancelAtIso ? new Date(nextCancelAtIso).toLocaleDateString() : null;
      setProfileMsg(endNice ? `Subscription will cancel on ${endNice}. You keep Pro until then.` : "Subscription will cancel at period end.");

      // Close modal only after success
      setCancelSubModalOpen(false);
    } catch (e: any) {
      setProfileErr(e?.message ?? "Failed to cancel subscription.");
    } finally {
      setIsCancelling(false);
      setProfileBusy(false);
    }
  };


  const openDeleteAccountModal = () => {
    setProfileErr(null);
    setProfileMsg(null);
    setIsDeletingAccount(false);
    setDeleteConfirmText("");
    setDeleteAccountModalOpen(true);
  };

  const deleteAccountConfirmed = async () => {
    if (isDeletingAccount) return;

    setIsDeletingAccount(true);
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg("Deleting your account…");

    try {
      const { error } = await supabase.functions.invoke("delete-account");
      if (error) throw error;

      await platform.signOut();
    } catch (e: any) {
      setProfileErr(
        e?.message ??
        "Delete failed. Make sure you deployed the Supabase Edge Function 'delete-account' and set its service role secret."
      );
      setProfileMsg(null);
    } finally {
      setIsDeletingAccount(false);
      setProfileBusy(false);
    }
  };

  const deleteProjectConfirmed = async () => {
    if (!projectRowId || isDeletingProject) return;
    setIsDeletingProject(true);
    try {
      await platform.deleteProject(projectRowId);
      setDeleteProjectModalOpen(false);
      setDeleteProjectConfirmText("");
      if (isDesktop) {
        // Back to the launcher to pick/create another vault.
        setProject(null);
        setProjectRowId(null);
        setNeedsVaultPicker(true);
      } else {
        // Web: load (or create) a fresh project in its place.
        setLoadingInit(true);
        await loadOrCreateProject(userId ?? "local");
        setLoadingInit(false);
      }
    } catch (e: any) {
      await appModal.alert(e?.message ?? "Failed to delete project.", { title: "Delete failed" } as any);
    } finally {
      setIsDeletingProject(false);
    }
  };


  /** =========================
   *  Column resizing
   *  ========================= */
  const handleColumnResizeMouseDown = (e: React.MouseEvent<HTMLDivElement>, collectionId: Id, fieldId: Id) => {
    e.preventDefault();
    e.stopPropagation();

    const fieldKey = `${collectionId}:${fieldId}`;

    // Grab the <th> we're resizing directly from the DOM.
    const th = (e.currentTarget as HTMLElement).closest("th") as HTMLTableCellElement | null;
    if (!th) return;

    const startWidth = th.getBoundingClientRect().width;
    const startX = e.clientX;

    activeResizeRef.current = { fieldKey, startX, startWidth };

    // During drag: mutate the DOM directly — zero React re-renders, no cascade.
    const onMouseMove = (ev: MouseEvent) => {
      if (!activeResizeRef.current) return;
      const nextWidth = Math.max(60, activeResizeRef.current.startWidth + (ev.clientX - activeResizeRef.current.startX));
      th.style.width = `${nextWidth}px`;
    };

    // On release: read the final width from the DOM and commit once to React state.
    const onMouseUp = () => {
      if (activeResizeRef.current) {
        const finalWidth = th.getBoundingClientRect().width;
        setColumnWidths((prev) => ({ ...prev, [fieldKey]: finalWidth }));
        activeResizeRef.current = null;
      }
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  /** =========================
   *  Document CRUD
   *  ========================= */
  const addDocument = (folderPath: string[] = []) => {
    if (!project || !profile) return;

    if (!profile.is_pro && project.documents.length >= FREE_DOC_LIMIT) {
      if (isGuest) {
        promptCreateAccount("You'll need to create a free account to add more documents.");
      } else {
        appModal.alert(`The free plan includes up to ${FREE_DOC_LIMIT} documents. Upgrade to Pro to add more.`, { title: "Pro required" });
      }
      return;
    }

    const index = project.documents.length + 1;
    const newDoc: Doc = {
      id: `doc_${Date.now()}`,
      title: `Untitled ${index}`,
      content: "",
      entityLinks: [],
      folderPath,
    };

    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, documents: [...prev.documents, newDoc] };
    });

    setActiveDocId(newDoc.id);
  };


  const renameDocument = async (id: Id) => {
    if (!project) return;
    const doc = project.documents.find((d) => d.id === id);
    const current = doc?.title ?? "";

    const title = await appModal.prompt({
      title: "Rename document",
      message: "Enter a new document name.",
      defaultValue: current,
      placeholder: "Document name",
      confirmText: "Rename",
      cancelText: "Cancel",
    });

    if (!title) return;

    // Allow typing "Folder: Sub: Name" to move/nest the doc; otherwise keep its folder.
    const existingFolder = doc?.folderPath ?? [];
    const parsed = parseTitlePath(title.trim());
    const newFolderPath = parsed.folderPath.length > 0 ? parsed.folderPath : existingFolder;
    const newName = parsed.name;

    const oldSegments = docVaultSegments(existingFolder, current);
    const newSegments = docVaultSegments(newFolderPath, newName);
    if (oldSegments.join("/") === newSegments.join("/")) return;

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        documents: prev.documents.map((d) =>
          d.id === id ? { ...d, title: newName, folderPath: newFolderPath } : d
        ),
      };
    });

    if (isDesktop) {
      platform.renameDocumentFile(oldSegments, newSegments).catch(console.warn);
    }
  };

  const deleteDocument = async (id: Id) => {
    if (!project) return;

    const ok = await appModal.confirm({
      title: "Delete document?",
      message: "Delete this document? This cannot be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;

    // Rule: must keep at least one document OR one collection
    if (project.documents.length <= 1 && project.collections.length <= 0) {
      appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
      return;
    }

    // If this is the last document, only allow deletion if there is at least one collection
    if (project.documents.length <= 1 && project.collections.length >= 1) {
      // ok
    } else if (project.documents.length <= 1) {
      appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
      return;
    }

    const delDoc = project.documents.find((d) => d.id === id);
    const delDocSegments = delDoc ? docVaultSegments(delDoc.folderPath, delDoc.title) : null;

    setProject((prev) => {
      if (!prev) return prev;
      const docs = prev.documents.filter((d) => d.id !== id);
      return { ...prev, documents: docs };
    });

    if (activeDocId === id) {
      const remaining = project.documents.filter((d) => d.id !== id);
      setActiveDocId(remaining[0]?.id ?? "");
    }

    if (isDesktop && delDocSegments) {
      platform.trashVaultPath(`documents/${delDocSegments.join("/")}.md`).catch(console.warn);
    }
  };

  /** =========================
   *  Collection CRUD
   *  ========================= */
  const addCollection = async (folderPath: string[] = []) => {
    if (!project) return;

    const name = await appModal.prompt({
      title: "New table",
      message: "Table name (e.g. Items, Locations):",
      defaultValue: `Table ${project.collections.length + 1}`,
      placeholder: "Table name",
      confirmText: "Create",
      cancelText: "Cancel",
    });
    if (!name) return;

    const trimmed = name.trim();
    if (!trimmed) return;

    // Parse "Folder: Sub: Name" typed at creation; nest under the button's folder if given.
    const parsed = parseTitlePath(trimmed);
    const finalFolderPath = [...folderPath, ...parsed.folderPath];
    const finalName = parsed.name;

    const newId = finalName.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();

    const newCollection: Collection = {
      id: newId,
      name: finalName,
      folderPath: finalFolderPath,
      kind: "generic",
      assetsEnabled: true,
      color: getDefaultColor(project.collections.length),
      schema: [
        { id: "id", label: "ID", type: "string" },
        { id: "name", label: "Name", type: "string" },
        { id: "description", label: "Description", type: "text" },
      ],
      rows: [],
    };

    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, collections: [...prev.collections, newCollection] };
    });
    setActiveCollectionId(newCollection.id);
  };

  const renameCollection = async (id: Id) => {
    if (!project) return;
    const col = project.collections.find((c) => c.id === id);
    const current = col?.name ?? "";

    const name = await appModal.prompt({
      title: "Rename table",
      message: "Enter a new table name.",
      defaultValue: current,
      placeholder: "Table name",
      confirmText: "Rename",
      cancelText: "Cancel",
    });

    if (!name) return;

    // Allow typing "Folder: Sub: Name" to move/nest the collection; else keep folder.
    const existingFolder = col?.folderPath ?? [];
    const parsed = parseTitlePath(name.trim());
    const newFolderPath = parsed.folderPath.length > 0 ? parsed.folderPath : existingFolder;
    const newName = parsed.name;

    const oldSlug = colVaultSegments(existingFolder, current).join("/");
    const newSlug = colVaultSegments(newFolderPath, newName).join("/");
    if (oldSlug === newSlug) return;

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        collections: prev.collections.map((c) => {
          if (c.id !== id) return c;
          const updatedRows = c.rows.map(row => ({
            ...row,
            assets: row.assets?.map(asset => ({
              ...asset,
              path: asset.path.startsWith(`${oldSlug}/`)
                ? `${newSlug}/${asset.path.slice(oldSlug.length + 1)}`
                : asset.path,
            })),
          }));
          return { ...c, name: newName, folderPath: newFolderPath, rows: updatedRows };
        }),
      };
    });

    if (isDesktop) {
      platform.renameCollectionFiles(
        oldSlug.split("/"),
        newSlug.split("/"),
      ).catch(console.warn);
    }
  };

  const deleteCollection = async (id: Id) => {
    if (!project) return;

    const ok = await appModal.confirm({
      title: "Delete table?",
      message: "Delete this table and unlink all links to it? This cannot be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;

    // Rule: must keep at least one document OR one collection
    if (project.collections.length <= 1 && project.documents.length <= 0) {
      appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
      return;
    }

    // If this is the last collection, only allow deletion if there is at least one document
    if (project.collections.length <= 1 && project.documents.length >= 1) {
      // ok
    } else if (project.collections.length <= 1) {
      appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
      return;
    }

    const delCol = project.collections.find((c) => c.id === id);
    const delColSlug = delCol ? colVaultSegments(delCol.folderPath, delCol.name).join("/") : null;
    const delColAssetPaths = (delCol?.rows ?? []).flatMap((r) => (r.assets ?? []).map((a) => a.path)).filter(Boolean);

    setProject((prev) => {
      if (!prev) return prev;

      const collections = prev.collections.filter((c) => c.id !== id);

      // Remove links to deleted collection
      const documents = prev.documents.map((d) => ({
        ...d,
        entityLinks: d.entityLinks.filter((l) => l.collectionId !== id),
      }));

      // Scrub dataset references to the deleted collection.
      const datasets = scrubDatasetRefs(prev.datasets, { collectionId: id });

      return { ...prev, collections, documents, datasets };
    });

    if (activeCollectionId === id) {
      const remaining = project.collections.filter((c) => c.id !== id);
      setActiveCollectionId(remaining[0]?.id ?? "");
    }

    if (isDesktop && delColSlug) {
      platform.trashVaultPath(`tables/${delColSlug}.json`).catch(console.warn);
      platform.trashVaultPath(`assets/${delColSlug}`).catch(console.warn);
    } else if (!isDesktop) {
      // Web: delete the table's row assets from storage so they don't orphan.
      for (const p of delColAssetPaths) platform.deleteAsset(p).catch(console.warn);
    }
  };


  /** =========================
   *  Folder CRUD (documents & collections)
   *  ========================= */
  const pathStartsWith = (full: string[], prefix: string[]) =>
    prefix.length <= full.length && prefix.every((seg, i) => full[i] === seg);

  const cleanFolderName = (raw: string) => raw.trim().replace(/[/:]/g, "-");

  // When a collection's folder changes, its stored asset paths (which embed the
  // collection's vault slug) must be remapped too, or they drift from the moved files.
  // No-op on web, where asset paths are keyed by ids rather than the vault slug.
  const remapCollectionAssetPaths = (c: Collection, newFolderPath: string[]): Collection => {
    const oldSlug = colVaultSegments(c.folderPath, c.name).join("/");
    const newSlug = colVaultSegments(newFolderPath, c.name).join("/");
    if (oldSlug === newSlug) return { ...c, folderPath: newFolderPath };
    return {
      ...c,
      folderPath: newFolderPath,
      rows: c.rows.map((r) => ({
        ...r,
        assets: r.assets?.map((a) =>
          a.path.startsWith(oldSlug + "/")
            ? { ...a, path: newSlug + "/" + a.path.slice(oldSlug.length + 1) }
            : a
        ),
      })),
    };
  };

  const addFolder = async (kind: "doc" | "col", parentPath: string[]) => {
    const name = await appModal.prompt({
      title: "New folder",
      message: "Folder name:",
      placeholder: "Folder name",
      confirmText: "Create",
      cancelText: "Cancel",
    });
    if (!name) return;
    const clean = cleanFolderName(name);
    if (!clean) return;
    const newPath = [...parentPath, clean];
    const key = newPath.join("/");

    setProject((prev) => {
      if (!prev) return prev;
      if (kind === "doc") {
        const existing = prev.documentFolders ?? [];
        if (existing.some((f) => f.join("/") === key)) return prev;
        return { ...prev, documentFolders: [...existing, newPath] };
      } else {
        const existing = prev.collectionFolders ?? [];
        if (existing.some((f) => f.join("/") === key)) return prev;
        return { ...prev, collectionFolders: [...existing, newPath] };
      }
    });

    // If more than one item of this kind is selected, nest them in the new folder.
    const prefix = kind === "doc" ? "doc" : "col";
    const selectedOfKind = [...treeSelection].filter(
      (id) => id.startsWith(`${prefix}item:`) || id.startsWith(`${prefix}folder:`)
    );
    if (selectedOfKind.length > 1) {
      moveTreeEntries(kind, selectedOfKind, newPath);
      setTreeSelection(new Set());
    }

    // Expand the parent so the new folder is visible
    if (parentPath.length) {
      const setCollapsed = kind === "doc" ? setCollapsedDocumentGroups : setCollapsedCollectionGroups;
      setCollapsed((prev) => ({ ...prev, [parentPath.join("/")]: false }));
    }
  };

  const renameFolder = async (kind: "doc" | "col", path: string[]) => {
    const current = path[path.length - 1];
    const name = await appModal.prompt({
      title: "Rename folder",
      message: "Enter a new folder name.",
      defaultValue: current,
      placeholder: "Folder name",
      confirmText: "Rename",
      cancelText: "Cancel",
    });
    if (!name) return;
    const clean = cleanFolderName(name);
    if (!clean || clean === current) return;
    const newPath = [...path.slice(0, -1), clean];

    setProject((prev) => {
      if (!prev) return prev;
      const remap = (fp: string[]) => (pathStartsWith(fp, path) ? [...newPath, ...fp.slice(path.length)] : fp);
      if (kind === "doc") {
        return {
          ...prev,
          documents: prev.documents.map((d) => ({ ...d, folderPath: remap(d.folderPath ?? []) })),
          documentFolders: (prev.documentFolders ?? []).map(remap),
        };
      } else {
        return {
          ...prev,
          collections: prev.collections.map((c) => remapCollectionAssetPaths(c, remap(c.folderPath ?? []))),
          collectionFolders: (prev.collectionFolders ?? []).map(remap),
        };
      }
    });
    // Vault dir moves are reconciled at save (item files move via syncRenames,
    // old empty dirs pruned, explicit folders recreated).
  };

  const deleteFolder = async (kind: "doc" | "col", path: string[]) => {
    const ok = await appModal.confirm({
      title: "Delete folder?",
      message: `Delete "${path[path.length - 1]}" and everything inside it? This cannot be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok || !project) return;

    if (kind === "doc") {
      const removedIds = new Set(
        project.documents.filter((d) => pathStartsWith(d.folderPath ?? [], path)).map((d) => d.id)
      );
      const remainingDocs = project.documents.length - removedIds.size;
      if (remainingDocs <= 0 && project.collections.length <= 0) {
        appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
        return;
      }
      setProject((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          documents: prev.documents.filter((d) => !removedIds.has(d.id)),
          documentFolders: (prev.documentFolders ?? []).filter((f) => !pathStartsWith(f, path)),
        };
      });
      if (activeDocId && removedIds.has(activeDocId)) {
        const remaining = project.documents.filter((d) => !removedIds.has(d.id));
        setActiveDocId(remaining[0]?.id ?? "");
      }
      if (isDesktop) platform.trashVaultPath(`documents/${path.map(toSlug).join("/")}`).catch(console.warn);
    } else {
      const removedIds = new Set(
        project.collections.filter((c) => pathStartsWith(c.folderPath ?? [], path)).map((c) => c.id)
      );
      const remainingCols = project.collections.length - removedIds.size;
      if (remainingCols <= 0 && project.documents.length <= 0) {
        appModal.alert("You must keep at least one document or one collection.", { title: "Cannot delete" });
        return;
      }
      setProject((prev) => {
        if (!prev) return prev;
        const documents = prev.documents.map((d) => ({
          ...d,
          entityLinks: d.entityLinks.filter((l) => !removedIds.has(l.collectionId)),
        }));
        let datasets = prev.datasets;
        for (const cid of removedIds) datasets = scrubDatasetRefs(datasets, { collectionId: cid });
        return {
          ...prev,
          collections: prev.collections.filter((c) => !removedIds.has(c.id)),
          documents,
          datasets,
          collectionFolders: (prev.collectionFolders ?? []).filter((f) => !pathStartsWith(f, path)),
        };
      });
      if (activeCollectionId && removedIds.has(activeCollectionId)) {
        const remaining = project.collections.filter((c) => !removedIds.has(c.id));
        setActiveCollectionId(remaining[0]?.id ?? "");
      }
      if (isDesktop) {
        const slug = path.map(toSlug).join("/");
        platform.trashVaultPath(`tables/${slug}`).catch(console.warn);
        platform.trashVaultPath(`assets/${slug}`).catch(console.warn);
      } else {
        // Web: delete the removed tables' row assets from storage so they don't orphan.
        const orphanPaths = project.collections
          .filter((c) => removedIds.has(c.id))
          .flatMap((c) => (c.rows ?? []).flatMap((r) => (r.assets ?? []).map((a) => a.path)))
          .filter(Boolean);
        for (const p of orphanPaths) platform.deleteAsset(p).catch(console.warn);
      }
    }
  };

  // Ordered drag-ids of the visible tree rows (for shift-range selection).
  const orderedDragIds = (kind: "doc" | "col"): string[] => {
    if (kind === "doc") {
      return documentTreeRows.map((r) =>
        r.kind === "folder" ? `docfolder:${r.path.join("/")}` : `docitem:${r.doc.id}`
      );
    }
    return collectionTreeRows.map((r) =>
      r.kind === "folder" ? `colfolder:${r.path.join("/")}` : `colitem:${r.collection.id}`
    );
  };

  // Handles click selection (plain / shift-range / cmd-toggle). Returns true if a
  // modifier handled it (caller should skip its plain open/collapse action).
  const handleTreeRowClick = (e: React.MouseEvent, kind: "doc" | "col", dragId: string): boolean => {
    if (e.metaKey || e.ctrlKey) {
      setTreeSelection((prev) => {
        const n = new Set(prev);
        n.has(dragId) ? n.delete(dragId) : n.add(dragId);
        return n;
      });
      treeAnchorRef.current = dragId;
      return true;
    }
    if (e.shiftKey) {
      const ordered = orderedDragIds(kind);
      const anchor = treeAnchorRef.current ?? dragId;
      const ai = ordered.indexOf(anchor);
      const bi = ordered.indexOf(dragId);
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
        setTreeSelection(new Set(ordered.slice(lo, hi + 1)));
      } else {
        setTreeSelection(new Set([dragId]));
      }
      return true;
    }
    setTreeSelection(new Set([dragId]));
    treeAnchorRef.current = dragId;
    return false;
  };

  // Moves a set of selected items/folders into a target folder path.
  const moveTreeEntries = (kind: "doc" | "col", dragIds: string[], target: string[]) => {
    const folderPrefix = kind === "doc" ? "docfolder:" : "colfolder:";
    const itemPrefix = kind === "doc" ? "docitem:" : "colitem:";
    const selFolders = dragIds
      .filter((id) => id.startsWith(folderPrefix))
      .map((id) => id.slice(folderPrefix.length).split("/").filter(Boolean));
    const selItemIds = new Set(dragIds.filter((id) => id.startsWith(itemPrefix)).map((id) => id.slice(itemPrefix.length)));

    // Keep only top-most selected folders, and none that would move into themselves.
    const topFolders = selFolders.filter((f) => !selFolders.some((o) => o !== f && pathStartsWith(f, o)));
    const validFolders = topFolders.filter((f) => !pathStartsWith(target, f));

    const remapPath = (fp: string[]) => {
      for (const f of validFolders) {
        if (pathStartsWith(fp, f)) return [...target, f[f.length - 1], ...fp.slice(f.length)];
      }
      return fp;
    };
    const insideMovedFolder = (fp: string[]) => validFolders.some((f) => pathStartsWith(fp, f));

    setProject((prev) => {
      if (!prev) return prev;
      if (kind === "doc") {
        return {
          ...prev,
          documents: prev.documents.map((d) => {
            const fp = d.folderPath ?? [];
            if (selItemIds.has(d.id) && !insideMovedFolder(fp)) return { ...d, folderPath: target };
            return { ...d, folderPath: remapPath(fp) };
          }),
          documentFolders: (prev.documentFolders ?? []).map(remapPath),
        };
      }
      return {
        ...prev,
        collections: prev.collections.map((c) => {
          const fp = c.folderPath ?? [];
          const newFp = (selItemIds.has(c.id) && !insideMovedFolder(fp)) ? target : remapPath(fp);
          return remapCollectionAssetPaths(c, newFp);
        }),
        collectionFolders: (prev.collectionFolders ?? []).map(remapPath),
      };
    });
  };

  // Resolve which drag-ids to move: the multi-selection if the dragged row is part
  // of it, otherwise just the dragged row.
  const dragGroupIds = (activeId: string): string[] =>
    treeSelection.has(activeId) && treeSelection.size > 1 ? [...treeSelection] : [activeId];

  const makeDragStart = () => (event: DragStartEvent) => {
    const id = String(event.active.id);
    const group = dragGroupIds(id);
    if (group.length > 1) {
      setDragLabel({ icon: <span style={{ display: "flex", opacity: 0.7 }}><IconFile /></span>, text: `${group.length} items` });
      return;
    }
    if (id.startsWith("docitem:")) {
      const d = project?.documents.find((x) => x.id === id.slice(8));
      setDragLabel({ icon: <span style={{ display: "flex", opacity: 0.7 }}><IconFile /></span>, text: d?.title ?? "" });
    } else if (id.startsWith("colitem:")) {
      const c = project?.collections.find((x) => x.id === id.slice(8));
      setDragLabel({ icon: <span style={{ width: 9, height: 9, borderRadius: 999, background: c?.color ?? "var(--accent)" }} />, text: c?.name ?? "" });
    } else {
      const segs = id.split(":")[1].split("/");
      setDragLabel({ icon: <span style={{ display: "flex", opacity: 0.7 }}><IconFolder /></span>, text: segs[segs.length - 1] });
    }
  };
  const handleDocTreeDragStart = makeDragStart();
  const handleColTreeDragStart = makeDragStart();

  const handleDocTreeDragEnd = (event: DragEndEvent) => {
    setDragLabel(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    let target: string[] | null = null;
    if (overId === "doc-root") target = [];
    else if (overId.startsWith("docfolder:")) target = overId.slice(10).split("/").filter(Boolean);
    if (target === null) return;
    moveTreeEntries("doc", dragGroupIds(String(active.id)), target);
  };

  const handleColTreeDragEnd = (event: DragEndEvent) => {
    setDragLabel(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    let target: string[] | null = null;
    if (overId === "col-root") target = [];
    else if (overId.startsWith("colfolder:")) target = overId.slice(10).split("/").filter(Boolean);
    if (target === null) return;
    moveTreeEntries("col", dragGroupIds(String(active.id)), target);
  };

  const updateCollectionColor = (collectionId: Id, color: string) => {
    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, collections: prev.collections.map((c) => (c.id === collectionId ? { ...c, color } : c)) };
    });
  };

  const updateCollectionCell = (collectionId: Id, rowId: Id, fieldId: Id, value: string) => {
    // Pre-compute old/new entity key for desktop rename (before setProject runs)
    let oldEntityKey: string | null = null;
    let newEntityKey: string | null = null;
    let entityColSegments: string[] | null = null;

    if (fieldId === "id" && isDesktop && project) {
      const col = project.collections.find((c) => c.id === collectionId);
      const row = col?.rows.find((r) => r.id === rowId);
      oldEntityKey = String(row?.values["id"] ?? "");
      newEntityKey = finalizeEntityDisplayId(String(value ?? ""));
      entityColSegments = col ? colVaultSegments(col.folderPath, col.name) : null;
    }

    setProject((prev) => {
      if (!prev) return prev;

      const collections = prev.collections.map((c) => {
          if (c.id !== collectionId) return c;

          const fieldType = c.schema.find((f) => f.id === fieldId)?.type ?? "string";
          let nextValue: string | number = fieldType === "number" ? Number(value) || 0 : value;

          if (fieldId === "id") {
            const normalized = finalizeEntityDisplayId(String(value ?? ""));
            const used = new Set(
              c.rows
                .filter((r) => r.id !== rowId)
                .map((r) => String(r.values["id"] ?? ""))
                .map((v) => finalizeEntityDisplayId(v))
                .filter(Boolean)
            );

            if (!normalized) {
              nextValue = "";
            } else if (!used.has(normalized)) {
              nextValue = normalized;
            } else {
              let n = 1;
              let candidate = `${normalized}_${n}`;
              while (used.has(candidate)) {
                n++;
                candidate = `${normalized}_${n}`;
              }
              nextValue = candidate;
            }
          }

          return {
            ...c,
            rows: c.rows.map((r) => {
              if (r.id !== rowId) return r;
              const updated = { ...r, values: { ...r.values, [fieldId]: nextValue } };
              // Update stored asset paths if entity key changed
              if (
                fieldId === "id" && isDesktop &&
                oldEntityKey && newEntityKey && oldEntityKey !== newEntityKey
              ) {
                const colSlug = colVaultSegments(c.folderPath, c.name).join("/");
                const oldPrefix = `${colSlug}/${oldEntityKey}/`;
                const newPrefix = `${colSlug}/${newEntityKey}/`;
                updated.assets = updated.assets?.map((asset) => ({
                  ...asset,
                  path: asset.path.startsWith(oldPrefix)
                    ? newPrefix + asset.path.slice(oldPrefix.length)
                    : asset.path,
                }));
              }
              return updated;
            }),
          };
      });

      // When a record's label (name, or id fallback) changes, re-sync every `label`
      // chip that points at it across ALL documents (open or not). Unlinked text and
      // `text`-mode chips are untouched.
      let documents = prev.documents;
      if (fieldId === "name" || fieldId === "id") {
        const labelOf: LabelResolver = (cid, eid) => {
          const col = collections.find((c) => c.id === cid);
          const row = col?.rows.find((r) => r.id === eid);
          return row ? String(row.values["name"] || row.values["id"] || row.id) : null;
        };
        const colorOf = (cid: string) => collections.find((c) => c.id === cid)?.color;
        documents = prev.documents.map((d) => {
          try {
            const res = reconcileDocChips(d, labelOf, colorOf);
            return res ? { ...d, richContent: res.richContent, content: res.content, entityLinks: res.entityLinks } : d;
          } catch {
            return d;
          }
        });
      }

      return { ...prev, collections, documents };
    });

    // Trigger immediate folder rename on desktop
    if (
      fieldId === "id" && isDesktop &&
      oldEntityKey && newEntityKey && oldEntityKey !== newEntityKey && entityColSegments
    ) {
      platform.renameEntityFolder(entityColSegments, oldEntityKey, newEntityKey).catch(console.warn);
    }
  };

  const addFieldToActiveCollection = async () => {
    if (!project || !activeCollectionId) return;

    const col = project.collections.find((c) => c.id === activeCollectionId);
    if (!col) return;

    const label = await appModal.prompt({
      title: "New column",
      message: "New column name:",
      defaultValue: "New field",
      placeholder: "Column name",
      confirmText: "Next",
      cancelText: "Cancel",
    });
    if (!label) return;

    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;

    const normalizedId = trimmedLabel.toLowerCase().replace(/\s+/g, "_");
    if (!normalizedId) return;

    if (normalizedId === "id" || normalizedId === "name") {
      appModal.alert("'id' and 'name' are reserved column IDs.", { title: "Invalid column" });
      return;
    }

    if (col.schema.some((f) => f.id === normalizedId)) {
      appModal.alert("A column with that ID already exists in this collection.", { title: "Duplicate column" });
      return;
    }

    const typeInput = await appModal.select({
      title: "Field type",
      message: "Choose how this column should behave.",
      defaultValue: "string",
      confirmText: "Add column",
      cancelText: "Cancel",
      options: [
        { value: "string", label: "String (short text)" },
        { value: "number", label: "Number (numeric value)" },
        { value: "bool", label: "Bool (true / false)" },
        { value: "text", label: "Text (long notes)" },
      ],
    });
    if (!typeInput) return;

    const fieldType: CollectionField["type"] =
      typeInput === "number" ? "number" : typeInput === "bool" ? "bool" : typeInput === "text" ? "text" : "string";

    const newField: CollectionField = { id: normalizedId, label: trimmedLabel, type: fieldType };
    const defaultValue: string | number = fieldType === "number" ? 0 : fieldType === "bool" ? "false" : "";

    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        collections: prev.collections.map((c) => {
          if (c.id !== col.id) return c;
          return {
            ...c,
            schema: [...c.schema, newField],
            rows: c.rows.map((r) => ({
              ...r,
              values: { ...r.values, [normalizedId]: defaultValue },
            })),
          };
        }),
      };
    });
  };

  const deleteFieldFromCollection = async (collectionId: Id, fieldId: Id) => {
    if (fieldId === "id" || fieldId === "name") {
      appModal.alert("The 'id' and 'name' columns are required and cannot be deleted.", { title: "Cannot delete" });
      return;
    }

    const ok = await appModal.confirm({
      title: "Delete column?",
      message: "Delete this column from the table?",
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setProject((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        collections: prev.collections.map((c) => {
          if (c.id !== collectionId) return c;
          return {
            ...c,
            schema: c.schema.filter((f) => f.id !== fieldId),
            rows: c.rows.map((r) => {
              const { [fieldId]: _omit, ...rest } = r.values;
              return { ...r, values: rest };
            }),
          };
        }),
      };
    });
  };

  const addRowToActiveCollection = () => {
    if (!project || !activeCollectionId) return;

    setProject((prev) => {
      if (!prev) return prev;
      const col = prev.collections.find((c) => c.id === activeCollectionId);
      if (!col) return prev;

      const internalRowId = `${col.id.toUpperCase()}_${Date.now()}_${col.rows.length + 1}`;
      const baseDisplayId = `${col.id.toUpperCase()}_${col.rows.length + 1}`;

      const used = new Set(
        col.rows
          .map((r) => String(r.values["id"] ?? ""))
          .map((v) => normalizeEntityDisplayId(v))
          .filter(Boolean)
      );

      let displayId = normalizeEntityDisplayId(baseDisplayId);
      if (used.has(displayId)) {
        let n = 1;
        let candidate = `${displayId}_${n}`;
        while (used.has(candidate)) {
          n++;
          candidate = `${displayId}_${n}`;
        }
        displayId = candidate;
      }

      const values: Record<string, string | number> = {};
      col.schema.forEach((field) => {
        values[field.id] = field.id === "id" ? displayId : field.type === "number" ? 0 : "";
      });

      const newRow: CollectionRow = { id: internalRowId, values };
      return {
        ...prev,
        collections: prev.collections.map((c) =>
          c.id === col.id ? { ...c, rows: [...c.rows, newRow] } : c
        ),
      };
    });
  };

  const moveRowToIndex = (collectionId: Id, rowId: Id, targetIndex: number) => {
    setProject((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        collections: prev.collections.map((c) => {
          if (c.id !== collectionId) return c;

          const fromIndex = c.rows.findIndex((r) => r.id === rowId);
          if (fromIndex === -1) return c;

          const clampedTarget = Math.max(0, Math.min(targetIndex, c.rows.length - 1));
          if (fromIndex === clampedTarget) return c;

          const nextRows = [...c.rows];
          const [moved] = nextRows.splice(fromIndex, 1);
          nextRows.splice(clampedTarget, 0, moved);

          return { ...c, rows: nextRows };
        }),
      };
    });
  };

  const deleteRow = async (collectionId: Id, rowId: Id) => {
    if (!project) return;

    const ok = await appModal.confirm({
      title: "Delete row?",
      message: "Delete this row and unlink all links to it?",
      confirmText: "Delete",
      cancelText: "Cancel",
      danger: true,
    });
    if (!ok) return;

    const rowCol = project.collections.find((c) => c.id === collectionId);
    const delRow = rowCol?.rows.find((r) => r.id === rowId);
    const rowKey = String(delRow?.values["id"] ?? "");
    const rowAssetPaths = (delRow?.assets ?? []).map((a) => a.path).filter(Boolean);

    setProject((prev) => {
      if (!prev) return prev;

      const collections = prev.collections.map((c) =>
        c.id === collectionId ? { ...c, rows: c.rows.filter((r) => r.id !== rowId) } : c
      );

      const documents = prev.documents.map((d) => ({
        ...d,
        entityLinks: d.entityLinks.filter((l) => !(l.collectionId === collectionId && l.entityId === rowId)),
      }));

      const datasets = scrubDatasetRefs(prev.datasets, { collectionId, rowId });

      return { ...prev, collections, documents, datasets };
    });

    if (isDesktop && rowCol && rowKey) {
      platform.trashVaultPath(`assets/${colVaultSegments(rowCol.folderPath, rowCol.name).join("/")}/${rowKey}`).catch(console.warn);
    } else if (!isDesktop) {
      // Web: delete the row's assets from storage so they don't orphan.
      for (const p of rowAssetPaths) platform.deleteAsset(p).catch(console.warn);
    }
  };

  /** =========================
 *  Timeline actions
 *  ========================= */

  const uploadTimelineCover = async (beat: number, file: File) => {
    if (!project || !projectRowId || !userId) return;
    if (!requireAccount("upload assets")) return;
    const replacingCover = !!(project.view as any)?.timelineCovers?.[beat];
    if (!(await requireAssetCapacity(replacingCover ? 0 : 1))) return;

    const safeName = file.name.replace(/[^\w.-]/g, "_");
    const uploadFile = isDesktop ? file : await compressImageForWeb(file);
    const path = isDesktop
      ? `timeline/${beat}/${safeName}`
      : `${userId}/${project.id}/timeline/${beat}_${Date.now()}_${safeName}`;

    try {
      await platform.uploadAsset(uploadFile, path);
    } catch (error: any) {
      appModal.alert(error.message, { title: "Upload failed" });
      return;
    }

    const nextProject: Project = structuredClone(project);
    nextProject.view = nextProject.view ?? {};
    nextProject.view.timelineCovers = {
      ...(nextProject.view.timelineCovers ?? {}),
      [beat]: path,
    };

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  const removeTimelineCover = async (beat: number) => {
    if (!project) return;

    // Remove from storage (best-effort)
    const path = (project.view as any)?.timelineCovers?.[beat];
    if (path) {
      await platform.deleteAsset(path);
    }

    const nextProject: Project = structuredClone(project);
    nextProject.view = nextProject.view ?? {};
    const covers = { ...(nextProject.view.timelineCovers ?? {}) };
    delete (covers as any)[beat];
    nextProject.view.timelineCovers = covers;

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  const setTimelineVisible = (visible: boolean) => {
    setProject((prev) => {
      if (!prev) return prev;
      if ((prev.view?.timelineEnabled ?? false) === visible) return prev;
      return { ...prev, view: { ...(prev.view ?? {}), timelineEnabled: visible } };
    });
  };

  const moveDocOnTimeline = (docId: Id, position: number) => {
    setProject((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        documents: prev.documents.map((d) => {
          if (d.id !== docId) return d;

          // ✅ position === -1 means "unassigned"
          if (position === -1) {
            const { timelinePos: _omit, ...rest } = d as any;
            return rest as Doc;
          }

          return { ...d, timelinePos: position };
        }),
      };
    });
  };


  const addTimelineEntityLabel = (position: number, collectionId: Id, entityId: Id) => {
    setProject((prev) => {
      if (!prev) return prev;

      const current = prev.timelineLabels ?? [];
      const exists = current.some(
        (l: any) => l.position === position && l.collectionId === collectionId && l.entityId === entityId
      );
      if (exists) return prev;

      const newLabel = {
        id: ("tl_" + Date.now()) as Id,
        position,
        collectionId,
        entityId,
      };

      return { ...prev, timelineLabels: [...current, newLabel] as any };
    });
  };

  const deleteTimelineLabel = (labelId: Id) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        timelineLabels: (prev.timelineLabels ?? []).filter((l: any) => l.id !== labelId),
      };
    });
  };


  // ---------- World Map actions ----------
  // Uploading a world-map image also files it as a record asset, so it shows up in the
  // Assets tree. The destination record is either the one the world name was picked from
  // (entity mode) or a table+record auto-created from the typed name (text mode).
  const uploadWorldMapImage = async (file: File, nameCtx?: WorldNameCtx) => {
    if (!project || !projectRowId || !userId) return;
    if (!requireAccount("create a map")) return;
    if (!(await requireAssetCapacity(1))) return;

    const safeName = sanitizeSegment(file.name) || "map_image";
    const assetId = crypto.randomUUID();

    const nextProject: Project = structuredClone(project);
    nextProject.view = nextProject.view ?? {};
    const view = nextProject.view;

    // ---- Resolve (or create) the destination record ----
    const ctxMode = nameCtx?.mode ?? (view.worldMapNameCollectionId ? "entity" : "text");
    let destColId: Id | undefined =
      ctxMode === "entity" ? (nameCtx?.collectionId ?? view.worldMapNameCollectionId) : view.worldMapNameCollectionId;
    let destRowId: Id | undefined =
      ctxMode === "entity" ? (nameCtx?.entityId ?? view.worldMapNameEntityId) : view.worldMapNameEntityId;

    let destCol = destColId ? nextProject.collections.find((c) => c.id === destColId) : undefined;
    let destRow = destCol?.rows.find((r) => r.id === destRowId);

    if (!destRow) {
      // No existing destination → create (or reuse) a "World" table holding a single
      // world record (ID field = "World", Name field = the typed world name).
      const worldName =
        (nameCtx?.mode === "text" ? nameCtx.name?.trim() : "") ||
        view.worldMapName?.trim() ||
        "World";

      const TABLE_NAME = "Map";
      destCol = nextProject.collections.find((c) => c.name.toLowerCase() === TABLE_NAME.toLowerCase());
      if (!destCol) {
        destCol = {
          id: "map_" + Date.now(),
          name: TABLE_NAME,
          folderPath: [],
          kind: "generic",
          assetsEnabled: true,
          color: getDefaultColor(nextProject.collections.length),
          schema: [
            { id: "id", label: "ID", type: "string" },
            { id: "name", label: "Name", type: "string" },
            { id: "description", label: "Description", type: "text" },
          ],
          rows: [],
        } as Collection;
        nextProject.collections.push(destCol);
      }

      // Each new map is its own record. First = "Map", then "Map_1", "Map_2", …
      const usedIds = new Set(destCol.rows.map((r) => String(r.values["id"] ?? "")));
      let recordKey = "Map";
      let n = 1;
      while (usedIds.has(recordKey)) recordKey = "Map_" + n++;
      destRow = { id: "row_" + Date.now(), values: { id: recordKey, name: worldName }, assets: [] } as CollectionRow;
      destCol.rows.push(destRow);

      destColId = destCol.id;
      destRowId = destRow.id;
      view.worldMapName = worldName;
      view.worldMapNameCollectionId = destColId;
      view.worldMapNameEntityId = destRowId;
    } else if (ctxMode === "entity") {
      // Keep the world name in sync with the chosen record.
      destColId = destCol!.id;
      destRowId = destRow.id;
      view.worldMapNameCollectionId = destColId;
      view.worldMapNameEntityId = destRowId;
      view.worldMapName = getRowLabel(destRow);
    }

    destCol = destCol!;
    destRow.assets = destRow.assets ?? [];

    // ---- Compute the asset path (mirrors the entity-asset upload scheme) ----
    let path: string;
    if (isDesktop) {
      const colSlug = colVaultSegments(destCol.folderPath, destCol.name).join("/");
      const firstField = destCol.schema[0];
      const entityKey = firstField ? (String(destRow.values[firstField.id] ?? "") || destRow.id) : destRow.id;
      path = `${colSlug}/${entityKey}/${safeName}`;
    } else {
      path = `${userId}/${nextProject.id}/${destColId}/${destRowId}/${assetId}_${safeName}`;
    }

    const uploadFile = isDesktop ? file : await compressImageForWeb(file);
    try {
      await platform.uploadAsset(uploadFile, path);
    } catch (error: any) {
      appModal.alert(error.message, { title: "Upload failed" } as any);
      return;
    }

    destRow.assets.push({
      id: assetId,
      name: file.name,
      mime: uploadFile.type || file.type || "image/*",
      size: uploadFile.size,
      path,
      createdAt: new Date().toISOString(),
    });
    if (!destRow.profileAssetId) destRow.profileAssetId = assetId;

    view.worldMapImagePath = path;
    if (!view.activeWorldMapId) view.activeWorldMapId = "wm_" + Date.now();

    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  // Set the map image to an already-existing record asset (referenced, not copied).
  const setWorldMapImageFromAsset = (path: string) => {
    setProject((prev) => {
      if (!prev) return prev;
      const view = { ...(prev.view ?? {}), worldMapImagePath: path };
      if (!view.activeWorldMapId) view.activeWorldMapId = "wm_" + Date.now();
      return { ...prev, view };
    });
    // Save on the next tick so the new path is committed first.
    setTimeout(() => saveProjectToSupabase(), 0);
  };

  const removeWorldMapImage = async () => {
    if (!project) return;
    // Note: we no longer delete the underlying file — it's a managed record asset now.
    // "Remove map" just detaches it from the map and resets pins.
    const nextProject: Project = structuredClone(project);
    nextProject.view = nextProject.view ?? {};
    delete nextProject.view.worldMapImagePath;
    delete nextProject.view.worldMapName;
    delete nextProject.view.worldMapNameCollectionId;
    delete nextProject.view.worldMapNameEntityId;
    nextProject.worldMapDocPins = [];
    nextProject.worldMapLabelPins = [];
    setProject(nextProject);
    await saveProjectToSupabase(nextProject);
  };

  // Archive the current map, then clear the live fields → returns to the setup wizard.
  const makeNewWorldMap = async () => {
    if (!project) return;
    const { worldMaps } = archiveActiveWorldMap(project);
    const next: Project = structuredClone(project);
    next.worldMaps = worldMaps;
    next.view = next.view ?? {};
    delete next.view.worldMapImagePath;
    delete next.view.worldMapName;
    delete next.view.worldMapNameCollectionId;
    delete next.view.worldMapNameEntityId;
    next.view.worldMapIncludeInWiki = false;
    next.view.activeWorldMapId = undefined;
    next.worldMapDocPins = [];
    next.worldMapLabelPins = [];
    setProject(next);
    await saveProjectToSupabase(next);
  };

  // Archive the current map, then load a previously-saved one (with its pins).
  const loadWorldMap = async (id: Id) => {
    if (!project) return;
    const { worldMaps } = archiveActiveWorldMap(project);
    const entry = worldMaps.find((m) => m.id === id);
    const next: Project = structuredClone(project);
    next.worldMaps = worldMaps;
    if (entry) {
      next.view = next.view ?? {};
      next.view.worldMapImagePath = entry.imagePath;
      next.view.worldMapName = entry.name;
      next.view.worldMapNameCollectionId = entry.collectionId || undefined;
      next.view.worldMapNameEntityId = entry.entityId || undefined;
      next.view.worldMapIncludeInWiki = entry.includeInWiki ?? false;
      next.view.activeWorldMapId = id;
      next.worldMapDocPins = (entry.docPins ?? []).map((p) => ({ ...p }));
      next.worldMapLabelPins = (entry.labelPins ?? []).map((p) => ({ ...p }));
    }
    setProject(next);
    await saveProjectToSupabase(next);
  };

  // Setup "Use existing record" → load that record's saved map (with pins) if one exists,
  // otherwise start a fresh map bound to that record.
  const selectOrCreateWorldMapForRecord = async (collectionId: Id, entityId: Id, name: string) => {
    if (!project) return;
    const { worldMaps } = archiveActiveWorldMap(project);
    const existing = worldMaps.find((m) => m.collectionId === collectionId && m.entityId === entityId);
    const next: Project = structuredClone(project);
    next.worldMaps = worldMaps;
    next.view = next.view ?? {};
    if (existing) {
      next.view.worldMapImagePath = existing.imagePath;
      next.view.worldMapName = existing.name || name;
      next.view.worldMapNameCollectionId = collectionId;
      next.view.worldMapNameEntityId = entityId;
      next.view.worldMapIncludeInWiki = existing.includeInWiki ?? false;
      next.view.activeWorldMapId = existing.id;
      next.worldMapDocPins = (existing.docPins ?? []).map((p) => ({ ...p }));
      next.worldMapLabelPins = (existing.labelPins ?? []).map((p) => ({ ...p }));
    } else {
      delete next.view.worldMapImagePath;
      next.view.worldMapName = name;
      next.view.worldMapNameCollectionId = collectionId;
      next.view.worldMapNameEntityId = entityId;
      next.view.worldMapIncludeInWiki = false;
      next.view.activeWorldMapId = "wm_" + Date.now();
      next.worldMapDocPins = [];
      next.worldMapLabelPins = [];
    }
    setProject(next);
    await saveProjectToSupabase(next);
  };

  const clearWorldMapDocPins = async () => {
    if (!project) return;
    const next: Project = structuredClone(project);
    next.worldMapDocPins = [];
    setProject(next);
    await saveProjectToSupabase(next);
  };

  const clearWorldMapLabelPins = async () => {
    if (!project) return;
    const next: Project = structuredClone(project);
    next.worldMapLabelPins = [];
    setProject(next);
    await saveProjectToSupabase(next);
  };

  const setWorldMapName = (name: string, collectionId?: Id, entityId?: Id) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        view: {
          ...(prev.view ?? {}),
          worldMapName: name,
          worldMapNameCollectionId: collectionId,
          worldMapNameEntityId: entityId,
        },
      };
    });
  };

  const setWorldMapIncludeInWiki = (include: boolean) => {
    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, view: { ...(prev.view ?? {}), worldMapIncludeInWiki: include } };
    });
  };

  const addWorldMapDocPin = (docId: Id, x: number, y: number) => {
    setProject((prev) => {
      if (!prev) return prev;
      const pin = { id: `wmdoc_${Date.now()}` as Id, docId, x, y };
      return { ...prev, worldMapDocPins: [...(prev.worldMapDocPins ?? []), pin] };
    });
  };

  const updateWorldMapDocPinPos = (pinId: Id, x: number, y: number) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        worldMapDocPins: (prev.worldMapDocPins ?? []).map((p) =>
          p.id === pinId ? { ...p, x, y } : p
        ),
      };
    });
  };

  const removeWorldMapDocPin = (pinId: Id) => {
    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, worldMapDocPins: (prev.worldMapDocPins ?? []).filter((p) => p.id !== pinId) };
    });
  };

  const addWorldMapLabelPin = (collectionId: Id, entityId: Id, x: number, y: number) => {
    setProject((prev) => {
      if (!prev) return prev;
      const pin = { id: `wmlbl_${Date.now()}` as Id, collectionId, entityId, x, y };
      return { ...prev, worldMapLabelPins: [...(prev.worldMapLabelPins ?? []), pin] };
    });
  };

  const updateWorldMapLabelPinPos = (pinId: Id, x: number, y: number) => {
    setProject((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        worldMapLabelPins: (prev.worldMapLabelPins ?? []).map((p) =>
          p.id === pinId ? { ...p, x, y } : p
        ),
      };
    });
  };

  const removeWorldMapLabelPin = (pinId: Id) => {
    setProject((prev) => {
      if (!prev) return prev;
      return { ...prev, worldMapLabelPins: (prev.worldMapLabelPins ?? []).filter((p) => p.id !== pinId) };
    });
  };

  const timelineBeatCount = project?.view?.timelineBeatCount;


  const insertBeatAfter = (afterBeat: number) => {
    setProject((prev) => {
      if (!prev) return prev;

      const assignedDocs = prev.documents.filter((d: any) => d.timelinePos != null);
      const maxDocPos = assignedDocs.reduce((m: number, d: any) => Math.max(m, d.timelinePos ?? 0), 0);
      const maxLabelPos = (prev.timelineLabels ?? []).reduce((m: number, l: any) => Math.max(m, l.position ?? 0), 0);
      const currentCount = prev.view?.timelineBeatCount ?? Math.max(5, Math.max(maxDocPos, maxLabelPos) + 1);
      const insertIndex = Math.max(0, Math.min(afterBeat + 1, currentCount));

      // Shift docs at/after insertIndex to the right by 1
      const documents = prev.documents.map((d: any) => {
        if (typeof d.timelinePos !== "number") return d;
        if (d.timelinePos >= insertIndex) return { ...d, timelinePos: d.timelinePos + 1 };
        return d;
      });

      // Shift labels at/after insertIndex
      const timelineLabels = (prev.timelineLabels ?? []).map((l: any) => {
        if (l.position >= insertIndex) return { ...l, position: l.position + 1 };
        return l;
      });

      // Shift section titles at/after insertIndex
      const sectionTitles: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev.view?.timelineSectionTitles ?? {})) {
        const idx = Number(k);
        sectionTitles[idx >= insertIndex ? idx + 1 : idx] = v as string;
      }

      return {
        ...prev,
        documents,
        timelineLabels,
        view: { ...(prev.view ?? {}), timelineBeatCount: currentCount + 1, timelineSectionTitles: sectionTitles },
      };
    });
  };

  const removeBeatAt = (beat: number) => {
    setProject((prev) => {
      if (!prev) return prev;

      const assignedDocs = prev.documents.filter((d: any) => d.timelinePos != null);
      const maxDocPos = assignedDocs.reduce((m: number, d: any) => Math.max(m, d.timelinePos ?? 0), 0);
      const maxLabelPos = (prev.timelineLabels ?? []).reduce((m: number, l: any) => Math.max(m, l.position ?? 0), 0);
      const currentCount = prev.view?.timelineBeatCount ?? Math.max(5, Math.max(maxDocPos, maxLabelPos) + 1);
      if (currentCount <= 1) return prev;

      const removeIndex = Math.max(0, Math.min(beat, currentCount - 1));

      // Docs on removed beat become unassigned; docs after shift left
      const documents = prev.documents.map((d: any) => {
        if (typeof d.timelinePos !== "number") return d;

        if (d.timelinePos === removeIndex) {
          const { timelinePos: _omit, ...rest } = d;
          return rest;
        }
        if (d.timelinePos > removeIndex) return { ...d, timelinePos: d.timelinePos - 1 };
        return d;
      });

      // Labels on removed beat removed; labels after shift left
      const timelineLabels = (prev.timelineLabels ?? [])
        .filter((l: any) => l.position !== removeIndex)
        .map((l: any) => (l.position > removeIndex ? { ...l, position: l.position - 1 } : l));

      // Drop the removed section's title; shift later titles left
      const sectionTitles: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev.view?.timelineSectionTitles ?? {})) {
        const idx = Number(k);
        if (idx === removeIndex) continue;
        sectionTitles[idx > removeIndex ? idx - 1 : idx] = v as string;
      }

      return {
        ...prev,
        documents,
        timelineLabels,
        view: { ...(prev.view ?? {}), timelineBeatCount: Math.max(1, currentCount - 1), timelineSectionTitles: sectionTitles },
      };
    });
  };

  const renameTimelineSection = (beat: number, title: string) => {
    setProject((prev) => {
      if (!prev) return prev;
      const titles = { ...(prev.view?.timelineSectionTitles ?? {}) };
      const t = title.trim();
      if (t) titles[beat] = t;
      else delete titles[beat];
      return { ...prev, view: { ...(prev.view ?? {}), timelineSectionTitles: titles } };
    });
  };

  /** =========================
   *  Timeline window bridge (desktop only)
   *  ========================= */
  const timelineBridgeRef = useRef<{
    state: () => Parameters<typeof emitTimelineState>[0];
    handlers: Record<string, (...args: any[]) => void>;
  }>(null as any);

  timelineBridgeRef.current = {
    state: () => ({
      documents: project?.documents ?? [],
      collections: project?.collections ?? [],
      labels: timelineLabels,
      beatCount: timelineBeatCount,
      covers: timelineCoverUrls,
      sectionTitles: project?.view?.timelineSectionTitles ?? {},
    }),
    handlers: {
      insertBeat: (beat: number) => insertBeatAfter(beat),
      removeBeat: (beat: number) => removeBeatAt(beat),
      moveDoc: (docId: Id, position: number) => moveDocOnTimeline(docId, position),
      openDoc: (docId: Id) => setActiveDocId(docId),
      addEntityLabel: (position: number, collectionId: Id, entityId: Id) =>
        addTimelineEntityLabel(position, collectionId, entityId),
      deleteLabel: (labelId: Id) => deleteTimelineLabel(labelId),
      uploadCover: (beat: number, fileName: string, base64: string) => {
        const bytes = atob(base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        uploadTimelineCover(beat, new File([arr], fileName));
      },
      removeCover: (beat: number) => removeTimelineCover(beat),
      renameSection: (beat: number, title: string) => renameTimelineSection(beat, title),
      selectEntity: (collectionId: Id, entityId: Id) => openEntityInCollection(collectionId, entityId),
    },
  };

  // Subscribe to mutations + state requests from the timeline window (once).
  // `cancelled` guards StrictMode's double-mount so the listener isn't registered twice.
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    let unlistenMut: (() => void) | undefined;
    let unlistenReq: (() => void) | undefined;
    (async () => {
      const fnMut = await onTimelineMutation((m: any) => {
        const h = timelineBridgeRef.current.handlers;
        switch (m.kind) {
          case "insertBeat": h.insertBeat(m.beat); break;
          case "removeBeat": h.removeBeat(m.beat); break;
          case "moveDoc": h.moveDoc(m.docId, m.position); break;
          case "openDoc": h.openDoc(m.docId); break;
          case "addEntityLabel": h.addEntityLabel(m.position, m.collectionId, m.entityId); break;
          case "deleteLabel": h.deleteLabel(m.labelId); break;
          case "uploadCover": h.uploadCover(m.beat, m.fileName, m.base64); break;
          case "removeCover": h.removeCover(m.beat); break;
          case "renameSection": h.renameSection(m.beat, m.title); break;
          case "selectEntity": h.selectEntity(m.collectionId, m.entityId); break;
        }
      });
      if (cancelled) { fnMut(); } else { unlistenMut = fnMut; }

      const fnReq = await onTimelineStateRequest(() => {
        emitTimelineState(timelineBridgeRef.current.state());
      });
      if (cancelled) { fnReq(); } else { unlistenReq = fnReq; }
    })();
    return () => { cancelled = true; unlistenMut?.(); unlistenReq?.(); };
  }, []);

  // Push state to the timeline window whenever the relevant slice changes
  useEffect(() => {
    if (!isDesktop) return;
    emitTimelineState(timelineBridgeRef.current.state());
  }, [project?.documents, project?.collections, timelineLabels, timelineBeatCount, timelineCoverUrls, project?.view?.timelineSectionTitles]);

  /** =========================
   *  World map window bridge (desktop only)
   *  ========================= */
  const worldMapBridgeRef = useRef<{
    state: () => Parameters<typeof emitWorldMapState>[0];
    handlers: Record<string, (...args: any[]) => void>;
  }>(null as any);

  worldMapBridgeRef.current = {
    state: () => {
      const { worldMaps: wmList, activeId: wmActiveId } = project
        ? archiveActiveWorldMap(project)
        : { worldMaps: [] as WorldMapEntry[], activeId: "" };
      return {
        imageUrl: worldMapImageUrl,
        worldName: project?.view?.worldMapName ?? "",
        worldNameCollectionId: project?.view?.worldMapNameCollectionId,
        worldNameEntityId: project?.view?.worldMapNameEntityId,
        includeInWiki: project?.view?.worldMapIncludeInWiki ?? false,
        docPins: (project?.worldMapDocPins ?? []) as WorldMapDocPin[],
        labelPins: (project?.worldMapLabelPins ?? []) as WorldMapLabelPin[],
        documents: project?.documents ?? [],
        collections: project?.collections ?? [],
        savedMaps: wmList.map((m) => ({ id: m.id, name: m.name, hasImage: !!m.imagePath })),
        activeMapId: wmActiveId,
        saveMessage,
      };
    },
    handlers: {
      uploadImage: (fileName: string, base64: string, nameCtx?: WorldNameCtx) => {
        const bytes = atob(base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        uploadWorldMapImage(new File([arr], fileName), nameCtx);
      },
      setImagePath: (path: string) => setWorldMapImageFromAsset(path),
      removeImage: () => removeWorldMapImage(),
      makeNewMap: () => makeNewWorldMap(),
      loadMap: (id: Id) => loadWorldMap(id),
      selectRecord: (collectionId: Id, entityId: Id, name: string) => selectOrCreateWorldMapForRecord(collectionId, entityId, name),
      clearDocPins: () => clearWorldMapDocPins(),
      clearLabelPins: () => clearWorldMapLabelPins(),
      setWorldName: (name: string, collectionId?: Id, entityId?: Id) => setWorldMapName(name, collectionId, entityId),
      setIncludeInWiki: (include: boolean) => setWorldMapIncludeInWiki(include),
      addDocPin: (docId: Id, x: number, y: number) => addWorldMapDocPin(docId, x, y),
      moveDocPin: (pinId: Id, x: number, y: number) => updateWorldMapDocPinPos(pinId, x, y),
      removeDocPin: (pinId: Id) => removeWorldMapDocPin(pinId),
      addLabelPin: (collectionId: Id, entityId: Id, x: number, y: number) => addWorldMapLabelPin(collectionId, entityId, x, y),
      moveLabelPin: (pinId: Id, x: number, y: number) => updateWorldMapLabelPinPos(pinId, x, y),
      removeLabelPin: (pinId: Id) => removeWorldMapLabelPin(pinId),
      openDoc: (docId: Id) => setActiveDocId(docId),
      save: () => saveProjectToSupabase(),
    },
  };

  // Subscribe to world map mutations + state requests (once)
  useEffect(() => {
    if (!isDesktop) return;
    // `cancelled` guards against StrictMode's mount→unmount→mount: if the cleanup runs
    // before these async subscriptions resolve, we must unlisten the moment they do,
    // otherwise the listener stays registered twice and every mutation fires twice
    // (which placed duplicate pins).
    let cancelled = false;
    let unlistenMut: (() => void) | undefined;
    let unlistenReq: (() => void) | undefined;
    (async () => {
      const fnMut = await onWorldMapMutation((m: any) => {
        const h = worldMapBridgeRef.current.handlers;
        switch (m.kind) {
          case "uploadImage": h.uploadImage(m.fileName, m.base64, m.nameCtx); break;
          case "setImagePath": h.setImagePath(m.path); break;
          case "removeImage": h.removeImage(); break;
          case "makeNewMap": h.makeNewMap(); break;
          case "loadMap": h.loadMap(m.id); break;
          case "selectRecord": h.selectRecord(m.collectionId, m.entityId, m.name); break;
          case "clearDocPins": h.clearDocPins(); break;
          case "clearLabelPins": h.clearLabelPins(); break;
          case "setWorldName": h.setWorldName(m.name, m.collectionId, m.entityId); break;
          case "setIncludeInWiki": h.setIncludeInWiki(m.include); break;
          case "addDocPin": h.addDocPin(m.docId, m.x, m.y); break;
          case "moveDocPin": h.moveDocPin(m.pinId, m.x, m.y); break;
          case "removeDocPin": h.removeDocPin(m.pinId); break;
          case "addLabelPin": h.addLabelPin(m.collectionId, m.entityId, m.x, m.y); break;
          case "moveLabelPin": h.moveLabelPin(m.pinId, m.x, m.y); break;
          case "removeLabelPin": h.removeLabelPin(m.pinId); break;
          case "openDoc": h.openDoc(m.docId); break;
          case "save": h.save(); break;
        }
      });
      if (cancelled) { fnMut(); } else { unlistenMut = fnMut; }

      const fnReq = await onWorldMapStateRequest(() => {
        emitWorldMapState(worldMapBridgeRef.current.state());
      });
      if (cancelled) { fnReq(); } else { unlistenReq = fnReq; }
    })();
    return () => { cancelled = true; unlistenMut?.(); unlistenReq?.(); };
  }, []);

  // Push state to the world map window whenever the relevant slice changes
  useEffect(() => {
    if (!isDesktop) return;
    emitWorldMapState(worldMapBridgeRef.current.state());
  }, [
    project?.worldMapDocPins,
    project?.worldMapLabelPins,
    project?.view?.worldMapName,
    project?.view?.worldMapImagePath,
    project?.view?.worldMapIncludeInWiki,
    project?.view?.activeWorldMapId,
    project?.worldMaps,
    project?.documents,
    project?.collections,
    worldMapImageUrl,
    saveMessage,
  ]);

  /** =========================
   *  Document content update with link-range tracking
   *  ========================= */
  const updateDocumentContent = (docId: Id, newContent: string) => {
    setProject((prev) => {
      if (!prev) return prev;

      const documents = prev.documents.map((doc) => {
        if (doc.id !== docId) return doc;

        const oldContent = doc.content;

        // Canonicalize newlines so indices are stable across save/load (Windows CRLF, etc.)
        const normalizedNewContent = normalizeNewlines(newContent);

        if (oldContent === normalizedNewContent) return doc;

        const oldLen = oldContent.length;
        const newLen = normalizedNewContent.length;

        let diffStart = 0;
        while (
          diffStart < oldLen &&
          diffStart < newLen &&
          oldContent[diffStart] === normalizedNewContent[diffStart]
        ) {
          diffStart++;
        }

        let oldEnd = oldLen;
        let newEnd = newLen;
        while (
          oldEnd > diffStart &&
          newEnd > diffStart &&
          oldContent[oldEnd - 1] === normalizedNewContent[newEnd - 1]
        ) {
          oldEnd--;
          newEnd--;
        }

        const removedCount = oldEnd - diffStart;
        const insertedCount = newEnd - diffStart;

        const delStart = diffStart;
        const delEnd = oldEnd;

        const mapIndexAfterDeletion = (idx: number): number => {
          if (removedCount <= 0) return idx;
          if (idx <= delStart) return idx;
          if (idx >= delEnd) return idx - removedCount;
          return delStart;
        };

        const adjustForInsertion = (start: number, end: number): { start: number; end: number } => {
          if (insertedCount <= 0) return { start, end };
          const p = diffStart;

          if (p <= start) return { start: start + insertedCount, end: end + insertedCount };
          if (p < end) return { start, end: end + insertedCount };
          return { start, end };
        };

        const adjustedLinks: EntityLink[] = [];
        for (const link of doc.entityLinks) {
          let s = mapIndexAfterDeletion(link.start);
          let e = mapIndexAfterDeletion(link.end);

          if (e <= s) continue;

          const afterIns = adjustForInsertion(s, e);
          s = afterIns.start;
          e = afterIns.end;

          if (e <= s) continue;
          adjustedLinks.push({ ...link, start: s, end: e });
        }

        return { ...doc, content: normalizedNewContent, entityLinks: adjustedLinks };
      });

      return { ...prev, documents };
    });
  };

  /** =========================
   *  Document rich content update (Lexical JSON)
   *  Keeps doc.content + link indices aligned with the text implied by richContent.
   *  ========================= */
  const updateDocumentRichContent = (docId: Id, richContent: string) => {
    setProject((prev) => {
      if (!prev) return prev;

      const documents = prev.documents.map((doc) => {
        if (doc.id !== docId) return doc;

        const oldText = normalizeNewlines(doc.content);

        // Derive the plain text exactly the way Lexical root.getTextContent() would.
        // This is critical for correct link offsets, especially around empty paragraphs.
        const derived = lexicalTextFromRichContent(richContent);
        const newText = derived != null ? normalizeNewlines(derived) : oldText;

        // Always store richContent
        let nextDoc: any = { ...doc, richContent };

        // If text didn’t change, keep content/links as-is.
        if (newText === oldText) {
          return nextDoc;
        }

        // Remap existing link ranges oldText -> newText (multi-change safe)
        const mapOldToNew = buildGreedyOldToNewIndexMap(oldText, newText);

        const adjustedLinks: EntityLink[] = [];
        for (const link of doc.entityLinks) {
          const s = mapOldIndex(link.start, mapOldToNew);
          const e = mapOldIndex(link.end, mapOldToNew);

          if (e > s) {
            adjustedLinks.push({ ...link, start: s, end: e });
          }
        }

        // Store updated plain text + remapped links
        nextDoc = { ...nextDoc, content: newText, entityLinks: adjustedLinks };
        return nextDoc;
      });

      return { ...prev, documents };
    });
  };

  /** =========================
   *  Linking logic
   *  ========================= */
  const handleHighlightClick = useCallback(
    (linkId: Id, anchorRect: DOMRect) => {
      if (!project || !activeDoc) return;

      const link = activeDoc.entityLinks.find((l) => l.id === linkId);
      if (!link) return;

      // Reflect the link target in the table panel, but DON'T switch focus away from the
      // doc editor — otherwise (in focus mode) clicking a link hides the text you're editing
      // and the popover loses its anchor. We only update the active collection/row + scroll
      // it into view if the table is actually visible.
      setActiveCollectionId(link.collectionId);
      setActiveRowId(link.entityId);
      if (layoutMode === "dual" || focusView === "collection") {
        setTimeout(() => {
          const el = document.querySelector(
            `[data-rowkey="${link.collectionId}:${link.entityId}"]`
          ) as HTMLElement | null;
          el?.scrollIntoView({ block: "nearest" });
        }, 50);
      }

      const text = activeDoc.content.slice(link.start, link.end);

      setLinkingSelection({ start: link.start, end: link.end, text });
      setLinkingCollectionId(link.collectionId);
      setLinkingEntityId(link.entityId);
      setEditingLinkId(link.id);
      setLinkingNotice(null);
      // Use the clicked element's own rect — accurate and synchronous
      setLinkPopoverAnchorRect({
        left: anchorRect.left,
        top: anchorRect.top,
        right: anchorRect.right,
        bottom: anchorRect.bottom,
        width: anchorRect.width,
        height: anchorRect.height,
      });

    },
    [project, activeDoc, layoutMode, focusView]
  );

  // Keeps the link popover from disappearing when you click its controls (which can collapse editor selection).
  const linkUiInteractionBatonRef = useRef<number>(0);

  const closeLinkEditor = useCallback(() => {
    setLinkingSelection(null);
    setEditingLinkId(null);
    setLinkingCollectionId("");
    setLinkingEntityId("");
    setLinkingNotice(null);

    setCaretLinkId(null);
    setLinkPopoverAnchorRect(null);
  }, []);

  // Close link popover on Escape or clicking off the highlighted selection (and outside the popover)
  useEffect(() => {
    const popoverOpen = !!((linkingSelection || editingLink) && linkPopoverAnchorRect);
    if (!popoverOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Don’t trigger while IME is composing (JP/CN input)
      if ((e as any).isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        closeLinkEditor();
        return;
      }

      // Backspace/Delete should also dismiss the popover (let the editor handle the actual delete)
      if (e.key === "Backspace" || e.key === "Delete") {
        closeLinkEditor();
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Click inside the popover should NOT close it
      if (target.closest(".linkPopover")) return;

      // If the user clicks INSIDE the currently highlighted selection, keep it open
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (!r.collapsed) {
          const x = e.clientX;
          const y = e.clientY;

          // Some selections span multiple rects (wrapped lines), so test all rects.
          const rects = Array.from(r.getClientRects());
          for (const rect of rects) {
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
              return; // clicked "on" the highlighted text
            }
          }
        }
      }

      // Otherwise, click was "off" the highlighted text -> close the menu
      closeLinkEditor();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [linkingSelection, editingLink, linkPopoverAnchorRect, closeLinkEditor]);

  const handleEditorSelectionChange = (range: { start: number; end: number; text: string; anchorRect: AnchorRect | null } | null) => {
    if (!project || !activeDoc) {
      closeLinkEditor();
      return;
    }

    if (!range) {
      // Don’t force-close here on caret collapse; caret-link listener will decide visibility.
      // But if we’re not on a linked span and not interacting with the popover, close.
      if (Date.now() - linkUiInteractionBatonRef.current < 300) return;

      if (!caretLinkId) {
        closeLinkEditor();
      }
      return;
    }

    // ✅ If the highlighted selection intersects ANY existing link (even partially),
    // do NOT open the link menu.
    const overlapsExistingLink = activeDoc.entityLinks.some(
      (l) => !(range.end <= l.start || range.start >= l.end)
    );
    if (overlapsExistingLink) {
      closeLinkEditor();
      return;
    }

    // Selection-based linking (text is highlighted)
    setCaretLinkId(null);
    setLinkPopoverAnchorRect(range.anchorRect);

    setLinkingSelection({ start: range.start, end: range.end, text: range.text });
    setEditingLinkId(null);
    setLinkingCollectionId("");
    setLinkingEntityId("");
    setLinkingNotice(null);
  };

  const handleCaretLinkChange = useCallback(
    (payload: { linkId: Id | null; anchorRect: AnchorRect | null }) => {
      if (!project || !activeDoc) return;

      setCaretLinkId(payload.linkId);
      setLinkPopoverAnchorRect(payload.anchorRect);

      // If caret is not on a link, close unless user currently has a real selection open.
      if (!payload.linkId) {
        if (Date.now() - linkUiInteractionBatonRef.current < 300) return;

        // If the user is actively selecting text to create a link, keep it open.
        if (linkingSelection && !editingLinkId) return;

        closeLinkEditor();
        return;
      }

      const link = activeDoc.entityLinks.find((l) => l.id === payload.linkId);
      if (!link) return;

      const text = activeDoc.content.slice(link.start, link.end);

      setLinkingSelection({ start: link.start, end: link.end, text });
      setLinkingCollectionId(link.collectionId);
      setLinkingEntityId(link.entityId);
      setEditingLinkId(link.id);
      setLinkingNotice(null);
    },
    [project, activeDoc, linkingSelection, editingLinkId]
  );

  // Replace a document's derived link index (chips report their offsets up here).
  const updateDocumentLinks = (docId: Id, links: EntityLink[]) => {
    setProject((prev) => {
      if (!prev) return prev;
      let changed = false;
      const documents = prev.documents.map((d) => {
        if (d.id !== docId) return d;
        const norm = links.map((l) => ({ ...l, docId }));
        if (JSON.stringify(norm) === JSON.stringify(d.entityLinks)) return d;
        changed = true;
        return { ...d, entityLinks: norm };
      });
      return changed ? { ...prev, documents } : prev;
    });
  };

  const newLinkId = () => `link_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Slash-link: the typeahead already inserted the record's label as plain text at
  // [start,end]; wrap that span into a label chip. Links sync up via onLinksChange.
  const handleSlashLinkCreate = (payload: {
    newText: string;
    start: number;
    end: number;
    collectionId: Id;
    entityId: Id;
  }) => {
    if (!project || !activeDoc) return;
    const label = labelResolver(payload.collectionId, payload.entityId) ?? payload.newText.slice(payload.start, payload.end);
    linkApiRef.current?.wrapRange(payload.start, payload.end, label, {
      linkId: newLinkId(),
      collectionId: payload.collectionId,
      entityId: payload.entityId,
      linkMode: "label",
      color: colorResolver(payload.collectionId),
    });
  };

  const saveLink = () => {
    if (!project || !activeDoc || !linkingCollectionId || !linkingEntityId) return;
    const label = labelResolver(linkingCollectionId, linkingEntityId) ?? "";
    const color = colorResolver(linkingCollectionId);

    if (editingLinkId) {
      // Re-point an existing chip at the chosen record. Relabel only if it was a
      // single-word (label-tracking) span.
      const existing = activeDoc.entityLinks.find((l) => l.id === editingLinkId);
      const curText = existing ? activeDoc.content.slice(existing.start, existing.end) : "";
      linkApiRef.current?.updateLink(editingLinkId, {
        collectionId: linkingCollectionId,
        entityId: linkingEntityId,
        label,
        color,
        relabel: isSingleWord(curText),
      });
    } else {
      if (!linkingSelection) return;
      const overlapsNow = activeDoc.entityLinks.some(
        (l) => !(linkingSelection.end <= l.start || linkingSelection.start >= l.end)
      );
      if (overlapsNow) {
        setLinkingNotice("Selection overlaps an existing link. Click the highlighted text to edit/unlink it.");
        return;
      }
      const selText = activeDoc.content.slice(linkingSelection.start, linkingSelection.end);
      const single = isSingleWord(selText);
      linkApiRef.current?.wrapRange(linkingSelection.start, linkingSelection.end, single ? (label || selText) : selText, {
        linkId: newLinkId(),
        collectionId: linkingCollectionId,
        entityId: linkingEntityId,
        linkMode: single ? "label" : "text",
        color,
      });
    }

    setActiveCollectionId(linkingCollectionId);
    setLinkingSelection(null);
    setLinkingCollectionId("");
    setLinkingEntityId("");
    setEditingLinkId(null);
    setLinkingNotice(null);
  };

  const unlinkCurrentLink = () => {
    if (!editingLinkId) return;
    linkApiRef.current?.unlink(editingLinkId);
    setLinkingSelection(null);
    setLinkingCollectionId("");
    setLinkingEntityId("");
    setEditingLinkId(null);
    setLinkingNotice(null);
  };

  /** =========================
   *  Export
   *  ========================= */
  const escapeDelimited = (v: string, delim: string) => {
    const s = String(v ?? "");
    const needs = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delim);
    const out = s.replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  };

  const toDelimited = (rows: string[][], delim: string) =>
    rows.map((r) => r.map((c) => escapeDelimited(c, delim)).join(delim)).join("\n");

  const mdCell = (v: string) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r\n|\r|\n/g, "<br/>");

  const mdTable = (headers: string[], rows: string[][]) => {
    const head = `| ${headers.map(mdCell).join(" | ")} |`;
    const sep = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`).join("\n");
    return [head, sep, body].filter(Boolean).join("\n");
  };

  const exportCollectionsZip = async (format: "csv" | "tsv" | "md", collectionIds?: Id[]) => {
    if (!project) return;

    const zip = new JSZip();
    const cols = collectionIds ? project.collections.filter((c) => collectionIds.includes(c.id)) : project.collections;

    for (const col of cols) {
      const header = col.schema.map((f) => String(f.label ?? f.id));
      const ids = col.schema.map((f) => f.id);

      const dataRows: string[][] = [];
      for (const row of col.rows) {
        dataRows.push(ids.map((id) => String((row.values as any)[id] ?? "")));
      }

      const baseName = sanitizeSegment(col.name) || sanitizeSegment(col.id) || "collection";

      if (format === "md") {
        const content = `# ${String(col.name ?? col.id)}\n\n${mdTable(header, dataRows)}\n`;
        zip.file(`${baseName}.md`, content);
      } else {
        const delim = format === "csv" ? "," : "\t";
        const rows: string[][] = [header, ...dataRows];
        const content = toDelimited(rows, delim);
        zip.file(`${baseName}.${format}`, content);
      }
    }

    const outBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(`${sanitizeSegment(project.name) || "project"}_collections_${format}.zip`, outBlob);
  };

  const rtfEscape = (s: string) =>
    String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/{/g, "\\{")
      .replace(/}/g, "\\}")
      .replace(/\r\n|\r|\n/g, "\\par\n");

  const exportDocumentsZip = async (format: "txt" | "doc" | "md", documentIds?: Id[]) => {
    if (!project) return;

    const zip = new JSZip();
    const docs = documentIds ? project.documents.filter((d) => documentIds.includes(d.id)) : project.documents;

    for (const doc of docs) {
      const base = sanitizeSegment(doc.title) || sanitizeSegment(doc.id) || "document";

      if (format === "txt") {
        zip.file(`${base}.txt`, doc.content ?? "");
      } else if (format === "md") {
        const body =
          richContentToMarkdown((doc as any).richContent, [], () => null) ??
          (doc.content ?? "");

        const md = `# ${String(doc.title ?? doc.id)}\n\n${body}\n`;
        zip.file(`${base}.md`, md);
      } else {
        const richRtf = lexicalRichContentToRTF((doc as any).richContent);
        const plainBody = rtfEscape(doc.content ?? "");

        const rtf =
          `{\\rtf1\\ansi\\deff0\n` +
          `{\\fonttbl{\\f0 Arial;}}\n` +
          `\\fs28\\b ${rtfEscape(String(doc.title ?? doc.id))}\\b0\\fs22\\par\n` +
          `${richRtf ?? plainBody}\\par\n` +
          `}`;
        zip.file(`${base}.doc`, rtf);
      }
    }

    const outBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(`${sanitizeSegment(project.name) || "project"}_documents_${format}.zip`, outBlob);
  };

  const exportCollections = async (format: "csv" | "tsv" | "json" | "md", collectionIds?: Id[]) => {
    if (!project) return;

    const cols = collectionIds ? project.collections.filter((c) => collectionIds.includes(c.id)) : project.collections;

    if (format === "json") {
      downloadJson(`${sanitizeSegment(project.name) || "project"}_collections.json`, cols);
      return;
    }

    await exportCollectionsZip(format, collectionIds);
  };

  const exportDocuments = async (format: "txt" | "doc" | "json" | "md", documentIds?: Id[]) => {
    if (!project) return;

    const docs = documentIds ? project.documents.filter((d) => documentIds.includes(d.id)) : project.documents;

    if (format === "json") {
      downloadJson(`${sanitizeSegment(project.name) || "project"}_documents.json`, docs);
      return;
    }

    await exportDocumentsZip(format, documentIds);
  };

  const exportDatasetsJson = (datasetIds: Id[]) => {
    if (!project) {
      appModal.alert("No project loaded.", { title: "Export failed" });
      return;
    }
    const chosen = getDatasets(project).filter((d) => datasetIds.includes(d.id));
    for (const ds of chosen) {
      const slug = sanitizeSegment(ds.name) || ds.id;
      downloadJson(`${slug}.json`, buildDatasetFile(project, ds));
    }
  };


  // Local edits that haven't been pushed to the linked web project yet. We compare
  // a hash of the current project to the hash stored at the last sync (persisted in
  // sync.json), so this survives app restarts.
  const projectHash = useMemo(() => {
    try { return project ? hashString(syncContentString(project)) : ""; } catch { return ""; }
  }, [project]);
  const localUnpushed = isDesktop && !!syncMeta?.syncedHash && projectHash !== syncMeta.syncedHash;

  /** =========================
   *  Render
   *  ========================= */
  // Shared desktop sign-in modal (used by both the launcher and the in-app UI).
  const signInModalNode = signInModalOpen ? (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ width: 360, maxWidth: "90vw", background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 18 }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>Sign in to sync</div>
        <input
          type="email"
          placeholder="Email"
          value={signInEmail}
          onChange={(e) => setSignInEmail(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", marginBottom: 8, borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-surface)", color: "var(--text)", padding: "9px 10px", fontSize: 13 }}
        />
        <input
          type="password"
          placeholder="Password"
          value={signInPassword}
          onChange={(e) => setSignInPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") desktopSignIn(); }}
          style={{ width: "100%", boxSizing: "border-box", borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-surface)", color: "var(--text)", padding: "9px 10px", fontSize: 13 }}
        />
        {signInError && <div style={{ color: "var(--danger-text)", fontSize: 12, marginTop: 8 }}>{signInError}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button
            onClick={() => { setSignInModalOpen(false); setSignInContext("default"); }}
            title={signInContext === "linkedOpen" ? "Keep editing offline; it won't sync until you sign in" : undefined}
            style={{ borderRadius: 8, border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-2)", padding: "8px 12px", fontSize: 13, cursor: "pointer" }}
          >
            {signInContext === "linkedOpen" ? "Work locally for now" : "Cancel"}
          </button>
          <button disabled={signInBusy} onClick={desktopSignIn} style={{ borderRadius: 8, border: "none", background: "var(--accent, #5b7fff)", color: "#fff", padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: signInBusy ? "default" : "pointer" }}>{signInBusy ? "Signing in…" : "Sign in"}</button>
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 12, lineHeight: 1.4 }}>
          Use the same account as the web app. Login is free; syncing requires Pro.
        </div>
        <a
          href="https://app.rpgstorytoolkit.com/?auth=signup"
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--accent-text, #8ab4ff)", textDecoration: "underline", cursor: "pointer" }}
        >
          Don't have an account? Sign up
        </a>
      </div>
    </div>
  ) : null;

  if (needsVaultPicker) {
    return (
      <div style={{ minHeight: "100vh", maxHeight: "100vh", overflowY: "auto", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "safe center", backgroundColor: "var(--bg)", color: "var(--text)", fontFamily: "system-ui", gap: 18, padding: "48px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img src="/rpgst_logo.png" alt="" style={{ width: 40, height: 40, borderRadius: 8 }} />
          <div style={{ fontSize: 26, fontWeight: 800 }}>RPG Story Toolkit</div>
        </div>
        <div style={{ fontSize: 14, opacity: 0.7, textAlign: "center", maxWidth: 460 }}>
          Choose a project to work on. Each project is a folder the app reads and writes files into, so your game engine can pick them up in real time.
        </div>

        {initError && (
          <div style={{ fontSize: 13, color: "var(--danger-text)", maxWidth: 460, textAlign: "center" }}>{initError}</div>
        )}

        {/* Recent vaults */}
        {recentVaults.length > 0 && (
          <div style={{ width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
              Recent projects
            </div>
            {recentVaults.slice(0, 8).map((v) => {
              const status = vaultStatus[v.path]; // undefined = checking, false = missing, true = ok
              const missing = status === false;
              return (
                <div
                  key={v.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid var(--border-2)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    background: "var(--bg-elevated)",
                    opacity: missing ? 0.6 : 1,
                  }}
                >
                  <button
                    type="button"
                    disabled={vaultPickerBusy || missing}
                    onClick={() => openVaultAndLoad(v.path)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      cursor: vaultPickerBusy || missing ? "default" : "pointer",
                      padding: 0,
                    }}
                    title={v.path}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {v.name}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {missing ? "Can't find this project. It may have been moved or deleted." : v.path}
                    </div>
                  </button>
                  {vaultSyncStatus[v.path] && (
                    <span
                      title={syncSession ? "Synced to your web account" : "Linked to a web account — sign in to sync"}
                      style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "2px 8px", border: "1px solid var(--accent)", background: "var(--accent-bg-2)", color: "var(--accent-text)" }}
                    >
                      {syncSession ? "☁ Synced" : "☁ Linked"}
                    </span>
                  )}
                  <span
                    title="Stored on this device"
                    style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "2px 8px", border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-dim)" }}
                  >
                    Local
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveRecent(v.path)}
                    title="Remove from recents"
                    style={{ border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 4 }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {recentVaults.length > 8 && (
              <button
                type="button"
                onClick={() => setAllProjectsModalOpen(true)}
                style={{ alignSelf: "center", marginTop: 2, border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: "4px 8px" }}
              >
                +{recentVaults.length - 8} more
              </button>
            )}
          </div>
        )}

        {/* Web-only projects (signed in): on the account but not yet on this device */}
        {syncSession && launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).length > 0 && (
          <div style={{ width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
              Available from your web account
            </div>
            {launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).slice(0, 8).map((p) => (
              <div
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border-2)", borderRadius: 10, padding: "10px 12px", background: "var(--bg-elevated)" }}
              >
                <button
                  type="button"
                  disabled={vaultPickerBusy || transferBusy}
                  onClick={() => doPullProject(p.id)}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", color: "var(--text)", cursor: "pointer", padding: 0 }}
                  title="Import this project to a new folder on this device"
                >
                  <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || "Untitled"}</div>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>Not on this device — click to import</div>
                </button>
                <span
                  title="On your web account"
                  style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "2px 8px", border: "1px solid var(--accent)", background: "var(--accent-bg-2)", color: "var(--accent-text)" }}
                >
                  ☁ Web
                </span>
              </div>
            ))}
            {launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).length > 8 && (
              <button
                type="button"
                onClick={() => setAllProjectsModalOpen(true)}
                style={{ alignSelf: "center", marginTop: 2, border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: "4px 8px" }}
              >
                +{launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).length - 8} more
              </button>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            disabled={vaultPickerBusy}
            onClick={handleCreateNewProject}
            style={{ padding: "12px 24px", fontSize: 15, borderRadius: 8, cursor: vaultPickerBusy ? "default" : "pointer", border: "none", background: "var(--accent, #5b7fff)", color: "#fff", fontWeight: 600 }}
          >
            {vaultPickerBusy ? "Opening…" : "Create new project"}
          </button>
          <button
            disabled={vaultPickerBusy}
            onClick={() => openVaultAndLoad(null)}
            style={{ padding: "12px 24px", fontSize: 15, borderRadius: 8, cursor: vaultPickerBusy ? "default" : "pointer", border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", fontWeight: 600 }}
          >
            Open project…
          </button>
          <button
            disabled={vaultPickerBusy || transferBusy}
            onClick={handleLauncherImport}
            style={{ padding: "12px 24px", fontSize: 15, borderRadius: 8, cursor: (vaultPickerBusy || transferBusy) ? "default" : "pointer", border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", fontWeight: 600 }}
          >
            Import project…
          </button>
        </div>
        <div style={{ fontSize: 11, opacity: 0.55, textAlign: "center", maxWidth: 460, marginTop: -6 }}>
          <b>Create new project</b> makes a dedicated folder inside the folder you pick{syncSession && syncIsPro ? " and syncs it to your web account" : ""}. <b>Open project…</b> opens an existing one. <b>Import project…</b> brings in a project {syncSession ? "from your web account or a file" : `from a .${PROJECT_FILE_EXT} file`}.
        </div>

        {/* Web-account sign-in status (desktop) */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)", width: 460, maxWidth: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          {!syncSession ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.7, textAlign: "center" }}>
                Sign in to your web account to sync projects between desktop and web (Pro).
              </div>
              <button
                onClick={() => setSignInModalOpen(true)}
                style={{ padding: "10px 18px", fontSize: 14, borderRadius: 8, cursor: "pointer", border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", fontWeight: 600 }}
              >
                Sign in to sync
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, textAlign: "center" }}>
                Signed in as <b>{syncSession.user?.email ?? "your account"}</b>
                {syncIsPro ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, color: "var(--accent-text)", background: "var(--accent-bg-2)", border: "1px solid var(--accent)", borderRadius: 999, padding: "1px 6px" }}>PRO</span> : null}
              </div>
              <button
                onClick={desktopSignOut}
                style={{ alignSelf: "center", border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, textDecoration: "underline", padding: "2px 6px" }}
              >
                Sign out
              </button>
            </>
          )}
        </div>

        {/* Hidden input for Import project on the launcher (the main-app input isn't mounted here) */}
        <input
          ref={importFileInputRef}
          type="file"
          accept={`.${PROJECT_FILE_EXT},.zip`}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importProjectArchive(f);
          }}
        />

        {/* Desktop sign-in modal */}
        {signInModalNode}

        {/* Import source chooser (signed-in users) */}
        {importChooserOpen && (
          <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
            <div style={{ width: 360, maxWidth: "90vw", background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Import a project</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 14 }}>Bring in a project from your web account or from a file.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  onClick={() => { setImportChooserOpen(false); pullProjectFromWeb(); }}
                  style={{ textAlign: "left", borderRadius: 8, border: "1px solid var(--border-3)", background: "var(--bg-surface)", color: "var(--text)", padding: "11px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                >
                  From your web account
                </button>
                <button
                  onClick={() => { setImportChooserOpen(false); importFileInputRef.current?.click(); }}
                  style={{ textAlign: "left", borderRadius: 8, border: "1px solid var(--border-3)", background: "var(--bg-surface)", color: "var(--text)", padding: "11px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                >
                  From a file (.{PROJECT_FILE_EXT})
                </button>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button onClick={() => setImportChooserOpen(false)} style={{ borderRadius: 8, border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-2)", padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Web project picker (pull) */}
        {webPickerOpen && (
          <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
            <div style={{ width: 400, maxWidth: "90vw", maxHeight: "70vh", overflowY: "auto", background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Import from your web account</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>Pick a project to copy into a new local vault (you'll choose a folder next).</div>
              {webPickerProjects.length === 0 && <div style={{ fontSize: 13, opacity: 0.6, padding: "8px 0" }}>No projects found on this account.</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {webPickerProjects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => doPullProject(p.id)}
                    style={{ textAlign: "left", borderRadius: 8, border: "1px solid var(--border-3)", background: "var(--bg-surface)", color: "var(--text)", padding: "10px 12px", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                  >
                    {p.name || "Untitled"}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button onClick={() => setWebPickerOpen(false)} style={{ borderRadius: 8, border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-2)", padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* All projects (full list) */}
        {allProjectsModalOpen && (
          <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
            <div style={{ width: 460, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12 }}>All projects</div>
              <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>On this device</div>
                  {recentVaults.length === 0 && <div style={{ fontSize: 12, opacity: 0.6 }}>None.</div>}
                  {recentVaults.map((v) => (
                    <button
                      key={v.path}
                      type="button"
                      onClick={() => { setAllProjectsModalOpen(false); openVaultAndLoad(v.path); }}
                      title={v.path}
                      style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", borderRadius: 8, border: "1px solid var(--border-3)", background: "var(--bg-surface)", color: "var(--text)", padding: "9px 12px", fontSize: 13, cursor: "pointer" }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{v.name}</span>
                      <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, opacity: 0.85, color: vaultSyncStatus[v.path] ? "var(--accent-text)" : "var(--text-dim)" }}>
                        {vaultSyncStatus[v.path] ? (syncSession ? "☁ Synced" : "☁ Linked") : "Local"}
                      </span>
                    </button>
                  ))}
                </div>

                {syncSession && launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Available from your web account</div>
                    {launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setAllProjectsModalOpen(false); doPullProject(p.id); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", borderRadius: 8, border: "1px solid var(--border-3)", background: "var(--bg-surface)", color: "var(--text)", padding: "9px 12px", fontSize: 13, cursor: "pointer" }}
                      >
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{p.name || "Untitled"}</span>
                        <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: "var(--accent-text)" }}>☁ Web</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                <button onClick={() => setAllProjectsModalOpen(false)} style={{ borderRadius: 8, border: "1px solid var(--border-3)", background: "transparent", color: "var(--text-2)", padding: "8px 12px", fontSize: 13, cursor: "pointer" }}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (loadingInit || !project) {
    // On error, show the message; otherwise the themed splash (matches index.html + AuthGate).
    if (initError) {
      return (
        <div
          style={{
            height: "100vh",
            display: "grid",
            placeItems: "center",
            backgroundColor: "var(--bg)",
            color: "var(--text)",
            fontFamily: "system-ui",
            padding: 16,
            textAlign: "center",
          }}
        >
          {initError}
        </div>
      );
    }
    return (
      <div className="app-splash">
        <img className="app-splash-logo" src="/rpgst_logo.png" alt="" />
        <div className="app-splash-name">RPG Story Toolkit</div>
        <div className="app-splash-bar" />
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", width: "100vw", fontFamily: "system-ui", backgroundColor: "var(--bg)", color: "var(--text)" }}>
      {/* Offline indicator (fixed; doesn't affect layout) */}
      {isOffline && (
        <div
          title={isDesktop ? "Local editing works; syncing is paused until you reconnect." : "Changes can't be saved until you reconnect."}
          style={{
            position: "fixed",
            bottom: 14,
            left: 14,
            zIndex: 300,
            background: "var(--danger-bg, #5a1f1f)",
            color: "var(--danger-text, #ffd7d7)",
            border: "1px solid var(--danger-border-2, #7a2a2a)",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            padding: "6px 12px",
            boxShadow: "0 6px 18px var(--overlay-3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: "currentColor", opacity: 0.8 }} />
          Offline
        </div>
      )}

      {/* Desktop sign-in modal (also reachable in-app via the profile menu / sync chip) */}
      {signInModalNode}

      {/* Top bar */}
      <div
        style={{
          height: 44,
          borderBottom: "1px solid var(--border-2)",
          backgroundColor: "var(--bg-panel)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Profile button */}
          <div ref={profileMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => {
                if (!profileMenuOpen) markSupportSeen();
                setProfileMenuOpen((v) => !v);
              }}
              style={{
                borderRadius: 999,
                border: "1px solid var(--border-2)",
                backgroundColor: "var(--bg-elevated)",
                color: "var(--text)",
                cursor: "pointer",
                width: 34,
                height: 34,
                padding: 0,
                overflow: "hidden",
                display: "grid",
                placeItems: "center",
              }}
              title="Profile"
            >
              {isDesktop ? (
                syncSession ? (
                  // Signed in to a web account on desktop — show its initial.
                  <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.9 }}>
                    {(syncSession.user?.email ?? "U").trim().charAt(0).toUpperCase()}
                  </span>
                ) : (
                  <img src="/rpgst_logo.png" alt="RPG Story Toolkit" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                )
              ) : isGuest ? (
                // Guests have no account yet — show a neutral silhouette.
                <span style={{ fontSize: 16, opacity: 0.7 }}>👤</span>
              ) : avatarUrl ? (
                <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.9 }}>{avatarLabel}</span>
              )}
            </button>

            {/* Notification badge for free web users (clears once they open the menu) */}
            {!isDesktop && !profile?.is_pro && !supportSeen && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 999,
                  background: "#e5484d",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 800,
                  display: "grid",
                  placeItems: "center",
                  border: "1.5px solid var(--bg)",
                  pointerEvents: "none",
                }}
              >
                1
              </span>
            )}

            {profileMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 40,
                  width: !isDesktop && !profile?.is_pro ? 360 : 280,
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 10,
                  padding: 10,
                  zIndex: 50,
                  boxShadow: "0 10px 25px var(--overlay-3)",
                }}
              >
                {!isDesktop && !profile?.is_pro && (
                  <BreakEvenBar costs={MONTHLY_COSTS} earnings={MONTHLY_EARNINGS} />
                )}

                {isDesktop && (
                  <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
                    {syncSession ? (
                      <>
                        <div style={{ fontWeight: 700 }}>{syncSession.user?.email ?? "Signed in"}</div>
                        <div style={{ opacity: 0.7 }}>{syncIsPro ? "Pro account" : "Free account"}</div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontWeight: 700 }}>Not signed in</div>
                        <div style={{ opacity: 0.7 }}>Local only — sign in to sync.</div>
                      </>
                    )}
                  </div>
                )}

                {!isDesktop && !isGuest && (
                  <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700 }}>{profile?.username ?? emailToDefaultUsername(userEmail)}</div>
                    <div style={{ opacity: 0.7 }}>{userEmail ?? "(no email)"}</div>
                  </div>
                )}

                {!isDesktop && isGuest && (
                  <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
                    <div style={{ fontWeight: 700 }}>Guest</div>
                    <div style={{ opacity: 0.7 }}>No account — work is saved on this device.</div>
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {isDesktop && !syncSession && (
                    <button
                      type="button"
                      onClick={() => { setProfileMenuOpen(false); setSignInModalOpen(true); }}
                      style={{ borderRadius: 8, border: "1px solid var(--accent)", backgroundColor: "var(--accent-bg-2)", color: "var(--accent-text)", cursor: "pointer", padding: "8px 10px", fontSize: 13, fontWeight: 700, textAlign: "left" }}
                    >
                      Sign in to sync
                    </button>
                  )}

                  {isDesktop && syncSession && (
                    <a
                      href="https://app.rpgstorytoolkit.com"
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setProfileMenuOpen(false)}
                      style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13, textAlign: "left", textDecoration: "none", display: "block" }}
                    >
                      Account settings (web) ↗
                    </a>
                  )}

                  {!isDesktop && isGuest && (
                    <button
                      type="button"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        onRequestSignup?.();
                      }}
                      style={{
                        borderRadius: 8,
                        border: "1px solid var(--accent)",
                        backgroundColor: "var(--accent-bg-2)",
                        color: "var(--accent-text)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        fontWeight: 700,
                        textAlign: "left",
                      }}
                    >
                      Create account
                    </button>
                  )}

                  {!isDesktop && !isGuest && (
                  <button
                    type="button"
                    onClick={openProfileModal}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    Profile settings
                  </button>
                  )}

                  {!isDesktop && !isGuest && !profile?.is_pro && (
                    <button
                      type="button"
                      onClick={goPro}
                      disabled={isUpgrading}
                      style={{
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "var(--bg-surface)",
                        color: "var(--text)",
                        cursor: isUpgrading ? "not-allowed" : "pointer",
                        opacity: isUpgrading ? 0.6 : 1,
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                      }}
                    >
                      {isUpgrading ? "Opening checkout…" : "Upgrade to Pro"}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => { platform.openExternal("https://forms.gle/P2NBsNxSXrJ8pMHG8"); }}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                      textAlign: "left",
                      textDecoration: "none",
                      display: "block",
                      width: "100%",
                    }}
                  >
                    Contact Support
                  </button>

                  {isDesktop && syncSession && (
                    <button
                      type="button"
                      onClick={async () => {
                        setProfileMenuOpen(false);
                        await desktopSignOut();
                      }}
                      style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13, textAlign: "left" }}
                    >
                      Log out
                    </button>
                  )}

                  {!isDesktop && !isGuest && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await appModal.confirm({
                        title: "Log out?",
                        message: "You'll be returned to the sign-in screen.",
                        confirmText: "Log out",
                        cancelText: "Cancel",
                      });
                      if (ok) logout();
                    }}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                      textAlign: "left",
                    }}
                  >
                    Log out
                  </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Hidden input for Import project (always mounted so the File-menu item can trigger it) */}
          <input
            ref={importFileInputRef}
            type="file"
            accept={`.${PROJECT_FILE_EXT},.zip`}
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // allow re-picking the same file
              if (f) importProjectArchive(f);
            }}
          />

          {/* File menu */}
          <div ref={fileMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setFileMenuOpen((v) => !v)}
              style={{
                borderRadius: 6,
                border: "1px solid var(--border-3)",
                backgroundColor: fileMenuOpen ? "var(--bg-elevated)" : "transparent",
                color: "var(--text-2)",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 10px",
              }}
            >
              File ▾
            </button>

            {fileMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 40,
                  width: 260,
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 10,
                  padding: 10,
                  zIndex: 60,
                  boxShadow: "0 10px 25px var(--overlay-3)",
                }}
              >
                {/* Save — autosave runs in the background; this is a manual flush (Cmd+S also works) */}
                {(
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (autoSaveTimerRef.current != null) {
                          window.clearTimeout(autoSaveTimerRef.current);
                          autoSaveTimerRef.current = null;
                        }
                        pendingAutoSaveRef.current = false;
                        saveProjectToSupabase();
                        setFileMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "transparent",
                        color: "var(--text-2)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        marginBottom: 8,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span>{saving ? "Saving…" : "Save now"}</span>
                      <span style={{ opacity: 0.5 }}>⌘S</span>
                    </button>
                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "0 0 10px 0" }} />
                  </>
                )}

                {/* Wiki publish / settings — web only */}
                {!isDesktop && (project.view?.wiki?.published ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        openWikiModal();
                        setFileMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "transparent",
                        color: "var(--text-2)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        marginBottom: 6,
                      }}
                    >
                      Wiki settings…
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await appModal.confirm({
                          title: "Unpublish wiki?",
                          message: "Your wiki will no longer be publicly accessible. You can re-publish it at any time.",
                          confirmText: "Unpublish",
                          cancelText: "Cancel",
                          danger: true,
                        });
                        if (!ok) return;
                        await unpublishWiki();
                        setFileMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--danger-border-2)",
                        backgroundColor: "transparent",
                        color: "var(--danger-text)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        marginBottom: 10,
                      }}
                    >
                      Unpublish wiki
                    </button>

                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "0 0 10px 0" }} />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        openWikiModal();
                        setFileMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "transparent",
                        color: "var(--text-2)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        marginBottom: 10,
                      }}
                    >
                      Publish as a wiki…
                    </button>

                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "0 0 10px 0" }} />
                  </>
                ))}

                {!isDesktop && (
                  <button
                    type="button"
                    onClick={() => {
                      setFileMenuOpen(false);
                      createNewWebProject();
                    }}
                    style={{
                      width: "100%",
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                      textAlign: "left",
                      marginBottom: 8,
                    }}
                  >
                    New project{!profile?.is_pro ? "  ·  Pro" : ""}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    const ds = getDatasets(project);
                    const target = ds.find((d) => d.id === activeDatasetId) ?? ds[0];
                    setShowDialogueTree(true);
                    if (target) openDataset(target.id);
                    setFileMenuOpen(false);
                  }}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-2)",
                    cursor: "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                    textAlign: "left",
                    marginBottom: 8,
                  }}
                >
                  Conditions…
                </button>

                {/* Portable project transfer (web <-> desktop) */}
                <button
                  type="button"
                  disabled={transferBusy}
                  onClick={exportProjectArchive}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-2)",
                    cursor: transferBusy ? "default" : "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                    textAlign: "left",
                    marginBottom: 6,
                  }}
                >
                  {transferBusy ? "Working…" : `Export project (.${PROJECT_FILE_EXT})`}
                </button>
                <button
                  type="button"
                  disabled={transferBusy}
                  onClick={triggerImportProject}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-2)",
                    cursor: transferBusy ? "default" : "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                    textAlign: "left",
                    marginBottom: 8,
                  }}
                >
                  Import project…
                </button>

                {/* Export submenu */}
                <div
                  style={{ position: "relative" }}
                  onMouseLeave={() => setExportMenuOpen(false)}
                >
                  <button
                    type="button"
                    onMouseEnter={() => setExportMenuOpen(true)}
                    onClick={() => setExportMenuOpen((v) => !v)}
                    style={{
                      width: "100%",
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                      textAlign: "left",
                      marginBottom: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <span>Export</span>
                    <span style={{ opacity: 0.9 }}>▸</span>
                  </button>

                  {exportMenuOpen && (
                    <div
                      style={{
                        position: "absolute",
                        left: "100%",
                        top: 0,
                        width: 260,
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-2)",
                        borderRadius: 10,
                        padding: 10,
                        zIndex: 70,
                        boxShadow: "0 10px 25px var(--overlay-3)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                      onMouseEnter={() => setExportMenuOpen(true)}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setExportDatasetIds(getDatasets(project).map((d) => d.id));
                          setExportDialogueModalOpen(true);
                          setExportMenuOpen(false);
                          setFileMenuOpen(false);
                        }}

                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                        }}
                      >
                        Export condition JSON
                      </button>

                      <div style={{ height: 1, backgroundColor: "var(--border)", margin: "6px 0" }} />

                      <button
                        type="button"
                        onClick={() => {
                          setExportCollectionsFormat("csv");
                          setExportCollectionsSelection(project?.collections.map((c) => c.id) ?? []);
                          setExportCollectionsModalOpen(true);
                          setExportMenuOpen(false);
                          setFileMenuOpen(false);
                        }}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                        }}
                      >
                        Export tables…
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setExportDocumentsFormat("txt");
                          setExportDocumentsSelection(project?.documents.map((d) => d.id) ?? []);
                          setExportDocumentsModalOpen(true);
                          setExportMenuOpen(false);
                          setFileMenuOpen(false);
                        }}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                        }}
                      >
                        Export documents…
                      </button>

                      <div style={{ height: 1, backgroundColor: "var(--border)", margin: "6px 0" }} />

                      <button
                        type="button"
                        onClick={() => {
                          setExportAssetsSelection(project?.collections.map((c) => c.id) ?? []);
                          setExportAssetsModalOpen(true);
                          setExportMenuOpen(false);
                          setFileMenuOpen(false);
                        }}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                        }}
                      >
                        Export assets (ZIP)
                      </button>
                    </div>
                  )}
                </div>

                {isDesktop && (
                  <>
                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "10px 0" }} />
                    {syncMeta ? (
                      <>
                      <button
                        type="button"
                        onClick={syncNow}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid " + ((webHasNewer || localUnpushed) ? "#e8a33d" : "var(--accent)"),
                          backgroundColor: (webHasNewer || localUnpushed) ? "rgba(232,163,61,0.18)" : "var(--accent-bg-2)",
                          color: (webHasNewer || localUnpushed) ? "#e8a33d" : "var(--accent-text)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                          fontWeight: 700,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <span>Sync now</span>
                        <span style={{ opacity: 0.85, fontWeight: 600 }}>
                          {webHasNewer && localUnpushed
                            ? "both changed"
                            : webHasNewer
                              ? "newer on web"
                              : localUnpushed
                                ? "not synced"
                                : syncMeta.lastSyncedAt
                                  ? `synced ${new Date(syncMeta.lastSyncedAt).toLocaleDateString()}`
                                  : "linked"}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          if (!syncIsPro) { requireSyncPro(); return; }
                          setAutoSyncOnSave((v) => {
                            const nv = !v;
                            try { localStorage.setItem("evenstory_autosync", nv ? "1" : "0"); } catch { /* ignore */ }
                            return nv;
                          });
                        }}
                        title="Automatically push to your web account a few seconds after each save (Pro). Skipped when the web copy is newer, to avoid overwriting it."
                        style={{
                          width: "100%",
                          marginTop: 6,
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <span>Auto-sync on save</span>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: 11,
                            fontWeight: 700,
                            borderRadius: 999,
                            padding: "1px 8px",
                            border: "1px solid " + (autoSyncOnSave ? "var(--accent)" : "var(--border-3)"),
                            background: autoSyncOnSave ? "var(--accent-bg-2)" : "transparent",
                            color: autoSyncOnSave ? "var(--accent-text)" : "var(--text-dim)",
                          }}
                        >
                          {autoSyncOnSave ? "On" : "Off"}
                        </span>
                      </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => syncExistingToWeb()}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "8px 10px",
                          fontSize: 13,
                          textAlign: "left",
                        }}
                      >
                        Sync to web…
                      </button>
                    )}
                  </>
                )}

                {isDesktop && (
                  <>
                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "10px 0" }} />
                    <div style={{ fontSize: 11, color: "var(--text-3)", padding: "0 10px 4px", opacity: 0.6 }}>
                      Project Folder
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-2)", padding: "0 10px 6px", opacity: 0.7, wordBreak: "break-all" }}>
                      {getVaultPath() ?? "Not set"}
                    </div>
                    <button
                      type="button"
                      disabled={vaultPickerBusy}
                      onClick={pickAndSwitchVault}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "transparent",
                        color: "var(--text-2)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        marginBottom: 6,
                      }}
                    >
                      {vaultPickerBusy ? "Opening…" : "Create new project…"}
                    </button>
                    <button
                      type="button"
                      disabled={vaultPickerBusy}
                      onClick={returnToLauncher}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-3)",
                        backgroundColor: "transparent",
                        color: "var(--text-2)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                      }}
                    >
                      Switch project…
                    </button>
                  </>
                )}

                {!isGuest && (
                  <>
                    <div style={{ height: 1, backgroundColor: "var(--border)", margin: "8px 0" }} />

                    <button
                      type="button"
                      onClick={() => {
                        setFileMenuOpen(false);
                        setDeleteProjectConfirmText("");
                        setDeleteProjectModalOpen(true);
                      }}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--danger-border-2)",
                        backgroundColor: "transparent",
                        color: "var(--danger-text)",
                        cursor: "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                        textAlign: "left",
                      }}
                    >
                      Delete project…
                    </button>
                  </>
                )}

              </div>
            )}
          </div>

          {/* View menu */}
          <div ref={viewMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setViewMenuOpen((v) => !v)}
              style={{
                borderRadius: 6,
                border: "1px solid var(--border-3)",
                backgroundColor: viewMenuOpen ? "var(--bg-elevated)" : "transparent",
                color: "var(--text-2)",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 10px",
              }}
              title="View"
            >
              View ▾
            </button>

            {viewMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 40,
                  width: 260,
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 10,
                  padding: 10,
                  zIndex: 60,
                  boxShadow: "0 10px 25px var(--overlay-3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {/* Layout */}
                <button
                  type="button"
                  onClick={() => { setLayoutModalOpen(true); setViewMenuOpen(false); }}
                  style={viewMenuItemStyle}
                >
                  <span>Change layout…</span>
                  <span style={{ opacity: 0.6 }}>{layoutMode === "dual" ? "Dual" : "Focus"}</span>
                </button>

                <button
                  type="button"
                  onClick={() => { setShowAssetsTree((v) => !v); setViewMenuOpen(false); }}
                  style={viewMenuItemStyle}
                >
                  {showAssetsTree ? "Hide assets in sidebar" : "Show assets in sidebar"}
                </button>

                <button
                  type="button"
                  onClick={() => { setShowDialogueTree((v) => !v); setViewMenuOpen(false); }}
                  style={viewMenuItemStyle}
                >
                  {showDialogueTree ? "Hide conditions in sidebar" : "Show conditions in sidebar"}
                </button>

                {/* Theme */}
                <button
                  type="button"
                  onClick={() => cycleTheme()}
                  style={viewMenuItemStyle}
                >
                  <span>Theme</span>
                  <span style={{ opacity: 0.7 }}>{themeIcon} {themeLabel}</span>
                </button>

              </div>
            )}
          </div>

          {/* Tools menu */}
          <div ref={toolsMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setToolsMenuOpen((v) => !v)}
              style={{
                borderRadius: 6,
                border: "1px solid var(--border-3)",
                backgroundColor: toolsMenuOpen ? "var(--bg-elevated)" : "transparent",
                color: "var(--text-2)",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 10px",
              }}
              title="Tools"
            >
              Tools ▾
            </button>

            {toolsMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 40,
                  width: 200,
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 10,
                  padding: 10,
                  zIndex: 60,
                  boxShadow: "0 10px 25px var(--overlay-3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <button
                  type="button"
                  onClick={() => { isDesktop ? openTimelineWindow() : setTimelineVisible(true); setToolsMenuOpen(false); }}
                  style={viewMenuItemStyle}
                >
                  Open Timeline
                </button>
                <button
                  type="button"
                  onClick={() => { isDesktop ? openWorldMapWindow() : setWorldMapOpen(true); setToolsMenuOpen(false); }}
                  style={viewMenuItemStyle}
                >
                  Open World Map
                </button>
              </div>
            )}
          </div>

          {/* Wiki button (only when published) — wiki is web-only, never shown on desktop */}
          {!isDesktop && project.view?.wiki?.published && project.view?.wiki?.slug && (
            <button
              type="button"
              onClick={() => {
                const url = `${window.location.origin}/${project.view!.wiki!.slug}`;
                window.open(url, "_blank", "noopener,noreferrer");
              }}
              style={{
                borderRadius: 6,
                border: "1px solid var(--border-3)",
                backgroundColor: "transparent",
                color: "var(--text-2)",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 10px",
              }}
              title="Open public wiki in a new tab"
            >
              Wiki ↗
            </button>
          )}
          {/* ✅ 5: editable project name */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {!editingProjectName ? (
              <button
                type="button"
                onClick={() => {
                  setProjectNameDraft(project.name);
                  setEditingProjectName(true);
                }}
                style={{
                  border: "1px solid transparent",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--text)",
                  fontWeight: 700,
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: 14,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.border = "1px solid var(--border-3)")}
                onMouseLeave={(e) => (e.currentTarget.style.border = "1px solid transparent")}
                title="Rename project"
              >
                {project.name}
                <span style={{ opacity: 0.5, fontSize: 12 }}>✎</span>
              </button>
            ) : (
              <input
                ref={projectNameInputRef}
                value={projectNameDraft}
                onChange={(e) => setProjectNameDraft(e.target.value)}
                onBlur={async () => {
                  setEditingProjectName(false);
                  await commitProjectName(projectNameDraft);
                }}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setEditingProjectName(false);
                    await commitProjectName(projectNameDraft);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingProjectName(false);
                    setProjectNameDraft(project.name);
                  }
                }}
                style={{
                  borderRadius: 6,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "var(--bg-surface)",
                  color: "var(--text)",
                  padding: "6px 8px",
                  fontSize: 13,
                  width: 240,
                }}
              />
            )}

            {/* Sync status chip (desktop) */}
            {isDesktop && (() => {
              const attention = localUnpushed || (!!syncSession && webHasNewer);
              const label = !syncMeta
                ? "Local only"
                : !syncSession
                  ? (localUnpushed ? "↑ Linked · changes" : "☁ Linked")
                  : webHasNewer && localUnpushed
                    ? "⚠ Both changed"
                    : webHasNewer
                      ? "⬇ Newer on web"
                      : localUnpushed
                        ? "↑ Changes not synced"
                        : "☁ Synced";
              const title = !syncMeta
                ? "Local only — click to sync this project to your web account"
                : !syncSession
                  ? (localUnpushed
                    ? "Linked, with local changes not yet synced — sign in to sync"
                    : "Linked to a web account — sign in to sync")
                  : webHasNewer && localUnpushed
                    ? "Both this device and the web have changes — click to choose how to sync"
                    : webHasNewer
                      ? "A newer version is on the web — click to sync"
                      : localUnpushed
                        ? "You have changes that aren't on the web yet — click to push them"
                        : "Up to date with your web account";
              return (
                <button
                  type="button"
                  onClick={() => (syncMeta ? syncNow() : syncExistingToWeb())}
                  title={title}
                  style={{
                    border: "1px solid " + (attention ? "#e8a33d" : syncMeta ? "var(--accent)" : "var(--border-3)"),
                    borderRadius: 999,
                    background: attention ? "rgba(232,163,61,0.18)" : syncMeta ? "var(--accent-bg-2)" : "transparent",
                    color: attention ? "#e8a33d" : syncMeta ? "var(--accent-text)" : "var(--text-2)",
                    cursor: "pointer",
                    padding: "3px 10px",
                    fontSize: 11,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </button>
              );
            })()}

            {/* Project switcher — web lists web projects, desktop lists local projects */}
            <div ref={projectSwitcherRef} style={{ position: "relative" }}>
              <button
                type="button"
                title="Switch project"
                onClick={() => {
                  if (!projectSwitcherOpen) {
                    if (isDesktop) refreshVaultSyncStatus();
                    else if (userId) platform.listProjects(userId).then(setWebProjects).catch(() => {});
                  }
                  setProjectSwitcherOpen((v) => !v);
                }}
                style={{
                  border: "1px solid var(--border-3)",
                  borderRadius: 6,
                  background: projectSwitcherOpen ? "var(--bg-elevated)" : "transparent",
                  color: "var(--text-2)",
                  cursor: "pointer",
                  padding: "5px 8px",
                  fontSize: 12,
                }}
              >
                ▾
              </button>
              {projectSwitcherOpen && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 34,
                    width: 280,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 10,
                    padding: 8,
                    zIndex: 60,
                    boxShadow: "0 10px 25px var(--overlay-3)",
                    maxHeight: 380,
                    overflowY: "auto",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", padding: "4px 8px" }}>
                    Your projects
                  </div>

                  {isDesktop ? (
                    <>
                      {recentVaults.length === 0 && (
                        <div style={{ fontSize: 12, opacity: 0.6, padding: "6px 8px" }}>No recent projects.</div>
                      )}
                      {recentVaults.map((v) => {
                        const active = v.path === projectRowId;
                        const synced = vaultSyncStatus[v.path];
                        return (
                          <button
                            key={v.path}
                            type="button"
                            onClick={() => switchToVault(v.path)}
                            title={v.path}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              width: "100%",
                              textAlign: "left",
                              border: "none",
                              borderRadius: 6,
                              background: active ? "var(--bg-row-sel)" : "transparent",
                              color: active ? "var(--text)" : "var(--text-2)",
                              cursor: "pointer",
                              padding: "7px 8px",
                              fontSize: 13,
                              fontWeight: active ? 700 : 500,
                            }}
                          >
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                            <span
                              title={synced ? "Synced to web" : "Local only"}
                              style={{
                                flexShrink: 0,
                                fontSize: 9.5,
                                fontWeight: 700,
                                borderRadius: 999,
                                padding: "1px 7px",
                                border: "1px solid " + (synced ? "var(--accent)" : "var(--border-3)"),
                                background: synced ? "var(--accent-bg-2)" : "transparent",
                                color: synced ? "var(--accent-text)" : "var(--text-dim)",
                              }}
                            >
                              {synced ? "☁ Synced" : "Local"}
                            </span>
                          </button>
                        );
                      })}

                      {syncSession && launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).length > 0 && (
                        <>
                          <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
                          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", padding: "4px 8px" }}>
                            From your web account
                          </div>
                          {launcherWebProjects.filter((p) => !linkedWebIds.has(p.id)).map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => { setProjectSwitcherOpen(false); doPullProject(p.id); }}
                              title="Import this project to a new folder on this device"
                              style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 8px", fontSize: 13 }}
                            >
                              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || "Untitled"}</span>
                              <span
                                title="On your web account — click to import"
                                style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: "1px 7px", border: "1px solid var(--accent)", background: "var(--accent-bg-2)", color: "var(--accent-text)" }}
                              >
                                ☁ Web
                              </span>
                            </button>
                          ))}
                        </>
                      )}

                      <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
                      <button
                        type="button"
                        onClick={() => { setProjectSwitcherOpen(false); handleCreateNewProject(); }}
                        style={{ width: "100%", textAlign: "left", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 8px", fontSize: 13 }}
                      >
                        ＋ Create new project
                      </button>
                      <button
                        type="button"
                        onClick={async () => { setProjectSwitcherOpen(false); if (isDirty) await saveProjectToSupabase(); openVaultAndLoad(null); }}
                        style={{ width: "100%", textAlign: "left", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 8px", fontSize: 13 }}
                      >
                        Open project…
                      </button>
                    </>
                  ) : (
                    <>
                      {webProjects.length === 0 && (
                        <div style={{ fontSize: 12, opacity: 0.6, padding: "6px 8px" }}>No projects.</div>
                      )}
                      {webProjects.map((p) => {
                        const active = p.id === projectRowId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => switchToProject(p.id)}
                            style={{
                              width: "100%",
                              textAlign: "left",
                              border: "none",
                              borderRadius: 6,
                              background: active ? "var(--bg-row-sel)" : "transparent",
                              color: active ? "var(--text)" : "var(--text-2)",
                              cursor: "pointer",
                              padding: "7px 8px",
                              fontSize: 13,
                              fontWeight: active ? 700 : 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {p.name || "Untitled"}
                          </button>
                        );
                      })}
                      <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
                      <button
                        type="button"
                        onClick={createNewWebProject}
                        style={{ width: "100%", textAlign: "left", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 8px", fontSize: 13 }}
                      >
                        ＋ New project{!profile?.is_pro ? "  ·  Pro" : ""}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

          </div>

          {saveMessage && <div style={{ fontSize: 12, opacity: 0.8 }}>{saveMessage}</div>}
        </div>
      </div>

      {/* Profile modal */}
      {profileModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
        >
          <div
            style={{
              width: 720,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Profile</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Avatar, username, email, password, subscription, logout, delete account.
                </div>
              </div>

              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: "pointer",
                  padding: "6px 10px",
                  height: 34,
                }}
              >
                Close
              </button>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 999,
                  border: "1px solid var(--border-2)",
                  backgroundColor: "var(--bg-surface)",
                  overflow: "hidden",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontSize: 22, fontWeight: 800 }}>{avatarLabel}</span>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <label
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "var(--bg-surface)",
                    color: "var(--text)",
                    cursor: "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                  }}
                >
                  Upload picture
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    disabled={profileBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadAvatar(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>

                {profile?.avatar_path && (
                  <button
                    type="button"
                    disabled={profileBusy}
                    onClick={removeAvatar}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: profileBusy ? "default" : "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                    }}
                  >
                    Remove picture
                  </button>
                )}
              </div>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Username</div>
                <input
                  value={editUsername}
                  onChange={(e) => setEditUsername(e.target.value)}
                  disabled={profileBusy}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--border-2)",
                    backgroundColor: "var(--bg-surface)",
                    color: "var(--text)",
                    padding: "8px 10px",
                    fontSize: 14,
                  }}
                />
                <button
                  type="button"
                  onClick={updateUsername}
                  disabled={profileBusy || editUsername.trim() === savedUsername}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--accent)",
                    backgroundColor: "var(--accent-bg)",
                    color: "var(--text)",
                    cursor: profileBusy || editUsername.trim() === savedUsername ? "default" : "pointer",
                    opacity: profileBusy || editUsername.trim() === savedUsername ? 0.4 : 1,
                    padding: "8px 10px",
                    fontSize: 13,
                    width: "fit-content",
                  }}
                >
                  Save username
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Email</div>
                <input
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  disabled={profileBusy}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--border-2)",
                    backgroundColor: "var(--bg-surface)",
                    color: "var(--text)",
                    padding: "8px 10px",
                    fontSize: 14,
                  }}
                />
                <button
                  type="button"
                  onClick={updateEmail}
                  disabled={profileBusy || editEmail.trim() === savedEmail}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--accent)",
                    backgroundColor: "var(--accent-bg)",
                    color: "var(--text)",
                    cursor: profileBusy || editEmail.trim() === savedEmail ? "default" : "pointer",
                    opacity: profileBusy || editEmail.trim() === savedEmail ? 0.4 : 1,
                    padding: "8px 10px",
                    fontSize: 13,
                    width: "fit-content",
                  }}
                >
                  Update email
                </button>
                <div style={{ fontSize: 11, opacity: 0.7 }}>Email changes usually require inbox confirmation.</div>
              </div>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Password</div>
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.35 }}>
                For security, password changes happen via email. We’ll send you a reset link.
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={sendPasswordResetEmail}
                  disabled={profileBusy}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--border-3)",
                    backgroundColor: "transparent",
                    color: "var(--text-2)",
                    cursor: profileBusy ? "default" : "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                  }}
                >
                  Send password reset email
                </button>
              </div>
            </div>

            {/* Subscription section */}
            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Subscription</div>

              {!profile?.is_pro ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>You are on the Free plan. Upgrade to pro to unlock more features.</div>
                  <button
                    type="button"
                    onClick={goPro}
                    disabled={profileBusy || isUpgrading}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--accent)",
                      backgroundColor: "var(--accent-bg)",
                      color: "var(--text)",
                      cursor: profileBusy || isUpgrading ? "default" : "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                    }}
                  >
                    {isUpgrading ? "Opening checkout…" : "Upgrade to Pro"}
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {cancelScheduledAt
                      ? `Cancellation scheduled — cancels on ${new Date(cancelScheduledAt).toLocaleDateString()}. You keep Pro until then.`
                      : `Pro is active${profile.subscription_current_period_end
                        ? ` (current period ends ${new Date(profile.subscription_current_period_end).toLocaleDateString()})`
                        : ""
                      }.`}
                  </div>

                  {!cancelScheduledAt && (
                    <button
                      type="button"
                      onClick={openCancelSubscriptionModal}
                      disabled={profileBusy || isCancelling || !profile?.stripe_subscription_id}
                      style={{
                        alignSelf: "flex-start",
                        borderRadius: 8,
                        border: "1px solid var(--warn-border)",
                        backgroundColor: "var(--warn-bg)",
                        color: "var(--warn-text)",
                        cursor: profileBusy || isCancelling || !profile?.stripe_subscription_id ? "default" : "pointer",
                        padding: "8px 10px",
                        fontSize: 13,
                      }}
                    >
                      {isCancelling ? "Cancelling…" : "Cancel subscription"}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={async () => {
                  const ok = await appModal.confirm({
                    title: "Log out?",
                    message: "You'll be returned to the sign-in screen.",
                    confirmText: "Log out",
                    cancelText: "Cancel",
                  });
                  if (ok) logout();
                }}
                disabled={profileBusy}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: profileBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                  marginLeft: "auto",
                }}
              >
                Log out
              </button>

              <button
                type="button"
                onClick={openDeleteAccountModal}
                disabled={profileBusy}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--danger-border-2)",
                  backgroundColor: "var(--danger-bg-2)",
                  color: "var(--danger-text)",
                  cursor: profileBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                Delete account
              </button>
            </div>

            <div style={{ marginTop: 10 }}>
              {profileMsg && <div style={{ fontSize: 12, color: "var(--accent-text)" }}>{profileMsg}</div>}
              {profileErr && <div style={{ fontSize: 12, color: "var(--error-text)" }}>{profileErr}</div>}
            </div>
          </div>
        </div>
      )}

      {cancelSubModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 120,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCancelSubModalOpen(false);
          }}
        >
          <div
            style={{
              width: 520,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>Cancel subscription?</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12, lineHeight: 1.4 }}>
              Your subscription will be set to cancel at the end of your current billing period. You will keep Pro access until then.
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setCancelSubModalOpen(false)}
                disabled={profileBusy}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: profileBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                Never mind
              </button>

              <button
                type="button"
                onClick={cancelSubscriptionConfirmed}
                disabled={profileBusy || isCancelling}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--warn-border)",
                  backgroundColor: "var(--warn-bg)",
                  color: "var(--warn-text)",
                  cursor: profileBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                {isCancelling ? "Cancelling…" : "Confirm cancel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteAccountModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 121,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isDeletingAccount) setDeleteAccountModalOpen(false);
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8, color: "var(--danger-text)" }}>Delete account</div>

            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10, lineHeight: 1.4 }}>
              This permanently deletes your account and data. To confirm, type <b>delete</b> below.
            </div>

            <input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder='Type "delete" to confirm'
              disabled={profileBusy || isDeletingAccount}
              style={{
                width: "100%",
                borderRadius: 8,
                border: "1px solid var(--border-3)",
                backgroundColor: "var(--bg-deep)",
                color: "var(--text-3)",
                padding: "10px 10px",
                fontSize: 13,
                outline: "none",
                marginBottom: 12,
              }}
            />

            {isDeletingAccount && (
              <div style={{ fontSize: 12, color: "var(--warn-text)", marginBottom: 12, lineHeight: 1.4 }}>
                Deleting your account… this can take a moment. Please don’t close this tab.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => !isDeletingAccount && setDeleteAccountModalOpen(false)}
                disabled={profileBusy || isDeletingAccount}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: profileBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={deleteAccountConfirmed}
                disabled={profileBusy || isDeletingAccount || deleteConfirmText.trim().toLowerCase() !== "delete"}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--danger-border-2)",
                  backgroundColor: "var(--danger-bg-2)",
                  color: "var(--danger-text)",
                  cursor:
                    profileBusy || deleteConfirmText.trim().toLowerCase() !== "delete" ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                {isDeletingAccount ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteProjectModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 121,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !isDeletingProject) setDeleteProjectModalOpen(false);
          }}
        >
          <div
            style={{
              width: 520,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8, color: "var(--danger-text)" }}>
              Delete project
            </div>

            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10, lineHeight: 1.45 }}>
              {isDesktop ? (
                <>
                  This moves the entire project folder to the Trash, including all documents, tables, dialogue and assets.{" "}
                  {syncMeta ? (
                    <>The copy on your web account is <b>not</b> deleted{syncSession ? " — delete it from the web app if you want it gone there too" : " — sign in on the web app to delete it there"}. </>
                  ) : null}
                  To confirm, type <b>DELETE</b> below.
                </>
              ) : (
                <>This permanently deletes this project and all its data. To confirm, type <b>DELETE</b> below.</>
              )}
            </div>

            <input
              value={deleteProjectConfirmText}
              onChange={(e) => setDeleteProjectConfirmText(e.target.value)}
              placeholder='Type "DELETE" to confirm'
              disabled={isDeletingProject}
              autoFocus
              style={{
                width: "100%",
                boxSizing: "border-box",
                borderRadius: 8,
                border: "1px solid var(--border-3)",
                backgroundColor: "var(--bg-deep)",
                color: "var(--text-3)",
                padding: "10px 10px",
                fontSize: 13,
                outline: "none",
                marginBottom: 12,
              }}
            />

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => !isDeletingProject && setDeleteProjectModalOpen(false)}
                disabled={isDeletingProject}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: isDeletingProject ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={deleteProjectConfirmed}
                disabled={isDeletingProject || deleteProjectConfirmText.trim() !== "DELETE"}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--danger-border-2)",
                  backgroundColor: "var(--danger-bg-2)",
                  color: "var(--danger-text)",
                  cursor: isDeletingProject || deleteProjectConfirmText.trim() !== "DELETE" ? "default" : "pointer",
                  opacity: deleteProjectConfirmText.trim() !== "DELETE" ? 0.6 : 1,
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                {isDeletingProject ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {exportDialogueModalOpen && project && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExportDialogueModalOpen(false);
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Export condition JSON</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose which conditions to export as engine-readable JSON.</div>
              </div>
              <button
                type="button"
                onClick={() => setExportDialogueModalOpen(false)}
                style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "6px 10px", height: 34 }}
              >
                Close
              </button>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label style={{ fontSize: 12, opacity: 0.85 }}>Conditions</label>
                  <button
                    type="button"
                    onClick={() => {
                      const allIds = getDatasets(project).map((d) => d.id);
                      setExportDatasetIds(exportDatasetIds.length === allIds.length ? [] : allIds);
                    }}
                    style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}
                  >
                    {exportDatasetIds.length === getDatasets(project).length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: 8, padding: 8, background: "var(--bg-surface)" }}>
                  {getDatasets(project).map((ds) => {
                    const checked = exportDatasetIds.includes(ds.id);
                    return (
                      <label
                        key={ds.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "var(--accent-sel)" : "transparent" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setExportDatasetIds((prev) =>
                            prev.includes(ds.id) ? prev.filter((id) => id !== ds.id) : [...prev, ds.id]
                          )}
                          style={{ accentColor: "var(--accent)", width: 14, height: 14, flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 13, flex: 1 }}>{ds.name}</span>
                        <span style={{ fontSize: 11, opacity: 0.5 }}>{ds.entries.length} entr{ds.entries.length !== 1 ? "ies" : "y"}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setExportDialogueModalOpen(false)}
                  style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={exportDatasetIds.length === 0}
                  onClick={() => {
                    exportDatasetsJson(exportDatasetIds);
                    setExportDialogueModalOpen(false);
                  }}
                  style={{ borderRadius: 8, border: "1px solid var(--accent)", backgroundColor: exportDatasetIds.length === 0 ? "var(--bg-elevated)" : "var(--accent-bg)", color: exportDatasetIds.length === 0 ? "var(--text-dim)" : "var(--text)", cursor: exportDatasetIds.length === 0 ? "not-allowed" : "pointer", padding: "8px 14px", fontSize: 13, opacity: exportDatasetIds.length === 0 ? 0.6 : 1 }}
                >
                  Export {exportDatasetIds.length > 0 ? `(${exportDatasetIds.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportAssetsModalOpen && project && (
        <div
          style={{ position: "fixed", inset: 0, backgroundColor: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setExportAssetsModalOpen(false); }}
        >
          <div style={{ width: 560, maxWidth: "100%", backgroundColor: "var(--bg-panel)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 14, boxShadow: "0 12px 30px var(--overlay-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Export assets (ZIP)</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose which tables to export attached files from.</div>
              </div>
              <button type="button" onClick={() => setExportAssetsModalOpen(false)} style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "6px 10px", height: 34 }}>Close</button>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label style={{ fontSize: 12, opacity: 0.85 }}>Tables</label>
                  <button
                    type="button"
                    onClick={() => {
                      const allIds = project.collections.map((c) => c.id);
                      setExportAssetsSelection(exportAssetsSelection.length === allIds.length ? [] : allIds);
                    }}
                    style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}
                  >
                    {exportAssetsSelection.length === project.collections.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: 8, padding: 8, background: "var(--bg-surface)" }}>
                  {project.collections.map((c) => {
                    const checked = exportAssetsSelection.includes(c.id);
                    const assetCount = c.rows.reduce((n, r) => n + (r.assets?.length ?? 0), 0);
                    return (
                      <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "var(--accent-sel)" : "transparent" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setExportAssetsSelection((prev) => prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id])}
                          style={{ accentColor: "var(--accent)", width: 14, height: 14, flexShrink: 0 }}
                        />
                        <div style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 13, flex: 1 }}>{c.name}</span>
                        <span style={{ fontSize: 11, opacity: 0.5 }}>{assetCount} file{assetCount !== 1 ? "s" : ""}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                <button type="button" onClick={() => setExportAssetsModalOpen(false)} style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13 }}>Cancel</button>
                <button
                  type="button"
                  disabled={exportAssetsSelection.length === 0}
                  onClick={async () => {
                    await exportAssetsZip(exportAssetsSelection);
                    setExportAssetsModalOpen(false);
                  }}
                  style={{ borderRadius: 8, border: "1px solid var(--accent)", backgroundColor: exportAssetsSelection.length === 0 ? "var(--bg-elevated)" : "var(--accent-bg)", color: exportAssetsSelection.length === 0 ? "var(--text-dim)" : "var(--text)", cursor: exportAssetsSelection.length === 0 ? "not-allowed" : "pointer", padding: "8px 14px", fontSize: 13, opacity: exportAssetsSelection.length === 0 ? 0.6 : 1 }}
                >
                  Export {exportAssetsSelection.length > 0 && exportAssetsSelection.length < project.collections.length ? `(${exportAssetsSelection.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportCollectionsModalOpen && project && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExportCollectionsModalOpen(false);
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Export tables</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose which tables to export and in what format.</div>
              </div>
              <button
                type="button"
                onClick={() => setExportCollectionsModalOpen(false)}
                style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "6px 10px", height: 34 }}
              >
                Close
              </button>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Collections checklist */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label style={{ fontSize: 12, opacity: 0.85 }}>Tables</label>
                  <button
                    type="button"
                    onClick={() => {
                      const allIds = project.collections.map((c) => c.id);
                      setExportCollectionsSelection(
                        exportCollectionsSelection.length === allIds.length ? [] : allIds
                      );
                    }}
                    style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}
                  >
                    {exportCollectionsSelection.length === project.collections.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: 8, padding: 8, background: "var(--bg-surface)" }}>
                  {project.collections.map((c) => {
                    const checked = exportCollectionsSelection.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "var(--accent-sel)" : "transparent" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setExportCollectionsSelection((prev) =>
                            prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                          )}
                          style={{ accentColor: "var(--accent)", width: 14, height: 14, flexShrink: 0 }}
                        />
                        <div style={{ width: 8, height: 8, borderRadius: 999, background: c.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 13, flex: 1 }}>{c.name}</span>
                        <span style={{ fontSize: 11, opacity: 0.5 }}>{c.rows.length} rows</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Format picker */}
              <div>
                <label style={{ fontSize: 12, opacity: 0.85, display: "block", marginBottom: 6 }}>Format</label>
                <select
                  className="themed-select"
                  value={exportCollectionsFormat}
                  onChange={(e) => setExportCollectionsFormat(e.target.value as any)}
                  style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-surface)", color: "var(--text)", padding: "10px 10px", fontSize: 14 }}
                >
                  <option value="csv">CSV (ZIP)</option>
                  <option value="tsv">TSV (ZIP)</option>
                  <option value="md">Markdown (ZIP)</option>
                  <option value="json">JSON</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setExportCollectionsModalOpen(false)}
                  style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={exportCollectionsSelection.length === 0}
                  onClick={async () => {
                    await exportCollections(exportCollectionsFormat, exportCollectionsSelection);
                    setExportCollectionsModalOpen(false);
                  }}
                  style={{ borderRadius: 8, border: "1px solid var(--accent)", backgroundColor: exportCollectionsSelection.length === 0 ? "var(--bg-elevated)" : "var(--accent-bg)", color: exportCollectionsSelection.length === 0 ? "var(--text-dim)" : "var(--text)", cursor: exportCollectionsSelection.length === 0 ? "not-allowed" : "pointer", padding: "8px 14px", fontSize: 13, opacity: exportCollectionsSelection.length === 0 ? 0.6 : 1 }}
                >
                  Export {exportCollectionsSelection.length > 0 && exportCollectionsSelection.length < project.collections.length ? `(${exportCollectionsSelection.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {exportDocumentsModalOpen && project && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExportDocumentsModalOpen(false);
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "100%",
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 12px 30px var(--overlay-2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Export documents</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Choose which documents to export and in what format.</div>
              </div>
              <button
                type="button"
                onClick={() => setExportDocumentsModalOpen(false)}
                style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "6px 10px", height: 34 }}
              >
                Close
              </button>
            </div>

            <div style={{ height: 1, backgroundColor: "var(--border)", margin: "12px 0" }} />

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Documents checklist */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <label style={{ fontSize: 12, opacity: 0.85 }}>Documents</label>
                  <button
                    type="button"
                    onClick={() => {
                      const allIds = project.documents.map((d) => d.id);
                      setExportDocumentsSelection(
                        exportDocumentsSelection.length === allIds.length ? [] : allIds
                      );
                    }}
                    style={{ fontSize: 12, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}
                  >
                    {exportDocumentsSelection.length === project.documents.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: 8, padding: 8, background: "var(--bg-surface)" }}>
                  {project.documents.map((d) => {
                    const checked = exportDocumentsSelection.includes(d.id);
                    return (
                      <label
                        key={d.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 6, cursor: "pointer", background: checked ? "var(--accent-sel)" : "transparent" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setExportDocumentsSelection((prev) =>
                            prev.includes(d.id) ? prev.filter((id) => id !== d.id) : [...prev, d.id]
                          )}
                          style={{ accentColor: "var(--accent)", width: 14, height: 14, flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 13, flex: 1 }}>{d.title}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Format picker */}
              <div>
                <label style={{ fontSize: 12, opacity: 0.85, display: "block", marginBottom: 6 }}>Format</label>
                <select
                  className="themed-select"
                  value={exportDocumentsFormat}
                  onChange={(e) => setExportDocumentsFormat(e.target.value as any)}
                  style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-surface)", color: "var(--text)", padding: "10px 10px", fontSize: 14 }}
                >
                  <option value="txt">TXT (ZIP)</option>
                  <option value="md">Markdown (ZIP)</option>
                  <option value="doc">DOC (ZIP)</option>
                  <option value="json">JSON</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setExportDocumentsModalOpen(false)}
                  style={{ borderRadius: 8, border: "1px solid var(--border-3)", backgroundColor: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "8px 10px", fontSize: 13 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={exportDocumentsSelection.length === 0}
                  onClick={async () => {
                    await exportDocuments(exportDocumentsFormat, exportDocumentsSelection);
                    setExportDocumentsModalOpen(false);
                  }}
                  style={{ borderRadius: 8, border: "1px solid var(--accent)", backgroundColor: exportDocumentsSelection.length === 0 ? "var(--bg-elevated)" : "var(--accent-bg)", color: exportDocumentsSelection.length === 0 ? "var(--text-dim)" : "var(--text)", cursor: exportDocumentsSelection.length === 0 ? "not-allowed" : "pointer", padding: "8px 14px", fontSize: 13, opacity: exportDocumentsSelection.length === 0 ? 0.6 : 1 }}
                >
                  Export {exportDocumentsSelection.length > 0 && exportDocumentsSelection.length < project.documents.length ? `(${exportDocumentsSelection.length})` : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {wikiModalOpen && project && (
        <Modal
          title={project.view?.wiki?.published ? "Wiki settings" : "Publish as a wiki"}
          width={920}
          onClose={() => setWikiModalOpen(false)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>Public URL</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>app.rpgstorytoolkit.com/</div>
                  <input
                    value={wikiDraftSlug}
                    onChange={(e) => {
                      setWikiDraftSlug(e.target.value);
                      setWikiDraftSlugOverride(true);
                    }}
                    placeholder={slugFromProjectName(project.name)}
                    style={{
                      flex: 1,
                      minWidth: 220,
                      borderRadius: 8,
                      border: "1px solid var(--border-2)",
                      backgroundColor: "var(--bg-surface)",
                      color: "var(--text)",
                      padding: "8px 10px",
                      fontSize: 14,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setWikiDraftSlug(slugFromProjectName(project.name));
                      setWikiDraftSlugOverride(false);
                    }}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--border-3)",
                      backgroundColor: "transparent",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      padding: "8px 10px",
                      fontSize: 13,
                    }}
                    title="Use project name (auto-updating URL)"
                  >
                    Use project name
                  </button>
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  If the URL is already taken, “-1”, “-2”, etc. will be appended.
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  Auto-update on rename: <b>{wikiDraftSlugOverride ? "Off" : "On"}</b>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>Home page</div>
                <select className="themed-select"
                  value={wikiDraftHomeDocId}
                  onChange={(e) => setWikiDraftHomeDocId(e.target.value)}
                  style={{
                    width: "100%",
                    borderRadius: 8,
                    border: "1px solid var(--border-2)",
                    background: "var(--bg-surface)",
                    color: "var(--text)",
                    padding: "8px 10px",
                    fontSize: 14,
                  }}
                >
                  {(project.documents ?? [])
                    .filter((d) => wikiDraftDocIds.includes(d.id))
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title || d.id}
                      </option>
                    ))}
                </select>
                {wikiDraftDocIds.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--error-text)", marginTop: 6 }}>Select at least one page.</div>
                )}
              </div>
            </div>

            {/* ✅ SEO / Search settings + preview */}
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-surface)" }}>
              <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Search engine settings</div>

              <div style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 12, alignItems: "start" }}>
                {/* Left: fields */}
                <div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Title (search result)</div>
                      <input
                        value={wikiDraftSeoTitle}
                        onChange={(e) => setWikiDraftSeoTitle(e.target.value)}
                        placeholder={project.name}
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-2)",
                          backgroundColor: "var(--bg-surface)",
                          color: "var(--text)",
                          padding: "8px 10px",
                          fontSize: 14,
                        }}
                      />
                    </div>

                    <div>
                      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>OG image URL (optional)</div>
                      <input
                        value={wikiDraftSeoImageUrl}
                        onChange={(e) => setWikiDraftSeoImageUrl(e.target.value)}
                        placeholder="https://…"
                        style={{
                          width: "100%",
                          borderRadius: 8,
                          border: "1px solid var(--border-2)",
                          backgroundColor: "var(--bg-surface)",
                          color: "var(--text)",
                          padding: "8px 10px",
                          fontSize: 14,
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Description</div>
                    <textarea
                      value={wikiDraftSeoDescription}
                      onChange={(e) => setWikiDraftSeoDescription(e.target.value)}
                      placeholder="A short description shown in search results."
                      rows={3}
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        border: "1px solid var(--border-2)",
                        backgroundColor: "var(--bg-surface)",
                        color: "var(--text)",
                        padding: "8px 10px",
                        fontSize: 14,
                        resize: "vertical",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={wikiDraftAllowIndexing}
                      onChange={(e) => setWikiDraftAllowIndexing(e.target.checked)}
                    />
                    Allow search engines to index this wiki
                  </label>

                  {!wikiDraftAllowIndexing && (
                    <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: 6 }}>
                      Search engines will be asked not to index (noindex/nofollow).
                    </div>
                  )}
                </div>

                {/* Right: preview */}
                <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-deep)" }}>
                  <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800, marginBottom: 8 }}>
                    Search result preview
                  </div>

                  {(() => {
                    const slug = (wikiDraftSlug || slugFromProjectName(project.name)).trim() || "your-wiki";
                    const url = `app.rpgstorytoolkit.com/${slug}`;
                    const title = (wikiDraftSeoTitle || project.name || "Story Wiki").trim() || "Story Wiki";
                    const desc =
                      (wikiDraftSeoDescription || "Public wiki for this story project.").trim() ||
                      "Public wiki for this story project.";

                    return (
                      <div style={{ padding: 10, borderRadius: 10, border: "1px solid var(--bg-dark)", background: "var(--bg-deep)" }}>
                        <div style={{ fontSize: 15, color: "#8ab4f8", marginBottom: 4, lineHeight: 1.2 }}>
                          {title.length > 70 ? `${title.slice(0, 70)}…` : title}
                        </div>
                        <div style={{ fontSize: 12, color: "#9aa0a6", marginBottom: 6 }}>
                          {url}
                        </div>
                        <div style={{ fontSize: 12, color: "#bdc1c6", lineHeight: 1.35 }}>
                          {desc.length > 160 ? `${desc.slice(0, 160)}…` : desc}
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{ fontSize: 11, opacity: 0.65, marginTop: 8, lineHeight: 1.35 }}>
                    Preview is an approximation; Google may rewrite titles/descriptions.
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-surface)" }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Pages</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflow: "auto" }}>
                  {project.documents.map((d) => (
                    <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={wikiDraftDocIds.includes(d.id)}
                        onChange={() => {
                          setWikiDraftDocIds((prev) => {
                            const has = prev.includes(d.id);
                            const next = has ? prev.filter((x) => x !== d.id) : [...prev, d.id];

                            setWikiDraftHomeDocId((h) => {
                              if (!h) return next[0] ?? "";
                              if (h === d.id && has) return next[0] ?? "";
                              return h;
                            });

                            return next;
                          });
                        }}
                      />
                      <span style={{ opacity: 0.95 }}>{d.title || d.id}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-surface)" }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Tables</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflow: "auto" }}>
                  {project.collections.map((c) => (
                    <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={wikiDraftColIds.includes(c.id)}
                        onChange={() => {
                          setWikiDraftColIds((prev) => {
                            const has = prev.includes(c.id);
                            return has ? prev.filter((x) => x !== c.id) : [...prev, c.id];
                          });
                        }}
                      />
                      <span style={{ opacity: 0.95 }}>{c.name || c.id}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {project.view?.worldMapImagePath && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-surface)" }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>World Map</div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={project.view?.worldMapIncludeInWiki ?? false}
                    onChange={(e) => setWorldMapIncludeInWiki(e.target.checked)}
                  />
                  Include World Map in public wiki
                </label>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
              {project.view?.wiki?.published && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await appModal.confirm({
                      title: "Unpublish wiki?",
                      message: "Your wiki will no longer be publicly accessible. You can re-publish it at any time.",
                      confirmText: "Unpublish",
                      cancelText: "Cancel",
                      danger: true,
                    });
                    if (!ok) return;
                    await unpublishWiki();
                    setWikiModalOpen(false);
                  }}
                  disabled={wikiBusy}
                  style={{
                    borderRadius: 8,
                    border: "1px solid var(--danger-border-2)",
                    backgroundColor: "var(--danger-bg-2)",
                    color: "var(--danger-text)",
                    cursor: wikiBusy ? "default" : "pointer",
                    padding: "8px 10px",
                    fontSize: 13,
                    marginRight: "auto",
                  }}
                >
                  Unpublish
                </button>
              )}

              <button
                type="button"
                onClick={() => setWikiModalOpen(false)}
                disabled={wikiBusy}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--border-3)",
                  backgroundColor: "transparent",
                  color: "var(--text-2)",
                  cursor: wikiBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={publishOrUpdateWiki}
                disabled={wikiBusy}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--accent)",
                  backgroundColor: "var(--accent-bg)",
                  color: "var(--text)",
                  cursor: wikiBusy ? "default" : "pointer",
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              >
                {wikiBusy ? "Working…" : project.view?.wiki?.published ? "Save" : "Publish"}
              </button>
            </div>

            {(wikiInfo || wikiErr) && (
              <div style={{ fontSize: 12 }}>
                {wikiInfo && <div style={{ color: "var(--accent-text)" }}>{wikiInfo}</div>}
                {wikiErr && <div style={{ color: "var(--error-text)" }}>{wikiErr}</div>}
              </div>
            )}
          </div>
        </Modal>
      )}

      {layoutModalOpen && (
        <Modal title="Change layout" width={620} onClose={() => setLayoutModalOpen(false)}>
          <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 14 }}>
            Choose how the workspace is arranged. You can switch any time.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {([
              { mode: "focus" as const, title: "Focus", desc: "Sidebar + one editor at a time. Click a document or table to view it." },
              { mode: "dual" as const, title: "Dual", desc: "Sidebar with the story editor and table editor side by side." },
            ]).map((opt) => {
              const active = layoutMode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => { setLayoutMode(opt.mode); setPanelSizes([]); setLayoutModalOpen(false); }}
                  style={{
                    textAlign: "left",
                    border: active ? "2px solid var(--accent)" : "1px solid var(--border-2)",
                    background: active ? "var(--bg-row-sel)" : "var(--bg-surface)",
                    borderRadius: 12,
                    padding: 14,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {/* Mini diagram */}
                  <div style={{ display: "flex", gap: 4, height: 64, background: "var(--bg-deep)", borderRadius: 8, padding: 6 }}>
                    <div style={{ width: 22, borderRadius: 4, background: "var(--border-2)" }} />
                    {opt.mode === "focus" ? (
                      <div style={{ flex: 1, borderRadius: 4, background: "var(--accent-bg-2, var(--border))" }} />
                    ) : (
                      <>
                        <div style={{ flex: 1, borderRadius: 4, background: "var(--accent-bg-2, var(--border))" }} />
                        <div style={{ flex: 1, borderRadius: 4, background: "var(--border)" }} />
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 800, fontSize: 14 }}>{opt.title}</span>
                    {active && <span style={{ fontSize: 11, color: "var(--accent-text)", fontWeight: 700 }}>Current</span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.4 }}>{opt.desc}</div>
                </button>
              );
            })}
          </div>
        </Modal>
      )}

      {assetModalOpen && project && (
        <Modal onClose={() => setAssetModalOpen(false)}>
          {(() => {
            const col = project.collections.find((c) => c.id === assetModalCollectionId);
            const row = col?.rows.find((r) => r.id === assetModalRowId);
            if (!col || !row) return <div>Missing entity.</div>;

            const assets = row.assets ?? [];
            const profileId = row.profileAssetId;

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontWeight: 900, fontSize: 14 }}>
                  Assets — {col.name} / {getRowLabel(row) || row.id}
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="file"
                      multiple
                      accept="image/*,video/*,.gif"
                      onChange={async (e) => {
                        const count = e.target.files?.length ?? 0;
                        await addAssetsToEntity(col.id, row.id, e.target.files);
                        e.currentTarget.value = ""; // allow re-upload same file
                        if (count > 0) {
                          setAssetUploadMsg(`Uploaded ${count} file${count > 1 ? "s" : ""} ✓`);
                          window.setTimeout(() => setAssetUploadMsg(null), 2500);
                        }
                      }}
                    />
                  </label>

                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    {uploadingCount > 0
                      ? `Uploading ${uploadingCount} file${uploadingCount > 1 ? "s" : ""}…`
                      : (assetUploadMsg ?? "")}
                  </div>
                </div>

                {assets.length === 0 ? (
                  <div style={{ opacity: 0.75, fontSize: 13 }}>No assets uploaded for this record.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, border: "1px solid var(--border-2)", borderRadius: 10, padding: 6 }}>
                    {assets.map((a) => {
                      const isProfile = profileId === a.id;
                      return (
                        <div
                          key={a.id}
                          className="treeRow"
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 6 }}
                        >
                          <span style={{ flexShrink: 0, display: "flex" }}><AssetTypeBadge name={a.name} mime={a.mime} size={10} /></span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {a.name} {isProfile ? <span style={{ fontSize: 11, opacity: 0.7 }}>(icon)</span> : null}
                            </div>
                            <div style={{ fontSize: 11, opacity: 0.55 }}>{(a.size / 1024).toFixed(1)} KB</div>
                          </div>
                          <div className="kebabWrap" data-assetkebab style={{ flex: "0 0 auto" }}>
                            <button
                              type="button"
                              className="kebabBtn"
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = e.currentTarget.getBoundingClientRect();
                                setAssetCtxMenu((cur) => (cur?.assetId === a.id ? null : { kind: "asset", colId: col.id, rowId: row.id, assetId: a.id, x: r.right, y: r.bottom }));
                              }}
                              title="Actions"
                            >
                              ⋯
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>
            );
          })()}
        </Modal>
      )}

      {/* Main app */}
      <div
        style={{
          height: "calc(100vh - 44px)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* TOP: 3 panels row */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <PanelGroup
            ref={panelGroupRef}
            key={layoutMode}
            direction="horizontal"
            onLayout={(sizes) => setPanelSizes(sizes)}
          >
            {/* LEFT */}
            {showLeftPanel && (
              <>
                <Panel id="left-panel" order={1} defaultSize={panelSizes[0] ?? 20} minSize={16}>
                  <div
                    style={{
                      height: "100%",
                      borderRight: "1px solid var(--border-2)",
                      padding: "12px",
                      backgroundColor: "var(--bg-panel)",
                      boxSizing: "border-box",
                      overflowY: "auto",
                      overflowX: "hidden",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.85 }}>Documents</div>

                        <span
                          className="infoIcon"
                          tabIndex={0}
                          role="button"
                          aria-label="About documents"
                        >
                          i
                          <span className="infoTooltip" role="tooltip">
                            Write your world's story, lore, and dialogue, and link parts of it
                            to entities in your collections. Organize documents into folders.
                          </span>
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                        <button
                          type="button"
                          className="iconBtn"
                          onClick={() => addDocument()}
                          disabled={atFreeDocLimit}
                          title={
                            atFreeDocLimit
                              ? isGuest
                                ? `Create a free account to add more than ${FREE_DOC_LIMIT} documents`
                                : `Free plan is limited to ${FREE_DOC_LIMIT} documents — upgrade to Pro for more`
                              : "New document"
                          }
                          style={{ opacity: atFreeDocLimit ? 0.5 : 1, cursor: atFreeDocLimit ? "not-allowed" : "pointer" }}
                        >
                          <IconNewNote />
                        </button>
                        <button
                          type="button"
                          className="iconBtn"
                          onClick={() => addFolder("doc", [])}
                          title="New folder"
                        >
                          <IconNewFolder />
                        </button>
                      </div>
                    </div>

                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDocTreeDragStart} onDragEnd={handleDocTreeDragEnd} onDragCancel={() => setDragLabel(null)}>
                    <TreeRootDroppable id="doc-root">
                      {documentTreeRows.map((row) => {
                        if (row.kind === "folder") {
                          const pathKey = row.path.join("/");
                          return (
                            <TreeRow
                              key={"f:" + pathKey}
                              dragId={"docfolder:" + pathKey}
                              dropId={"docfolder:" + pathKey}
                              selected={treeSelection.has("docfolder:" + pathKey)}
                              onClick={(e) => {
                                if (handleTreeRowClick(e, "doc", "docfolder:" + pathKey)) return;
                                setCollapsedDocumentGroups((prev) => ({ ...prev, [pathKey]: !prev[pathKey] }));
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setTreeCtxMenu({ x: e.clientX, y: e.clientY, kind: "doc", targetType: "folder", path: row.path });
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                paddingLeft: 6 + row.depth * 14,
                                paddingRight: 6,
                                height: 26,
                                cursor: "pointer",
                                borderRadius: 6,
                                color: "var(--text-2)",
                                background: treeSelection.has("docfolder:" + pathKey) ? "var(--bg-row-sel)" : undefined,
                              }}
                            >
                              <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{row.collapsed ? "▸" : "▾"}</span>
                              <span style={{ display: "flex", opacity: 0.6, flexShrink: 0 }}><IconFolder /></span>
                              <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.name}</span>
                              <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                              <button
                                type="button"
                                title="New document in this folder"
                                onClick={(e) => { e.stopPropagation(); addDocument(row.path); }}
                                style={{ border: "none", background: "transparent", color: "var(--text-3)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}
                              >
                                +
                              </button>
                            </TreeRow>
                          );
                        }
                        const d = row.doc;
                        const selected = d.id === activeDocId && showMiddlePanel;
                        return (
                          <TreeRow
                            key={d.id}
                            dragId={"docitem:" + d.id}
                            selected={treeSelection.has("docitem:" + d.id)}
                            onClick={(e) => {
                              if (handleTreeRowClick(e, "doc", "docitem:" + d.id)) return;
                              setActiveDocId(d.id);
                              setFocusView("doc");
                            }}
                            onContextMenu={(e) => { e.preventDefault(); setTreeCtxMenu({ x: e.clientX, y: e.clientY, kind: "doc", targetType: "item", id: d.id }); }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              paddingLeft: 6 + row.depth * 14 + 16,
                              paddingRight: 6,
                              height: 26,
                              cursor: "pointer",
                              borderRadius: 6,
                              border: selected ? "1px solid var(--accent)" : "1px solid transparent",
                              background: treeSelection.has("docitem:" + d.id) || selected ? "var(--bg-row-sel)" : "transparent",
                            }}
                          >
                            <span style={{ display: "flex", opacity: 0.5, flexShrink: 0 }}><IconFile /></span>
                            <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{d.title}</span>
                            {wikiIsPublished && publicDocIdSet.has(d.id) && (
                              <span style={{ flexShrink: 0, borderRadius: 999, border: "1px solid var(--accent)", background: "var(--accent-bg-2)", color: "var(--accent-text)", padding: "1px 6px", fontSize: 9, fontWeight: 800 }} title="Public on the published wiki">Public</span>
                            )}
                            <div className="kebabWrap" data-docmenu={d.id}>
                              <button type="button" className="kebabBtn" onClick={(e) => { e.stopPropagation(); setOpenDocMenuId((cur) => (cur === d.id ? null : d.id)); }} title="Actions">⋯</button>
                              {openDocMenuId === d.id && (
                                <div className="kebabMenu">
                                  <button type="button" className="kebabMenuItem" onClick={(e) => { e.stopPropagation(); setOpenDocMenuId(null); renameDocument(d.id); }}>Rename</button>
                                  <button type="button" className="kebabMenuItem kebabMenuItemDanger" onClick={(e) => { e.stopPropagation(); setOpenDocMenuId(null); deleteDocument(d.id); }}>Delete</button>
                                </div>
                              )}
                            </div>
                          </TreeRow>
                        );
                      })}
                    </TreeRootDroppable>
                    <DragOverlay dropAnimation={null}>
                      {dragLabel && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: "var(--bg-elevated)", border: "1px solid var(--accent)", boxShadow: "0 6px 16px var(--overlay-3)", fontSize: 13, fontWeight: 600, color: "var(--text)", cursor: "grabbing" }}>
                          <span>{dragLabel.icon}</span>
                          <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dragLabel.text}</span>
                        </div>
                      )}
                    </DragOverlay>
                    </DndContext>

                    <div style={{ height: 1, background: "var(--border)", margin: "14px 0" }} />

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.85 }}>Database</div>

                        <span
                          className="infoIcon"
                          tabIndex={0}
                          role="button"
                          aria-label="About the database"
                        >
                          i
                          <span className="infoTooltip" role="tooltip">
                            Define your world's data, like characters, monsters, items, and
                            locations, as tables of records. Organize tables into folders.
                          </span>
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                        <button
                          type="button"
                          className="iconBtn"
                          onClick={() => addCollection()}
                          title="New table"
                        >
                          <IconNewCollection />
                        </button>
                        <button
                          type="button"
                          className="iconBtn"
                          onClick={() => addFolder("col", [])}
                          title="New folder"
                        >
                          <IconNewFolder />
                        </button>
                      </div>
                    </div>

                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleColTreeDragStart} onDragEnd={handleColTreeDragEnd} onDragCancel={() => setDragLabel(null)}>
                    <TreeRootDroppable id="col-root">
                      {collectionTreeRows.map((row) => {
                        if (row.kind === "folder") {
                          const pathKey = row.path.join("/");
                          return (
                            <TreeRow
                              key={"f:" + pathKey}
                              dragId={"colfolder:" + pathKey}
                              dropId={"colfolder:" + pathKey}
                              selected={treeSelection.has("colfolder:" + pathKey)}
                              onClick={(e) => {
                                if (handleTreeRowClick(e, "col", "colfolder:" + pathKey)) return;
                                setCollapsedCollectionGroups((prev) => ({ ...prev, [pathKey]: !prev[pathKey] }));
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setTreeCtxMenu({ x: e.clientX, y: e.clientY, kind: "col", targetType: "folder", path: row.path });
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                paddingLeft: 6 + row.depth * 14,
                                paddingRight: 6,
                                height: 26,
                                cursor: "pointer",
                                borderRadius: 6,
                                color: "var(--text-2)",
                                background: treeSelection.has("colfolder:" + pathKey) ? "var(--bg-row-sel)" : undefined,
                              }}
                            >
                              <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{row.collapsed ? "▸" : "▾"}</span>
                              <span style={{ display: "flex", opacity: 0.6, flexShrink: 0 }}><IconFolder /></span>
                              <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.name}</span>
                              <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                              <button
                                type="button"
                                title="New table in this folder"
                                onClick={(e) => { e.stopPropagation(); addCollection(row.path); }}
                                style={{ border: "none", background: "transparent", color: "var(--text-3)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}
                              >
                                +
                              </button>
                            </TreeRow>
                          );
                        }
                        const c = row.collection;
                        const selected = c.id === activeCollectionId && showRightPanel;
                        return (
                          <TreeRow
                            key={c.id}
                            dragId={"colitem:" + c.id}
                            selected={treeSelection.has("colitem:" + c.id)}
                            onClick={(e) => {
                              if (handleTreeRowClick(e, "col", "colitem:" + c.id)) return;
                              setActiveCollectionId(c.id);
                              setFocusView("collection");
                            }}
                            onContextMenu={(e) => { e.preventDefault(); setTreeCtxMenu({ x: e.clientX, y: e.clientY, kind: "col", targetType: "item", id: c.id }); }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              paddingLeft: 6 + row.depth * 14 + 16,
                              paddingRight: 6,
                              height: 26,
                              cursor: "pointer",
                              borderRadius: 6,
                              border: selected ? "1px solid var(--accent)" : "1px solid transparent",
                              background: treeSelection.has("colitem:" + c.id) || selected ? "var(--bg-row-sel)" : "transparent",
                            }}
                          >
                            <span style={{ width: 9, height: 9, borderRadius: 999, background: c.color, flexShrink: 0 }} />
                            <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{c.name}</span>
                            {wikiIsPublished && publicCollectionIdSet.has(c.id) && (
                              <span style={{ flexShrink: 0, borderRadius: 999, border: "1px solid rgba(79,140,255,0.35)", background: "rgba(79,140,255,0.12)", color: "var(--accent-text)", padding: "1px 6px", fontSize: 9, fontWeight: 800 }} title="Public on the published wiki">Public</span>
                            )}
                            <div className="kebabWrap" data-colmenu={c.id}>
                              <button type="button" className="kebabBtn" onClick={(e) => { e.stopPropagation(); setOpenColMenuId((cur) => (cur === c.id ? null : c.id)); }} title="Actions">⋯</button>
                              {openColMenuId === c.id && (
                                <div className="kebabMenu">
                                  <button type="button" className="kebabMenuItem" onClick={(e) => { e.stopPropagation(); setOpenColMenuId(null); renameCollection(c.id); }}>Rename</button>
                                  <button type="button" className="kebabMenuItem kebabMenuItemDanger" onClick={(e) => { e.stopPropagation(); setOpenColMenuId(null); deleteCollection(c.id); }}>Delete</button>
                                </div>
                              )}
                            </div>
                          </TreeRow>
                        );
                      })}
                    </TreeRootDroppable>
                    <DragOverlay dropAnimation={null}>
                      {dragLabel && (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 6, background: "var(--bg-elevated)", border: "1px solid var(--accent)", boxShadow: "0 6px 16px var(--overlay-3)", fontSize: 13, fontWeight: 600, color: "var(--text)", cursor: "grabbing" }}>
                          <span>{dragLabel.icon}</span>
                          <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dragLabel.text}</span>
                        </div>
                      )}
                    </DragOverlay>
                    </DndContext>

                    {showAssetsTree && (
                      <>
                        <div style={{ height: 1, background: "var(--border)", margin: "14px 0" }} />
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.85 }}>Assets</div>
                            <span className="infoIcon" tabIndex={0} role="button" aria-label="About assets">
                              i
                              <span className="infoTooltip" role="tooltip">
                                Files attached to your table records. Upload from a record's menu.
                              </span>
                            </span>
                          </div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
                          {assetsTreeRows.length === 0 && (
                            <div style={{ fontSize: 12, opacity: 0.55, padding: "4px 6px" }}>No assets yet.</div>
                          )}
                          {assetsTreeRows.map((row) => {
                            if (row.kind === "collection") {
                              const key = `col:${row.colId}`;
                              return (
                                <div key={key} className="treeRow" onClick={() => setCollapsedAssetGroups((p) => ({ ...p, [key]: !(p[key] ?? true) }))}
                                  style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 6, paddingRight: 6, height: 26, cursor: "pointer", borderRadius: 6, color: "var(--text-2)" }}>
                                  <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{row.collapsed ? "▸" : "▾"}</span>
                                  <span style={{ display: "flex", opacity: 0.6, flexShrink: 0 }}><IconFolder /></span>
                                  <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.name}</span>
                                  <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                                </div>
                              );
                            }
                            if (row.kind === "entity") {
                              const key = `ent:${row.colId}:${row.rowId}`;
                              const iconUrl = row.iconPath ? assetUrlCache[row.iconPath] : null;
                              return (
                                <div key={key} className="treeRow"
                                  onClick={() => setCollapsedAssetGroups((p) => ({ ...p, [key]: !(p[key] ?? true) }))}
                                  onContextMenu={(e) => { e.preventDefault(); setAssetCtxMenu({ kind: "entity", colId: row.colId, rowId: row.rowId, x: e.clientX, y: e.clientY }); }}
                                  style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 20, paddingRight: 6, height: 28, cursor: "pointer", borderRadius: 6 }}>
                                  <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{row.collapsed ? "▸" : "▾"}</span>
                                  <span style={{ width: 18, height: 18, borderRadius: 4, overflow: "hidden", flexShrink: 0, background: "var(--bg-deep)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    {row.iconPath
                                      ? <img src={iconUrl || ""} onError={() => getSignedAssetUrl(row.iconPath!)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                      : <span style={{ opacity: 0.5, display: "flex" }}><IconFile /></span>}
                                  </span>
                                  <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.label}</span>
                                  <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                                  <div className="kebabWrap" data-assetkebab>
                                    <button type="button" className="kebabBtn" title="Actions"
                                      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAssetCtxMenu({ kind: "entity", colId: row.colId, rowId: row.rowId, x: r.right, y: r.bottom }); }}>⋯</button>
                                  </div>
                                </div>
                              );
                            }
                            // asset row
                            const a = row.asset;
                            return (
                              <div key={a.id} className="treeRow"
                                onContextMenu={(e) => { e.preventDefault(); setAssetCtxMenu({ kind: "asset", colId: row.colId, rowId: row.rowId, assetId: a.id, x: e.clientX, y: e.clientY }); }}
                                style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 44, paddingRight: 6, height: 26, borderRadius: 6 }}>
                                <span style={{ flexShrink: 0, display: "flex" }}><AssetTypeBadge name={a.name} mime={a.mime} /></span>
                                <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, opacity: 0.85 }}>{a.name}</span>
                                <div className="kebabWrap" data-assetkebab>
                                  <button type="button" className="kebabBtn" title="Actions"
                                    onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAssetCtxMenu({ kind: "asset", colId: row.colId, rowId: row.rowId, assetId: a.id, x: r.right, y: r.bottom }); }}>⋯</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {showDialogueTree && (
                      <>
                        <div style={{ height: 1, background: "var(--border)", margin: "14px 0" }} />
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.85 }}>Conditions</div>
                            <span className="infoIcon" tabIndex={0} role="button" aria-label="About conditions">
                              i
                              <span className="infoTooltip" role="tooltip">
                                Create conditions to give an output result. Click one to edit it.
                              </span>
                            </span>
                          </div>
                          <button type="button" className="iconBtn" onClick={addDataset} title="New condition">
                            <IconNewDataset />
                          </button>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
                          {datasetTreeRows.length === 0 && (
                            <div style={{ fontSize: 12, opacity: 0.55, padding: "4px 6px" }}>No conditions yet.</div>
                          )}
                          {datasetTreeRows.map((row) => {
                            if (row.kind === "leaf") {
                              return (
                                <div key={row.key} className="treeRow"
                                  onClick={() => openDataset(row.datasetId)}
                                  title={row.text}
                                  style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 6 + row.depth * 14 + 4, paddingRight: 6, minHeight: 24, borderRadius: 6, cursor: "pointer" }}>
                                  <span style={{ opacity: 0.4, flexShrink: 0 }}>›</span>
                                  <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, opacity: 0.7 }}>{row.text}</span>
                                </div>
                              );
                            }
                            if (row.kind === "dataset") {
                              const selected = activeDatasetId === row.datasetId && rightShowsDataset;
                              return (
                                <div key={"ds:" + row.datasetId} className="treeRow"
                                  onClick={() => openDataset(row.datasetId)}
                                  onContextMenu={(e) => { e.preventDefault(); renameDataset(row.datasetId); }}
                                  title="Open condition (right-click to rename)"
                                  style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 6, paddingRight: 6, height: 26, cursor: "pointer", borderRadius: 6, color: "var(--text)", background: selected ? "var(--bg-row-sel)" : undefined }}>
                                  <span
                                    onClick={(e) => { e.stopPropagation(); setCollapsedDialogueGroups((p) => ({ ...p, ["ds:" + row.datasetId]: !(p["ds:" + row.datasetId] ?? true) })); }}
                                    style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}
                                  >{row.collapsed ? "▸" : "▾"}</span>
                                  <span style={{ display: "flex", opacity: 0.6, flexShrink: 0 }}><IconChat /></span>
                                  <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{row.name}</span>
                                  <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                                </div>
                              );
                            }
                            return (
                              <div key={"g:" + row.key} className="treeRow"
                                onClick={() => setCollapsedDialogueGroups((p) => ({ ...p, [row.key]: !(p[row.key] ?? true) }))}
                                style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 6 + row.depth * 14, paddingRight: 6, height: 26, cursor: "pointer", borderRadius: 6, color: "var(--text-2)" }}>
                                <span style={{ fontSize: 10, opacity: 0.7, width: 10, flexShrink: 0 }}>{row.collapsed ? "▸" : "▾"}</span>
                                <span style={{ display: "flex", opacity: 0.6, flexShrink: 0 }}><IconFolder /></span>
                                <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                                  {row.fieldLabel && (
                                    <span style={{ opacity: 0.5, fontWeight: 500 }}>{row.fieldLabel}: </span>
                                  )}
                                  {row.label}
                                </span>
                                <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{row.count}</span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </Panel>

                <PanelResizeHandle className="resize-handle" />
              </>
            )}

            {/* MIDDLE */}
            {showMiddlePanel && (
              <Panel
                id="middle-panel"
                order={2}
                defaultSize={panelSizes[1] ?? (layoutMode === "dual" ? 40 : 80)}
                minSize={30}
              >
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    padding: "12px 16px",
                    borderRight: showRightPanel ? "1px solid var(--border-2)" : "none",
                    boxSizing: "border-box",
                    minHeight: 0,
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>
                        {activeDoc ? activeDoc.title : "No document selected"}
                      </div>

                      <span
                        className="infoIcon"
                        tabIndex={0}
                        role="button"
                        aria-label="How linking works"
                      >
                        i
                        <span className="infoTooltip" role="tooltip">
                          Link text to a record by highlighting words, then choosing a table/record. You can also type
                          “/” in the editor to add a record quickly, or quotation marks to link to a dialogue line.
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Floating link popover (passive; anchored like the slash menu) */}
                  {(linkingSelection || editingLink) &&
                    linkPopoverAnchorRect &&
                    createPortal(
                      <div
                        className="linkPopover"
                        style={(() => {
                          const W = 400;
                          const H = 300;
                          const pad = 12;

                          const left = Math.min(
                            Math.max(pad, linkPopoverAnchorRect.left),
                            window.innerWidth - W - pad
                          );

                          const above = linkPopoverAnchorRect.top - H - 10;
                          const below = linkPopoverAnchorRect.bottom + 10;

                          // Prefer BELOW (like the slash menu), fall back to above if no room.
                          const top =
                            below + H + pad <= window.innerHeight
                              ? below
                              : above >= pad
                                ? above
                                : Math.min(below, window.innerHeight - H - pad);

                          return { left, top, width: W } as React.CSSProperties;
                        })()}
                        onMouseDown={(e) => {
                          // keep it "passive": don’t collapse selection / trigger close while interacting
                          e.stopPropagation();
                          linkUiInteractionBatonRef.current = Date.now();
                        }}
                      >
                        <div className="linkPopoverHeader">
                          <div className="linkPopoverTitle">{editingLinkId ? "Link" : "Create link"}</div>

                          <button type="button" className="linkPopoverClose" onClick={closeLinkEditor}>
                            ✕
                          </button>
                        </div>

                        <div className="linkPanelFixedTopLine">{`Selected: "${selectedDisplayText}"`}</div>

                        {linkingNotice && <div style={{ fontSize: 12, color: "var(--danger-text)", marginTop: -2 }}>{linkingNotice}</div>}

                        <div className="linkDivider" />

                        <div className="linkForm">
                          {/* Table + record selection (both create and edit) */}
                          <div className="linkFieldRow">
                            <span className="linkFieldLabel">Table</span>
                            <select
                              className="themed-select linkInput"
                              value={linkingCollectionId}
                              onChange={(e) => {
                                setLinkingCollectionId(e.target.value as any);
                                setLinkingEntityId("");
                              }}
                            >
                              <option value="">Choose table…</option>
                              {project.collections.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="linkFieldRow">
                            <span className="linkFieldLabel">Record</span>
                            <select
                              className="themed-select linkInput"
                              value={linkingEntityId}
                              onChange={(e) => setLinkingEntityId(e.target.value as any)}
                              disabled={!linkingCollectionId}
                            >
                              <option value="">Choose record…</option>
                              {(project.collections.find((c) => c.id === linkingCollectionId)?.rows ?? []).map((r) => (
                                <option key={r.id} value={r.id}>
                                  {getRowLabel(r)}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="linkDivider" />

                          <div className="linkActions">
                            <button
                              type="button"
                              className="linkBtn linkBtnPrimary"
                              onClick={saveLink}
                              disabled={
                                !linkingCollectionId ||
                                !linkingEntityId ||
                                (!editingLinkId && (!linkingSelection || selectionOverlapsExistingLink))
                              }
                            >
                              {editingLinkId ? "Save" : "Create link"}
                            </button>

                            {editingLinkId && (
                              <button
                                type="button"
                                className="linkBtn linkBtnDanger linkBtnGhost"
                                onClick={() => {
                                  unlinkCurrentLink();
                                  closeLinkEditor();
                                }}
                              >
                                Unlink
                              </button>
                            )}
                          </div>
                        </div>
                      </div>,
                      document.body
                    )}

                  {/* Editor (now sits UNDER the link panel) — fills the panel height */}
                  <div
                    style={{
                      flex: "1 1 auto",
                      minHeight: 0,
                      overflow: "hidden",
                    }}
                  >
                    <StoryEditor
                      docKey={activeDoc?.id ?? ""}
                      value={activeDoc?.content ?? ""}
                      richValue={activeDoc?.richContent ?? ""}
                      onChange={(text) => activeDoc && updateDocumentContent(activeDoc.id, text)}
                      onRichChange={(json) => activeDoc && updateDocumentRichContent(activeDoc.id, json)}
                      onSelectionChange={handleEditorSelectionChange}
                      onCaretLinkChange={handleCaretLinkChange}
                      entityLinks={activeDoc?.entityLinks ?? []}
                      getCollectionColor={getCollectionColor}
                      onHighlightClick={handleHighlightClick}
                      onLinksChange={(links) => activeDoc && updateDocumentLinks(activeDoc.id, links)}
                      linkApiRef={linkApiRef}
                      slashItems={slashItems}
                      onSlashLinkCreate={handleSlashLinkCreate}
                      enableSlashLinking={true}
                      enableDialogueQuoteLinking={false}
                    />
                  </div>
                </div>
              </Panel>
            )}

            {showMiddlePanel && showRightPanel && <PanelResizeHandle className="resize-handle" />}


            {/* RIGHT */}
            {showRightPanel && (
              <Panel id="right-panel" order={3} defaultSize={panelSizes[2] ?? (layoutMode === "dual" ? 40 : 80)} minSize={20}>
                {rightShowsDataset ? (
                  activeDataset ? (
                    <DatasetView
                      dataset={activeDataset}
                      collections={project.collections}
                      onChange={updateDataset}
                      onRename={() => renameDataset(activeDataset.id)}
                      onDelete={() => deleteDataset(activeDataset.id)}
                      getRowLabel={getRowLabel}
                    />
                  ) : (
                    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.6, fontSize: 13 }}>
                      No dataset selected.
                    </div>
                  )
                ) : (
                <div style={{ height: "100%", padding: "12px 16px", boxSizing: "border-box", overflow: "auto" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>
                      {activeCollection ? activeCollection.name : "No table selected"}
                    </div>

                    {activeCollection && (
                      <input
                        type="color"
                        value={activeCollection.color}
                        onChange={(e) => updateCollectionColor(activeCollection.id, e.target.value)}
                        title="Collection color"
                        style={{ width: 34, height: 28, border: "1px solid var(--border-2)", background: "transparent", borderRadius: 6 }}
                      />
                    )}
                  </div>

                  {activeCollection ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" className="toolBtn" onClick={addFieldToActiveCollection} title="Add a column to this table">
                        <IconAddColumn />
                        Column
                      </button>

                      <button type="button" className="toolBtn" onClick={addRowToActiveCollection} title="Add a row to this table">
                        <IconAddRow />
                        Row
                      </button>

                      <select className="themed-select"
                        value={activeCollection.assetsEnabled !== false ? "enabled" : "disabled"}
                        onChange={(e) => {
                          const shouldEnable = e.target.value === "enabled";
                          const isEnabled = activeCollection.assetsEnabled !== false;
                          if (shouldEnable !== isEnabled) {
                            toggleCollectionAssetsEnabled(activeCollection.id);
                          }
                        }}
                        title="Control whether this table shows asset UI"
                        style={{
                          height: 32,
                          borderRadius: 6,
                          border: "1px solid var(--border-3)",
                          backgroundColor: "transparent",
                          color: "var(--text-2)",
                          cursor: "pointer",
                          padding: "0 34px 0 10px",
                          fontSize: 12,
                          fontWeight: 600,
                          fontFamily: "inherit",
                          outline: "none",
                        }}
                      >
                        <option value="enabled">Assets: Enabled</option>
                        <option value="disabled">Assets: Disabled</option>
                      </select>
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, opacity: 0.7, fontSize: 12 }}>
                      Select a table to edit it.
                    </div>
                  )}

                  {activeCollection ? (
                    <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", width: "fit-content", maxWidth: "100%" }}>
                      <div style={{ overflowX: "auto" }}>
                        <table
                          style={{
                            width: "max-content",
                            borderCollapse: "collapse",
                            tableLayout: "fixed",
                          }}
                        >
                          <thead>
                            <tr>
                              <th
                                style={{
                                  textAlign: "left",
                                  padding: "10px 4px 10px 10px",
                                  borderBottom: "1px solid var(--border-2)",
                                  width: 34,
                                  minWidth: 34,
                                  background: "var(--bg-table-hd)",
                                  zIndex: 2,
                                }}
                              />

                              {activeCollection.assetsEnabled !== false && (
                                <th
                                  style={{
                                    textAlign: "left",
                                    padding: "10px 10px",
                                    borderBottom: "1px solid var(--border-2)",
                                    width: 64,
                                    minWidth: 64,
                                    background: "var(--bg-table-hd)",
                                    zIndex: 2,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontWeight: 800,
                                      fontSize: 12,
                                    }}
                                  >
                                    Profile
                                  </div>
                                </th>
                              )}

                              {activeCollection.schema.map((f) => (
                                <th
                                  key={f.id}
                                  style={{
                                    textAlign: "left",
                                    padding: "10px 10px",
                                    borderBottom: "1px solid var(--border-2)",
                                    position: "relative",
                                    width: `${columnWidths[`${activeCollection.id}:${f.id}`] ?? 200}px`,
                                    minWidth: 60,
                                    background: "var(--bg-table-hd)",
                                    zIndex: 2,
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                    <div style={{ fontWeight: 800, fontSize: 12 }}>{f.label}</div>
                                    <button
                                      type="button"
                                      onClick={() => deleteFieldFromCollection(activeCollection.id, f.id)}
                                      title="Delete column"
                                      style={{
                                        borderRadius: 6,
                                        border: "1px solid var(--border-3)",
                                        background: "transparent",
                                        color: "var(--text-2)",
                                        cursor: "pointer",
                                        fontSize: 11,
                                        padding: "2px 6px",
                                        opacity: f.id === "id" || f.id === "name" ? 0.35 : 1,
                                        pointerEvents: f.id === "id" || f.id === "name" ? "none" : "auto",
                                      }}
                                    >
                                      ×
                                    </button>
                                  </div>

                                  <div
                                    onMouseDown={(e) => handleColumnResizeMouseDown(e, activeCollection.id, f.id)}
                                    style={{
                                      position: "absolute",
                                      right: 0,
                                      top: 0,
                                      bottom: 0,
                                      width: 8,
                                      cursor: "col-resize",
                                      // Visible grip line
                                      borderRight: "2px solid var(--border-2)",
                                      transition: "border-color 120ms",
                                    }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)"; }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-2)"; }}
                                  />
                                </th>
                              ))}

                              {/* Assets column */}
                              {activeCollection.assetsEnabled !== false && (
                                <th
                                  style={{
                                    textAlign: "left",
                                    padding: "10px 10px",
                                    borderBottom: "1px solid var(--border-2)",
                                    width: 120,
                                    minWidth: 120,
                                    background: "var(--bg-table-hd)",
                                    zIndex: 2,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontWeight: 800,
                                      fontSize: 12,
                                    }}
                                  >
                                    Assets
                                  </div>
                                </th>
                              )}
                            </tr>
                          </thead>

                          <tbody>
                            {activeCollection.rows.map((r, rowIndex) => (
                              <tr
                                key={r.id}
                                data-rowkey={`${activeCollection.id}:${r.id}`}
                                onClick={() => setActiveRowId(r.id)}
                                onDragOver={(e) => {
                                  if (!draggingRowId || draggingRowId === r.id) return;
                                  e.preventDefault();
                                  setDragOverRowId(r.id);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();

                                  if (!draggingRowId || draggingRowId === r.id) {
                                    setDraggingRowId(null);
                                    setDragOverRowId(null);
                                    return;
                                  }

                                  moveRowToIndex(activeCollection.id, draggingRowId, rowIndex);
                                  setDraggingRowId(null);
                                  setDragOverRowId(null);
                                }}
                                onDragEnd={() => {
                                  setDraggingRowId(null);
                                  setDragOverRowId(null);
                                }}
                                style={{
                                  background:
                                    draggingRowId === r.id
                                      ? "var(--bg-row-drag)"
                                      : activeRowId === r.id
                                        ? "var(--bg-row-sel)"
                                        : undefined,
                                  cursor: "pointer",
                                  outline: dragOverRowId === r.id && draggingRowId !== r.id ? "1px solid var(--accent)" : undefined,
                                  outlineOffset: -1,
                                  opacity: draggingRowId === r.id ? 0.6 : 1,
                                }}
                              >
                                <td
                                  style={{
                                    padding: "6px 4px 6px 10px",
                                    borderBottom: "1px solid var(--border-row)",
                                    width: 34,
                                    minWidth: 34,
                                    verticalAlign: "middle",
                                  }}
                                >
                                  <button
                                    type="button"
                                    draggable
                                    onClick={(e) => e.stopPropagation()}
                                    onDragStart={(e) => {
                                      e.stopPropagation();
                                      setDraggingRowId(r.id);
                                      setDragOverRowId(r.id);
                                      e.dataTransfer.effectAllowed = "move";
                                      e.dataTransfer.setData("text/plain", r.id);
                                    }}
                                    onDragEnd={() => {
                                      setDraggingRowId(null);
                                      setDragOverRowId(null);
                                    }}
                                    title="Drag to reorder row"
                                    style={{
                                      width: 24,
                                      height: 28,
                                      border: "none",
                                      background: "transparent",
                                      color: "var(--text-dim)",
                                      cursor: "grab",
                                      padding: 0,
                                      fontSize: 14,
                                      lineHeight: 1,
                                      opacity: draggingRowId === r.id ? 0.9 : 0.35,
                                    }}
                                  >
                                    ⋮⋮
                                  </button>
                                </td>

                                {/* Profile cell */}
                                {activeCollection.assetsEnabled !== false && (
                                  <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--border-row)" }}>
                                    {(() => {
                                      const profileAsset =
                                        r.profileAssetId && r.assets?.find((a) => a.id === r.profileAssetId);

                                      if (profileAsset && assetUrlCache[profileAsset.path]) {
                                        return (
                                          <img
                                            src={assetUrlCache[profileAsset.path]}
                                            alt=""
                                            style={{
                                              width: 28,
                                              height: 28,
                                              borderRadius: 999,
                                              objectFit: "cover",
                                              border: "1px solid var(--border-2)",
                                            }}
                                          />
                                        );
                                      }

                                      return (
                                        <div
                                          style={{
                                            width: 28,
                                            height: 28,
                                            borderRadius: 999,
                                            background: "var(--bg-dark)",
                                            display: "grid",
                                            placeItems: "center",
                                            fontSize: 11,
                                            opacity: 0.5,
                                          }}
                                        >
                                          —
                                        </div>
                                      );
                                    })()}
                                  </td>
                                )}

                                {activeCollection.schema.map((f) => (
                                  <td
                                    key={f.id}
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid var(--border-row)",
                                      verticalAlign: f.type === "text" ? "top" : "middle",
                                    }}
                                  >
                                    {f.id === "id" ? (
                                      (() => {
                                        const cellKey = `${activeCollection.id}:${r.id}:${f.id}`;
                                        const currentValue = String(r.values[f.id] ?? "");
                                        const suggestion = idSuggestionByCell[cellKey] ?? "";
                                        const finalizedCurrent = finalizeEntityDisplayId(currentValue);
                                        const suffix =
                                          suggestion &&
                                            suggestion.startsWith(finalizedCurrent) &&
                                            finalizedCurrent.length > 0 &&
                                            suggestion !== finalizedCurrent
                                            ? suggestion.slice(finalizedCurrent.length)
                                            : "";

                                        return (
                                          <div style={{ position: "relative" }}>
                                            <input
                                              data-cellkey={cellKey}
                                              value={currentValue}
                                              onChange={(e) => {
                                                const raw = e.target.value;
                                                const normalized = normalizeEntityDisplayId(raw);

                                                pendingCellFocusRestoreRef.current = {
                                                  key: cellKey,
                                                  selectionStart: e.currentTarget.selectionStart,
                                                  selectionEnd: e.currentTarget.selectionEnd,
                                                  t: Date.now(),
                                                };

                                                const nextSuggestion =
                                                  normalized &&
                                                    getUniqueDisplayIdSuggestion(activeCollection.id, r.id, raw) !== finalizeEntityDisplayId(raw)
                                                    ? getUniqueDisplayIdSuggestion(activeCollection.id, r.id, raw)
                                                    : "";

                                                setIdSuggestionByCell((prev) => {
                                                  if (!nextSuggestion) {
                                                    const { [cellKey]: _omit, ...rest } = prev;
                                                    return rest;
                                                  }
                                                  return { ...prev, [cellKey]: nextSuggestion };
                                                });

                                                setProject((prev) => {
                                                  if (!prev) return prev;
                                                  return {
                                                    ...prev,
                                                    collections: prev.collections.map((c) =>
                                                      c.id !== activeCollection.id
                                                        ? c
                                                        : {
                                                          ...c,
                                                          rows: c.rows.map((row) =>
                                                            row.id === r.id
                                                              ? {
                                                                ...row,
                                                                values: {
                                                                  ...row.values,
                                                                  id: normalized,
                                                                },
                                                              }
                                                              : row
                                                          ),
                                                        }
                                                    ),
                                                  };
                                                });
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === " ") {
                                                  e.preventDefault();

                                                  const input = e.currentTarget;
                                                  const start = input.selectionStart ?? currentValue.length;
                                                  const end = input.selectionEnd ?? start;

                                                  const rawNext = `${currentValue.slice(0, start)}_${currentValue.slice(end)}`;
                                                  const normalized = normalizeEntityDisplayId(rawNext);

                                                  pendingCellFocusRestoreRef.current = {
                                                    key: cellKey,
                                                    selectionStart: start + 1,
                                                    selectionEnd: start + 1,
                                                    t: Date.now(),
                                                  };

                                                  const nextSuggestion =
                                                    normalized &&
                                                      getUniqueDisplayIdSuggestion(activeCollection.id, r.id, rawNext) !== finalizeEntityDisplayId(rawNext)
                                                      ? getUniqueDisplayIdSuggestion(activeCollection.id, r.id, rawNext)
                                                      : "";

                                                  setIdSuggestionByCell((prev) => {
                                                    if (!nextSuggestion) {
                                                      const { [cellKey]: _omit, ...rest } = prev;
                                                      return rest;
                                                    }
                                                    return { ...prev, [cellKey]: nextSuggestion };
                                                  });

                                                  setProject((prev) => {
                                                    if (!prev) return prev;
                                                    return {
                                                      ...prev,
                                                      collections: prev.collections.map((c) =>
                                                        c.id !== activeCollection.id
                                                          ? c
                                                          : {
                                                            ...c,
                                                            rows: c.rows.map((row) =>
                                                              row.id === r.id
                                                                ? {
                                                                  ...row,
                                                                  values: {
                                                                    ...row.values,
                                                                    id: normalized,
                                                                  },
                                                                }
                                                                : row
                                                            ),
                                                          }
                                                      ),
                                                    };
                                                  });

                                                  return;
                                                }

                                                const suggestionNow = idSuggestionByCell[cellKey];
                                                if (e.key === "Tab" && suggestionNow) {
                                                  e.preventDefault();

                                                  pendingCellFocusRestoreRef.current = {
                                                    key: cellKey,
                                                    selectionStart: suggestionNow.length,
                                                    selectionEnd: suggestionNow.length,
                                                    t: Date.now(),
                                                  };

                                                  updateCollectionCell(activeCollection.id, r.id, "id", suggestionNow);
                                                  setIdSuggestionByCell((prev) => {
                                                    const { [cellKey]: _omit, ...rest } = prev;
                                                    return rest;
                                                  });
                                                }
                                              }}
                                              onBlur={(e) => {
                                                const finalValue = e.currentTarget.value;
                                                updateCollectionCell(activeCollection.id, r.id, "id", finalValue);

                                                setIdSuggestionByCell((prev) => {
                                                  const { [cellKey]: _omit, ...rest } = prev;
                                                  return rest;
                                                });
                                              }}
                                              title={suggestion ? `Suggested unique ID: ${suggestion} (press Tab)` : "Unique ID"}
                                              style={{
                                                width: "100%",
                                                borderRadius: 6,
                                                border: suggestion ? "1px solid #e67e22" : "1px solid var(--border-2)",
                                                background: "var(--bg-surface)",
                                                color: "var(--text)",
                                                padding: "6px 8px",
                                                fontSize: 13,
                                                fontWeight: 400,
                                                boxSizing: "border-box",
                                                position: "relative",
                                                zIndex: 2,
                                              }}
                                            />

                                            {suffix && (
                                              <div
                                                style={{
                                                  position: "absolute",
                                                  inset: 0,
                                                  pointerEvents: "none",
                                                  display: "flex",
                                                  alignItems: "center",
                                                  padding: "6px 8px",
                                                  fontSize: 13,
                                                  fontWeight: 400,
                                                  boxSizing: "border-box",
                                                  whiteSpace: "nowrap",
                                                  overflow: "hidden",
                                                  zIndex: 3,
                                                  color: "var(--text)",
                                                }}
                                              >
                                                <span style={{ visibility: "hidden" }}>{currentValue}</span>
                                                <span style={{ color: "var(--text-dim)" }}>{suffix}</span>
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })()
                                    ) : (
                                      f.type === "bool" ? (
                                        <input
                                          type="checkbox"
                                          data-cellkey={`${activeCollection.id}:${r.id}:${f.id}`}
                                          checked={r.values[f.id] === "true" || r.values[f.id] === 1}
                                          onChange={(e) =>
                                            updateCollectionCell(activeCollection.id, r.id, f.id, e.target.checked ? "true" : "false")
                                          }
                                          style={{ width: 16, height: 16 }}
                                        />
                                      ) : f.type === "text" ? (
                                        <textarea
                                          data-cellkey={`${activeCollection.id}:${r.id}:${f.id}`}
                                          value={String(r.values[f.id] ?? "")}
                                          onChange={(e) => {
                                            pendingCellFocusRestoreRef.current = {
                                              key: `${activeCollection.id}:${r.id}:${f.id}`,
                                              selectionStart: e.currentTarget.selectionStart,
                                              selectionEnd: e.currentTarget.selectionEnd,
                                              t: Date.now(),
                                            };
                                            updateCollectionCell(activeCollection.id, r.id, f.id, e.target.value);
                                          }}
                                          rows={4}
                                          style={{
                                            width: "100%",
                                            minHeight: 84,
                                            borderRadius: 6,
                                            border: "1px solid var(--border-2)",
                                            background: "var(--bg-surface)",
                                            color: "var(--text)",
                                            padding: "6px 8px",
                                            fontSize: 13,
                                            lineHeight: 1.4,
                                            boxSizing: "border-box",
                                            resize: "vertical",
                                            fontFamily: "inherit",
                                          }}
                                        />
                                      ) : (
                                        <input
                                          data-cellkey={`${activeCollection.id}:${r.id}:${f.id}`}
                                          type={f.type === "number" ? "number" : "text"}
                                          value={String(r.values[f.id] ?? "")}
                                          onChange={(e) => {
                                            pendingCellFocusRestoreRef.current = {
                                              key: `${activeCollection.id}:${r.id}:${f.id}`,
                                              selectionStart: e.currentTarget.selectionStart,
                                              selectionEnd: e.currentTarget.selectionEnd,
                                              t: Date.now(),
                                            };
                                            updateCollectionCell(activeCollection.id, r.id, f.id, e.target.value);
                                          }}
                                          style={{
                                            width: "100%",
                                            borderRadius: 6,
                                            border: "1px solid var(--border-2)",
                                            background: "var(--bg-surface)",
                                            color: "var(--text)",
                                            padding: "6px 8px",
                                            fontSize: 13,
                                            boxSizing: "border-box",
                                          }}
                                        />
                                      )
                                    )}
                                  </td>
                                ))}


                                

                                {activeCollection.assetsEnabled !== false ? (
                                  <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--border-row)" }}>
                                    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openAssetsForEntity(activeCollection.id, r.id);
                                        }}
                                        style={{
                                          flex: 1,
                                          height: 32,
                                          minHeight: 32,
                                          borderRadius: 6,
                                          border: "1px solid var(--border-2)",
                                          background: "var(--bg-surface)",
                                          color: "var(--text-2)",
                                          cursor: "pointer",
                                          padding: "0 8px",
                                          fontSize: 13,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 8,
                                          boxSizing: "border-box",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {(() => {
                                          const profileAsset =
                                            r.profileAssetId && r.assets?.find((a) => a.id === r.profileAssetId);
                                          if (profileAsset && assetUrlCache[profileAsset.path]) {
                                            return (
                                              <img
                                                src={assetUrlCache[profileAsset.path]}
                                                alt=""
                                                style={{
                                                  width: 18,
                                                  height: 18,
                                                  borderRadius: 4,
                                                  objectFit: "cover",
                                                  flex: "0 0 auto",
                                                }}
                                              />
                                            );
                                          }
                                          return (
                                            <div
                                              style={{
                                                width: 18,
                                                height: 18,
                                                borderRadius: 4,
                                                background: "var(--bg-dark)",
                                                display: "grid",
                                                placeItems: "center",
                                                fontSize: 9,
                                                opacity: 0.7,
                                                flex: "0 0 auto",
                                              }}
                                            >
                                              IMG
                                            </div>
                                          );
                                        })()}
                                        ({(r.assets ?? []).length})
                                      </button>

                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteRow(activeCollection.id, r.id);
                                        }}
                                        title="Delete row"
                                        style={{
                                          borderRadius: 8,
                                          border: "1px solid var(--danger-border)",
                                          background: "var(--danger-bg)",
                                          color: "var(--text)",
                                          cursor: "pointer",
                                          padding: "6px 8px",
                                          fontSize: 12,
                                          alignSelf: "stretch",
                                        }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </td>
                                ) : (
                                  <td style={{ padding: "6px 10px", borderBottom: "1px solid var(--border-row)", width: 48 }}>
                                    <div style={{ display: "flex", gap: 6 }}>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteRow(activeCollection.id, r.id);
                                        }}
                                        title="Delete row"
                                        style={{
                                          borderRadius: 8,
                                          border: "1px solid var(--danger-border)",
                                          background: "var(--danger-bg)",
                                          color: "var(--text)",
                                          cursor: "pointer",
                                          padding: "6px 8px",
                                          fontSize: 12,
                                        }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}
                </div>
                )}
              </Panel>
            )}
          </PanelGroup>
        </div>

        {/* Hidden file input for uploading assets to an entity from the Assets tree */}
        <input
          ref={assetUploadInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.gif"
          style={{ display: "none" }}
          onChange={async (e) => {
            const target = pendingUploadTargetRef.current;
            const count = e.target.files?.length ?? 0;
            if (target && count > 0) {
              await addAssetsToEntity(target.colId, target.rowId, e.target.files);
            }
            e.currentTarget.value = "";
            pendingUploadTargetRef.current = null;
          }}
        />

        {/* Shared asset/entity actions menu (modal + Assets tree) */}
        {assetCtxMenu && project && (() => {
          const m = assetCtxMenu;
          const col = project.collections.find((c) => c.id === m.colId);
          const row = col?.rows.find((r) => r.id === m.rowId);
          if (!col || !row) return null;
          const close = () => setAssetCtxMenu(null);
          const itemStyle: React.CSSProperties = { textAlign: "left", border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 10px", fontSize: 13, borderRadius: 6, whiteSpace: "nowrap" };
          const dangerStyle: React.CSSProperties = { ...itemStyle, color: "var(--danger-text)" };
          const entityLabelText = String(row.values["id"] || getRowLabel(row) || row.id);

          return (
            <div
              data-assetmenupopup
              style={{
                position: "fixed",
                top: Math.min(m.y + 4, window.innerHeight - 200),
                left: Math.max(8, m.x - 200),
                zIndex: 300,
                minWidth: 200,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 8,
                padding: 6,
                boxShadow: "0 10px 25px var(--overlay-3)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {m.kind === "entity" ? (
                <>
                  <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); pendingUploadTargetRef.current = { colId: col.id, rowId: row.id }; assetUploadInputRef.current?.click(); }}>
                    Upload asset
                  </button>
                  <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); renameEntity(col.id, row.id); }}>
                    Rename
                  </button>
                </>
              ) : (() => {
                const a = (row.assets ?? []).find((x) => x.id === m.assetId);
                if (!a) return null;
                const isImage = (a.mime || "").startsWith("image/");
                const isProfile = row.profileAssetId === a.id;
                return (
                  <>
                    <button type="button" className="ctxItem" style={itemStyle} onClick={async () => { close(); const url = await getSignedAssetUrl(a.path); if (!url) { await appModal.alert("Could not open this asset.", { title: "Open failed" }); return; } window.open(url, "_blank", "noopener,noreferrer"); }}>
                      Open
                    </button>
                    <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); renameEntityAsset(col.id, row.id, a.id); }}>
                      Rename
                    </button>
                    {isImage && (
                      <button type="button" className="ctxItem" disabled={isProfile} style={{ ...itemStyle, opacity: isProfile ? 0.5 : 1, cursor: isProfile ? "default" : "pointer" }} onClick={() => { close(); setEntityProfileAsset(col.id, row.id, a.id); }}>
                        {isProfile ? `Current icon for ${entityLabelText} ✓` : `Set as icon for ${entityLabelText}`}
                      </button>
                    )}
                    <button type="button" className="ctxItem" style={dangerStyle} onClick={async () => { close(); const ok = await appModal.confirm({ title: "Delete asset?", message: `Delete "${a.name}"?`, confirmText: "Delete", cancelText: "Cancel", danger: true }); if (!ok) return; deleteEntityAsset(col.id, row.id, a.id); }}>
                      Delete
                    </button>
                  </>
                );
              })()}
            </div>
          );
        })()}

        {/* Folder-tree right-click context menu */}
        {treeCtxMenu && (
          <>
            <div
              onClick={() => setTreeCtxMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setTreeCtxMenu(null); }}
              style={{ position: "fixed", inset: 0, zIndex: 200 }}
            />
            <div
              style={{
                position: "fixed",
                left: Math.min(treeCtxMenu.x, window.innerWidth - 200),
                top: Math.min(treeCtxMenu.y, window.innerHeight - 200),
                zIndex: 201,
                minWidth: 180,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 8,
                padding: 6,
                boxShadow: "0 10px 25px var(--overlay-3)",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {(() => {
                const m = treeCtxMenu;
                const close = () => setTreeCtxMenu(null);
                const itemStyle: React.CSSProperties = { textAlign: "left", border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 10px", fontSize: 13, borderRadius: 6 };
                const dangerStyle: React.CSSProperties = { ...itemStyle, color: "var(--danger-text)" };
                if (m.targetType === "folder" && m.path) {
                  const path = m.path;
                  return (
                    <>
                      <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); m.kind === "doc" ? addDocument(path) : addCollection(path); }}>
                        {m.kind === "doc" ? "New document here" : "New table here"}
                      </button>
                      <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); addFolder(m.kind, path); }}>
                        New subfolder
                      </button>
                      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
                      <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); renameFolder(m.kind, path); }}>
                        Rename folder
                      </button>
                      <button type="button" className="ctxItem" style={dangerStyle} onClick={() => { close(); deleteFolder(m.kind, path); }}>
                        Delete folder
                      </button>
                    </>
                  );
                }
                if (m.targetType === "item" && m.id) {
                  const id = m.id;
                  return (
                    <>
                      <button type="button" className="ctxItem" style={itemStyle} onClick={() => { close(); m.kind === "doc" ? renameDocument(id) : renameCollection(id); }}>
                        Rename
                      </button>
                      <button type="button" className="ctxItem" style={dangerStyle} onClick={() => { close(); m.kind === "doc" ? deleteDocument(id) : deleteCollection(id); }}>
                        Delete
                      </button>
                    </>
                  );
                }
                return null;
              })()}
            </div>
          </>
        )}

        {/* WORLD MAP overlay (full-screen, above everything) — web only; desktop uses a separate window */}
        {worldMapOpen && project && !isDesktop && (
          <WorldMap
            imageUrl={worldMapImageUrl}
            worldName={project.view?.worldMapName ?? ""}
            worldNameCollectionId={project.view?.worldMapNameCollectionId}
            worldNameEntityId={project.view?.worldMapNameEntityId}
            worldMapIncludeInWiki={project.view?.worldMapIncludeInWiki ?? false}
            docPins={(project.worldMapDocPins ?? []) as WorldMapDocPin[]}
            labelPins={(project.worldMapLabelPins ?? []) as WorldMapLabelPin[]}
            documents={project.documents}
            collections={project.collections}
            onClose={() => setWorldMapOpen(false)}
            onUploadImage={uploadWorldMapImage}
            onPickImagePath={setWorldMapImageFromAsset}
            onRemoveImage={removeWorldMapImage}
            onSetWorldName={setWorldMapName}
            onSetIncludeInWiki={setWorldMapIncludeInWiki}
            onAddDocPin={addWorldMapDocPin}
            onMoveDocPin={updateWorldMapDocPinPos}
            onRemoveDocPin={removeWorldMapDocPin}
            onAddLabelPin={addWorldMapLabelPin}
            onMoveLabelPin={updateWorldMapLabelPinPos}
            onRemoveLabelPin={removeWorldMapLabelPin}
            onOpenDoc={(id) => { setActiveDocId(id); setWorldMapOpen(false); }}
            onSave={() => saveProjectToSupabase()}
            showWikiOption={!isDesktop}
            savedMaps={(archiveActiveWorldMap(project).worldMaps).map((m) => ({ id: m.id, name: m.name, hasImage: !!m.imagePath }))}
            activeMapId={project.view?.activeWorldMapId ?? ""}
            onMakeNewMap={makeNewWorldMap}
            onLoadMap={loadWorldMap}
            onSelectRecord={selectOrCreateWorldMapForRecord}
            onClearDocPins={clearWorldMapDocPins}
            onClearLabelPins={clearWorldMapLabelPins}
            saveMessage={saveMessage}
          />
        )}

        {/* TIMELINE overlay (web only; desktop opens the timeline in a window) */}
        {timelineEnabled && !isDesktop && (
          <div
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: 0,
              height: timelineHeight,
              zIndex: 80,
              borderTop: "1px solid var(--border-2)",
              background: "var(--bg-surface)",
              boxShadow: "0 -10px 25px var(--overlay-3)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Slim drag-to-resize strip (the Close button lives in the Timeline header now) */}
            <div
              onMouseDown={beginTimelineResize}
              title="Drag to resize"
              style={{ height: 6, flexShrink: 0, cursor: "ns-resize", background: "var(--bg-hover)" }}
            />

            <div style={{ flex: 1, minHeight: 0 }}>
              <Timeline
                enabled={timelineEnabled}
                documents={project.documents}
                collections={project.collections}
                labels={timelineLabels}
                beatCount={timelineBeatCount}
                timelineCovers={timelineCoverUrls}
                sectionTitles={project.view?.timelineSectionTitles ?? {}}
                onRenameSection={renameTimelineSection}
                onInsertBeat={insertBeatAfter}
                onRemoveBeat={removeBeatAt}
                onMoveDoc={moveDocOnTimeline}
                onOpenDoc={(id) => setActiveDocId(id)}
                onAddEntityLabel={addTimelineEntityLabel}
                onDeleteLabel={deleteTimelineLabel}
                onUploadCover={uploadTimelineCover}
                onRemoveCover={removeTimelineCover}
                onSelectEntity={openEntityInCollection}
                onClose={() => setTimelineVisible(false)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
