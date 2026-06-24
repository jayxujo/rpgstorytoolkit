// Converts a document's Lexical rich content into Markdown (headings, bold,
// italic, lists) while injecting entity links at their plain-text offsets.
//
// The plain-text offset bookkeeping below must mirror how the app derives a
// document's `content` from its rich content (text nodes verbatim, linebreak =
// "\n", list items joined by "\n", top-level blocks joined by "\n\n"). Entity
// link ranges are offsets into that derived plain text.
import type { EntityLink } from '../types';

export interface ResolvedLink {
  path: string;   // relative path to the collection json, e.g. "../collections/characters.json"
  anchor: string; // entity id, e.g. "CERKA"
}

type ResolveLink = (collectionId: string, entityId: string) => ResolvedLink | null;

function hasFormat(node: any, flag: number, name: string): boolean {
  const f = node?.format;
  if (typeof f === 'number') return (f & flag) !== 0;
  if (typeof f === 'string') {
    return f.split(/\s+/).map((x) => x.trim().toLowerCase()).includes(name);
  }
  return node?.[name] === true;
}

function wrapLinks(
  raw: string,
  start: number,
  end: number,
  links: EntityLink[],
  resolve: ResolveLink,
): string {
  const overlapping = links
    .filter((l) => l.start < end && l.end > start)
    .sort((a, b) => a.start - b.start);
  if (overlapping.length === 0) return raw;

  let result = '';
  let cursor = start;
  for (const l of overlapping) {
    const segStart = Math.max(l.start, start);
    const segEnd = Math.min(l.end, end);
    if (segStart > cursor) result += raw.slice(cursor - start, segStart - start);
    const linkText = raw.slice(segStart - start, segEnd - start);
    const resolved = resolve(l.collectionId, l.entityId);
    result += resolved ? `[${linkText}](${resolved.path}#${resolved.anchor})` : linkText;
    cursor = segEnd;
  }
  if (cursor < end) result += raw.slice(cursor - start);
  return result;
}

export function richContentToMarkdown(
  richJson: string | null | undefined,
  links: EntityLink[],
  resolve: ResolveLink,
): string | null {
  if (!richJson || typeof richJson !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(richJson);
  } catch {
    return null;
  }
  const root = parsed?.root;
  if (!root || typeof root !== 'object') return null;

  let offset = 0;

  const inline = (node: any): string => {
    const t = String(node?.type ?? '');
    if (t === 'text') {
      const raw = String(node?.text ?? '');
      const start = offset;
      offset += raw.length;
      let text = wrapLinks(raw, start, offset, links, resolve);
      const bold = hasFormat(node, 1, 'bold');
      const italic = hasFormat(node, 2, 'italic');
      if (bold && italic) return `***${text}***`;
      if (bold) return `**${text}**`;
      if (italic) return `*${text}*`;
      return text;
    }
    if (t === 'linebreak') {
      offset += 1; // derived content uses "\n"
      return '  \n';
    }
    const children: any[] = Array.isArray(node?.children) ? node.children : [];
    return children.map(inline).join('');
  };

  const block = (node: any): string => {
    const t = String(node?.type ?? '');
    const children: any[] = Array.isArray(node?.children) ? node.children : [];
    if (t === 'heading') {
      const tag = String(node?.tag ?? 'h1').toLowerCase();
      const level = tag === 'h1' ? '#' : tag === 'h2' ? '##' : '###';
      return `${level} ${children.map(inline).join('')}`;
    }
    if (t === 'list') {
      const out: string[] = [];
      children.forEach((child: any, i: number) => {
        if (i > 0) offset += 1; // "\n" between list items in derived content
        const prefix = node?.listType === 'number' ? `${i + 1}. ` : '- ';
        out.push(`${prefix}${block(child)}`);
      });
      return out.join('\n');
    }
    // paragraph, listitem, and fallthrough all concatenate inline children
    return children.map(inline).join('');
  };

  const blocks: any[] = Array.isArray(root.children) ? root.children : [];
  const parts: string[] = [];
  blocks.forEach((b: any, i: number) => {
    if (i > 0) offset += 2; // "\n\n" between top-level blocks in derived content
    parts.push(block(b));
  });
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
