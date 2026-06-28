// Timeline.tsx
import React from "react";
import { useAppModal } from "./AppModal";
import { useLang } from "./i18n";
import type { Collection, CollectionRow, Document, Id, TimelineLineDoc, TimelineLinePin } from "./types";

type TimelineEntityLabel = {
  id: Id;
  position: number;
  collectionId: Id;
  entityId: Id;
};

interface TimelineProps {
  enabled: boolean;

  // When true (popped-out window), render edge-to-edge without the panel margin/border chrome.
  bare?: boolean;

  documents: Document[];
  collections: Collection[];

  labels: TimelineEntityLabel[];

  beatCount?: number;
  onInsertBeat: (afterBeat: number) => void;
  onRemoveBeat: (beat: number) => void;

  onMoveDoc: (docId: Id, newPos: number) => void;
  onOpenDoc: (docId: Id) => void;

  timelineCovers: Record<number, string>;
  onUploadCover: (beat: number, file: File) => void;
  onRemoveCover: (beat: number) => void;

  // Custom section titles (beat -> title). Falls back to "Section N" when unset.
  sectionTitles?: Record<number, string>;
  onRenameSection?: (beat: number, title: string) => void;

  onAddEntityLabel: (position: number, collectionId: Id, entityId: Id) => void;
  onDeleteLabel: (labelId: Id) => void;

  onSelectEntity: (collectionId: Id, entityId: Id) => void;

  // ── Line-style (Gantt) layout. When onSetStyle is provided, a Sections/Line
  // toggle appears. Line data + handlers drive the alternative single-line view.
  style?: "section" | "line";
  onSetStyle?: (s: "section" | "line") => void;
  lineDocs?: TimelineLineDoc[];
  linePins?: TimelineLinePin[];
  onAddLineDoc?: (docId: Id, start: number, order?: number) => void;
  onUpdateLineDoc?: (docId: Id, start: number, end?: number) => void;
  onRemoveLineDoc?: (docId: Id) => void;
  onAddLinePin?: (collectionId: Id, entityId: Id, start: number, order?: number) => void;
  onUpdateLinePin?: (id: Id, start: number, end?: number) => void;
  onRemoveLinePin?: (id: Id) => void;
  onSetLineOrder?: (kind: "doc" | "pin", id: Id, order: number) => void;

  // When provided (in-app web strip), shows a Close button in the header.
  onClose?: () => void;
}

function computeDefaultBeatCount(documents: Document[], labels: TimelineEntityLabel[]) {
  const assignedDocs = documents.filter((d: any) => d.timelinePos != null);
  const maxDocPos = assignedDocs.reduce((m, d: any) => Math.max(m, d.timelinePos ?? 0), 0);
  const maxLabelPos = labels.reduce((m, l) => Math.max(m, l.position ?? 0), 0);

  // New users: start with 5 sections.
  // Always include enough sections to show the highest assigned doc/label position.
  return Math.max(5, Math.max(maxDocPos, maxLabelPos) + 1);
}

const getRowLabel = (row: CollectionRow): string =>
  String((row.values as any)["name"] ?? row.id);

