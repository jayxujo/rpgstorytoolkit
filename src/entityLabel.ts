import type { CollectionRow } from "./types";

// Display label for a collection entity: prefer the Name field, fall back to the
// user-set ID field, then the internal row id. Uses || so empty strings fall through.
export function entityLabel(row: CollectionRow): string {
  return String(row.values["name"] || row.values["id"] || row.id);
}
