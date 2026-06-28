import React, { useMemo, useRef, useState, useEffect } from "react";
import { useLang } from "./i18n";
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
import { buildDatasetFile } from "./dialogueExport";
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

// Small dim label that prefixes each segment of an entry row.
const segLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  opacity: 0.45,
  flexShrink: 0,
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
  const showJsonPreview = viewWidth === 0 || viewWidth >= 620;

  const recordOptions = useMemo(
    () =>
      collections.map((c) => ({
        id: c.id,
        name: c.name,
        rows: c.rows,
      })),
    [collections]
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
  const addEntry = () => {
    const entry: DatasetEntry = {
      id: newEntryId(),
      fields: buildDefaultFieldValues(fieldDefs),
      result: { kind: "text", value: "" },
    };
    onChange({ ...dataset, entries: [...dataset.entries, entry] });
  };

  const updateEntry = (id: Id, patch: Partial<DatasetEntry>) =>
    onChange({ ...dataset, entries: dataset.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const removeEntry = (id: Id) =>
    onChange({ ...dataset, entries: dataset.entries.filter((e) => e.id !== id) });

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
          <input
            type="text"
            value={r.value}
            onChange={(e) => updateEntry(entry.id, { result: { kind: "text", value: e.target.value } })}
            placeholder={t("cond.phTextValue")}
            style={{ ...inputStyle, flex: 1, minWidth: 140 }}
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
                onChange={(e) => updateField(idx, { type: e.target.value as DatasetFieldType })}
                style={{ ...inputStyle, width: 84 }}
              >
                <option value="number">{t("cond.typeNumber")}</option>
                <option value="string">{t("cond.typeString")}</option>
                <option value="bool">{t("cond.typeBool")}</option>
              </select>
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
            <button type="button" onClick={addEntry} style={{ ...inputStyle, cursor: "pointer" }}>{t("cond.addEntry")}</button>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
            {dataset.entries.length === 0 && (
              <div style={{ fontSize: 12, opacity: 0.6, padding: "8px 0" }}>No entries yet. Add one to map fields to a result.</div>
            )}
            {dataset.entries.map((entry) => {
              const subjCol = collections.find((c) => c.id === entry.subjectCollectionId);
              return (
                <div
                  key={entry.id}
                  style={{ border: "1px solid var(--border-2)", borderRadius: 8, background: "var(--bg-panel)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}
                >
                  {/* Subject */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ ...segLabelStyle, width: 66 }}>{t("cond.subject")}</span>
                    <select
                      className="themed-select"
                      value={entry.subjectCollectionId ?? ""}
                      onChange={(e) => {
                        const nc = collections.find((c) => c.id === e.target.value);
                        updateEntry(entry.id, { subjectCollectionId: e.target.value || undefined, subjectEntityId: nc?.rows[0]?.id });
                      }}
                      style={{ ...inputStyle, width: 130 }}
                    >
                      <option value="">{t("cond.phTable")}</option>
                      {recordOptions.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {/* The record select only appears once a table is chosen. */}
                    {subjCol && (
                      <select
                        className="themed-select"
                        value={entry.subjectEntityId ?? ""}
                        onChange={(e) => updateEntry(entry.id, { subjectEntityId: e.target.value || undefined })}
                        style={{ ...inputStyle, width: 130 }}
                      >
                        <option value="">{t("cond.phRecord")}</option>
                        {(subjCol.rows ?? []).map((row) => (
                          <option key={row.id} value={row.id}>{getRowLabel(row)}</option>
                        ))}
                      </select>
                    )}

                    <button
                      type="button"
                      onClick={() => removeEntry(entry.id)}
                      title={t("cond.removeEntry")}
                      style={{ marginLeft: "auto", ...inputStyle, width: 26, padding: 0, border: "1px solid var(--danger-border)", background: "var(--danger-bg)", color: "var(--danger-text)", cursor: "pointer" }}
                    >
                      ✕
                    </button>
                  </div>

                  {/* Condition (field values) */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ ...segLabelStyle, width: 66 }}>{t("cond.condition")}</span>
                    {fieldDefs.length === 0 && <span style={{ fontSize: 12, opacity: 0.4 }}>(none)</span>}
                    {fieldDefs.map((def) => (
                      <label key={def.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.85 }}>
                        <span style={{ opacity: 0.7 }}>{def.label}</span>
                        <TypedValueInput
                          type={def.type}
                          value={entry.fields?.[def.id] ?? (def.type === "number" ? 1 : def.type === "bool" ? "false" : "")}
                          width={def.type === "number" ? 60 : 100}
                          onChange={(v) => updateEntry(entry.id, { fields: { ...entry.fields, [def.id]: v } })}
                        />
                      </label>
                    ))}
                  </div>

                  {/* Result */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ ...segLabelStyle, width: 66 }}>{t("cond.result")}</span>
                    {renderResultEditor(entry)}
                  </div>
                </div>
              );
            })}
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