export default function Timeline({
  enabled,
  bare,
  documents,
  collections,
  labels,
  beatCount,
  timelineCovers,
  onUploadCover,
  onRemoveCover,
  sectionTitles,
  onRenameSection,
  onInsertBeat,
  onRemoveBeat,
  onMoveDoc,
  onOpenDoc,
  onAddEntityLabel,
  onDeleteLabel,
  onSelectEntity,
  style,
  onSetStyle,
  lineDocs,
  linePins,
  onAddLineDoc,
  onUpdateLineDoc,
  onRemoveLineDoc,
  onAddLinePin,
  onUpdateLinePin,
  onRemoveLinePin,
  onSetLineOrder,
  onClose,
}: TimelineProps) {
  const appModal = useAppModal();
  const { t } = useLang();
  const lineMode = style === "line" && !!onSetStyle;
  const [editingSection, setEditingSection] = React.useState<number | null>(null);
  const [sectionDraft, setSectionDraft] = React.useState("");
  if (!enabled) return null;

  const isDesktop = "__TAURI_INTERNALS__" in window;

  const sectionTitleFor = (beat: number) => (sectionTitles?.[beat]?.trim() || `${t("tl.sectionWord")} ${beat + 1}`);

  const commitSectionTitle = (beat: number) => {
    onRenameSection?.(beat, sectionDraft.trim());
    setEditingSection(null);
  };

  const effectiveBeatCount = beatCount ?? computeDefaultBeatCount(documents, labels);
  const beats = React.useMemo(() => Array.from({ length: effectiveBeatCount }, (_, i) => i), [effectiveBeatCount]);

  const assignedDocs = React.useMemo(() => documents.filter((d: any) => d.timelinePos != null), [documents]);

  const unassignedDocs = React.useMemo(() => {
    const arr = documents.filter((d: any) => d.timelinePos == null);
    arr.sort((a, b) => a.title.localeCompare(b.title));
    return arr;
  }, [documents]);

  // Per-section inline "add" pickers (replaces the old global selected-beat toolbar).
  const [addDocBeat, setAddDocBeat] = React.useState<number | null>(null);
  const [addLabelBeat, setAddLabelBeat] = React.useState<number | null>(null);

  const docsByBeat = React.useMemo(() => {
    const map = new Map<number, Document[]>();
    for (const d of assignedDocs as any[]) {
      const pos = d.timelinePos as number;
      const arr = map.get(pos) ?? [];
      arr.push(d);
      map.set(pos, arr);
    }
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => a.title.localeCompare(b.title));
      map.set(k, arr);
    }
    return map;
  }, [assignedDocs]);

  const labelsByBeat = React.useMemo(() => {
    const map = new Map<number, TimelineEntityLabel[]>();
    for (const l of labels) {
      const arr = map.get(l.position) ?? [];
      arr.push(l);
      map.set(l.position, arr);
    }
    return map;
  }, [labels]);

  const collectionById = React.useMemo(() => {
    const m = new Map<Id, Collection>();
    for (const c of collections) m.set(c.id, c);
    return m;
  }, [collections]);

  const [labelCollectionId, setLabelCollectionId] = React.useState<string>("");
  const [labelEntityId, setLabelEntityId] = React.useState<string>("");

  // If selected collection changes, reset entity if invalid
  React.useEffect(() => {
    if (!labelCollectionId) {
      setLabelEntityId("");
      return;
    }
    const col = collectionById.get(labelCollectionId as Id);
    if (!col) {
      setLabelCollectionId("");
      setLabelEntityId("");
      return;
    }
    if (labelEntityId && !col.rows.some((r) => r.id === labelEntityId)) {
      setLabelEntityId("");
    }
  }, [labelCollectionId, labelEntityId, collectionById]);

  const closePickers = () => {
    setAddDocBeat(null);
    setAddLabelBeat(null);
    setLabelCollectionId("");
    setLabelEntityId("");
  };

  const assignDocToBeat = (beat: number, docId: string) => {
    if (!docId) return;
    onMoveDoc(docId as Id, beat);
    closePickers();
  };

  const addLabelToBeat = (beat: number) => {
    if (!labelCollectionId || !labelEntityId) return;
    onAddEntityLabel(beat, labelCollectionId as Id, labelEntityId as Id);
    closePickers();
  };

  const removeSection = async (beat: number) => {
    const ok = await appModal.confirm({
      title: t("tl.removeSectionQ"),
      message: t("tl.removeSectionMsg"),
      confirmText: t("common.remove"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    onRemoveBeat(beat);
  };

  const onDragStartDoc = (e: React.DragEvent, docId: Id) => {
    e.dataTransfer.setData("text/plain", String(docId));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDropOnBeat = (e: React.DragEvent, beat: number) => {
    e.preventDefault();
    const docId = e.dataTransfer.getData("text/plain") as Id;
    if (!docId) return;
    onMoveDoc(docId, beat);
  };

  const labelPillStyle = (colColor?: string): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
    border: `1px solid ${colColor ?? "var(--border-3)"}`,
    background: "var(--bg-surface)",
    padding: "4px 8px",
    color: colColor ?? "var(--text-2)",
    fontSize: 12,
    maxWidth: "100%",
  });

  return (
    <div className={"timelineWrap" + (bare ? " timelineWrapBare" : "")} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="timelineHeader">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="timelineTitle">{t("term.timeline")}</div>

          <span
            className="infoIcon"
            tabIndex={0}
            role="button"
            aria-label={t("tl.infoLabel")}
          >
            i
            <span className="infoTooltip" role="tooltip">
              {lineMode ? t("tl.infoLine") : t("tl.infoSection")}
            </span>
          </span>
        </div>

        <div className="timelineHint">
          {lineMode ? null : <>{t("tl.sectionsCount")} <code>{effectiveBeatCount}</code></>}
        </div>

        <div className="timelineHeaderRight">
          {/* Add section sits LEFT of the view toggle so the toggle stays anchored on
              the right and doesn't jump when this button shows/hides between modes. */}
          {!lineMode && (
            <button
              type="button"
              className="timelineAddSection"
              style={{ marginRight: 4 }}
              onClick={() => onInsertBeat(effectiveBeatCount - 1)}
              title={t("tl.addSectionTitle")}
            >
              {t("tl.addSection")}
            </button>
          )}
          {onSetStyle && (
            <div style={{ display: "inline-flex", border: "1px solid var(--border-2)", borderRadius: 8, overflow: "hidden", marginRight: 4 }}>
              {([
                { val: "section" as const, label: t("tl.toggleSections") },
                { val: "line" as const, label: t("tl.toggleLine") },
              ]).map((opt) => {
                const sel = (style ?? "section") === opt.val;
                return (
                  <button
                    key={opt.val}
                    type="button"
                    onClick={() => onSetStyle(opt.val)}
                    style={{
                      border: "none",
                      background: sel ? "var(--accent)" : "transparent",
                      color: sel ? "#fff" : "var(--text-2)",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 700,
                      padding: "5px 12px",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
          {onClose && (
            <button type="button" className="timelineAddSection" onClick={onClose} title={t("tl.closeTimeline")}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>

      {lineMode ? (
        <LineTimeline
          documents={documents}
          collections={collections}
          lineDocs={lineDocs ?? []}
          linePins={linePins ?? []}
          onAddLineDoc={onAddLineDoc!}
          onUpdateLineDoc={onUpdateLineDoc!}
          onRemoveLineDoc={onRemoveLineDoc!}
          onAddLinePin={onAddLinePin!}
          onUpdateLinePin={onUpdateLinePin!}
          onRemoveLinePin={onRemoveLinePin!}
          onSetLineOrder={onSetLineOrder!}
          onOpenDoc={onOpenDoc}
          onSelectEntity={onSelectEntity}
        />
      ) : (
      <div className="timelineScroller" style={{ flex: 1, minHeight: 0 }}>
        <div className="timelineGrid">
          {beats.map((beat) => {
            const beatLabels = labelsByBeat.get(beat) ?? [];
            const beatDocs = docsByBeat.get(beat) ?? [];

            return (
              <div
                key={beat}
                className="timelineSlot"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDropOnBeat(e, beat)}
              >
                {timelineCovers[beat] && (
                  <div style={{ position: "relative", marginBottom: 6 }}>
                    <img
                      src={timelineCovers[beat]}
                      style={{
                        width: "100%",
                        height: 90,
                        objectFit: "cover",
                        borderRadius: 6,
                        border: "1px solid var(--border-2)",
                        display: "block",
                      }}
                    />
                    <div style={{ position: "absolute", top: 5, right: 5, display: "flex", gap: 4 }}>
                      <label
                        title={t("tl.replaceCover")}
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          background: "rgba(0,0,0,0.55)",
                          border: "1px solid rgba(255,255,255,0.15)",
                          cursor: "pointer",
                          fontSize: 12,
                          color: "#fff",
                        }}
                      >
                        ↑
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onUploadCover(beat, f);
                            e.currentTarget.value = "";
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        title={t("tl.removeCover")}
                        onClick={(e) => { e.stopPropagation(); onRemoveCover(beat); }}
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          background: "rgba(0,0,0,0.55)",
                          border: "1px solid rgba(255,255,255,0.15)",
                          cursor: "pointer",
                          fontSize: 13,
                          color: "#fff",
                          padding: 0,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}

                <div className="timelineSlotTop">
                  {editingSection === beat ? (
                    <input
                      autoFocus
                      value={sectionDraft}
                      placeholder={`${t("tl.sectionWord")} ${beat + 1}`}
                      onChange={(e) => setSectionDraft(e.target.value)}
                      onBlur={() => commitSectionTitle(beat)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitSectionTitle(beat); }
                        else if (e.key === "Escape") { e.preventDefault(); setEditingSection(null); }
                      }}
                      style={{
                        font: "inherit",
                        fontWeight: 700,
                        maxWidth: 160,
                        borderRadius: 6,
                        border: "1px solid var(--border-2)",
                        background: "var(--bg-surface)",
                        color: "var(--text)",
                        padding: "2px 6px",
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="timelineSlotIndex"
                      title={onRenameSection ? t("tl.renameSection") : undefined}
                      onClick={() => {
                        if (!onRenameSection) return;
                        setSectionDraft(sectionTitles?.[beat] ?? "");
                        setEditingSection(beat);
                      }}
                      style={{ cursor: onRenameSection ? "text" : "default", display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "transparent" }}
                    >
                      <span>{sectionTitleFor(beat)}</span>
                      {onRenameSection && <span aria-hidden style={{ opacity: 0.6, fontSize: "0.85em" }}>✎</span>}
                    </button>
                  )}
                  <div className="timelineSlotActions">
                    <button
                      type="button"
                      className="timelineIconBtn"
                      title={t("tl.insertSectionTitle")}
                      onClick={() => onInsertBeat(beat)}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="timelineIconBtn danger"
                      title={t("tl.removeSectionTitle")}
                      onClick={() => removeSection(beat)}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {beatLabels.length > 0 && (
                  <div className="timelineLabels" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {beatLabels.map((l) => {
                      const col = collectionById.get(l.collectionId);
                      const row = col?.rows.find((r) => r.id === l.entityId) ?? null;
                      const text = row ? getRowLabel(row) : `${l.collectionId}:${l.entityId}`;
                      const color = col?.color;

                      return (
                        <div
                          key={l.id}
                          style={labelPillStyle(color)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectEntity(l.collectionId, l.entityId);
                          }}
                          title={t("tl.openInCollections")}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {text}
                          </span>

                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const ok = await appModal.confirm({
                                title: t("tl.removeRecordQ"),
                                message: t("tl.removeRecordMsg"),
                                confirmText: t("common.remove"),
                                cancelText: t("common.cancel"),
                                danger: true,
                              });
                              if (!ok) return;
                              onDeleteLabel(l.id);
                            }}
                            title={t("tl.removeRecordTitle")}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: color ?? "var(--text-dim)",
                              cursor: "pointer",
                              padding: 0,
                              fontSize: 12,
                              lineHeight: 1,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(beatDocs.length > 0 || !isDesktop) && (
                  <div className="timelineDocs">
                    {beatDocs.length === 0 ? (
                      <div className="timelineEmpty">
                        <div className="timelineEmptyDot" />
                        <div className="timelineEmptyText">{t("tl.dropDocs")}</div>
                      </div>
                    ) : (
                      beatDocs.map((d) => (
                        <div
                          key={d.id}
                          className="timelineDocChip"
                          draggable={!isDesktop}
                          onDragStart={!isDesktop ? (e) => onDragStartDoc(e, d.id) : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenDoc(d.id);
                          }}
                          title={isDesktop ? t("tl.clickToOpen") : t("tl.dragOrOpen")}
                          style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}
                        >
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                              wordBreak: "break-word",
                              lineHeight: 1.25,
                            }}
                          >
                            {d.title}
                          </span>

                          <button
                            type="button"
                            className="timelineDocRemove"
                            onClick={(e) => {
                              e.stopPropagation();
                              onMoveDoc(d.id, -1);
                            }}
                            title={t("tl.removeFromTimeline")}
                          >
                            ✕
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Per-section add controls */}
                <div className="timelineAddRow">
                  {addDocBeat === beat ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        className="timelineMiniSelect"
                        autoFocus
                        value=""
                        onChange={(e) => assignDocToBeat(beat, e.target.value)}
                      >
                        <option value="">
                          {unassignedDocs.length > 0 ? t("wmap.selectDocument") : t("tl.noUnassignedDocs")}
                        </option>
                        {unassignedDocs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.title}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="timelinePickerCancel" onClick={closePickers} title="Cancel">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="timelineAddBtn"
                      onClick={() => {
                        closePickers();
                        setAddDocBeat(beat);
                      }}
                    >
                      Attach document
                    </button>
                  )}

                  {addLabelBeat === beat ? (
                    <div className="timelineLabelPicker">
                      <select
                        className="timelineMiniSelect"
                        autoFocus
                        value={labelCollectionId}
                        onChange={(e) => setLabelCollectionId(e.target.value)}
                      >
                        <option value="">{t("tl.selectTable")}</option>
                        {collections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>

                      <select
                        className="timelineMiniSelect"
                        value={labelEntityId}
                        disabled={!labelCollectionId}
                        onChange={(e) => setLabelEntityId(e.target.value)}
                      >
                        <option value="">{t("tl.selectRecord")}</option>
                        {(collectionById.get(labelCollectionId as Id)?.rows ?? []).map((r) => (
                          <option key={r.id} value={r.id}>
                            {getRowLabel(r)}
                          </option>
                        ))}
                      </select>

                      <div className="timelinePickerActions">
                        <button
                          type="button"
                          className="timelinePickerAdd"
                          disabled={!labelCollectionId || !labelEntityId}
                          onClick={() => addLabelToBeat(beat)}
                        >
                          {t("tl.addRecord")}
                        </button>
                        <button type="button" className="timelinePickerCancel" onClick={closePickers}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="timelineAddBtn"
                      onClick={() => {
                        closePickers();
                        setAddLabelBeat(beat);
                      }}
                    >
                      Attach record
                    </button>
                  )}

                  {!timelineCovers[beat] && (
                    <label className="timelineAddBtn" title={t("tl.addCoverTitle")}>
                      Add cover image
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onUploadCover(beat, f);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

// ── Line-style (Gantt) timeline ───────────────────────────────────────────────
interface LineTimelineProps {
  documents: Document[];
  collections: Collection[];
  lineDocs: TimelineLineDoc[];
  linePins: TimelineLinePin[];
  onAddLineDoc: (docId: Id, start: number, order?: number) => void;
  onUpdateLineDoc: (docId: Id, start: number, end?: number) => void;
  onRemoveLineDoc: (docId: Id) => void;
  onAddLinePin: (collectionId: Id, entityId: Id, start: number, order?: number) => void;
  onUpdateLinePin: (id: Id, start: number, end?: number) => void;
  onRemoveLinePin: (id: Id) => void;
  onSetLineOrder: (kind: "doc" | "pin", id: Id, order: number) => void;
  onOpenDoc: (docId: Id) => void;
  onSelectEntity: (collectionId: Id, entityId: Id) => void;
}

type LineDrag = { kind: "doc" | "pin"; id: string; handle: "move" | "start" | "end"; offset: number; width: number };
type LineItem = { kind: "doc" | "pin"; id: string; label: string; color: string; start: number; end?: number; order: number; open: () => void };

function LineTimeline({
  documents,
  collections,
  lineDocs,
  linePins,
  onAddLineDoc,
  onUpdateLineDoc,
  onRemoveLineDoc,
  onAddLinePin,
  onUpdateLinePin,
  onRemoveLinePin,
  onSetLineOrder,
  onOpenDoc,
  onSelectEntity,
}: LineTimelineProps) {
  const appModal = useAppModal();
  const { t } = useLang();
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const lanesRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<LineDrag | null>(null);
  const didDragRef = React.useRef(false);
  const [dragging, setDragging] = React.useState(false);
  const [trackW, setTrackW] = React.useState(0);
  const [menu, setMenu] = React.useState<{ kind: "doc" | "pin"; id: string; x: number; y: number } | null>(null);

  // Placement flow, mirroring the world map: pick what to add, then click the line to
  // drop it. `armedRef` blocks a duplicate drop before React re-renders.
  const [placeMode, setPlaceMode] = React.useState<"none" | "doc" | "record">("none");
  const [pendingDocId, setPendingDocId] = React.useState("");
  const [pendingColId, setPendingColId] = React.useState("");
  const [pendingEntId, setPendingEntId] = React.useState("");
  const [cursorPct, setCursorPct] = React.useState<number | null>(null);
  const armedRef = React.useRef(false);

  const clamp01 = (n: number) => Math.max(0, Math.min(100, n));
  const pctFromX = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return clamp01(((clientX - r.left) / r.width) * 100);
  };

  React.useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setTrackW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const collectionById = React.useMemo(() => {
    const m = new Map<Id, Collection>();
    for (const c of collections) m.set(c.id, c);
    return m;
  }, [collections]);

  const docById = React.useMemo(() => {
    const m = new Map<Id, Document>();
    for (const d of documents) m.set(d.id, d);
    return m;
  }, [documents]);

  const unplacedDocs = React.useMemo(
    () => documents.filter((d) => !lineDocs.some((ld) => ld.docId === d.id)).sort((a, b) => a.title.localeCompare(b.title)),
    [documents, lineDocs]
  );

  // One unified list so docs and records share rendering + interactions. Items are
  // stacked into vertical lanes sorted by `order` (items without one keep their
  // natural position: docs first, then pins).
  const items: LineItem[] = React.useMemo(() => {
    const out: LineItem[] = [];
    let i = 0;
    for (const ld of lineDocs) {
      const doc = docById.get(ld.docId);
      out.push({ kind: "doc", id: ld.docId, label: doc?.title || ld.docId, color: "var(--accent)", start: ld.start, end: ld.end, order: ld.order ?? i, open: () => onOpenDoc(ld.docId as Id) });
      i++;
    }
    for (const pin of linePins) {
      const col = collectionById.get(pin.collectionId);
      const row = col?.rows.find((r) => r.id === pin.entityId) ?? null;
      out.push({ kind: "pin", id: pin.id, label: row ? getRowLabel(row) : pin.entityId, color: col?.color ?? "var(--text-2)", start: pin.start, end: pin.end, order: pin.order ?? i, open: () => onSelectEntity(pin.collectionId, pin.entityId) });
      i++;
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }, [lineDocs, linePins, docById, collectionById, onOpenDoc, onSelectEntity]);

  const ROW_H = 46;
  const LANE_TOP = 9; // measurement strip height (1) + its marginBottom (8)

  // Which lane index a pointer Y falls over (0..count). `exclude` drops the dragged
  // item from the count so it can settle into its own gap cleanly.
  const laneFromY = (clientY: number, exclude?: { kind: "doc" | "pin"; id: string }) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const scrollTop = lanesRef.current?.scrollTop ?? 0;
    const y = clientY - rect.top + scrollTop - LANE_TOP;
    const count = exclude ? items.filter((it) => !(it.kind === exclude.kind && it.id === exclude.id)).length : items.length;
    return Math.max(0, Math.min(count, Math.round(y / ROW_H)));
  };

  // A fractional order value that places an item at lane index `target`.
  const orderForLane = (target: number, exclude?: { kind: "doc" | "pin"; id: string }) => {
    const list = exclude ? items.filter((it) => !(it.kind === exclude.kind && it.id === exclude.id)) : items;
    if (list.length === 0) return 0;
    if (target <= 0) return list[0].order - 1;
    if (target >= list.length) return list[list.length - 1].order + 1;
    return (list[target - 1].order + list[target].order) / 2;
  };

  const updateItem = (kind: "doc" | "pin", id: string, start: number, end?: number) => {
    if (kind === "doc") onUpdateLineDoc(id as Id, start, end);
    else onUpdateLinePin(id as Id, start, end);
  };

  // Latest values for the drag listeners, so the global mousemove handler can be bound
  // once (no churn / stale closures) while always reading current data.
  const liveRef = React.useRef({ lineDocs, linePins, laneFromY, orderForLane, updateItem, onSetLineOrder });
  liveRef.current = { lineDocs, linePins, laneFromY, orderForLane, updateItem, onSetLineOrder };

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const L = liveRef.current;
      didDragRef.current = true;
      const pct = pctFromX(e.clientX);
      const item = d.kind === "doc" ? L.lineDocs.find((x) => x.docId === d.id) : L.linePins.find((x) => x.id === d.id);
      if (!item) return;
      const isPoint = item.end == null;

      // Vertical reorder: dragging the body across lanes moves it to that layer.
      if (d.handle === "move") {
        const target = L.laneFromY(e.clientY, { kind: d.kind, id: d.id });
        L.onSetLineOrder(d.kind, d.id as Id, L.orderForLane(target, { kind: d.kind, id: d.id }));
      }

      // Horizontal position
      if (isPoint) {
        L.updateItem(d.kind, d.id, pct - d.offset, undefined);
      } else if (d.handle === "move") {
        let s = pct - d.offset;
        let en = s + d.width;
        if (s < 0) { s = 0; en = d.width; }
        if (en > 100) { en = 100; s = 100 - d.width; }
        L.updateItem(d.kind, d.id, s, en);
      } else if (d.handle === "start") {
        L.updateItem(d.kind, d.id, Math.min(pct, (item.end ?? 0) - 1), item.end);
      } else {
        L.updateItem(d.kind, d.id, item.start, Math.max(pct, item.start + 1));
      }
    };
    const onUp = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = (
    kind: "doc" | "pin",
    id: string,
    handle: "move" | "start" | "end",
    e: React.MouseEvent,
    start: number,
    end?: number
  ) => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const pct = pctFromX(e.clientX);
    didDragRef.current = false;
    dragRef.current = { kind, id, handle, offset: pct - start, width: end != null ? end - start : 0 };
    setDragging(true);
  };

  const toggleRange = (it: LineItem) => {
    if (it.end == null) {
      const s = Math.min(it.start, 85);
      updateItem(it.kind, it.id, s, s + 15);
    } else {
      updateItem(it.kind, it.id, it.start, undefined);
    }
  };

  const removeItem = async (it: LineItem) => {
    const ok = await appModal.confirm({
      title: t("tl.removeFromLineQ"),
      message: t("tl.removeFromLineMsg"),
      confirmText: t("common.remove"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    if (it.kind === "doc") onRemoveLineDoc(it.id as Id);
    else onRemoveLinePin(it.id as Id);
  };

  // ── Placement (pick → click the line to drop) ──────────────────────────────
  const armed =
    (placeMode === "doc" && !!pendingDocId) ||
    (placeMode === "record" && !!pendingColId && !!pendingEntId);

  const placeName =
    placeMode === "doc"
      ? docById.get(pendingDocId as Id)?.title || ""
      : (() => {
          const r = collectionById.get(pendingColId as Id)?.rows.find((x) => x.id === pendingEntId);
          return r ? getRowLabel(r) : "";
        })();

  React.useEffect(() => { armedRef.current = armed; }, [armed]);

  const cancelPlace = () => {
    armedRef.current = false;
    setPlaceMode("none");
    setPendingDocId("");
    setPendingColId("");
    setPendingEntId("");
    setCursorPct(null);
  };

  const placeAt = (clientX: number, clientY: number) => {
    if (!armedRef.current) return;
    const pct = pctFromX(clientX);
    const order = orderForLane(laneFromY(clientY));
    armedRef.current = false;
    if (placeMode === "doc" && pendingDocId) onAddLineDoc(pendingDocId as Id, pct, order);
    else if (placeMode === "record" && pendingColId && pendingEntId) onAddLinePin(pendingColId as Id, pendingEntId as Id, pct, order);
    cancelPlace();
  };

  React.useEffect(() => {
    if (placeMode === "none") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancelPlace(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placeMode]);

  const ticks = [0, 25, 50, 75, 100];
  const rowH = ROW_H;
  const barTop = 20;
  const barH = 20;
  const handleW = 10;

  const rulerAndGrid = (
    <>
      {ticks.map((t) => (
        <div key={"g" + t} style={{ position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 1, background: "var(--border-2)", opacity: 0.5 }} />
      ))}
    </>
  );

  const selectStyle: React.CSSProperties = { height: 30 };
  const activeBtn: React.CSSProperties = { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" };
  const menuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer", padding: "7px 12px", fontSize: 13, whiteSpace: "nowrap" };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "10px 16px", boxSizing: "border-box", gap: 12, userSelect: dragging ? "none" : "auto" }}>
      {/* Add controls — pick what to add, then click the line to drop it (like the map). */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {/* Add document */}
        <button
          type="button"
          className="timelineAddBtn"
          style={placeMode === "doc" ? activeBtn : undefined}
          onClick={() => (placeMode === "doc" ? cancelPlace() : (cancelPlace(), setPlaceMode("doc")))}
        >
          {t("tl.addDocument")}
        </button>
        {placeMode === "doc" && (
          <select
            className="timelineMiniSelect"
            style={selectStyle}
            autoFocus
            value={pendingDocId}
            onChange={(e) => setPendingDocId(e.target.value)}
          >
            <option value="">{unplacedDocs.length ? t("wmap.selectDocument") : t("tl.allDocsAdded")}</option>
            {unplacedDocs.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        )}

        {/* Add record */}
        <button
          type="button"
          className="timelineAddBtn"
          style={placeMode === "record" ? activeBtn : undefined}
          onClick={() => (placeMode === "record" ? cancelPlace() : (cancelPlace(), setPlaceMode("record")))}
        >
          {t("tl.addRecord")}
        </button>
        {placeMode === "record" && (
          <select className="timelineMiniSelect" style={selectStyle} value={pendingColId} onChange={(e) => { setPendingColId(e.target.value); setPendingEntId(""); }}>
            <option value="">{t("cond.phTable")}</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {placeMode === "record" && pendingColId && (
          <select className="timelineMiniSelect" style={selectStyle} value={pendingEntId} onChange={(e) => setPendingEntId(e.target.value)}>
            <option value="">{t("cond.phRecord")}</option>
            {(collectionById.get(pendingColId as Id)?.rows ?? []).map((r) => (
              <option key={r.id} value={r.id}>{getRowLabel(r)}</option>
            ))}
          </select>
        )}
      </div>

      {armed && (
        <div style={{ fontSize: 11, color: "var(--accent-text)" }}>
          {t("tl.clickLineToPlace")} <b>{placeName}</b>. {t("tl.pressEsc")}
        </div>
      )}

      {/* Scrollable lanes */}
      <div
        ref={lanesRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative", cursor: armed ? "crosshair" : undefined }}
        onMouseMove={armed ? (e) => setCursorPct(pctFromX(e.clientX)) : undefined}
        onMouseLeave={armed ? () => setCursorPct(null) : undefined}
        onClick={armed ? (e) => placeAt(e.clientX, e.clientY) : undefined}
      >
        {/* Measurement strip (maps pointer X → %); no visible scale numbers. */}
        <div ref={trackRef} style={{ position: "relative", height: 1, marginBottom: 8 }} />

        {/* Placement guide line following the cursor */}
        {armed && cursorPct != null && (
          <div style={{ position: "absolute", left: `${cursorPct}%`, top: 0, bottom: 0, width: 2, background: "var(--accent)", opacity: 0.8, pointerEvents: "none", zIndex: 5 }} />
        )}

        {items.length === 0 && (
          <div style={{ opacity: 0.6, fontSize: 13, padding: "18px 4px" }}>
            {t("tl.lineEmpty")}
          </div>
        )}

        {items.map((it) => {
          const isSpan = it.end != null;
          const pxW = isSpan ? ((it.end! - it.start) / 100) * trackW : 0;
          const labelOutside = isSpan && pxW < 64; // too narrow to read text inside
          const solid = it.kind === "doc";
          const onCtx = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ kind: it.kind, id: it.id, x: e.clientX, y: e.clientY }); };
          return (
            <div key={it.kind + it.id} style={{ position: "relative", height: rowH, pointerEvents: armed ? "none" : undefined }}>
              {rulerAndGrid}

              {/* Caption shown above the bar when it's too narrow to fit the text inside. */}
              {isSpan && labelOutside && (
                <div style={{ position: "absolute", left: `${it.start}%`, top: 0, fontSize: 11, fontWeight: 700, color: it.color, whiteSpace: "nowrap", pointerEvents: "none", maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {it.label}
                </div>
              )}

              {isSpan ? (
                <div
                  onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); return; } startDrag(it.kind, it.id, "move", e, it.start, it.end); }}
                  onClick={() => { if (!didDragRef.current) it.open(); }}
                  onContextMenu={onCtx}
                  title={`${it.label} · ${t("tl.dragMoveResize")}`}
                  style={{
                    position: "absolute",
                    left: `${it.start}%`,
                    width: `${Math.max(it.end! - it.start, 0)}%`,
                    minWidth: 6,
                    top: barTop,
                    height: barH,
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    background: solid ? it.color : `color-mix(in srgb, ${it.color} 32%, transparent)`,
                    border: solid ? "none" : `2px solid ${it.color}`,
                    color: solid ? "#fff" : it.color,
                    borderRadius: solid ? 7 : 999,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 10px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "grab",
                    boxShadow: solid ? "0 1px 4px rgba(0,0,0,0.3)" : "none",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    boxSizing: "border-box",
                  }}
                >
                  <div onMouseDown={(e) => startDrag(it.kind, it.id, "start", e, it.start, it.end)} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: handleW, cursor: "ew-resize" }} />
                  {!labelOutside && <span style={{ overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none" }}>{it.label}</span>}
                  <div onMouseDown={(e) => startDrag(it.kind, it.id, "end", e, it.start, it.end)} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: handleW, cursor: "ew-resize" }} />
                </div>
              ) : (
                <div style={{ position: "absolute", left: `${it.start}%`, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 6, userSelect: "none", WebkitUserSelect: "none" }}>
                  {/* marginLeft:-8 centers the 16px diamond exactly on the placed position. */}
                  <div
                    onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); return; } startDrag(it.kind, it.id, "move", e, it.start); }}
                    onClick={() => { if (!didDragRef.current) it.open(); }}
                    onContextMenu={onCtx}
                    title={`${it.label} · ${t("tl.dragMove")}`}
                    style={{ width: 16, height: 16, marginLeft: -8, background: it.color, transform: "rotate(45deg)", borderRadius: 3, border: "2px solid var(--bg-surface)", cursor: "grab", flexShrink: 0, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}
                  />
                  <span onContextMenu={onCtx} style={{ fontSize: 12, fontWeight: 700, color: it.color, whiteSpace: "nowrap" }}>{it.label}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right-click menu */}
      {menu && (() => {
        const it = items.find((x) => x.kind === menu.kind && x.id === menu.id);
        if (!it) return null;
        const MW = 180, MH = 92;
        const left = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - MW - 8);
        const top = Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - MH - 8);
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 200 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
            <div style={{ position: "fixed", left, top, zIndex: 201, background: "var(--bg-elevated)", border: "1px solid var(--border-2)", borderRadius: 8, padding: 4, boxShadow: "0 10px 25px rgba(0,0,0,0.4)", minWidth: 160 }}>
              <button type="button" style={menuItem} onClick={() => { toggleRange(it); setMenu(null); }}>
                {it.end == null ? t("tl.allowRange") : t("tl.turnOffRange")}
              </button>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
              <button type="button" style={{ ...menuItem, color: "var(--danger-text)" }} onClick={() => { const t = it; setMenu(null); removeItem(t); }}>
                {t("tl.removeFromLine")}
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}
