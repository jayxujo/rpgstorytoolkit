import { createEditor, $getRoot, $isTextNode, $isElementNode, $createTextNode, $createParagraphNode, type LexicalNode, type TextNode } from "lexical";
import { HeadingNode } from "@lexical/rich-text";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { EntityLinkNode, $createEntityLinkNode, $isEntityLinkNode } from "./EntityLinkNode";
import type { Document as Doc, EntityLink, Id } from "../types";

// Resolve a record's display label (name, id fallback), or null if it's gone.
export type LabelResolver = (collectionId: Id, entityId: Id) => string | null;

// A single shared headless editor for off-screen richContent transforms (migration,
// rename propagation, offset derivation for closed documents). No DOM required.
let headless: ReturnType<typeof createEditor> | null = null;
function getHeadlessEditor() {
  if (!headless) {
    headless = createEditor({
      namespace: "linkEngine",
      nodes: [HeadingNode, EntityLinkNode, HorizontalRuleNode],
      onError: () => {},
    });
  }
  return headless;
}

// Flat, in-reading-order list of text nodes with their global start offset. Mirrors
// Lexical's root.getTextContent(), which joins top-level blocks with "\n\n".
function buildIndex(): { nodes: TextNode[]; starts: number[] } {
  const root = $getRoot();
  const nodes: TextNode[] = [];
  const starts: number[] = [];
  let offset = 0;
  const blocks = root.getChildren();
  blocks.forEach((block, bi) => {
    if (bi > 0) offset += 2; // "\n\n" between top-level blocks
    const visit = (node: LexicalNode) => {
      if ($isTextNode(node)) {
        nodes.push(node as TextNode);
        starts.push(offset);
        offset += (node as TextNode).getTextContentSize();
      } else if ($isElementNode(node)) {
        node.getChildren().forEach(visit);
      }
    };
    visit(block);
  });
  return { nodes, starts };
}

// Derive the EntityLink offset index + plain text from the current editor state.
// This is the single source of truth for `content` + `entityLinks` once a document
// uses chips, so every downstream consumer (wiki, export, timeline) stays correct.
// Collect text + chip offsets from the CURRENT active editor read-context. Call this
// from inside editorState.read(...) (live editor) — see StoryEditor handleChange.
export function collectLinksAndText(docId: Id): { text: string; links: EntityLink[] } {
  const text = $getRoot().getTextContent();
  const links: EntityLink[] = [];
  const { nodes, starts } = buildIndex();
  nodes.forEach((node, i) => {
    if ($isEntityLinkNode(node)) {
      const start = starts[i];
      links.push({
        id: node.getLinkId(),
        docId,
        collectionId: node.getCollectionId(),
        entityId: node.getEntityId(),
        start,
        end: start + node.getTextContentSize(),
      });
    }
  });
  return { text, links };
}

export function readLinksAndText(docId: Id): { text: string; links: EntityLink[] } {
  let out = { text: "", links: [] as EntityLink[] };
  getHeadlessEditor().getEditorState().read(() => {
    out = collectLinksAndText(docId);
  });
  return out;
}

function loadRichContent(richContent: string | undefined, content: string): void {
  const editor = getHeadlessEditor();
  if (richContent) {
    editor.setEditorState(editor.parseEditorState(richContent));
    return;
  }
  // No richContent: synthesize paragraphs from the plain text (blocks split on "\n\n").
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const blocks = String(content ?? "").split("\n\n");
      for (const b of blocks) {
        const para = $createParagraphNode();
        if (b) para.append($createTextNode(b));
        root.append(para);
      }
      if (root.getChildrenSize() === 0) root.append($createParagraphNode());
    },
    { discrete: true }
  );
}

export const isSingleWord = (s: string) => s.trim().length > 0 && !/\s/.test(s.trim());

// Replace the text covering [start,end) with an EntityLinkNode. Handles a range that
// sits inside one text node or spans several (rare: formatting changes mid-span).
// Must be called inside an editor.update() / read context (works for the live editor
// or the headless one — it operates on whatever editor is currently active).
export function wrapRangeAsChip(start: number, end: number, chipText: string, data: { linkId: string; collectionId: string; entityId: string; linkMode: "label" | "text"; color?: string }): void {
  const { nodes, starts } = buildIndex();
  // Collect text nodes overlapping the range.
  const covered: { node: TextNode; ns: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const ns = starts[i];
    const ne = ns + nodes[i].getTextContentSize();
    if (ne <= start || ns >= end) continue;
    covered.push({ node: nodes[i], ns });
  }
  if (covered.length === 0) return;

  const first = covered[0];
  const last = covered[covered.length - 1];
  const beforeText = first.node.getTextContent().slice(0, Math.max(0, start - first.ns));
  const afterText = last.node.getTextContent().slice(Math.max(0, end - last.ns));
  const format = first.node.getFormat();

  const chip = $createEntityLinkNode(chipText, data);
  chip.setFormat(format);

  const inserts: TextNode[] = [];
  if (beforeText) {
    const b = $createTextNode(beforeText);
    b.setFormat(format);
    inserts.push(b);
  }
  inserts.push(chip);
  if (afterText) {
    const a = $createTextNode(afterText);
    a.setFormat(last.node.getFormat());
    inserts.push(a);
  }

  for (const n of inserts) first.node.insertBefore(n);
  for (const c of covered) c.node.remove();
}

