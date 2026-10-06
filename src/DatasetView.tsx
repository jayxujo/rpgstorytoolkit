import React, { useMemo, useRef, useState, useEffect } from "react";
import { useLang } from "./i18n";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  Dataset,
  DatasetEntry,
  DatasetResult,
  DatasetFieldDef,
  DatasetFieldType,
  Collection,
  CollectionRow,
  CollectionField,
  Id,
} from "./types";
import {
  MAX_DATASET_FIELDS,
  makeDatasetFieldId,
  makeUniqueDatasetFieldId,
  buildDefaultFieldValues,
  ensureFieldValues,
} from "./datasetFields";
import { buildDatasetFile, fieldLevelValue } from "./dialogueExport";
import LinkedTextField, { type LinkableRecord } from "./editor/LinkedTextField";
import { toSlug } from "./platform/slugify";
import type { Project } from "./types";

type Props = {
  dataset: Dataset;
  collections: Collection[];
  onChange: (next: Dataset) => void;
  onRename: () => void;
  onDelete: () => void;
  getRowLabel: (row: CollectionRow) => string;
};

const newEntryId = () => `de_${Date.now()}_${Math.random().toString(16).slice(2)}`;

// CollectionField type -> the value type used when coupling a result to a column.
const columnValueType = (t: CollectionField["type"] | undefined): DatasetFieldType =>
  t === "number" ? "number" : t === "bool" ? "bool" : "string";

const inputStyle: React.CSSProperties = {
  borderRadius: 6,
  border: "1px solid var(--border-2)",
  background: "var(--bg-surface)",
  color: "var(--text)",
  padding: "4px 6px",
  fontSize: 12,
  height: 28,
  boxSizing: "border-box",
};


// A single value editor whose control follows the value type.
const TypedValueInput: React.FC<{
  type: DatasetFieldType;
  value: string | number;
  onChange: (v: string | number) => void;
  width?: number;
}> = ({ type, value, onChange, width }) => {
  if (type === "bool") {
    return (
      <input
        type="checkbox"
        checked={value === "true" || value === 1}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        style={{ width: 16, height: 16 }}
      />
    );
  }
  if (type === "number") {
    return (
      <input
        type="number"
        value={Number(value) || 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        style={{ ...inputStyle, width: width ?? 90 }}
      />
    );
  }
  return (
    <input
      type="text"
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, width: width ?? 160 }}
    />
  );
};

// One draggable entry card. Only the handle starts a drag, so the inputs inside stay usable.
const SortableEntryCard: React.FC<{ id: Id; children: React.ReactNode; compact?: boolean }> = ({ id, children, compact }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      title="Drag to reorder"
      aria-label="Drag to reorder"
      style={{ position: "absolute", left: 2, top: 0, bottom: 0, width: 18, border: "none", background: "transparent", color: "var(--text-3)", cursor: isDragging ? "grabbing" : "grab", padding: 0, fontSize: 14, lineHeight: 1, touchAction: "none" }}
    >
      ⠿
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.85 : 1,
        boxShadow: isDragging ? "0 6px 18px rgba(0,0,0,0.25)" : undefined,
        ...(compact
          ? { borderRadius: 6, background: isDragging ? "var(--bg-panel)" : "transparent", padding: "2px 4px 2px 22px" }
          : { border: "1px solid var(--border-2)", borderRadius: 8, background: "var(--bg-panel)", padding: "8px 10px 8px 22px" }),
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      {handle}
      {children}
    </div>
  );
};

