import React, { useEffect, useRef, useState } from "react";
import type { Id, Document, Collection, WorldMapDocPin, WorldMapLabelPin, WorldNameCtx } from "./types";
import { entityLabel } from "./entityLabel";

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
  onOpenDoc: (id: Id) => void;
  onSave: () => void;
  showWikiOption?: boolean; // hide the "Include in wiki" toggle on desktop

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
  onOpenDoc,
  onSave,
  showWikiOption = true,
  savedMaps,
  activeMapId,
  onMakeNewMap,
  onLoadMap,
  onSelectRecord,
  onClearDocPins,
  onClearLabelPins,
  saveMessage,
}) => {
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

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
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
    position: "fixed",
    inset: 0,
    zIndex: 85,
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
        <button type="button" style={fileMenuOpen ? btnActive : btnBase} onClick={() => setFileMenuOpen((o) => !o)}>File ▾</button>
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
                    <span>Save now</span>
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
                        { confirmLabel: "New map" }
                      );
                    }}
                  >
                    <span>Make new map</span>
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
                  <span style={{ opacity: loadable.length > 0 ? 1 : 0.5 }}>Load map</span>
                  <span style={{ opacity: 0.9 }}>▸</span>
                </button>
                {loadOpen && (
                  <div style={flyoutPanel} onMouseEnter={() => setLoadOpen(true)}>
                    {loadable.length === 0 ? (
                      <div style={{ ...fileItem, border: "none", cursor: "default", opacity: 0.5 }}>No saved maps</div>
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
                      <span>{uploading ? "Uploading…" : "Replace image"}</span>
                      <span style={{ opacity: 0.9 }}>▸</span>
                    </button>
                    {replaceOpen && (
                      <div style={flyoutPanel} onMouseEnter={() => setReplaceOpen(true)}>
                        <label style={{ ...fileItem, cursor: uploading ? "default" : "pointer" }}>
                          <span>Upload new image</span>
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
                            <span>Choose from assets</span>
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
                    <span>Clear all doc pins</span>
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
                    <span>Clear all record pins</span>
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
          title={empty ? "No maps found" : "Load a saved map"}
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
          <button type="button" style={btnBase} onClick={() => setConfirmDialog(null)}>Cancel</button>
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
          <div style={{ fontWeight: 800, fontSize: 14, color: "var(--text)" }}>Choose an image asset</div>
          <button type="button" onClick={() => setShowAssetPicker(false)} style={btnBase}>Close</button>
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
        {uploading ? "Uploading…" : "Click to upload an image"}
      </label>
    );

    return (
      <div style={overlayStyle}>
        {confirmModal}
        <div style={toolbarStyle}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>World Map</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Step {setupStep} of 2</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {renderLoadMapButton()}
            <button type="button" onClick={onClose} style={btnBase}>Close</button>
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
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>Create your world</div>

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
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>World name</div>
                    <input
                      autoFocus
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      placeholder="e.g. Azeroth, Middle-earth…"
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
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", marginBottom: 6 }}>Pick a record</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        className="themed-select"
                        style={{ ...inputStyle, flex: 1 }}
                        value={nameCollectionId}
                        onChange={(e) => { setNameCollectionId(e.target.value); setNameEntityId(""); }}
                      >
                        <option value="">Table…</option>
                        {collections.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                      </select>
                      <select
                        className="themed-select"
                        style={{ ...inputStyle, flex: 1 }}
                        value={nameEntityId}
                        onChange={(e) => setNameEntityId(e.target.value)}
                        disabled={!nameCollectionId}
                      >
                        <option value="">Record…</option>
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
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>Set the map image</div>
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
                <div style={{ fontSize: 11, opacity: 0.6, marginTop: -8 }}>PNG, JPG, or any image format.</div>

                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button type="button" onClick={() => setSetupStep(1)} style={btnBase}>Back</button>
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
            Add document pin
          </button>
          {addMode === "addDoc" && (
            <select
              className="themed-select"
              style={{ ...inputStyle, maxWidth: 180 }}
              value={pendingDocId}
              onChange={(e) => setPendingDocId(e.target.value)}
            >
              <option value="">Select document…</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>{d.title || d.id}</option>
              ))}
            </select>
          )}
          {addMode === "addDoc" && pendingDocId && (
            <span style={{ fontSize: 11, color: "var(--accent-text)", opacity: 0.8 }}>
              Click on the map to place
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
            Add record pin
          </button>
          {addMode === "addLabel" && (
            <>
              <select
                className="themed-select"
                style={{ ...inputStyle, maxWidth: 140 }}
                value={pendingLabelCollectionId}
                onChange={(e) => { setPendingLabelCollectionId(e.target.value); setPendingLabelEntityId(""); }}
              >
                <option value="">Table…</option>
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
                  <option value="">Record…</option>
                  {(collections.find((c) => c.id === pendingLabelCollectionId)?.rows ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {entityLabel(r)}
                    </option>
                  ))}
                </select>
              )}
              {pendingLabelCollectionId && pendingLabelEntityId && (
                <span style={{ fontSize: 11, color: "var(--accent-text)", opacity: 0.8 }}>
                  Click on the map to place
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
            title="Edit world name"
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
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)" }}>World name</div>

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
                    placeholder="World name…"
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
                      <option value="">Table…</option>
                      {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <select
                      className="themed-select"
                      style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                      value={nameEntityId}
                      onChange={(e) => setNameEntityId(e.target.value)}
                      disabled={!nameCollectionId}
                    >
                      <option value="">Record…</option>
                      {(collections.find((c) => c.id === nameCollectionId)?.rows ?? []).map((r) => (
                        <option key={r.id} value={r.id}>{entityLabel(r)}</option>
                      ))}
                    </select>
                  </>
                )}

                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 2 }}>
                  <button type="button" onClick={() => setEditingName(false)} style={btnBase}>Cancel</button>
                  <button type="button" onClick={commitName} style={btnActive}>Save</button>
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
              Include in wiki
            </label>
          </>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={onClose} style={btnBase}>Close</button>
        </div>
      </div>

      {/* Map canvas */}
      <div
        style={{ flex: 1, overflow: "auto", position: "relative" }}
        onClick={() => { setPopupPinId(null); }}
      >
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
                Map image missing
              </div>
              <div style={{ fontSize: 13, opacity: 0.8, color: "var(--text-dim)", lineHeight: 1.5 }}>
                This map's image couldn't be loaded. It may have been deleted from the record's
                assets. Choose a new image to restore the map.
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
                {uploading ? "Uploading…" : "Upload new image"}
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
                    Choose from this record's images
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
        <div style={{ position: "relative", display: "inline-block" }}>
          <img
            ref={imgRef}
            src={imageUrl}
            alt="World map"
            draggable={false}
            onError={() => setImageBroken(true)}
            onClick={handleImageClick}
            style={{
              display: "block",
              maxWidth: "100%",
              userSelect: "none",
              cursor: addMode !== "none" ? "crosshair" : "default",
            }}
          />

          {/* Doc pins */}
          {docPins.map((pin) => {
            const doc = documents.find((d) => d.id === pin.docId);
            return (
              <div
                key={pin.id}
                style={{
                  position: "absolute",
                  left: `${pin.x}%`,
                  top: `${pin.y}%`,
                  transform: "translate(-50%, -100%)",
                  cursor: draggingPin?.id === pin.id ? "grabbing" : "grab",
                  zIndex: popupPinId === pin.id ? 20 : 10,
                  userSelect: "none",
                }}
                onMouseDown={(e) => startDragPin(e, pin.id, "doc")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (Date.now() - dragEndedAt.current < 250) return;
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
                    boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
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
                      pointerEvents: "none",
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
                  left: `${pin.x}%`,
                  top: `${pin.y}%`,
                  transform: "translate(-50%, -50%)",
                  cursor: draggingPin?.id === pin.id ? "grabbing" : "grab",
                  zIndex: 10,
                  userSelect: "none",
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
                  boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
                onMouseDown={(e) => startDragPin(e, pin.id, "label")}
                onClick={(e) => e.stopPropagation()}
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
                  title="Remove label"
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
                left: `${popupPin.x}%`,
                top: `${popupPin.y}%`,
                transform: "translate(-50%, 10px)",
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
                  maxHeight: 100,
                  overflow: "hidden",
                }}
              >
                {popupDoc.content.replace(/\s+/g, " ").slice(0, 240)}
                {popupDoc.content.length > 240 ? "…" : ""}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => { onOpenDoc(popupDoc.id as Id); setPopupPinId(null); }}
                  style={{ ...btnActive, fontSize: 11 }}
                >
                  Read more
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRemoveDocPin(popupPin.id as Id);
                    setPopupPinId(null);
                    onSave();
                  }}
                  style={{ ...btnBase, fontSize: 11, color: "var(--danger-text)", border: "1px solid var(--danger-border-2)" }}
                >
                  Remove pin
                </button>
                <button
                  type="button"
                  onClick={() => setPopupPinId(null)}
                  style={{ ...btnBase, fontSize: 11 }}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorldMap;
