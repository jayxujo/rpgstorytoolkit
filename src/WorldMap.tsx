import React, { useEffect, useRef, useState } from "react";
import type { Id, Document, Collection, WorldMapDocPin, WorldMapLabelPin, WorldNameCtx } from "./types";
import { entityLabel } from "./entityLabel";
import { useLang } from "./i18n";

interface WorldMapProps {
  imageUrl: string | null;
  worldName: string;
  worldNameCollectionId?: Id;
  worldNameEntityId?: Id;
  worldMapIncludeInWiki: boolean;
  docPins: WorldMapDocPin[];
  labelPins: WorldMapLabelPin[];
  documents: Document[];
  collections: Collection[];
  onClose: () => void;
  onUploadImage: (file: File, nameCtx?: WorldNameCtx) => Promise<void>;
  onPickImagePath: (path: string) => void;
  onRemoveImage: () => Promise<void>;
  onSetWorldName: (name: string, collectionId?: Id, entityId?: Id) => void;
  onSetIncludeInWiki: (include: boolean) => void;
  onAddDocPin: (docId: Id, x: number, y: number) => void;
  onMoveDocPin: (pinId: Id, x: number, y: number) => void;
  onRemoveDocPin: (pinId: Id) => void;
  onAddLabelPin: (collectionId: Id, entityId: Id, x: number, y: number) => void;
  onMoveLabelPin: (pinId: Id, x: number, y: number) => void;
  onRemoveLabelPin: (pinId: Id) => void;
  onSetDocPinBorder: (pinId: Id, border: { x: number; y: number }[] | null) => void;
  onSetLabelPinBorder: (pinId: Id, border: { x: number; y: number }[] | null) => void;
  onOpenDoc: (id: Id) => void;
  onOpenRecord?: (collectionId: Id, entityId: Id) => void;
  onSave: () => void;
  showWikiOption?: boolean; // hide the "Include in wiki" toggle on desktop
  embedded?: boolean; // when true, fill the parent container instead of a full-screen overlay

  // Multi-map management (File menu)
  savedMaps: { id: string; name: string; hasImage: boolean }[];
  activeMapId?: string;
  onMakeNewMap: () => void;
  onLoadMap: (id: string) => void;
  onSelectRecord: (collectionId: Id, entityId: Id, name: string) => void;
  onClearDocPins: () => void;
  onClearLabelPins: () => void;
  saveMessage?: string | null;
}

type AddMode = "none" | "addDoc" | "addLabel";

