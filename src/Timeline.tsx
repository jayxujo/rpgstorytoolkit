// Timeline.tsx
import React from "react";
import { useAppModal } from "./AppModal";
import type { Collection, CollectionRow, Document, Id } from "./types";

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
  onClose,
}: TimelineProps) {
  const appModal = useAppModal();
  const [editingSection, setEditingSection] = React.useState<number | null>(null);
  const [sectionDraft, setSectionDraft] = React.useState("");
  if (!enabled) return null;

  const isDesktop = "__TAURI_INTERNALS__" in window;

  const sectionTitleFor = (beat: number) => (sectionTitles?.[beat]?.trim() || `Section ${beat + 1}`);

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
      title: "Remove section?",
      message: `Remove Section ${beat + 1}? Any documents in it return to unassigned and its labels are removed.`,
      confirmText: "Remove",
      cancelText: "Cancel",
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
          <div className="timelineTitle">Timeline</div>

          <span
            className="infoIcon"
            tabIndex={0}
            role="button"
            aria-label="How the timeline works"
          >
            i
            <span className="infoTooltip" role="tooltip">
              Sections run left to right. Use a section's Attach document / Attach record buttons to fill it, and the
              ✕ on a section to remove it{isDesktop ? "" : ". You can also drag documents between sections"}.
            </span>
          </span>
        </div>

        <div className="timelineHint">
          Sections: <code>{effectiveBeatCount}</code>
        </div>

        <div className="timelineHeaderRight">
          <button
            type="button"
            className="timelineAddSection"
            onClick={() => onInsertBeat(effectiveBeatCount - 1)}
            title="Add a section at the end"
          >
            Add section
          </button>
          {onClose && (
            <button type="button" className="timelineAddSection" onClick={onClose} title="Close timeline">
              Close
            </button>
          )}
        </div>
      </div>

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
                        title="Replace cover image"
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
                        title="Remove cover image"
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
                      placeholder={`Section ${beat + 1}`}
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
                      title={onRenameSection ? "Rename section" : undefined}
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
                      title="Insert a section after this one"
                      onClick={() => onInsertBeat(beat)}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="timelineIconBtn danger"
                      title="Remove this section"
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
                          title="Click to open in Collections panel"
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {text}
                          </span>

                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const ok = await appModal.confirm({
                                title: "Remove record?",
                                message: "Remove this record from this beat?",
                                confirmText: "Remove",
                                cancelText: "Cancel",
                                danger: true,
                              });
                              if (!ok) return;
                              onDeleteLabel(l.id);
                            }}
                            title="Remove record"
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
                        <div className="timelineEmptyText">Drop docs here</div>
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
                          title={isDesktop ? "Click to open" : "Drag to another section · Click to open"}
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
                            title="Remove from timeline"
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
                          {unassignedDocs.length > 0 ? "Select document…" : "No unassigned documents"}
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
                        <option value="">Select table…</option>
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
                        <option value="">Select record…</option>
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
                          Add record
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
                    <label className="timelineAddBtn" title="Add a cover image to this section">
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
    </div>
  );
}