export function richContentHasChips(richContent: string | undefined): boolean {
  if (!richContent) return false;
  return richContent.includes('"type":"entity-link"');
}

// Convert a legacy document (offset-based entityLinks) into one whose richContent
// contains EntityLink chips. Single-word spans become `label` chips (track the
// record); longer spans become `text` chips (keep the author's words).
export function migrateDocToChips(doc: Doc, labelOf: LabelResolver, colorOf?: (collectionId: Id) => string | undefined): { richContent: string; content: string; entityLinks: EntityLink[] } {
  const editor = getHeadlessEditor();
  loadRichContent(doc.richContent, doc.content);
  const content = doc.content ?? "";
  const links = [...(doc.entityLinks ?? [])].filter((l) => l.end > l.start).sort((a, b) => b.start - a.start);

  editor.update(
    () => {
      for (const link of links) {
        const covered = content.slice(link.start, link.end);
        const label = labelOf(link.collectionId, link.entityId);
        const useLabel = isSingleWord(covered);
        const chipText = useLabel ? (label ?? covered) : covered;
        wrapRangeAsChip(link.start, link.end, chipText, {
          linkId: link.id,
          collectionId: link.collectionId,
          entityId: link.entityId,
          linkMode: useLabel ? "label" : "text",
          color: colorOf?.(link.collectionId),
        });
      }
    },
    { discrete: true }
  );

  const richContent = JSON.stringify(editor.getEditorState().toJSON());
  const { text, links: derived } = readLinksAndText(doc.id);
  return { richContent, content: text, entityLinks: derived };
}

// Re-sync every `label` chip in a document to its record's current label, and refresh
// chip colors. Used after a record rename / recolor. Returns updated doc fields.
export function reconcileDocChips(doc: Doc, labelOf: LabelResolver, colorOf?: (collectionId: Id) => string | undefined): { richContent: string; content: string; entityLinks: EntityLink[] } | null {
  if (!richContentHasChips(doc.richContent)) return null;
  const editor = getHeadlessEditor();
  editor.setEditorState(editor.parseEditorState(doc.richContent!));

  let changed = false;
  editor.update(
    () => {
      const { nodes } = buildIndex();
      for (const node of nodes) {
        if (!$isEntityLinkNode(node)) continue;
        const color = colorOf?.(node.getCollectionId());
        if (color && color !== node.getColor()) {
          node.setColor(color);
          changed = true;
        }
        if (node.getLinkMode() !== "label") continue;
        const label = labelOf(node.getCollectionId(), node.getEntityId());
        if (label != null && label !== node.getTextContent()) {
          node.setTextContent(label);
          changed = true;
        }
      }
    },
    { discrete: true }
  );

  if (!changed) return null;
  const richContent = JSON.stringify(editor.getEditorState().toJSON());
  const { text, links } = readLinksAndText(doc.id);
  return { richContent, content: text, entityLinks: links };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Find/replace plain text in a document, leaving every EntityLink chip untouched
// (so linked text matching the search term is never altered). Returns null if there
// was nothing to change. Operates on richContent so offsets/content stay consistent.
export function replaceTextInDoc(
  doc: Doc,
  find: string,
  replaceWith: string,
  matchCase: boolean
): { richContent: string; content: string; entityLinks: EntityLink[]; count: number } | null {
  if (!find) return null;
  const editor = getHeadlessEditor();
  loadRichContent(doc.richContent, doc.content);
  const re = new RegExp(escapeRegExp(find), matchCase ? "g" : "gi");
  let count = 0;
  editor.update(
    () => {
      const { nodes } = buildIndex();
      for (const node of nodes) {
        if ($isEntityLinkNode(node)) continue; // never touch linked text
        const t = node.getTextContent();
        if (!t) continue;
        let n = 0;
        const next = t.replace(re, () => {
          n++;
          return replaceWith;
        });
        if (n > 0) {
          node.setTextContent(next);
          count += n;
        }
      }
    },
    { discrete: true }
  );
  if (count === 0) return null;
  const richContent = JSON.stringify(editor.getEditorState().toJSON());
  const { text, links } = readLinksAndText(doc.id);
  return { richContent, content: text, entityLinks: links, count };
}
