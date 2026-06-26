import type { DatasetFieldDef, DatasetResult, Collection } from "./types";

// A short human-readable summary of a dataset entry's result (used by the sidebar
// tree and the Dataset view).
export const summarizeResult = (collections: Collection[], r: DatasetResult | undefined): string => {
  if (!r) return "(empty)";
  if (r.kind === "text") return String(r.value ?? "").trim() || "(empty line)";
  if (r.kind === "value") return `= ${r.value}`;
  const col = collections.find((c) => c.id === r.collectionId);
  const row = col?.rows.find((rr) => rr.id === r.entityId);
  const field = col?.schema.find((f) => f.id === r.fieldId);
  const recName = row ? String(row.values["name"] || row.values["id"] || row.id) : r.entityId || "?";
  return `${recName}.${(field?.label ?? r.fieldId) || "?"} = ${r.value}`;
};

// Shared helpers for dataset index fields (formerly "dialogue fields").
// Kept free of Tauri/Supabase imports so both App.tsx and DatasetView can use them.

export const DEFAULT_DIALOGUE_FIELD_DEFS: DatasetFieldDef[] = [
  { id: "STAGE", label: "Stage", type: "number", defaultValue: 1 },
  { id: "INTERACTION", label: "Interaction", type: "number", defaultValue: 1 },
];

export const MAX_DATASET_FIELDS = 10;

export const makeDatasetFieldId = (label: string, fallback = "FIELD"): string => {
  const cleaned = String(label || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return cleaned || fallback;
};

export const makeUniqueDatasetFieldId = (baseId: string, used: Set<string>): string => {
  let next = baseId;
  let n = 2;
  while (used.has(next)) {
    next = `${baseId}_${n}`;
    n++;
  }
  used.add(next);
  return next;
};

export const buildDefaultFieldValues = (defs: DatasetFieldDef[]): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const def of defs) {
    if (def.defaultValue !== undefined) {
      out[def.id] = def.defaultValue;
    } else {
      out[def.id] = def.type === "number" ? 1 : def.type === "bool" ? "false" : "";
    }
  }
  return out;
};

export const ensureFieldValues = (
  defs: DatasetFieldDef[],
  incoming: Record<string, any> | null | undefined
): Record<string, string | number> => {
  const base = incoming && typeof incoming === "object" ? incoming : {};
  const out: Record<string, string | number> = {};
  for (const def of defs) {
    const raw = (base as any)[def.id];
    if (raw === undefined || raw === null || raw === "") {
      out[def.id] =
        def.defaultValue !== undefined
          ? def.defaultValue
          : def.type === "number"
            ? 1
            : def.type === "bool"
              ? "false"
              : "";
    } else {
      out[def.id] =
        def.type === "number"
          ? Math.max(1, Number(raw) || 1)
          : def.type === "bool"
            ? raw === true || raw === "true" ? "true" : "false"
            : String(raw);
    }
  }
  return out;
};
