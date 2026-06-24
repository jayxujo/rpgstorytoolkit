export function toSlug(name: string): string {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled';
}

// Parses the "Group: Child" naming convention into path segments.
// "Folder: Chapter 1" => ["folder", "chapter_1"];  "Chapter 1" => ["chapter_1"]
export function groupedSlugPath(name: string): string[] {
  const match = String(name ?? '').match(/^(.+?)\s*:\s*(.+)$/);
  if (match) return [toSlug(match[1]), toSlug(match[2])];
  return [toSlug(name)];
}

// Joined form of groupedSlugPath, e.g. "folder/chapter_1" or "chapter_1".
export function groupedSlug(name: string): string {
  return groupedSlugPath(name).join('/');
}

// Parses a typed name with the "Folder: Sub: Leaf" convention into an explicit
// folder path (display names) + leaf name. Supports arbitrary depth.
// "Act 1: Scene 2: Opening" => { folderPath: ["Act 1","Scene 2"], name: "Opening" }
export function parseTitlePath(raw: string): { folderPath: string[]; name: string } {
  const parts = String(raw ?? '').split(':').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { folderPath: [], name: String(raw ?? '').trim() };
  return { folderPath: parts.slice(0, -1), name: parts[parts.length - 1] };
}

// Vault-relative slug segments for any item: folder slugs + leaf slug.
export function vaultSegments(folderPath: string[] | undefined, leaf: string): string[] {
  return [...(folderPath ?? []).map(toSlug), toSlug(leaf)];
}

// Aliases for readability at call sites.
export function docVaultSegments(folderPath: string[] | undefined, title: string): string[] {
  return vaultSegments(folderPath, title);
}
export function colVaultSegments(folderPath: string[] | undefined, name: string): string[] {
  return vaultSegments(folderPath, name);
}
