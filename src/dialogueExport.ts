import type { Project } from "./types";

// The character key for a dialogue entry: the linked entity's Name, falling back
// to its collection ID field (e.g. "JOHN"), then the internal id.
export function dialogueCharKey(project: Project, entry: any): string {
  const colId = entry?.speakerCollectionId ?? entry?.collectionId;
  const entId = entry?.speakerEntityId ?? entry?.entityId ?? entry?.characterId;
  const col = colId ? project.collections.find((c) => c.id === colId) : null;
  const row = col?.rows.find((r) => r.id === entId);
  if (row) return String(row.values["name"] || row.values["id"] || row.id);
  return String(entId ?? "Unknown");
}

// Builds the engine-readable dialogue file. The structure is self-describing so a
// game engine knows what each nesting level means (rather than guessing from depth):
//   {
//     "format": "rpgst.dialogue.v1",
//     "fields": ["speaker", "Stage", "Interaction"],   // names each level, top to bottom
//     "dialogue": { "<speaker>": { "<Stage value>": { "<Interaction value>": ["line", ...] } } }
//   }
// `fields[0]` is always the speaker (the linked entity's name/ID); the rest are the
// dialogue field labels in order. The leaf at the deepest level is an array of lines.
export interface NestedDialogueFile {
  format: "rpgst.dialogue.v1";
  fields: string[];
  dialogue: Record<string, any>;
}

export function buildNestedDialogue(project: Project, opts?: { docIds?: string[] }): NestedDialogueFile {
  const fieldDefs = project.dialogueFieldDefs ?? [];
  const docIds = opts?.docIds;
  const entries = (project.dialogueEntries ?? []).filter(
    (e) => !docIds || docIds.includes(e.documentId)
  );

  const dialogue: Record<string, any> = {};
  for (const entry of entries) {
    const charKey = dialogueCharKey(project, entry);
    const text = String(entry.text ?? "");

    if (fieldDefs.length === 0) {
      if (!Array.isArray(dialogue[charKey])) dialogue[charKey] = [];
      (dialogue[charKey] as string[]).push(text);
      continue;
    }

    if (!dialogue[charKey] || Array.isArray(dialogue[charKey])) dialogue[charKey] = {};
    let node: any = dialogue[charKey];
    for (let i = 0; i < fieldDefs.length; i++) {
      const val = String(entry.fields?.[fieldDefs[i].id] ?? "");
      if (i === fieldDefs.length - 1) {
        if (!Array.isArray(node[val])) node[val] = [];
        node[val].push(text);
      } else {
        if (!node[val] || Array.isArray(node[val])) node[val] = {};
        node = node[val];
      }
    }
  }

  return {
    format: "rpgst.dialogue.v1",
    // Level 0 is the speaker; the remaining levels are the dialogue fields in order.
    fields: ["speaker", ...fieldDefs.map((d) => d.label || d.id)],
    dialogue,
  };
}
