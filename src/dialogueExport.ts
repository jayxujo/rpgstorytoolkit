import type { Project, Dataset, DatasetEntry, DatasetResult, DatasetFieldType } from "./types";

// The subject key for a dataset entry (used for grouping / the top level of the
// dialogue tree): the linked entity's Name, falling back to its ID field, then id.
export function datasetSubjectKey(project: Project, entry: DatasetEntry | any): string {
  const colId = entry?.subjectCollectionId ?? entry?.speakerCollectionId ?? entry?.collectionId;
  const entId = entry?.subjectEntityId ?? entry?.speakerEntityId ?? entry?.entityId ?? entry?.characterId;
  const col = colId ? project.collections.find((c) => c.id === colId) : null;
  const row = col?.rows.find((r) => r.id === entId);
  if (row) return String(row.values["name"] || row.values["id"] || row.id);
  return String(entId ?? "Unknown");
}

// Back-compat alias.
export const dialogueCharKey = datasetSubjectKey;

// Coerce a stored value (always string|number internally) to a typed JSON value.
function coerceTyped(type: DatasetFieldType, value: string | number): string | number | boolean {
  if (type === "bool") return value === "true" || value === 1;
  if (type === "number") return Number(value) || 0;
  return String(value ?? "");
}

// ── Condition file ───────────────────────────────────────────────────────────
// For non-dialogue conditions: each leaf is an array of result objects, which may be
// free text, a plain typed value, or a value coupled to a record's column.
export interface DatasetFile {
  // Index field labels, top-to-bottom. Prefixed with "subject" when any entry
  // sets a subject entity (mirrors how the dialogue file leads with "speaker").
  fields: string[];
  results: Record<string, any>;
}

function serializeResult(project: Project, r: DatasetResult | undefined): any {
  if (!r) return { kind: "value", type: "string", value: "" };
  if (r.kind === "text") return { kind: "text", value: String(r.value ?? "") };
  if (r.kind === "value") {
    return { kind: "value", type: r.valueType, value: coerceTyped(r.valueType, r.value) };
  }
  // column
  const col = project.collections.find((c) => c.id === r.collectionId);
  const row = col?.rows.find((rr) => rr.id === r.entityId);
  const field = col?.schema.find((f) => f.id === r.fieldId);
  const fType: DatasetFieldType =
    field?.type === "number" ? "number" : field?.type === "bool" ? "bool" : "string";
  return {
    kind: "column",
    collection: col?.name ?? r.collectionId,
    record: row ? String(row.values["name"] || row.values["id"] || row.id) : r.entityId,
    field: field?.label ?? r.fieldId,
    type: fType,
    value: coerceTyped(fType, r.value),
  };
}

export function buildDatasetFile(project: Project, dataset: Dataset): DatasetFile {
  const fieldDefs = dataset.fieldDefs ?? [];
  const entries = dataset.entries ?? [];
  const hasSubject = entries.some((e) => e.subjectEntityId);

  const data: Record<string, any> = {};
  for (const entry of entries) {
    const levels: string[] = [];
    if (hasSubject) levels.push(datasetSubjectKey(project, entry));
    for (const def of fieldDefs) levels.push(String(entry.fields?.[def.id] ?? ""));

    const serialized = serializeResult(project, entry.result);

    if (levels.length === 0) {
      if (!Array.isArray(data["_"])) data["_"] = [];
      data["_"].push(serialized);
      continue;
    }

    let node: any = data;
    for (let i = 0; i < levels.length; i++) {
      const key = levels[i];
      if (i === levels.length - 1) {
        if (!Array.isArray(node[key])) node[key] = [];
        node[key].push(serialized);
      } else {
        if (!node[key] || Array.isArray(node[key])) node[key] = {};
        node = node[key];
      }
    }
  }

  return {
    fields: [...(hasSubject ? ["subject"] : []), ...fieldDefs.map((d) => d.label || d.id)],
    results: data,
  };
}

// The id of the default seed condition ("Dialogue"). Only used to give it a stable
// id on migration — it is otherwise a perfectly ordinary condition.
export const DIALOGUE_DATASET_ID = "dialogue";