const DatasetView: React.FC<Props> = ({ dataset, collections, onChange, onRename, onDelete, getRowLabel }) => {
  const { t } = useLang();
  const fieldDefs = dataset.fieldDefs ?? [];

  // Hide the JSON preview side panel when the view is too narrow (e.g. a squeezed
  // dual-view panel) so the entries column keeps a usable width instead of overflowing.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setViewWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The JSON preview can also be hidden by hand (remembered on this device).
  const [jsonOpen, setJsonOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("evenstory_cond_json") !== "0"; } catch { return true; }
  });
  const toggleJson = () => {
    setJsonOpen((v) => {
      try { localStorage.setItem("evenstory_cond_json", v ? "0" : "1"); } catch { /* ignore */ }
      return !v;
    });
  };
  const showJsonPreview = jsonOpen && (viewWidth === 0 || viewWidth >= 620);

  // Entries are shown in blocks: consecutive entries with the same subject and condition values share
  // one header, so a run of lines reads as just the lines. Changing one entry's subject or a condition
  // value splits it off into its own block.
  const [editingGroup, setEditingGroup] = useState<Id | null>(null); // block whose header is being edited
  const [openEntry, setOpenEntry] = useState<Id | null>(null); // one entry's own subject/conditions shown

  const recordOptions = useMemo(
    () =>
      collections.map((c) => ({
        id: c.id,
        name: c.name,
        rows: c.rows,
      })),
    [collections]
  );

  // Records offered when linking text in a result ("/" search or the link button).
  const linkableRecords = useMemo<LinkableRecord[]>(
    () =>
      collections.flatMap((c) =>
        c.rows.map((row) => ({
          collectionId: c.id,
          collectionName: c.name,
          color: c.color,
          entityId: row.id,
          displayId: String(row.values["id"] ?? ""),
          label: getRowLabel(row),
        }))
      ),
    [collections, getRowLabel]
  );

  // Live preview of the engine-readable JSON this condition exports.
  const engineJson = useMemo(() => {
    try {
      const proj = { collections } as unknown as Project;
      return JSON.stringify(buildDatasetFile(proj, dataset), null, 2);
    } catch {
      return "{}";
    }
  }, [dataset, collections]);

  // ---- Field-def editing ----------------------------------------------------
  const setFieldDefs = (defs: DatasetFieldDef[]) => {
    // Keep every entry's field map consistent with the new defs.
    const entries = dataset.entries.map((e) => ({ ...e, fields: ensureFieldValues(defs, e.fields) }));
    onChange({ ...dataset, fieldDefs: defs, entries });
  };

  const addField = () => {
    if (fieldDefs.length >= MAX_DATASET_FIELDS) return;
    const used = new Set(fieldDefs.map((d) => d.id));
    const id = makeUniqueDatasetFieldId(makeDatasetFieldId("New Field"), used);
    setFieldDefs([...fieldDefs, { id, label: "New Field", type: "number", defaultValue: 1 }]);
  };

  const updateField = (idx: number, patch: Partial<DatasetFieldDef>) =>
    setFieldDefs(fieldDefs.map((d, i) => (i === idx ? { ...d, ...patch } : d)));

  const removeField = (idx: number) => setFieldDefs(fieldDefs.filter((_, i) => i !== idx));

  // ---- Entry editing --------------------------------------------------------
  // A new entry carries on from the last one: same subject and condition values, empty result.
  const addEntry = () => {
    const last = dataset.entries[dataset.entries.length - 1];
    const entry: DatasetEntry = {
      id: newEntryId(),
      ...(last?.subjectCollectionId ? { subjectCollectionId: last.subjectCollectionId, subjectEntityId: last.subjectEntityId } : {}),
      fields: last ? ensureFieldValues(fieldDefs, { ...last.fields }) : buildDefaultFieldValues(fieldDefs),
      result: { kind: "text", value: "" },
    };
    onChange({ ...dataset, entries: [...dataset.entries, entry] });
  };

  // Another line in a block: inserted right after its last entry, with the block's subject and values.
  const addLineToGroup = (group: DatasetEntry[]) => {
    const last = group[group.length - 1];
    const at = dataset.entries.findIndex((e) => e.id === last.id) + 1;
    const entry: DatasetEntry = {
      id: newEntryId(),
      ...(last.subjectCollectionId ? { subjectCollectionId: last.subjectCollectionId, subjectEntityId: last.subjectEntityId } : {}),
      fields: { ...last.fields },
      result: { kind: "text", value: "" },
    };
    const entries = [...dataset.entries];
    entries.splice(at, 0, entry);
    onChange({ ...dataset, entries });
  };

  // Editing a block's header changes every entry in it, so the block stays together.
  const updateGroup = (group: DatasetEntry[], patch: Partial<DatasetEntry>) => {
    const ids = new Set(group.map((e) => e.id));
    onChange({ ...dataset, entries: dataset.entries.map((e) => (ids.has(e.id) ? { ...e, ...patch } : e)) });
  };

  const groupKey = (e: DatasetEntry) =>
    `${e.subjectCollectionId ?? ""}|${e.subjectEntityId ?? ""}|${JSON.stringify(fieldDefs.map((d) => e.fields?.[d.id] ?? null))}`;
  const groups = useMemo(() => {
    const out: DatasetEntry[][] = [];
    for (const e of dataset.entries) {
      const prev = out[out.length - 1];
      if (prev && groupKey(prev[0]) === groupKey(e)) prev.push(e);
      else out.push([e]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.entries, fieldDefs]);

  const updateEntry = (id: Id, patch: Partial<DatasetEntry>) =>
    onChange({ ...dataset, entries: dataset.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const removeEntry = (id: Id) =>
    onChange({ ...dataset, entries: dataset.entries.filter((e) => e.id !== id) });

  // Reordering entries reorders the engine file too (buildDatasetFile keeps array order).
  const entrySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onEntryDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = dataset.entries.findIndex((e) => e.id === active.id);
    const to = dataset.entries.findIndex((e) => e.id === over.id);
    if (from < 0 || to < 0) return;
    onChange({ ...dataset, entries: arrayMove(dataset.entries, from, to) });
  };

  // Change a result's kind, preserving sensible defaults.
  const changeResultKind = (entry: DatasetEntry, kind: DatasetResult["kind"]) => {
    let result: DatasetResult;
    if (kind === "text") result = { kind: "text", value: "" };
    else if (kind === "value") result = { kind: "value", valueType: "string", value: "" };
    else {
      // Start empty so the user explicitly picks the target (avoids defaulting to the subject record).
      result = { kind: "column", collectionId: "", entityId: "", fieldId: "", value: "" };
    }
    updateEntry(entry.id, { result });
  };

  const renderResultEditor = (entry: DatasetEntry) => {
    const r = entry.result;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
        <select
          className="themed-select"
          value={r.kind}
          onChange={(e) => changeResultKind(entry, e.target.value as DatasetResult["kind"])}
          style={{ ...inputStyle, width: 92 }}
        >
          <option value="text">{t("cond.resText")}</option>
          <option value="value">{t("cond.resValue")}</option>
          <option value="column">{t("cond.resColumn")}</option>
        </select>

        {r.kind === "text" && (
          <LinkedTextField
            fieldKey={entry.id}
            value={r.value}
            richValue={r.richValue}
            records={linkableRecords}
            onChange={({ value, richValue, links }) =>
              updateEntry(entry.id, {
                result: links.length ? { kind: "text", value, richValue, links } : { kind: "text", value },
              })
            }
            placeholder={t("cond.phTextValue")}
            style={{ ...inputStyle, height: "auto", minHeight: 28, padding: 0, flex: 1, minWidth: 140 }}
          />
        )}

        {r.kind === "value" && (
          <>
            <select
              className="themed-select"
              value={r.valueType}
              onChange={(e) => {
                const vt = e.target.value as DatasetFieldType;
                updateEntry(entry.id, {
                  result: { kind: "value", valueType: vt, value: vt === "number" ? 0 : vt === "bool" ? "false" : "" },
                });
              }}
              style={{ ...inputStyle, width: 90 }}
            >
              <option value="string">{t("cond.typeString")}</option>
              <option value="number">{t("cond.typeNumber")}</option>
              <option value="bool">{t("cond.typeBool")}</option>
            </select>
            <span style={{ opacity: 0.5 }}>=</span>
            <TypedValueInput
              type={r.valueType}
              value={r.value}
              onChange={(v) => updateEntry(entry.id, { result: { ...r, value: v } })}
            />
          </>
        )}

        {r.kind === "column" && (() => {
          const col = collections.find((c) => c.id === r.collectionId);
          const field = col?.schema.find((f) => f.id === r.fieldId);
          const vType = columnValueType(field?.type);
          return (
            <>
              <select
                className="themed-select"
                value={r.collectionId}
                onChange={(e) => {
                  updateEntry(entry.id, {
                    result: { kind: "column", collectionId: e.target.value, entityId: "", fieldId: "", value: "" },
                  });
                }}
                style={{ ...inputStyle, width: 104 }}
              >
                <option value="">{t("cond.phTable")}</option>
                {recordOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>

              <select
                className="themed-select"
                value={r.entityId}
                onChange={(e) => updateEntry(entry.id, { result: { ...r, entityId: e.target.value } })}
                disabled={!col}
                style={{ ...inputStyle, width: 104 }}
              >
                <option value="">{t("cond.phRecord")}</option>
                {(col?.rows ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{getRowLabel(row)}</option>
                ))}
              </select>

              <span style={{ opacity: 0.5 }}>.</span>

              <select
                className="themed-select"
                value={r.fieldId}
                onChange={(e) => updateEntry(entry.id, { result: { ...r, fieldId: e.target.value, value: "" } })}
                disabled={!col}
                style={{ ...inputStyle, width: 100 }}
              >
                <option value="">{t("cond.phColumn")}</option>
                {(col?.schema ?? [])
                  .filter((f) => f.id !== "name")
                  .map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
              </select>

              <span style={{ opacity: 0.5 }}>=</span>
              <TypedValueInput
                type={vType}
                value={r.value}
                onChange={(v) => updateEntry(entry.id, { result: { ...r, value: v } })}
              />
            </>
          );
        })()}
      </div>
    );
  };

  // Who says it: table + record selects.
  const renderSubjectEditor = (entry: DatasetEntry, set: (patch: Partial<DatasetEntry>) => void) => {
    const subjCol = collections.find((c) => c.id === entry.subjectCollectionId);
    return (
      <>
        <select
          className="themed-select"
          value={entry.subjectCollectionId ?? ""}
          onChange={(e) => {
            const nc = collections.find((c) => c.id === e.target.value);
            set({ subjectCollectionId: e.target.value || undefined, subjectEntityId: nc?.rows[0]?.id });
          }}
          style={{ ...inputStyle, width: 120 }}
        >
          <option value="">{t("cond.phTable")}</option>
          {recordOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {subjCol && (
          <select
            className="themed-select"
            value={entry.subjectEntityId ?? ""}
            onChange={(e) => set({ subjectEntityId: e.target.value || undefined })}
            style={{ ...inputStyle, width: 120 }}
          >
            <option value="">{t("cond.phRecord")}</option>
            {(subjCol.rows ?? []).map((row) => (
              <option key={row.id} value={row.id}>{getRowLabel(row)}</option>
            ))}
          </select>
        )}
      </>
    );
  };

  // When: one input per condition field.
  const renderConditionEditor = (entry: DatasetEntry, set: (fields: DatasetEntry["fields"]) => void) =>
    fieldDefs.map((def) => (
      <label key={def.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.85 }}>
        <span style={{ opacity: 0.7 }}>{def.label}</span>
        {def.type === "record" ? (
          <select
            className="themed-select"
            value={String(entry.fields?.[def.id] ?? "")}
            onChange={(e) => set({ ...entry.fields, [def.id]: e.target.value })}
            style={{ ...inputStyle, width: 120 }}
          >
            <option value="">{t("cond.phRecord")}</option>
            {(collections.find((c) => c.id === def.collectionId)?.rows ?? []).map((row) => (
              <option key={row.id} value={row.id}>{getRowLabel(row)}</option>
            ))}
          </select>
        ) : (
          <TypedValueInput
            type={def.type}
            value={entry.fields?.[def.id] ?? (def.type === "number" ? 1 : def.type === "bool" ? "false" : "")}
            width={def.type === "number" ? 56 : 100}
            onChange={(v) => set({ ...entry.fields, [def.id]: v })}
          />
        )}
      </label>
    ));

  // A record field's value as people read it: the record's label (its Name, or its ID).
  const recordLabel = (def: DatasetFieldDef, raw: string | number | undefined) => {
    const row = collections.find((c) => c.id === def.collectionId)?.rows.find((r) => r.id === raw);
    return row ? getRowLabel(row) : raw ? fieldLevelValue(collections, def, raw) : "—";
  };

  // The block header at rest: "BROTHER · Act 1 · Chapter 1 · Stage 2 · Interaction 1".
  const renderSummary = (entry: DatasetEntry) => {
    const subjCol = collections.find((c) => c.id === entry.subjectCollectionId);
    const subjRow = subjCol?.rows.find((r) => r.id === entry.subjectEntityId);
    const chip: React.CSSProperties = { fontSize: 12, padding: "2px 7px", borderRadius: 10, background: "var(--bg-surface)", border: "1px solid var(--border-2)", whiteSpace: "nowrap" };
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{subjRow ? getRowLabel(subjRow) : t("cond.noSubject", "(no subject)")}</span>
        {fieldDefs.map((def) => (
          <span key={def.id} style={chip}>
            <span style={{ opacity: 0.6 }}>{def.label}</span> <b>{def.type === "record" ? recordLabel(def, entry.fields?.[def.id]) : String(entry.fields?.[def.id] ?? "")}</b>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ height: "100%", padding: "12px 16px", boxSizing: "border-box", display: "flex", flexDirection: "column", minHeight: 0, gap: 10 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {dataset.name}
          </div>
          <button type="button" className="iconBtn" onClick={onRename} title={t("cond.rename")}>✎</button>
        </div>
        <button
          type="button"
          onClick={onDelete}
          style={{ borderRadius: 8, border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", padding: "6px 10px", cursor: "pointer", fontSize: 13 }}
        >
          {t("cond.delete")}
        </button>
      </div>

      {/* Fields */}
      <div style={{ border: "1px solid var(--border-2)", borderRadius: 10, background: "var(--bg-surface)", padding: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>{t("cond.fields")}</div>
          <button
            type="button"
            onClick={addField}
            disabled={fieldDefs.length >= MAX_DATASET_FIELDS}
            title={fieldDefs.length >= MAX_DATASET_FIELDS ? t("cond.maxFields") : t("cond.addFieldTitle")}
            style={{ ...inputStyle, cursor: fieldDefs.length >= MAX_DATASET_FIELDS ? "not-allowed" : "pointer", opacity: fieldDefs.length >= MAX_DATASET_FIELDS ? 0.6 : 1 }}
          >
            {t("cond.addField")}
          </button>
        </div>
        {fieldDefs.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.6 }}>{t("cond.noFields")}</div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {fieldDefs.map((def, idx) => (
            <div key={def.id} style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--border-2)", borderRadius: 6, padding: "2px 2px 2px 6px", background: "var(--bg-panel)" }}>
              <input
                value={def.label}
                onChange={(e) => updateField(idx, { label: e.target.value })}
                placeholder={t("cond.label")}
                style={{ ...inputStyle, width: 120, border: "none", background: "transparent", padding: "4px 2px" }}
              />
              <select
                className="themed-select"
                value={def.type}
                onChange={(e) => {
                  const type = e.target.value as DatasetFieldDef["type"];
                  updateField(idx, type === "record"
                    ? { type, collectionId: def.collectionId ?? collections[0]?.id, defaultValue: undefined }
                    : { type, collectionId: undefined, defaultValue: undefined });
                }}
                style={{ ...inputStyle, width: 84 }}
              >
                <option value="number">{t("cond.typeNumber")}</option>
                <option value="string">{t("cond.typeString")}</option>
                <option value="bool">{t("cond.typeBool")}</option>
                <option value="record">{t("cond.typeRecord", "Record")}</option>
              </select>
              {def.type === "record" && (
                <select
                  className="themed-select"
                  value={def.collectionId ?? ""}
                  onChange={(e) => updateField(idx, { collectionId: e.target.value || undefined })}
                  title={t("cond.recordTable", "Which table this field's records come from")}
                  style={{ ...inputStyle, width: 110 }}
                >
                  <option value="">{t("cond.phTable")}</option>
                  {recordOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => removeField(idx)}
                title={t("cond.removeField")}
                style={{ ...inputStyle, width: 26, padding: 0, border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Entries (left) + live JSON (right), filling remaining height */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 12 }}>
        {/* Entries column */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>{t("cond.entries")} ({dataset.entries.length})</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={toggleJson} style={{ ...inputStyle, cursor: "pointer" }}>
                {jsonOpen ? t("cond.hideJson", "Hide JSON") : t("cond.showJson", "Show JSON")}
              </button>
              <button type="button" onClick={addEntry} style={{ ...inputStyle, cursor: "pointer" }}>{t("cond.addEntry")}</button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
            {dataset.entries.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.6, padding: "8px 0" }}>No entries yet. Add one to map fields to a result.</div>
            )}
            <DndContext sensors={entrySensors} collisionDetection={closestCenter} onDragEnd={onEntryDragEnd}>
            <SortableContext items={dataset.entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            {groups.map((group) => {
              const head = group[0];
              const editing = editingGroup === head.id;
              return (
                <div key={head.id} style={{ border: "1px solid var(--border-2)", borderRadius: 8, background: "var(--bg-panel)", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
                  {/* Block header: who and when, once for every line under it */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minHeight: 26 }}>
                    {editing ? (
                      <>
                        {renderSubjectEditor(head, (patch) => updateGroup(group, patch))}
                        {renderConditionEditor(head, (fields) => updateGroup(group, { fields }))}
                      </>
                    ) : (
                      renderSummary(head)
                    )}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                      <button type="button" className="iconBtn" onClick={() => setEditingGroup(editing ? null : head.id)}
                        title={editing ? t("cond.doneEditing", "Done") : t("cond.editBlock", "Change the subject / conditions of these lines")}>
                        {editing ? "✓" : "✎"}
                      </button>
                      <button type="button" onClick={() => addLineToGroup(group)} title={t("cond.addLine", "Add a line here")}
                        style={{ ...inputStyle, height: 24, padding: "0 8px", cursor: "pointer" }}>
                        {t("cond.addLineShort", "+ Line")}
                      </button>
                    </div>
                  </div>
                  {/* The lines */}
                  {group.map((entry) => (
                    <SortableEntryCard key={entry.id} id={entry.id} compact>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {renderResultEditor(entry)}
                        <button type="button" className="iconBtn" onClick={() => setOpenEntry(openEntry === entry.id ? null : entry.id)}
                          title={t("cond.entryDetails", "This line's own subject / conditions (changing them splits it off)")}
                          style={{ opacity: openEntry === entry.id ? 1 : 0.5 }}>
                          ⋯
                        </button>
                        <button
                          type="button"
                          onClick={() => removeEntry(entry.id)}
                          title={t("cond.removeEntry")}
                          style={{ ...inputStyle, width: 24, height: 24, padding: 0, border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", cursor: "pointer", flexShrink: 0 }}
                        >
                          ✕
                        </button>
                      </div>
                      {openEntry === entry.id && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "4px 0 2px" }}>
                          {renderSubjectEditor(entry, (patch) => updateEntry(entry.id, patch))}
                          {renderConditionEditor(entry, (fields) => updateEntry(entry.id, { fields }))}
                        </div>
                      )}
                    </SortableEntryCard>
                  ))}
                </div>
              );
            })}
            </SortableContext>
            </DndContext>
          </div>
        </div>

        {/* Live engine JSON preview (side panel) — hidden when the view is narrow */}
        {showJsonPreview && (
        <div style={{ width: "36%", minWidth: 260, maxWidth: 540, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85, marginBottom: 8 }}>
            conditions/{toSlug(dataset.name) || dataset.id}.json
          </div>
          <pre
            style={{
              margin: 0,
              flex: 1,
              minHeight: 0,
              border: "1px solid var(--border-2)",
              borderRadius: 10,
              background: "var(--bg-deep, var(--bg-surface))",
              color: "var(--text-dim, var(--text-2))",
              padding: 12,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
              lineHeight: 1.5,
              overflow: "auto",
              whiteSpace: "pre",
            }}
          >
            {engineJson}
          </pre>
        </div>
        )}
      </div>
    </div>
  );
};

export default DatasetView;