const WorldMap: React.FC<WorldMapProps> = ({
  imageUrl,
  worldName,
  worldNameCollectionId,
  worldNameEntityId,
  worldMapIncludeInWiki,
  docPins,
  labelPins,
  documents,
  collections,
  onClose,
  onUploadImage,
  onPickImagePath,
  onSetWorldName,
  onSetIncludeInWiki,
  onAddDocPin,
  onMoveDocPin,
  onRemoveDocPin,
  onAddLabelPin,
  onMoveLabelPin,
  onRemoveLabelPin,
  onSetDocPinBorder,
  onSetLabelPinBorder,
  onOpenDoc,
  onOpenRecord,
  onSave,
  showWikiOption = true,
  embedded = false,
  savedMaps,
  activeMapId,
  onMakeNewMap,
  onLoadMap,
  onSelectRecord,
  onClearDocPins,
  onClearLabelPins,
  saveMessage,
}) => {
  const { t } = useLang();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const didDrag = useRef(false);
  // Timestamp of the last pin drag end. Used to ignore the click that browsers fire
  // right after a drag (which previously could place a stray pin or get permanently
  // "stuck" because didDrag was never reset).
  const dragEndedAt = useRef(0);
  // Synchronous "ready to place" flag. `addMode` is React state (async), so two clicks in
  // quick succession can both read the stale "addDoc"/"addLabel" value and place twice.
  // This ref is set false the instant a pin is placed, blocking the duplicate immediately.
  const armedRef = useRef(false);

  const [addMode, setAddMode] = useState<AddMode>("none");
  const [pendingDocId, setPendingDocId] = useState<string>("");
  const [pendingLabelCollectionId, setPendingLabelCollectionId] = useState<string>("");
  const [pendingLabelEntityId, setPendingLabelEntityId] = useState<string>("");

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(worldName);
  const [nameSourceMode, setNameSourceMode] = useState<"text" | "entity">(
    worldNameCollectionId ? "entity" : "text"
  );
  const [nameCollectionId, setNameCollectionId] = useState(worldNameCollectionId ?? "");
  const [nameEntityId, setNameEntityId] = useState(worldNameEntityId ?? "");

  const [popupPinId, setPopupPinId] = useState<string | null>(null);
  const [draggingPin, setDraggingPin] = useState<{ id: string; kind: "doc" | "label" } | null>(null);

  // ── Pan / zoom canvas ───────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Map a percentage map-point to a pixel position within the viewport. Pins + borders
  // render in a non-transformed overlay using this, so they stay crisp at any zoom.
  const toScreen = (xPct: number, yPct: number) => ({
    left: pan.x + (xPct / 100) * imgNatural.w * zoom,
    top: pan.y + (yPct / 100) * imgNatural.h * zoom,
  });
  const panningRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 8;

  // Center + fit the map so even a small image fills a good portion of the view
  // (scales up to a minimum, down to fit a large one), leaving a margin.
  const fitToView = () => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (vw <= 0 || vh <= 0 || iw <= 0 || ih <= 0) return; // not laid out / not loaded yet
    const pad = 0.92; // leave a small margin
    // Fit large images down; scale small images up to at least fill ~70% of the view.
    const fit = Math.min((vw / iw) * pad, (vh / ih) * pad);
    const minFill = Math.min((vw * 0.7) / iw, (vh * 0.7) / ih);
    const z = Math.max(Math.min(fit, ZOOM_MAX), Math.min(minFill, ZOOM_MAX), ZOOM_MIN);
    setZoom(z);
    setPan({ x: (vw - iw * z) / 2, y: (vh - ih * z) / 2 });
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    setZoom((z) => {
      const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor));
      const k = nz / z;
      setPan((p) => ({ x: mx - (mx - p.x) * k, y: my - (my - p.y) * k }));
      return nz;
    });
  };

  const onCanvasWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  // Pan when dragging empty map area (not on a pin, not while placing a pin).
  const startPan = (e: React.MouseEvent) => {
    if (addMode !== "none" || drawing) return;
    if (e.button !== 0) return;
    panningRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
    const onMove = (ev: MouseEvent) => {
      const s = panningRef.current;
      if (!s) return;
      setPan({ x: s.panX + (ev.clientX - s.startX), y: s.panY + (ev.clientY - s.startY) });
    };
    const onUp = () => {
      panningRef.current = null;
      setIsPanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Pin region drawing (polygonal lasso) ────────────────────────────────────
  const [pinCtxMenu, setPinCtxMenu] = useState<{ kind: "doc" | "label"; pinId: string; x: number; y: number } | null>(null);
  const [drawing, setDrawing] = useState<{ kind: "doc" | "label"; pinId: string } | null>(null);
  const [drawPoints, setDrawPoints] = useState<{ x: number; y: number }[]>([]);
  const [cursorPt, setCursorPt] = useState<{ x: number; y: number } | null>(null);
  const [highlightPinId, setHighlightPinId] = useState<string | null>(null);

  const pctFromEvent = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100)),
    };
  };

  const pinColor = (kind: "doc" | "label", pin: WorldMapDocPin | WorldMapLabelPin): string => {
    if (kind === "label") {
      const lp = pin as WorldMapLabelPin;
      return collections.find((c) => c.id === lp.collectionId)?.color ?? "#9aa0a6";
    }
    return "#9aa0a6"; // doc pins → neutral grey
  };

  const startDrawBorder = (kind: "doc" | "label", pinId: string) => {
    setPinCtxMenu(null);
    setAddMode("none");
    setPopupPinId(null);
    setDrawPoints([]);
    setCursorPt(null);
    setDrawing({ kind, pinId });
  };

  const completeBorder = () => {
    if (!drawing) return;
    const pts = drawPoints;
    if (pts.length >= 3) {
      if (drawing.kind === "doc") onSetDocPinBorder(drawing.pinId as Id, pts);
      else onSetLabelPinBorder(drawing.pinId as Id, pts);
      onSave();
    }
    setDrawing(null);
    setDrawPoints([]);
    setCursorPt(null);
  };

  const cancelDrawing = () => {
    setDrawing(null);
    setDrawPoints([]);
    setCursorPt(null);
  };

  const deleteBorder = (kind: "doc" | "label", pinId: string) => {
    if (kind === "doc") onSetDocPinBorder(pinId as Id, null);
    else onSetLabelPinBorder(pinId as Id, null);
    onSave();
  };

  // Esc cancels an in-progress drawing; Enter completes it.
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancelDrawing(); }
      else if (e.key === "Enter") { e.preventDefault(); completeBorder(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, drawPoints]);

  const [uploading, setUploading] = useState(false);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);

  // In-component confirm dialog (window.confirm is a no-op inside the Tauri webview).
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; confirmLabel: string; danger?: boolean; onYes: () => void } | null>(null);
  const askConfirm = (message: string, onYes: () => void, opts?: { confirmLabel?: string; danger?: boolean }) =>
    setConfirmDialog({ message, onYes, confirmLabel: opts?.confirmLabel ?? "Confirm", danger: opts?.danger });

  // Current name selection, packaged so an upload can be filed against the right record.
  const currentNameCtx = (): WorldNameCtx =>
    nameSourceMode === "entity" && nameCollectionId && nameEntityId
      ? { mode: "entity", collectionId: nameCollectionId as Id, entityId: nameEntityId as Id }
      : { mode: "text", name: nameDraft.trim() };

  // Image attachments on a single record — the source for "choose from this record's images".
  const recordImageAssets = (colId?: string, entId?: string) => {
    const col = collections.find((c) => c.id === colId);
    const row = col?.rows.find((r) => r.id === entId);
    if (!col || !row) return [] as { path: string; name: string; sub: string }[];
    return (row.assets ?? [])
      .filter((a) => (a.mime || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(a.name))
      .map((a) => ({ path: a.path, name: a.name, sub: `${col.name} › ${entityLabel(row) || row.id}` }));
  };

  // The list currently shown by the floating asset picker (map view).
  const [pickerAssets, setPickerAssets] = useState<{ path: string; name: string; sub: string }[]>([]);
  const openAssetPicker = (list: { path: string; name: string; sub: string }[]) => {
    setPickerAssets(list);
    setShowAssetPicker(true);
  };

  // Fit the map when its image changes (covers cached images where onLoad is immediate
  // and the case where the viewport lays out after the image is ready).
  useEffect(() => {
    if (!imageUrl) return;
    const id = requestAnimationFrame(() => fitToView());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // Two-step setup wizard: 1 = create/select the world record, 2 = set its map image.
  const [setupStep, setSetupStep] = useState<1 | 2>(1);
  useEffect(() => {
    if (!imageUrl) setSetupStep(1);
  }, [imageUrl]);

  // Tracks when the map image fails to load (e.g. the underlying asset was deleted
  // from the record). We keep the world's reference but show a "replace it" prompt.
  const [imageBroken, setImageBroken] = useState(false);
  useEffect(() => { setImageBroken(false); }, [imageUrl]);

  const startDragPin = (
    e: React.MouseEvent,
    pinId: string,
    kind: "doc" | "label"
  ) => {
    if (drawing) return; // don't move pins while drawing a border
    e.preventDefault();
    e.stopPropagation();
    didDrag.current = false;
    setDraggingPin({ id: pinId, kind });
    setPopupPinId(null);

    // Grabbing an existing pin means the user wants to move it, not place a new one.
    // Exit placement mode so a stray map click during/after the drag can't add a pin.
    armedRef.current = false;
    if (addMode !== "none") {
      setAddMode("none");
      setPendingDocId("");
      setPendingLabelCollectionId("");
      setPendingLabelEntityId("");
    }

    // Capture rect once at drag start — re-renders during drag shift the image
    // position slightly, so calling getBoundingClientRect() on every move causes jitter.
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100));
      didDrag.current = true;
      if (kind === "doc") onMoveDocPin(pinId as Id, x, y);
      else onMoveLabelPin(pinId as Id, x, y);
    };

    const onUp = () => {
      setDraggingPin(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (didDrag.current) {
        onSave();
        dragEndedAt.current = Date.now();
      }
      // Always reset so the next map click can place a pin.
      didDrag.current = false;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Drag an existing border: "move" shifts the whole shape; "vertex" reshapes one point.
  const startBorderDrag = (
    e: React.MouseEvent,
    kind: "doc" | "label",
    pinId: string,
    mode: "move" | "vertex",
    vertexIndex?: number
  ) => {
    if (drawing || addMode !== "none") return;
    if ((e as React.MouseEvent).button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const pin = (kind === "doc" ? docPins : labelPins).find((p) => p.id === pinId) as
      | WorldMapDocPin
      | WorldMapLabelPin
      | undefined;
    if (!pin?.border || pin.border.length < 3) return;
    const startBorder = pin.border.map((p) => ({ ...p }));
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    const at = (cx: number, cy: number) => ({
      x: ((cx - rect.left) / rect.width) * 100,
      y: ((cy - rect.top) / rect.height) * 100,
    });
    const start = at(e.clientX, e.clientY);
    setHighlightPinId(pinId);
    const setBorder = kind === "doc" ? onSetDocPinBorder : onSetLabelPinBorder;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      const cur = at(ev.clientX, ev.clientY);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      moved = true;
      const next =
        mode === "move"
          ? startBorder.map((p) => ({ x: clamp(p.x + dx), y: clamp(p.y + dy) }))
          : startBorder.map((p, i) => (i === vertexIndex ? { x: clamp(p.x + dx), y: clamp(p.y + dy) } : p));
      setBorder(pinId as Id, next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (moved) { onSave(); dragEndedAt.current = Date.now(); }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    // Drawing a border: each click adds a vertex; clicking near the first point
    // (a "full circle") closes the shape.
    if (drawing) {
      const pt = pctFromEvent(e.clientX, e.clientY);
      if (!pt) return;
      if (drawPoints.length >= 3) {
        const first = drawPoints[0];
        if (Math.hypot(pt.x - first.x, pt.y - first.y) < 3) { completeBorder(); return; }
      }
      setDrawPoints((p) => [...p, pt]);
      return;
    }
    if (addMode === "none") return;
    // Never place while a pin drag is in progress or just finished.
    if (draggingPin) return;
    if (Date.now() - dragEndedAt.current < 250) return;
    // Synchronous guard — blocks a duplicate placement before React re-renders.
    if (!armedRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (addMode === "addDoc" && pendingDocId) {
      armedRef.current = false;
      onAddDocPin(pendingDocId as Id, x, y);
      onSave();
      setAddMode("none");
      setPendingDocId("");
    } else if (addMode === "addLabel" && pendingLabelCollectionId && pendingLabelEntityId) {
      armedRef.current = false;
      onAddLabelPin(pendingLabelCollectionId as Id, pendingLabelEntityId as Id, x, y);
      onSave();
      setAddMode("none");
      setPendingLabelCollectionId("");
      setPendingLabelEntityId("");
    }
  };

  const commitName = () => {
    setEditingName(false);
    if (nameSourceMode === "entity" && nameCollectionId && nameEntityId) {
      const col = collections.find((c) => c.id === nameCollectionId);
      const row = col?.rows.find((r) => r.id === nameEntityId);
      const entityName = row ? entityLabel(row) : "";
      onSetWorldName(entityName, nameCollectionId as Id, nameEntityId as Id);
    } else {
      onSetWorldName(nameDraft.trim());
    }
    onSave();
  };

  const overlayStyle: React.CSSProperties = {
    position: embedded ? "absolute" : "fixed",
    inset: 0,
    zIndex: embedded ? 1 : 85,
    background: "var(--bg)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  const toolbarStyle: React.CSSProperties = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid var(--border-2)",
    background: "var(--bg-panel)",
    flexWrap: "wrap",
  };

  const btnBase: React.CSSProperties = {
    borderRadius: 6,
    border: "1px solid var(--border-3)",
    backgroundColor: "transparent",
    color: "var(--text-2)",
    cursor: "pointer",
    fontSize: 12,
    padding: "5px 10px",
  };

  const btnActive: React.CSSProperties = {
    ...btnBase,
    border: "1px solid var(--accent)",
    backgroundColor: "var(--accent-bg)",
    color: "var(--text)",
  };

  const inputStyle: React.CSSProperties = {
    borderRadius: 6,
    border: "1px solid var(--border-2)",
    backgroundColor: "var(--bg-surface)",
    color: "var(--text)",
    padding: "5px 8px",
    fontSize: 12,
  };

  const menuDivider: React.CSSProperties = { height: 1, background: "var(--border)", margin: "4px 0" };

  // File menu — matches the top-bar File menu: bordered items + right-flyout submenus.
  const fileItem: React.CSSProperties = {
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
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  };
  const flyoutPanel: React.CSSProperties = {
    position: "absolute",
    left: "100%",
    top: -10,
    marginLeft: 4,
    minWidth: 220,
    backgroundColor: "var(--bg-elevated)",
    border: "1px solid var(--border-2)",
    borderRadius: 10,
    padding: 10,
    zIndex: 112,
    boxShadow: "0 10px 25px var(--overlay-3, rgba(0,0,0,0.45))",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const renderFileMenu = (inMap: boolean) => {
    const loadable = savedMaps.filter((m) => m.hasImage);
    const closeMenu = () => { setFileMenuOpen(false); setLoadOpen(false); setReplaceOpen(false); };
    const recAssets = recordImageAssets(worldNameCollectionId, worldNameEntityId);
    return (
      <div style={{ position: "relative" }}>
        <button type="button" style={fileMenuOpen ? btnActive : btnBase} onClick={() => setFileMenuOpen((o) => !o)}>{t("menu.file")} ▾</button>
        {fileMenuOpen && (
          <>
            <div onClick={closeMenu} style={{ position: "fixed", inset: 0, zIndex: 110 }} />
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 6,
                zIndex: 111,
                minWidth: 230,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 10,
                padding: 10,
                boxShadow: "0 10px 25px var(--overlay-3, rgba(0,0,0,0.45))",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {inMap && (
                <>
                  <button
                    type="button"
                    style={fileItem}
                    onMouseEnter={() => { setLoadOpen(false); setReplaceOpen(false); }}
                    onClick={() => { closeMenu(); onSave(); }}
                  >
                    <span>{t("file.saveNow")}</span>
                  </button>
                  <div style={menuDivider} />
                  <button
                    type="button"
                    style={fileItem}
                    onMouseEnter={() => { setLoadOpen(false); setReplaceOpen(false); }}
                    onClick={() => {
                      closeMenu();
                      askConfirm(
                        "This map is saved — you can reopen it any time from File ▸ Load map. Start a new map?",
                        () => onMakeNewMap(),
                        { confirmLabel: t("wmap.makeNewMap") }
                      );
                    }}
                  >
                    <span>{t("wmap.makeNewMap")}</span>
                  </button>
                </>
              )}

              {/* Load map ▸ */}
              <div style={{ position: "relative" }} onMouseLeave={() => setLoadOpen(false)}>
                <button
                  type="button"
                  style={fileItem}
                  onMouseEnter={() => { setLoadOpen(loadable.length > 0); setReplaceOpen(false); }}
                  onClick={() => loadable.length > 0 && setLoadOpen((o) => !o)}
                >
                  <span style={{ opacity: loadable.length > 0 ? 1 : 0.5 }}>{t("wmap.loadMap")}</span>
                  <span style={{ opacity: 0.9 }}>▸</span>
                </button>
                {loadOpen && (
                  <div style={flyoutPanel} onMouseEnter={() => setLoadOpen(true)}>
                    {loadable.length === 0 ? (
                      <div style={{ ...fileItem, border: "none", cursor: "default", opacity: 0.5 }}>{t("wmap.noSavedMaps")}</div>
                    ) : (
                      loadable.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          style={{ ...fileItem, opacity: m.id === activeMapId ? 0.6 : 1 }}
                          onClick={() => { closeMenu(); if (m.id !== activeMapId) onLoadMap(m.id); }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.name || "(unnamed)"}
                          </span>
                          {m.id === activeMapId && <span>✓</span>}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {inMap && (
                <>
                  <div style={menuDivider} />

                  {/* Replace image ▸ */}
                  <div style={{ position: "relative" }} onMouseLeave={() => setReplaceOpen(false)}>
                    <button
                      type="button"
                      style={fileItem}
                      onMouseEnter={() => { setReplaceOpen(true); setLoadOpen(false); }}
                      onClick={() => setReplaceOpen((o) => !o)}
                    >
                      <span>{uploading ? t("common.uploading") : t("wmap.replaceImage")}</span>
                      <span style={{ opacity: 0.9 }}>▸</span>
                    </button>
                    {replaceOpen && (
                      <div style={flyoutPanel} onMouseEnter={() => setReplaceOpen(true)}>
                        <label style={{ ...fileItem, cursor: uploading ? "default" : "pointer" }}>
                          <span>{t("wmap.uploadNewImage")}</span>
                          <input
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            disabled={uploading}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              e.currentTarget.value = "";
                              if (!f) return;
                              closeMenu();
                              askConfirm(
                                "Replace the current map image with this upload? The previous image stays attached to the record as an asset.",
                                async () => { setUploading(true); await onUploadImage(f); setUploading(false); },
                                { confirmLabel: "Replace" }
                              );
                            }}
                          />
                        </label>
                        {recAssets.length > 0 && (
                          <button
                            type="button"
                            style={fileItem}
                            onClick={() => { closeMenu(); openAssetPicker(recAssets); }}
                          >
                            <span>{t("wmap.chooseFromAssets")}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={menuDivider} />

                  <button
                    type="button"
                    style={fileItem}
                    onMouseEnter={() => { setLoadOpen(false); setReplaceOpen(false); }}
                    onClick={() => {
                      closeMenu();
                      askConfirm("Clear all document pins from this map?", () => onClearDocPins(), { confirmLabel: "Clear", danger: true });
                    }}
                  >
                    <span>{t("wmap.clearDocPins")}</span>
                  </button>
                  <button
                    type="button"
                    style={fileItem}
                    onMouseEnter={() => { setLoadOpen(false); setReplaceOpen(false); }}
                    onClick={() => {
                      closeMenu();
                      askConfirm("Clear all record pins from this map?", () => onClearLabelPins(), { confirmLabel: "Clear", danger: true });
                    }}
                  >
                    <span>{t("wmap.clearRecordPins")}</span>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  // Setup phase: a standalone "Load map" button (no File menu needed there).
  const renderLoadMapButton = () => {
    const loadable = savedMaps.filter((m) => m.hasImage);
    const empty = loadable.length === 0;
    return (
      <div style={{ position: "relative" }}>
        <button
          type="button"
          style={{ ...(loadOpen ? btnActive : btnBase), opacity: empty ? 0.5 : 1, cursor: empty ? "default" : "pointer" }}
          title={empty ? t("wmap.noSavedMaps") : t("wmap.loadMap")}
          onClick={() => !empty && setLoadOpen((o) => !o)}
        >
          Load map ▾
        </button>
        {loadOpen && !empty && (
          <>
            <div onClick={() => setLoadOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 110 }} />
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                zIndex: 111,
                minWidth: 200,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 10,
                padding: 10,
                boxShadow: "0 10px 25px var(--overlay-3, rgba(0,0,0,0.45))",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {loadable.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  style={{ ...fileItem, opacity: m.id === activeMapId ? 0.6 : 1 }}
                  onClick={() => { setLoadOpen(false); if (m.id !== activeMapId) onLoadMap(m.id); }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name || "(unnamed)"}
                  </span>
                  {m.id === activeMapId && <span>✓</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  // Confirm dialog (used in both views; works inside the Tauri webview).
  const confirmModal = confirmDialog ? (
    <div
      onClick={() => setConfirmDialog(null)}
      style={{ position: "fixed", inset: 0, zIndex: 130, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 12, padding: 20, maxWidth: 380, width: "100%" }}
      >
        <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 16 }}>{confirmDialog.message}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" style={btnBase} onClick={() => setConfirmDialog(null)}>{t("common.cancel")}</button>
          <button
            type="button"
            style={confirmDialog.danger
              ? { ...btnBase, border: "1px solid var(--danger-border-2)", color: "var(--danger-text)" }
              : btnActive}
            onClick={() => { const fn = confirmDialog.onYes; setConfirmDialog(null); fn(); }}
          >
            {confirmDialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // Shared "Choose an image asset" picker (rendered in both setup and map views).
  const pickerModal = showAssetPicker ? (
    <div
      onClick={() => setShowAssetPicker(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-2)",
          borderRadius: 12,
          width: "100%",
          maxWidth: 460,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-2)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: "var(--text)" }}>{t("wmap.chooseImageAsset")}</div>
          <button type="button" onClick={() => setShowAssetPicker(false)} style={btnBase}>{t("common.close")}</button>
        </div>
        <div style={{ overflow: "auto", padding: 8 }}>
          {pickerAssets.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, opacity: 0.7 }}>
              No image assets on this record yet. Upload one instead.
            </div>
          ) : (
            pickerAssets.map((a) => (
              <button
                key={a.path}
                type="button"
                onClick={() => {
                  onPickImagePath(a.path);
                  setShowAssetPicker(false);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  width: "100%",
                  textAlign: "left",
                  border: "1px solid transparent",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text)",
                  cursor: "pointer",
                  padding: "8px 10px",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                  {a.name}
                </span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>{a.sub}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  ) : null;

  // ---- Setup wizard (no image yet) ----
  if (!imageUrl) {
    const selectedRow = collections.find((c) => c.id === nameCollectionId)?.rows.find((r) => r.id === nameEntityId) ?? null;
    const existingEntityName = selectedRow ? entityLabel(selectedRow) : "";
    const step1Valid =
      nameSourceMode === "entity" ? !!(nameCollectionId && nameEntityId) : !!nameDraft.trim();
    const step2Assets = nameSourceMode === "entity" ? recordImageAssets(nameCollectionId, nameEntityId) : [];
    const worldLabel = nameSourceMode === "entity" ? existingEntityName : nameDraft.trim() || "your world";

    const uploadDropzone = (
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          border: "2px dashed var(--border-2)",
          borderRadius: 10,
          padding: "20px 16px",
          cursor: uploading ? "default" : "pointer",
          color: "var(--text-dim)",
          fontSize: 13,
          background: "var(--bg-surface)",
        }}
      >
        <input
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          disabled={uploading}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setUploading(true);
            await onUploadImage(file, currentNameCtx());
            setUploading(false);
          }}
        />
        {uploading ? t("common.uploading") : t("wmap.clickToUpload")}
      </label>
    );

    return (
      <div style={overlayStyle}>
        {confirmModal}
        <div style={toolbarStyle}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{t("term.worldMap")}</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Step {setupStep} of 2</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {renderLoadMapButton()}
            <button type="button" onClick={onClose} style={btnBase}>{t("common.close")}</button>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-2)",
              borderRadius: 14,
              padding: 28,
              maxWidth: 480,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            {setupStep === 1 ? (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>{t("wmap.createWorld")}</div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => setNameSourceMode("text")} style={nameSourceMode === "text" ? btnActive : btnBase}>
                    Create new
                  </button>
                  <button type="button" onClick={() => setNameSourceMode("entity")} style={nameSourceMode === "entity" ? btnActive : btnBase}>
                    Use existing record
                  </button>
                </div>

                {nameSourceMode === "text" ? (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>{t("wmap.worldName")}</div>
                    <input
                      autoFocus
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      placeholder={t("wmap.worldNamePh")}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && step1Valid) setSetupStep(2); }}
                    />
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                      Creates a record (in a <b>Map</b> table) named after your world. The map image attaches to it.
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>{t("wmap.pickRecord")}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        className="themed-select"
                        style={{ ...inputStyle, flex: 1 }}
                        value={nameCollectionId}
                        onChange={(e) => { setNameCollectionId(e.target.value); setNameEntityId(""); }}
                      >
                        <option value="">{t("cond.phTable")}</option>
                        {collections.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                      </select>
                      <select
                        className="themed-select"
                        style={{ ...inputStyle, flex: 1 }}
                        value={nameEntityId}
                        onChange={(e) => setNameEntityId(e.target.value)}
                        disabled={!nameCollectionId}
                      >
                        <option value="">{t("cond.phRecord")}</option>
                        {(collections.find((c) => c.id === nameCollectionId)?.rows ?? []).map((r) => (
                          <option key={r.id} value={r.id}>{entityLabel(r)}</option>
                        ))}
                      </select>
                    </div>
                    {existingEntityName && (
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
                        World name will be: <b>{existingEntityName}</b>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    disabled={!step1Valid}
                    onClick={() => {
                      if (nameSourceMode === "entity" && nameCollectionId && nameEntityId) {
                        onSelectRecord(nameCollectionId as Id, nameEntityId as Id, existingEntityName);
                      }
                      setSetupStep(2);
                    }}
                    style={{ ...(step1Valid ? btnActive : btnBase), opacity: step1Valid ? 1 : 0.5, cursor: step1Valid ? "pointer" : "default" }}
                  >
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>{t("wmap.setMapImage")}</div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: -8 }}>
                  for <b>{worldLabel}</b>
                </div>

                {step2Assets.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>
                      Choose from this record's images
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflow: "auto" }}>
                      {step2Assets.map((a) => (
                        <button
                          key={a.path}
                          type="button"
                          onClick={() => onPickImagePath(a.path)}
                          style={{
                            textAlign: "left",
                            border: "1px solid var(--border-2)",
                            borderRadius: 8,
                            background: "var(--bg-surface)",
                            color: "var(--text)",
                            cursor: "pointer",
                            padding: "8px 10px",
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                          onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-2)")}
                        >
                          {a.name}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0 4px" }}>
                      <div style={{ flex: 1, height: 1, background: "var(--border-2)" }} />
                      <span style={{ fontSize: 11, opacity: 0.6 }}>or upload a new image</span>
                      <div style={{ flex: 1, height: 1, background: "var(--border-2)" }} />
                    </div>
                  </div>
                )}

                {uploadDropzone}
                <div style={{ fontSize: 11, opacity: 0.6, marginTop: -8 }}>{t("wmap.imageFormats")}</div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button type="button" onClick={() => setSetupStep(1)} style={btnBase}>{t("common.back")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Map view ----
  const selectedCollection = collections.find((c) => c.id === nameCollectionId);
  const selectedEntity = selectedCollection?.rows.find((r) => r.id === nameEntityId);
  const entityDisplayName = selectedEntity
    ? entityLabel(selectedEntity)
    : "";

  const popupPin = docPins.find((p) => p.id === popupPinId);
  const popupDoc = popupPin ? documents.find((d) => d.id === popupPin.docId) : null;
  // Record (label) pin popup: same "read more" card, showing the record's description.
  const popupLabelPin = labelPins.find((p) => p.id === popupPinId);
  const popupLabelCol = popupLabelPin ? collections.find((c) => c.id === popupLabelPin.collectionId) : null;
  const popupLabelRow = popupLabelCol?.rows.find((r) => r.id === popupLabelPin?.entityId) ?? null;

  return (
    <div style={overlayStyle}>
      {pickerModal}
      {confirmModal}
      {/* Toolbar */}
      <div style={toolbarStyle}>
        {/* File menu (left, next to the name) */}
        {renderFileMenu(true)}

        <div style={{ width: 1, height: 20, background: "var(--border-2)", margin: "0 4px" }} />

        {/* Add doc pin */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              const next = addMode === "addDoc" ? "none" : "addDoc";
              setAddMode(next);
              armedRef.current = next !== "none";
            }}
            style={addMode === "addDoc" ? btnActive : btnBase}
          >
            {t("wmap.addDocPin")}
          </button>
          {addMode === "addDoc" && (
            <select
              className="themed-select"
              style={{ ...inputStyle, maxWidth: 180 }}
              value={pendingDocId}
              onChange={(e) => setPendingDocId(e.target.value)}
            >
              <option value="">{t("wmap.selectDocument")}</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>{d.title || d.id}</option>
              ))}
            </select>
          )}
          {addMode === "addDoc" && pendingDocId && (
            <span style={{ fontSize: 11, color: "var(--accent-text)", opacity: 0.8 }}>
              {t("wmap.clickToPlace")}
            </span>
          )}
        </div>

        {/* Add record pin */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              const next = addMode === "addLabel" ? "none" : "addLabel";
              setAddMode(next);
              armedRef.current = next !== "none";
            }}
            style={addMode === "addLabel" ? btnActive : btnBase}
          >
            {t("wmap.addRecordPin")}
          </button>
          {addMode === "addLabel" && (
            <>
              <select
                className="themed-select"
                style={{ ...inputStyle, maxWidth: 140 }}
                value={pendingLabelCollectionId}
                onChange={(e) => { setPendingLabelCollectionId(e.target.value); setPendingLabelEntityId(""); }}
              >
                <option value="">{t("cond.phTable")}</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {pendingLabelCollectionId && (
                <select
                  className="themed-select"
                  style={{ ...inputStyle, maxWidth: 160 }}
                  value={pendingLabelEntityId}
                  onChange={(e) => setPendingLabelEntityId(e.target.value)}
                >
                  <option value="">{t("cond.phRecord")}</option>
                  {(collections.find((c) => c.id === pendingLabelCollectionId)?.rows ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {entityLabel(r)}
                    </option>
                  ))}
                </select>
              )}
              {pendingLabelCollectionId && pendingLabelEntityId && (
                <span style={{ fontSize: 11, color: "var(--accent-text)", opacity: 0.8 }}>
                  {t("wmap.clickToPlace")}
                </span>
              )}
            </>
          )}
        </div>

        <div style={{ width: 1, height: 20, background: "var(--border-2)", margin: "0 4px" }} />

        {/* World name — click to edit in a small popover */}
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={() => {
              if (editingName) { setEditingName(false); return; }
              setNameDraft(worldName);
              setNameSourceMode(worldNameCollectionId ? "entity" : "text");
              setNameCollectionId(worldNameCollectionId ?? "");
              setNameEntityId(worldNameEntityId ?? "");
              setEditingName(true);
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
            title={t("wmap.editWorldName")}
          >
            {worldName || entityDisplayName || "Unnamed World"}
            <span style={{ opacity: 0.5, fontSize: 12 }}>✎</span>
          </button>

          {editingName && (
            <>
              <div onClick={() => setEditingName(false)} style={{ position: "fixed", inset: 0, zIndex: 110 }} />
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 6,
                  zIndex: 111,
                  width: 250,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-2)",
                  borderRadius: 10,
                  padding: 12,
                  boxShadow: "0 10px 25px var(--overlay-3, rgba(0,0,0,0.45))",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)" }}>{t("wmap.worldName")}</div>

                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => setNameSourceMode("text")} style={{ ...(nameSourceMode === "text" ? btnActive : btnBase), flex: 1 }}>
                    Type a name
                  </button>
                  <button type="button" onClick={() => setNameSourceMode("entity")} style={{ ...(nameSourceMode === "entity" ? btnActive : btnBase), flex: 1 }}>
                    From record
                  </button>
                </div>

                {nameSourceMode === "text" ? (
                  <input
                    autoFocus
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                    placeholder={t("wmap.worldNameInputPh")}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditingName(false); }}
                  />
                ) : (
                  <>
                    <select
                      className="themed-select"
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      value={nameCollectionId}
                      onChange={(e) => { setNameCollectionId(e.target.value); setNameEntityId(""); }}
                    >
                      <option value="">{t("cond.phTable")}</option>
                      {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <select
                      className="themed-select"
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      value={nameEntityId}
                      onChange={(e) => setNameEntityId(e.target.value)}
                      disabled={!nameCollectionId}
                    >
                      <option value="">{t("cond.phRecord")}</option>
                      {(collections.find((c) => c.id === nameCollectionId)?.rows ?? []).map((r) => (
                        <option key={r.id} value={r.id}>{entityLabel(r)}</option>
                      ))}
                    </select>
                  </>
                )}

                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 2 }}>
                  <button type="button" onClick={() => setEditingName(false)} style={btnBase}>{t("common.cancel")}</button>
                  <button type="button" onClick={commitName} style={btnActive}>{t("common.save")}</button>
                </div>
              </div>
            </>
          )}
        </div>

        {saveMessage && <span style={{ fontSize: 12, opacity: 0.8 }}>{saveMessage}</span>}

        {showWikiOption && (
          <>
            <div style={{ width: 1, height: 20, background: "var(--border-2)", margin: "0 4px" }} />

            {/* Wiki toggle */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-dim)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={worldMapIncludeInWiki}
                onChange={(e) => { onSetIncludeInWiki(e.target.checked); onSave(); }}
              />
              {t("wmap.includeInWiki")}
            </label>
          </>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={onClose} style={btnBase}>{t("common.close")}</button>
        </div>
      </div>

      {/* Map canvas (pan + zoom) */}
      <div
        ref={viewportRef}
        style={{
          flex: 1,
          overflow: "hidden",
          position: "relative",
          cursor: (addMode !== "none" || drawing) ? "crosshair" : isPanning ? "grabbing" : "grab",
          touchAction: "none",
          // FigJam-style dot grid that pans + scales with the canvas, for orientation.
          backgroundColor: "var(--bg)",
          backgroundImage: "radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.08)) 1px, transparent 1.5px)",
          backgroundSize: `${Math.min(60, Math.max(16, 22 * zoom))}px ${Math.min(60, Math.max(16, 22 * zoom))}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
        onClick={() => { setPopupPinId(null); }}
        onMouseDown={startPan}
        onMouseMove={(e) => { if (drawing) { const p = pctFromEvent(e.clientX, e.clientY); if (p) setCursorPt(p); } }}
        onWheel={onCanvasWheel}
      >
        {/* Zoom controls */}
        {!imageBroken && (
          <div style={{ position: "absolute", right: 14, bottom: 14, zIndex: 60, display: "flex", flexDirection: "column", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" title={t("wmap.zoomIn")} onClick={() => { const vp = viewportRef.current; if (vp) zoomAt(vp.getBoundingClientRect().left + vp.clientWidth / 2, vp.getBoundingClientRect().top + vp.clientHeight / 2, 1.25); }}
              style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>+</button>
            <button type="button" title={t("wmap.zoomOut")} onClick={() => { const vp = viewportRef.current; if (vp) zoomAt(vp.getBoundingClientRect().left + vp.clientWidth / 2, vp.getBoundingClientRect().top + vp.clientHeight / 2, 1 / 1.25); }}
              style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>−</button>
            <button type="button" title={t("wmap.fitToView")} onClick={fitToView}
              style={{ width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--bg-elevated)", color: "var(--text)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>⤢</button>
          </div>
        )}
        {imageBroken && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              background: "var(--bg-panel)",
              zIndex: 50,
            }}
          >
            <div
              style={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 14,
                padding: 28,
                maxWidth: 420,
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>
                {t("wmap.imageMissing")}
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("wmap.imageMissingDesc")}
              </div>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  ...btnActive,
                  cursor: uploading ? "default" : "pointer",
                  opacity: uploading ? 0.6 : 1,
                }}
              >
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  disabled={uploading}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.currentTarget.value = "";
                    if (!f) return;
                    setUploading(true);
                    await onUploadImage(f, currentNameCtx());
                    setUploading(false);
                  }}
                />
                {uploading ? t("common.uploading") : t("wmap.uploadNewImage")}
              </label>
              {(() => {
                const assets = recordImageAssets(worldNameCollectionId, worldNameEntityId);
                if (assets.length === 0) return null;
                return (
                  <button
                    type="button"
                    style={btnBase}
                    onClick={() => openAssetPicker(assets)}
                  >
                    {t("wmap.chooseFromRecord")}
                  </button>
                );
              })()}
            </div>
          </div>
        )}
        {/* This wrapper must tightly hug the image — pins use percentage coordinates
            relative to this element, and those percentages are calculated from the
            image's bounding rect. If this div is larger than the image the two
            coordinate systems diverge and pins land in the wrong place. */}
        <div style={{ position: "absolute", left: 0, top: 0, display: "inline-block", transformOrigin: "0 0", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <img
            ref={imgRef}
            src={imageUrl}
            alt={t("term.worldMap")}
            draggable={false}
            onError={() => setImageBroken(true)}
            onLoad={(e) => { setImageBroken(false); const im = e.currentTarget; setImgNatural({ w: im.naturalWidth, h: im.naturalHeight }); fitToView(); }}
            onClick={handleImageClick}
            onDoubleClick={(e) => { if (drawing) { e.preventDefault(); completeBorder(); } }}
            style={{
              display: "block",
              userSelect: "none",
              cursor: (addMode !== "none" || drawing) ? "crosshair" : "default",
            }}
          />
        </div>

        {/* Pins + borders overlay — NOT transformed, positioned in screen pixels via
            toScreen() so they stay crisp at any zoom and dots render as true circles. */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {/* Region borders + in-progress lasso */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
            {[
              ...docPins.map((p) => ({ kind: "doc" as const, pin: p as WorldMapDocPin | WorldMapLabelPin })),
              ...labelPins.map((p) => ({ kind: "label" as const, pin: p as WorldMapDocPin | WorldMapLabelPin })),
            ].map(({ kind, pin }) => {
              if (!pin.border || pin.border.length < 3) return null;
              const c = pinColor(kind, pin);
              const active = highlightPinId === pin.id;
              const pts = pin.border.map((p) => { const s = toScreen(p.x, p.y); return `${s.left},${s.top}`; }).join(" ");
              return (
                <g key={`brd-${pin.id}`}>
                  <polygon
                    points={pts}
                    fill={c}
                    fillOpacity={active ? 0.5 : 0.28}
                    stroke={c}
                    strokeOpacity={active ? 1 : 0.95}
                    strokeWidth={active ? 4 : 3}
                    strokeLinejoin="round"
                    style={{ pointerEvents: (drawing || addMode !== "none") ? "none" : "auto", cursor: "move", transition: "fill-opacity 120ms" }}
                    onMouseDown={(e) => startBorderDrag(e, kind, pin.id, "move")}
                    onMouseEnter={() => setHighlightPinId(pin.id)}
                    onMouseLeave={() => setHighlightPinId((cur) => (cur === pin.id ? null : cur))}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPinCtxMenu({ kind, pinId: pin.id, x: e.clientX, y: e.clientY }); }}
                  />
                  {pin.border.map((p, i) => {
                    const s = toScreen(p.x, p.y);
                    const interactive = !drawing && addMode === "none";
                    return (
                      <circle
                        key={i}
                        cx={s.left}
                        cy={s.top}
                        r={active ? 5 : 4}
                        fill="#fff"
                        stroke={c}
                        strokeWidth={2}
                        style={{ pointerEvents: interactive ? "auto" : "none", cursor: "grab" }}
                        onMouseDown={(e) => startBorderDrag(e, kind, pin.id, "vertex", i)}
                        onMouseEnter={() => setHighlightPinId(pin.id)}
                        onMouseLeave={() => setHighlightPinId((cur) => (cur === pin.id ? null : cur))}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPinCtxMenu({ kind, pinId: pin.id, x: e.clientX, y: e.clientY }); }}
                      />
                    );
                  })}
                </g>
              );
            })}

            {/* In-progress drawing: dashed rubber-band + a circle dot at each clicked point */}
            {drawing && drawPoints.length > 0 && (
              <>
                <polyline
                  points={[...drawPoints, ...(cursorPt ? [cursorPt] : [])].map((p) => { const s = toScreen(p.x, p.y); return `${s.left},${s.top}`; }).join(" ")}
                  fill="none"
                  stroke="var(--accent, #4f8cff)"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
                {drawPoints.map((p, i) => { const s = toScreen(p.x, p.y); return <circle key={i} cx={s.left} cy={s.top} r={4.5} fill="#fff" stroke="var(--accent, #4f8cff)" strokeWidth={2} />; })}
              </>
            )}
          </svg>

          {/* Doc pins */}
          {docPins.map((pin) => {
            const doc = documents.find((d) => d.id === pin.docId);
            return (
              <div
                key={pin.id}
                style={{
                  position: "absolute",
                  left: `${toScreen(pin.x, pin.y).left}px`,
                  top: `${toScreen(pin.x, pin.y).top}px`,
                  transform: "translate(-50%, -100%)",
                  transformOrigin: "center bottom",
                  cursor: draggingPin?.id === pin.id ? "grabbing" : "grab",
                  zIndex: popupPinId === pin.id ? 20 : 10,
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  pointerEvents: drawing ? "none" : "auto",
                }}
                onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); return; } startDragPin(e, pin.id, "doc"); }}
                onMouseEnter={() => pin.border && setHighlightPinId(pin.id)}
                onMouseLeave={() => setHighlightPinId((cur) => (cur === pin.id ? null : cur))}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPinCtxMenu({ kind: "doc", pinId: pin.id, x: e.clientX, y: e.clientY }); }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (Date.now() - dragEndedAt.current < 250) return;
                  if (pin.border) setHighlightPinId(pin.id);
                  setPopupPinId(pin.id === popupPinId ? null : pin.id);
                }}
                title={doc?.title ?? pin.docId}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50% 50% 50% 0",
                    transform: "rotate(-45deg)",
                    background: "var(--accent)",
                    border: "2px solid white",
                    boxShadow: highlightPinId === pin.id ? `0 0 0 2px ${pinColor("doc", pin)}, 0 0 10px 2px ${pinColor("doc", pin)}` : "0 2px 8px rgba(0,0,0,0.5)",
                  }}
                />
                {doc && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 26,
                      left: "50%",
                      transform: "translateX(-50%)",
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 6,
                      padding: "2px 6px",
                      fontSize: 10,
                      whiteSpace: "nowrap",
                      pointerEvents: "auto",
                      cursor: "inherit",
                      color: "var(--text)",
                    }}
                  >
                    {doc.title || doc.id}
                  </div>
                )}
              </div>
            );
          })}

          {/* Label pins */}
          {labelPins.map((pin) => {
            const col = collections.find((c) => c.id === pin.collectionId);
            const row = col?.rows.find((r) => r.id === pin.entityId);
            const label = row ? entityLabel(row) : pin.entityId;
            return (
              <div
                key={pin.id}
                style={{
                  position: "absolute",
                  left: `${toScreen(pin.x, pin.y).left}px`,
                  top: `${toScreen(pin.x, pin.y).top}px`,
                  transform: "translate(-50%, -50%)",
                  cursor: draggingPin?.id === pin.id ? "grabbing" : "grab",
                  zIndex: 10,
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  pointerEvents: drawing ? "none" : "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: col?.color ? `${col.color}22` : "var(--bg-elevated)",
                  border: `1px solid ${col?.color ?? "var(--border-2)"}`,
                  borderRadius: 20,
                  padding: "3px 8px 3px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  color: col?.color ?? "var(--text)",
                  boxShadow: highlightPinId === pin.id ? `0 0 0 2px ${col?.color ?? "var(--accent)"}, 0 0 10px 1px ${col?.color ?? "var(--accent)"}` : "0 2px 6px rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
                onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); return; } startDragPin(e, pin.id, "label"); }}
                onMouseEnter={() => pin.border && setHighlightPinId(pin.id)}
                onMouseLeave={() => setHighlightPinId((cur) => (cur === pin.id ? null : cur))}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setPinCtxMenu({ kind: "label", pinId: pin.id, x: e.clientX, y: e.clientY }); }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (Date.now() - dragEndedAt.current < 250) return;
                  if (pin.border) setHighlightPinId(pin.id);
                  setPopupPinId(pin.id === popupPinId ? null : pin.id);
                }}
              >
                {label}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveLabelPin(pin.id as Id);
                    onSave();
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 10,
                    lineHeight: 1,
                    color: "inherit",
                    opacity: 0.6,
                  }}
                  title={t("wmap.removeLabel")}
                >
                  ✕
                </button>
              </div>
            );
          })}

          {/* Doc pin excerpt popup */}
          {popupPin && popupDoc && (
            <div
              style={{
                position: "absolute",
                left: `${toScreen(popupPin.x, popupPin.y).left}px`,
                top: `${toScreen(popupPin.x, popupPin.y).top}px`,
                transform: "translate(-50%, 10px)",
                transformOrigin: "center top",
                zIndex: 30,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 10,
                padding: 14,
                maxWidth: 300,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                pointerEvents: "all",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6, color: "var(--text)" }}>
                {popupDoc.title || popupDoc.id}
              </div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.85,
                  lineHeight: 1.55,
                  marginBottom: 10,
                  color: "var(--text)",
                }}
              >
                {(() => {
                  const t = popupDoc.content.replace(/\s+/g, " ").trim();
                  return t.length > 150 ? t.slice(0, 150).trimEnd() + "…" : t;
                })()}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => { onOpenDoc(popupDoc.id as Id); setPopupPinId(null); }}
                  style={{ ...btnActive, fontSize: 11 }}
                >
                  {t("common.readMore")}
                </button>
              </div>
            </div>
          )}

          {/* Record (label) pin popup */}
          {popupLabelPin && popupLabelRow && (
            <div
              style={{
                position: "absolute",
                left: `${toScreen(popupLabelPin.x, popupLabelPin.y).left}px`,
                top: `${toScreen(popupLabelPin.x, popupLabelPin.y).top}px`,
                transform: "translate(-50%, 16px)",
                transformOrigin: "center top",
                zIndex: 30,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-2)",
                borderRadius: 10,
                padding: 14,
                maxWidth: 300,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                pointerEvents: "all",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6, color: popupLabelCol?.color ?? "var(--text)" }}>
                {entityLabel(popupLabelRow) || popupLabelRow.id}
              </div>
              {(() => {
                const desc = String((popupLabelRow.values as any)?.description ?? "").replace(/\s+/g, " ").trim();
                if (!desc) {
                  return <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10, color: "var(--text)" }}>{t("common.noDescription")}</div>;
                }
                return (
                  <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.55, marginBottom: 10, color: "var(--text)" }}>
                    {desc.length > 150 ? desc.slice(0, 150).trimEnd() + "…" : desc}
                  </div>
                );
              })()}
              {onOpenRecord && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => { onOpenRecord(popupLabelPin.collectionId, popupLabelPin.entityId); setPopupPinId(null); }}
                    style={{ ...btnActive, fontSize: 11 }}
                  >
                    Read more
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Drawing hint */}
      {drawing && (
        <div style={{ position: "fixed", top: 72, left: "50%", transform: "translateX(-50%)", zIndex: 120, background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{t("wmap.drawHint")}</span>
          <button type="button" onClick={completeBorder} style={{ ...btnActive, fontSize: 12, padding: "4px 10px" }}>{t("common.finish")}</button>
          <button type="button" onClick={cancelDrawing} style={{ ...btnBase, fontSize: 12, padding: "4px 10px" }}>{t("common.cancel")}</button>
        </div>
      )}

      {/* Pin right-click menu */}
      {pinCtxMenu && (() => {
        const m = pinCtxMenu;
        const pin = m.kind === "doc" ? docPins.find((p) => p.id === m.pinId) : labelPins.find((p) => p.id === m.pinId);
        if (!pin) return null;
        const hasBorder = !!(pin.border && pin.border.length >= 3);
        const close = () => setPinCtxMenu(null);
        const item: React.CSSProperties = { textAlign: "left", border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 10px", fontSize: 13, borderRadius: 6, whiteSpace: "nowrap" };
        return (
          <>
            <div onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} style={{ position: "fixed", inset: 0, zIndex: 130 }} />
            <div style={{ position: "fixed", top: Math.min(m.y + 4, window.innerHeight - 140), left: Math.max(8, Math.min(m.x, window.innerWidth - 200)), zIndex: 131, minWidth: 170, background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 8, padding: 6, boxShadow: "0 10px 25px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column", gap: 2 }}>
              {hasBorder ? (
                <button type="button" style={item} onClick={() => { close(); deleteBorder(m.kind, m.pinId); }}>{t("wmap.deleteBorder")}</button>
              ) : (
                <button type="button" style={item} onClick={() => { close(); startDrawBorder(m.kind, m.pinId); }}>{t("wmap.drawBorder")}</button>
              )}
              <button type="button" style={{ ...item, color: "var(--danger-text)" }}
                onClick={() => { close(); if (m.kind === "doc") onRemoveDocPin(m.pinId as Id); else onRemoveLabelPin(m.pinId as Id); onSave(); }}>
                {t("wmap.deletePin")}
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
};

export default WorldMap;
