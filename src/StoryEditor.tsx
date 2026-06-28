// StoryEditor.tsx
import React, { useMemo } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";

// Baton to prevent the selection listener from clearing state immediately after a link click
const recentLinkClickBaton = { t: 0 };

import type { EditorState, NodeKey, TextNode } from "lexical";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  SELECTION_CHANGE_COMMAND,
  KEY_DOWN_COMMAND,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  $isElementNode,
} from "lexical";
import { HeadingNode, $createHeadingNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { HorizontalRuleNode, INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { EntityLinkNode, $isEntityLinkNode } from "./editor/EntityLinkNode";
import { wrapRangeAsChip, collectLinksAndText } from "./editor/linkEngine";

import type { Id, EntityLink } from "./types";

// Imperative handle the host (App) uses to mutate links inside the live editor.
export interface LinkEditorApi {
  // Replace the text in [start,end) with a chip for the given record.
  wrapRange: (start: number, end: number, chipText: string, data: { linkId: string; collectionId: string; entityId: string; linkMode: "label" | "text"; color?: string }) => void;
  // Re-point an existing chip at a different record (relabel = set text to label).
  updateLink: (linkId: string, data: { collectionId: string; entityId: string; label: string; color?: string; relabel: boolean }) => void;
  // Turn the chip with this linkId back into plain text.
  unlink: (linkId: string) => void;
}

const HIDDEN_LINE_MARKER = "\u200B";

const isTrulyEmptyParagraphText = (s: string): boolean => {
  return String(s ?? "").trim().length === 0;
};

const isMarkerOnlyParagraphText = (s: string): boolean => {
  return String(s ?? "") === HIDDEN_LINE_MARKER;
};

const collapseExcessBlankParagraphs = (s: string): string => {
  const t = String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  // Disallow 2+ consecutive empty paragraphs, which show up as 3+ newlines in plain text.
  return t.replace(/\n{3,}/g, "\n\n");
};

const SyncExternalValuePlugin: React.FC<{
  docKey: string;
  value: string;
  richValue?: string;
  lastEmittedRichRef?: React.MutableRefObject<string>;
}> = ({ docKey, value, richValue, lastEmittedRichRef }) => {
  const [editor] = useLexicalComposerContext();
  const lastDocKeyRef = React.useRef<string>("");

  React.useEffect(() => {
    const switchingDoc = lastDocKeyRef.current !== docKey;
    const incomingRich = richValue ?? "";

    // When NOT switching documents, only reload for an EXTERNAL richContent change
    // (e.g. a record rename rewriting chips). Changes the editor itself emitted match
    // lastEmittedRich, so they don't trigger a disruptive reload mid-typing.
    if (!switchingDoc) {
      if (
        lastEmittedRichRef &&
        incomingRich &&
        incomingRich.trim().startsWith("{") &&
        incomingRich !== lastEmittedRichRef.current
      ) {
        try {
          editor.setEditorState(editor.parseEditorState(incomingRich));
          lastEmittedRichRef.current = incomingRich;
        } catch {
          /* ignore */
        }
      }
      return;
    }

    lastDocKeyRef.current = docKey;
    if (lastEmittedRichRef) lastEmittedRichRef.current = incomingRich;

    // Prefer rich state if present + parseable. Fall back to plain text.
    if (incomingRich && incomingRich.trim().startsWith("{")) {
      try {
        const parsed = editor.parseEditorState(incomingRich);
        editor.setEditorState(parsed);
        return;
      } catch {
        // fall through to plain text
      }
    }

    editor.update(() => {
      const root = $getRoot();
      root.clear();

      const text = collapseExcessBlankParagraphs(value ?? "");

      // IMPORTANT:
      // Lexical root.getTextContent() uses "\n\n" between top-level blocks.
      // So when we load plain text (no rich JSON), we must reconstruct blocks
      // from "\n\n" to preserve empty paragraphs and keep indices stable.
      const blocks = text.split("\n\n"); // keeps empty segments (""), which represent empty paragraphs

      // Always keep at least one paragraph
      if (blocks.length === 0) {
        root.append($createParagraphNode());
        return;
      }

      for (const b of blocks) {
        const p = $createParagraphNode();
        if (b.length > 0) {
          p.append($createTextNode(b));
        }
        // If b === "", this becomes a real empty paragraph (the "blank line" you need)
        root.append(p);
      }
    });
  }, [editor, docKey, richValue, lastEmittedRichRef]);

  return null;
};

type AnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SelectionRange = {
  start: number;
  end: number;
  text: string;
  anchorRect: AnchorRect | null;
};

export type SlashEntityItem = {
  collectionId: Id;
  collectionName: string;
  collectionColor?: string;
  entityId: Id; // internal stable row.id
  displayId?: string; // user-facing ID, usually row.values["id"]
  label: string; // display label (usually row.values.name)
};

type SlashLinkCreatePayload = {
  newText: string;
  start: number;
  end: number;
  collectionId: Id;
  entityId: Id;
};

type DialogueQuoteLinkCreatePayload = {
  start: number;
  end: number;
  collectionId: Id;
  entityId: Id;
};

// Lexical's root.getTextContent() inserts "\n\n" between top-level blocks (paragraphs).
// Any global-index math we do (links, selections, slash menus) must match that behavior.
function buildTextNodeIndex(root: any): {
  nodes: TextNode[];
  starts: number[];
  totalLength: number;
} {
  const nodes: TextNode[] = [];
  const starts: number[] = [];
  let offset = 0;

  const visit = (node: any) => {
    if ($isTextNode(node)) {
      const tn = node as TextNode;
      nodes.push(tn);
      starts.push(offset);
      offset += tn.getTextContentSize();
      return;
    }

    const children = node.getChildren?.() ?? [];
    const type = node.getType?.() ?? "";

    // IMPORTANT: separators must mirror Lexical's getTextContent().
    // - root: "\n\n" between top-level blocks
    // - list: "\n" between list items
    // - otherwise: no implicit separator
    const separatorLen = type === "root" ? 2 : type === "list" ? 1 : 0;

    for (let i = 0; i < children.length; i++) {
      visit(children[i]);
      if (separatorLen > 0 && i < children.length - 1) {
        offset += separatorLen;
      }
    }
  };

  visit(root);

  return { nodes, starts, totalLength: offset };
}

function computeCollapsedCursorIndexFromDOM(editor: any): number | null {
  const rootElem = editor.getRootElement?.();
  const sel = window.getSelection();
  if (!rootElem || !sel || sel.rangeCount === 0) return null;

  const r = sel.getRangeAt(0);
  if (!rootElem.contains(r.endContainer)) return null;

  const pre = r.cloneRange();
  pre.selectNodeContents(rootElem);
  pre.setEnd(r.endContainer, r.endOffset);

  const domLen = pre.toString().length;

  // Lexical root.getTextContent() inserts "\n\n" between top-level blocks.
  // The DOM range string typically only accounts for a single "\n" between blocks.
  // So add +1 for each top-level block boundary before the caret.
  let extraBetweenTopBlocks = 0;

  try {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

      const root = $getRoot();
      const topBlocks = root.getChildren();

      const top = selection.anchor.getNode().getTopLevelElementOrThrow();
      const topKey = top.getKey();

      const topIndex = topBlocks.findIndex((n: any) => n.getKey?.() === topKey);
      if (topIndex > 0) extraBetweenTopBlocks = topIndex;
    });
  } catch {
    // ignore; fall back to domLen
  }

  return domLen + extraBetweenTopBlocks;
}

function computeCollapsedCursorIndex(editor: any): number | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const root = $getRoot();
  const { nodes, starts, totalLength } = buildTextNodeIndex(root);
  if (nodes.length === 0) return 0;

  const nodeStartMap = new Map<NodeKey, number>();
  for (let i = 0; i < nodes.length; i++) {
    nodeStartMap.set(nodes[i].getKey(), starts[i]);
  }

  const anchor = selection.anchor;

  // Prefer Lexical selection mapping; fall back to DOM measurement for edge cases.
  if ($isTextNode(anchor.getNode())) {
    const tn = anchor.getNode() as TextNode;
    const start = nodeStartMap.get(tn.getKey());
    if (start == null) return computeCollapsedCursorIndexFromDOM(editor);
    const local = Math.max(0, Math.min(anchor.offset, tn.getTextContentSize()));
    return Math.max(0, Math.min(start + local, totalLength));
  }

  const domSel = window.getSelection();
  const domNode = domSel?.anchorNode;
  const nearest = domNode ? $getNearestNodeFromDOMNode(domNode) : null;
  if (nearest && $isTextNode(nearest)) {
    const tn = nearest as TextNode;
    const start = nodeStartMap.get(tn.getKey());
    if (start == null) return computeCollapsedCursorIndexFromDOM(editor);
    const local = Math.max(0, Math.min(anchor.offset, tn.getTextContentSize()));
    return Math.max(0, Math.min(start + local, totalLength));
  }

  return computeCollapsedCursorIndexFromDOM(editor);
}

function getDomSelectionRect(): AnchorRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const rect = r.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

interface StoryEditorProps {
  docKey: string;

  value: string;
  onChange: (newText: string) => void;

  // Optional rich editor state (Lexical JSON). Persisted separately from `value`.
  richValue?: string;
  onRichChange?: (newStateJson: string) => void;

  onSelectionChange: (range: SelectionRange | null) => void;
  // Passive link popover when caret is inside a linked span
  onCaretLinkChange?: (payload: { linkId: Id | null; anchorRect: AnchorRect | null }) => void;


  // For highlighting / clicking existing links
  entityLinks?: EntityLink[];
  getCollectionColor?: (collectionId: Id) => string | undefined;
  onHighlightClick?: (linkId: Id, anchorRect: DOMRect) => void;

  // Links are now chips inside the document; the editor derives the offset index and
  // reports it up so downstream consumers (wiki/export/timeline) stay in sync.
  onLinksChange?: (links: EntityLink[]) => void;
  // Imperative handle for creating/removing links from the host's link popover.
  linkApiRef?: React.MutableRefObject<LinkEditorApi | null>;

  // Programmatic "scroll to & open this link" (e.g. from the sidebar dialogue tree).
  // Bump scrollNonce to re-trigger even for the same linkId.
  scrollToLinkId?: Id | null;
  scrollNonce?: number;

  // Slash-linking
  slashItems?: SlashEntityItem[];
  onSlashLinkCreate?: (payload: SlashLinkCreatePayload) => void;
  enableSlashLinking?: boolean;

  // Dialogue quote-linking (triggered by typing a closing quote)
  dialogueQuoteItems?: SlashEntityItem[];
  onDialogueQuoteLinkCreate?: (payload: DialogueQuoteLinkCreatePayload) => void;
  enableDialogueQuoteLinking?: boolean;
}

// Minimal theme
const theme = {
  paragraph: "se-paragraph",
  hr: "se-hr",
  heading: {
    h1: "se-h1",
    h2: "se-h2",
    h3: "se-h3",
  },
  text: {
    bold: "se-text-bold",
    italic: "se-text-italic",
  },
};

function onError(error: Error) {
  // eslint-disable-next-line no-console
  console.error(error);
}

const ToolbarPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();

  const onBold = () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
  const onItalic = () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");

  const setParagraph = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      $setBlocksType(selection, () => $createParagraphNode());
    });
  };

  const setHeading = (tag: "h1" | "h2" | "h3") => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      const anchorNode = selection.anchor.getNode();
      const top =
        anchorNode.getTopLevelElementOrThrow?.() ??
        ($isElementNode(anchorNode) ? anchorNode : null);

      const isSameHeading =
        top?.getType?.() === "heading" &&
        (top as any).getTag?.() === tag;

      if (isSameHeading) {
        $setBlocksType(selection, () => $createParagraphNode());
        return;
      }

      $setBlocksType(selection, () => $createHeadingNode(tag));
    });
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 0",
        background: "transparent",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <button type="button" onClick={onBold} className="toolBtn" title="Bold">
        B
      </button>
      <button type="button" onClick={onItalic} className="toolBtn" title="Italic">
        I
      </button>

      <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />

      <button type="button" onClick={setParagraph} className="toolBtn" title="Paragraph">
        P
      </button>
      <button type="button" onClick={() => setHeading("h1")} className="toolBtn" title="Heading 1">
        H1
      </button>
      <button type="button" onClick={() => setHeading("h2")} className="toolBtn" title="Heading 2">
        H2
      </button>
      <button type="button" onClick={() => setHeading("h3")} className="toolBtn" title="Heading 3">
        H3
      </button>

      <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />

      <button type="button" onClick={() => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)} className="toolBtn" title="Divider">
        <span style={{ display: "inline-block", width: 14, height: 2, background: "currentColor", borderRadius: 1, opacity: 0.85 }} />
      </button>
    </div>
  );
};

const PreventConsecutiveEmptyParagraphsPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();
  const fixingRef = React.useRef(false);

  // 1) Block Enter when current paragraph is empty AND previous top-level block is empty.
  React.useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if ((e as any).isComposing) return false;

        // Only plain Enter creates a new paragraph. Allow Shift+Enter (linebreak), Cmd/Ctrl+Enter, etc.
        if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;

        let shouldInsertHiddenMarker = false;
        let shouldBlock = false;

        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

          const root = $getRoot();
          const blocks = root.getChildren();

          const top = selection.anchor.getNode().getTopLevelElementOrThrow?.();
          if (!top) return;

          const topType = (top as any).getType?.() ?? "";
          if (topType !== "paragraph" && topType !== "heading") return;

          const topText = String((top as any).getTextContent?.() ?? "");
          const currEmpty = isTrulyEmptyParagraphText(topText);

          // First priority: if the current line is truly empty, convert it into a hidden-marker line.
          if (currEmpty) {
            shouldInsertHiddenMarker = true;
            return;
          }

          // Backup logic: block only if the previous block is a truly empty paragraph.
          // A marker-only paragraph should NOT count as empty here.
          if (blocks.length < 2) return;

          const idx = blocks.findIndex((n: any) => n?.getKey?.() === (top as any).getKey?.());
          if (idx <= 0) return;

          const prev = blocks[idx - 1];
          const prevType = (prev as any).getType?.() ?? "";
          if (prevType !== "paragraph" && prevType !== "heading") return;

          const prevText = String((prev as any).getTextContent?.() ?? "");
          const prevEmpty =
            isTrulyEmptyParagraphText(prevText) && !isMarkerOnlyParagraphText(prevText);

          if (prevEmpty) shouldBlock = true;
        });

        if (shouldInsertHiddenMarker) {
          e.preventDefault();

          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

            const top = selection.anchor.getNode().getTopLevelElementOrThrow?.();
            if (!top) return;

            top.clear?.();
            top.append($createTextNode(HIDDEN_LINE_MARKER));

            const newParagraph = $createParagraphNode();
            top.insertAfter?.(newParagraph);

            const newSel = $createRangeSelection();
            newSel.anchor.set(newParagraph.getKey(), 0, "element");
            newSel.focus.set(newParagraph.getKey(), 0, "element");
            $setSelection(newSel);
          });

          return true;
        }

        if (shouldBlock) {
          e.preventDefault();
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor]);

  // 2) Safety net: if paste/undo creates consecutive empty paragraphs, remove extras without nuking formatting.
  React.useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      if (fixingRef.current) return;

      let hasConsecutiveEmpty = false;

      editorState.read(() => {
        const root = $getRoot();
        const blocks = root.getChildren();

        let prevWasEmpty = false;

        for (const b of blocks) {
          const type = (b as any).getType?.() ?? "";
          if (type !== "paragraph" && type !== "heading") {
            prevWasEmpty = false;
            continue;
          }

          const blockText = String((b as any).getTextContent?.() ?? "");
          const empty =
            isTrulyEmptyParagraphText(blockText) && !isMarkerOnlyParagraphText(blockText);
          if (empty && prevWasEmpty) {
            hasConsecutiveEmpty = true;
            return;
          }
          prevWasEmpty = empty;
        }
      });

      if (!hasConsecutiveEmpty) return;

      fixingRef.current = true;
      editor.update(() => {
        const root = $getRoot();
        const blocks = root.getChildren();

        let prevWasEmpty = false;

        for (const b of blocks) {
          const type = (b as any).getType?.() ?? "";
          if (type !== "paragraph" && type !== "heading") {
            prevWasEmpty = false;
            continue;
          }

          const blockText = String((b as any).getTextContent?.() ?? "");
          const empty =
            isTrulyEmptyParagraphText(blockText) && !isMarkerOnlyParagraphText(blockText);

          if (empty && prevWasEmpty) {
            (b as any).remove?.();
            continue;
          }

          prevWasEmpty = empty;
        }
      });
      fixingRef.current = false;
    });
  }, [editor]);

  return null;
};

const SelectionListenerPlugin: React.FC<{
  onSelectionChange: (range: SelectionRange | null) => void;
}> = ({ onSelectionChange }) => {
  const [editor] = useLexicalComposerContext();

  React.useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        // Defer so Lexical has final selection
        setTimeout(() => {
          editor.getEditorState().read(() => {
            const selection = $getSelection();

            if (!$isRangeSelection(selection)) {
              onSelectionChange(null);
              return;
            }

            // Collapsed selection is handled by the caret-link listener (so we don't flicker/close on caret moves).
            if (selection.isCollapsed()) {
              return;
            }

            const root = $getRoot();
            const fullText = root.getTextContent();
            const selectedText = selection.getTextContent();

            if (!selectedText || selectedText.length === 0) {
              onSelectionChange(null);
              return;
            }

            // Build a map of TextNode -> global start offset (matches root.getTextContent()).
            const nodeStartMap = new Map<NodeKey, number>();
            const { nodes, starts } = buildTextNodeIndex(root);
            for (let i = 0; i < nodes.length; i++) {
              nodeStartMap.set(nodes[i].getKey(), starts[i]);
            }

            const anchor = selection.anchor;
            const focus = selection.focus;

            const resolvePointToText = (point: any, preferEnd: boolean) => {
              const node = point.getNode();
              const offset = point.offset;
              const pointType = (point as any).type; // "text" | "element"

              // Text point: offset is character offset in TextNode.
              if (pointType === "text" && $isTextNode(node)) {
                return { textNode: node as TextNode, offset };
              }

              // Element point: offset is child index in ElementNode.
              const children = node?.getChildren?.() ?? [];
              if (!Array.isArray(children) || children.length === 0) return null;

              // For the "end" point, Lexical element offsets are often positioned *after* the child,
              // so we pick offset-1 and go to its last descendant.
              // For the "start" point, pick offset and go to its first descendant.
              let childIndex = preferEnd ? offset - 1 : offset;
              if (childIndex < 0) childIndex = 0;
              if (childIndex >= children.length) childIndex = children.length - 1;

              let child: any = children[childIndex];

              // Walk to a text descendant
              const desc = preferEnd ? child.getLastDescendant?.() : child.getFirstDescendant?.();
              const candidate = desc ?? child;

              if (candidate && $isTextNode(candidate)) {
                const tn = candidate as TextNode;
                return { textNode: tn, offset: preferEnd ? tn.getTextContentSize() : 0 };
              }

              // Final fallback: nearest node from DOM selection
              const domSel = window.getSelection();
              const domNode = preferEnd ? domSel?.focusNode : domSel?.anchorNode;
              const nearest = domNode ? $getNearestNodeFromDOMNode(domNode) : null;

              if (nearest && $isTextNode(nearest)) {
                const tn = nearest as TextNode;
                return { textNode: tn, offset: preferEnd ? tn.getTextContentSize() : 0 };
              }

              return null;
            };

            const a = resolvePointToText(anchor, false);
            const b = resolvePointToText(focus, true);

            if (!a || !b) {
              onSelectionChange(null);
              return;
            }

            const aStart = nodeStartMap.get(a.textNode.getKey());
            const bStart = nodeStartMap.get(b.textNode.getKey());

            if (aStart == null || bStart == null) {
              onSelectionChange(null);
              return;
            }

            const aGlobal = aStart + a.offset;
            const bGlobal = bStart + b.offset;

            const approxStart = Math.min(aGlobal, bGlobal);

            // Snap approxStart to actual substring in a small window (prevents off-by-one)
            let start = approxStart;
            const windowRadius = 12;
            const winStart = Math.max(0, approxStart - windowRadius);
            const winEnd = Math.min(fullText.length, approxStart + windowRadius + selectedText.length);
            const windowText = fullText.slice(winStart, winEnd);
            const localIndex = windowText.indexOf(selectedText);

            if (localIndex !== -1) {
              start = winStart + localIndex;
            }

            const end = start + selectedText.length;

            onSelectionChange({ start, end, text: selectedText, anchorRect: getDomSelectionRect() });
          });
        }, 0);

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, onSelectionChange]);

  return null;
};

const CaretLinkListenerPlugin: React.FC<{
  entityLinks?: EntityLink[];
  onCaretLinkChange?: (payload: { linkId: Id | null; anchorRect: AnchorRect | null }) => void;
}> = ({ entityLinks, onCaretLinkChange }) => {
  const [editor] = useLexicalComposerContext();
  const lastLinkIdRef = React.useRef<Id | null>(null);
  const lastPosKeyRef = React.useRef<string>("");

  React.useEffect(() => {
    if (!onCaretLinkChange) return;

    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        setTimeout(() => {
          editor.getEditorState().read(() => {
            const selection = $getSelection();

            // Only track when caret is collapsed (no selection).
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
              if (lastLinkIdRef.current !== null) {
                lastLinkIdRef.current = null;
                lastPosKeyRef.current = "";
                onCaretLinkChange({ linkId: null, anchorRect: null });
              }
              return;
            }

            const idx = computeCollapsedCursorIndex(editor);
            const links = entityLinks ?? [];
            const hit = idx == null ? null : links.find((l) => idx >= l.start && idx < l.end) ?? null;
            const nextId = hit ? hit.id : null;

            const rect = nextId ? getDomSelectionRect() : null;
            const key = rect ? `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.bottom)}` : "";

            if (nextId === lastLinkIdRef.current && key === lastPosKeyRef.current) {
              return;
            }

            lastLinkIdRef.current = nextId;
            lastPosKeyRef.current = key;

            onCaretLinkChange({ linkId: nextId, anchorRect: rect });
          });
        }, 0);

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, entityLinks, onCaretLinkChange]);

  return null;
};


const LinkApiPlugin: React.FC<{
  linkApiRef?: React.MutableRefObject<LinkEditorApi | null>;
  onHighlightClick?: (linkId: Id, anchorRect: DOMRect) => void;
}> = ({ linkApiRef, onHighlightClick }) => {
  const [editor] = useLexicalComposerContext();

  React.useEffect(() => {
    if (!linkApiRef) return;
    linkApiRef.current = {
      wrapRange: (start, end, chipText, data) => {
        editor.update(() => {
          wrapRangeAsChip(start, end, chipText, data);
        });
      },
      updateLink: (linkId, data) => {
        editor.update(() => {
          const stack: any[] = [...$getRoot().getChildren()];
          while (stack.length) {
            const n = stack.shift();
            if ($isEntityLinkNode(n)) {
              if (n.getLinkId() === linkId) {
                n.setEntityRef(data.collectionId, data.entityId);
                if (data.color) n.setColor(data.color);
                if (data.relabel) {
                  n.setLinkMode("label");
                  n.setTextContent(data.label);
                }
              }
            } else if ($isElementNode(n)) {
              stack.unshift(...n.getChildren());
            }
          }
        });
      },
      unlink: (linkId) => {
        editor.update(() => {
          const stack: any[] = [...$getRoot().getChildren()];
          while (stack.length) {
            const n = stack.shift();
            if ($isEntityLinkNode(n)) {
              if (n.getLinkId() === linkId) {
                const plain = $createTextNode(n.getTextContent());
                plain.setFormat(n.getFormat());
                n.replace(plain);
              }
            } else if ($isElementNode(n)) {
              stack.unshift(...n.getChildren());
            }
          }
        });
      },
    };
    return () => {
      if (linkApiRef) linkApiRef.current = null;
    };
  }, [editor, linkApiRef]);

  React.useEffect(() => {
    if (!onHighlightClick) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest("[data-entity-link]") as HTMLElement | null;
      if (!el) return;
      const linkId = el.getAttribute("data-entity-link");
      if (!linkId) return;
      recentLinkClickBaton.t = Date.now();
      onHighlightClick(linkId, el.getBoundingClientRect());
    };
    return editor.registerRootListener((rootEl, prevRootEl) => {
      if (prevRootEl) prevRootEl.removeEventListener("click", handler);
      if (rootEl) rootEl.addEventListener("click", handler);
    });
  }, [editor, onHighlightClick]);

  return null;
};

/**
 * Slash-link typeahead:
 * - typing "/" opens menu
 * - query filters across slashItems
 * - selecting inserts "/<entityId>" and calls onSlashLinkCreate with {newText,start,end,collectionId,entityId}
 */
const SlashLinkTypeaheadPlugin: React.FC<{
  enabled: boolean;
  items: SlashEntityItem[];
  existingLinks: EntityLink[];
  onCreate: (payload: SlashLinkCreatePayload) => void;
}> = ({ enabled, items, existingLinks, onCreate }) => {
  const [editor] = useLexicalComposerContext();

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [anchorRect, setAnchorRect] = React.useState<{ left: number; top: number } | null>(null);

  const triggerStartRef = React.useRef<number | null>(null); // global index of "/"
  const lastCursorRef = React.useRef<number | null>(null);
  const dismissedSlashPosRef = React.useRef<number | null>(null); // user-dismissed slash trigger position

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    setAnchorRect(null);
    triggerStartRef.current = null;
  }, []);

  const isInsideExistingLink = React.useCallback(
    (idx: number) => existingLinks.some((l) => idx >= l.start && idx < l.end),
    [existingLinks]
  );

  const computeCursorIndex = React.useCallback((): number | null => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

    const root = $getRoot();

    // Build a map of TextNode -> global start offset (must match root.getTextContent()).
    const nodeStartMap = new Map<NodeKey, number>();
    const { nodes, starts, totalLength } = buildTextNodeIndex(root);
    for (let i = 0; i < nodes.length; i++) {
      nodeStartMap.set(nodes[i].getKey(), starts[i]);
    }

    const anchor = selection.anchor;

    const getCollapsedEndpoint = (node: any, offsetInNode: number) => {
      // If it's already a TextNode, we can compute the global offset directly.
      if ($isTextNode(node)) {
        return { textNode: node as TextNode, offset: offsetInNode };
      }

      // Otherwise try the nearest text node Lexical can resolve from the DOM selection.
      const domSel = window.getSelection();
      const domNode = domSel?.anchorNode;
      const nearest = domNode ? $getNearestNodeFromDOMNode(domNode) : null;

      if (nearest && $isTextNode(nearest)) {
        const tn = nearest as TextNode;
        const clamped = Math.max(0, Math.min(offsetInNode, tn.getTextContentSize()));
        return { textNode: tn, offset: clamped };
      }

      return null;
    };

    const a = getCollapsedEndpoint(anchor.getNode(), anchor.offset);
    if (!a) {
      // Last-resort fallback to old DOM measurement.
      return computeCollapsedCursorIndexFromDOM(editor);
    }

    const start = nodeStartMap.get(a.textNode.getKey());
    if (start == null) {
      return computeCollapsedCursorIndexFromDOM(editor);
    }

    const global = start + a.offset;
    return Math.max(0, Math.min(global, totalLength));
  }, [editor]);

  const computeCaretRect = React.useCallback((): { left: number; top: number } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);

    const rects = range.getClientRects();
    const r = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (!r) return null;

    // menu under caret
    return { left: r.left, top: r.bottom + 6 };
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);

    const scored = items
      .map((it) => {
        const id = it.entityId.toLowerCase();
        const displayId = String(it.displayId ?? it.entityId).toLowerCase();
        const label = it.label.toLowerCase();
        const col = it.collectionName.toLowerCase();
        const hay = `${id} ${displayId} ${label} ${col}`;

        if (!hay.includes(q)) return null;

        const starts =
          id.startsWith(q) ||
            displayId.startsWith(q) ||
            label.startsWith(q) ||
            col.startsWith(q)
            ? 2
            : 0;

        const exact = displayId === q || id === q ? 5 : 0;

        return { it, score: exact + starts };
      })
      .filter(Boolean) as Array<{ it: SlashEntityItem; score: number }>;

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.it).slice(0, 12);
  }, [items, query]);

  // Keep activeIndex in bounds
  React.useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  const replaceGlobalRange = React.useCallback(
    (start: number, end: number, replacement: string): string | null => {
      const root = $getRoot();

      const topBlocks = root.getChildren?.() ?? [];
      if (!Array.isArray(topBlocks) || topBlocks.length === 0) return null;

      // Helper: ensure a block has a TextNode we can place a selection into.
      // If it's an empty paragraph (or any empty block), we create an empty TextNode.
      const ensureTextNodeInBlock = (block: any): TextNode | null => {
        const firstDesc = block?.getFirstDescendant?.();
        if (firstDesc && $isTextNode(firstDesc)) return firstDesc as TextNode;

        const lastDesc = block?.getLastDescendant?.();
        if (lastDesc && $isTextNode(lastDesc)) return lastDesc as TextNode;

        // No text descendants: create one.
        try {
          const tn = $createTextNode("");
          if (typeof block?.append === "function") {
            block.append(tn);
            return tn;
          }
        } catch {
          // ignore
        }
        return null;
      };

      // Map a "global" index (matching root.getTextContent()) to a {key, offset} in a TextNode.
      // IMPORTANT: if the index falls into a boundary where the NEXT top-level block is empty,
      // we bias the point into that empty block (so insertion happens on the blank line).
      const pointAtGlobal = (idxRaw: number) => {
        const full = root.getTextContent();
        const totalLen = full.length;

        const idx = Math.max(0, Math.min(Number(idxRaw) || 0, totalLen));

        let pos = 0;

        for (let bi = 0; bi < topBlocks.length; bi++) {
          const block = topBlocks[bi];
          const blockText = String(block?.getTextContent?.() ?? "");
          const blockLen = blockText.length;

          const blockEnd = pos + blockLen;

          // If idx is inside this block's text, map into the actual TextNode that contains it.
          // IMPORTANT: HighlightLinksPlugin splits TextNodes, so we must not assume one TextNode per block.
          if (idx <= blockEnd) {
            // Empty block: create/ensure a place to put the caret.
            if (blockLen === 0) {
              const tn = ensureTextNodeInBlock(block);
              return tn ? { key: tn.getKey(), offset: 0 } : { key: null as any, offset: 0 };
            }

            const { nodes, starts, totalLength } = buildTextNodeIndex(root);
            if (nodes.length === 0) {
              const tn = ensureTextNodeInBlock(block);
              return tn ? { key: tn.getKey(), offset: 0 } : { key: null as any, offset: 0 };
            }

            const clamped = Math.max(0, Math.min(idx, totalLength));
            for (let i = 0; i < nodes.length; i++) {
              const s = starts[i];
              const e = s + nodes[i].getTextContentSize();
              if (clamped <= e) {
                const local = Math.max(0, Math.min(clamped - s, nodes[i].getTextContentSize()));
                return { key: nodes[i].getKey(), offset: local };
              }
            }

            const last = nodes[nodes.length - 1];
            return { key: last.getKey(), offset: last.getTextContentSize() };
          }

          // Between top-level blocks Lexical uses "\n\n" (2 chars), except after the last.
          const hasNext = bi < topBlocks.length - 1;
          if (!hasNext) break;

          const sepStart = blockEnd;
          const sepEnd = blockEnd + 2;

          // If idx falls inside the separator region, decide whether it belongs to next block.
          if (idx > sepStart && idx <= sepEnd) {
            const nextBlock = topBlocks[bi + 1];
            const nextLen = String(nextBlock?.getTextContent?.() ?? "").length;

            // Key heuristic:
            // If next block is empty, place the point inside it (so edits on blank lines work).
            if (nextLen === 0) {
              const tn = ensureTextNodeInBlock(nextBlock);
              if (tn) return { key: tn.getKey(), offset: 0 };
            }

            // Otherwise map to the start of the next block.
            const tn = ensureTextNodeInBlock(nextBlock);
            if (tn) return { key: tn.getKey(), offset: 0 };
          }

          // Advance past this block and its separator
          pos = blockEnd + 2;
        }

        // Fallback: last block end
        const lastBlock = topBlocks[topBlocks.length - 1];
        const tn = ensureTextNodeInBlock(lastBlock);
        if (tn) return { key: tn.getKey(), offset: tn.getTextContentSize() };

        // Final fallback to text-node index
        const { nodes, starts, totalLength } = buildTextNodeIndex(root);
        if (nodes.length === 0) return { key: null as any, offset: 0 };
        const clamped = Math.max(0, Math.min(idx, totalLength));
        for (let i = 0; i < nodes.length; i++) {
          const s = starts[i];
          const e = s + nodes[i].getTextContentSize();
          if (clamped <= e) {
            const local = Math.max(0, Math.min(clamped - s, nodes[i].getTextContentSize()));
            return { key: nodes[i].getKey(), offset: local };
          }
        }
        const last = nodes[nodes.length - 1];
        return { key: last.getKey(), offset: last.getTextContentSize() };
      };

      const a = pointAtGlobal(start);
      const b = pointAtGlobal(end);

      if (!a.key || !b.key) return null;

      const sel = $createRangeSelection();
      sel.anchor.set(a.key, a.offset, "text");
      sel.focus.set(b.key, b.offset, "text");
      $setSelection(sel);
      sel.insertText(replacement);

      return root.getTextContent();
    },
    []
  );

  const choose = React.useCallback(
    (it: SlashEntityItem) => {
      const triggerStart = triggerStartRef.current;
      const cursor = lastCursorRef.current;

      if (triggerStart == null || cursor == null) return;

      editor.update(() => {
        const replacement = `${it.label || it.entityId}`;
        const newText = replaceGlobalRange(triggerStart, cursor, replacement);
        if (newText == null) return;

        const start = triggerStart;
        const end = triggerStart + replacement.length;

        onCreate({
          newText,
          start,
          end,
          collectionId: it.collectionId,
          entityId: it.entityId,
        });
      });

      dismissedSlashPosRef.current = null;
      closeMenu();
    },
    [editor, closeMenu, onCreate, replaceGlobalRange]
  );

  // Key handling when menu is open
  React.useEffect(() => {
    if (!enabled) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if ((e as any).isComposing) return false;
        // Open immediately on "/" keypress
        if (!open && e.key === "/") {
          const cursor = computeCursorIndex();
          if (cursor != null && !isInsideExistingLink(cursor)) {
            dismissedSlashPosRef.current = null; // new trigger, allow menu again
            triggerStartRef.current = cursor;
            lastCursorRef.current = cursor;
            setOpen(true);
            setQuery("");
            setAnchorRect(computeCaretRect());
            return true;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu();
          return true;
        }

        if (open && (e.key === "Backspace" || e.key === "Delete")) {
          // Dismiss the menu, but let the editor perform the deletion normally.
          dismissedSlashPosRef.current = triggerStartRef.current;
          closeMenu();
          return false;
        }

        if (open && e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
          return true;
        }

        if (open && e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
          return true;
        }

        if (open && (e.key === "Enter" || e.key === "Tab")) {
          if (filtered.length === 0) return false;
          e.preventDefault();
          const it = filtered[Math.max(0, Math.min(activeIndex, filtered.length - 1))];
          if (it) choose(it);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, enabled, open, filtered, activeIndex, choose, closeMenu]);

  // Detect "/" trigger + keep query updated
  React.useEffect(() => {
    if (!enabled) return;

    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const root = $getRoot();
        const fullText = root.getTextContent();
        const cursor = computeCursorIndex();
        if (cursor == null) {
          if (open) closeMenu();
          return;
        }

        lastCursorRef.current = cursor;

        // If user is inside an existing link, never open (prevents overlap creation)
        if (isInsideExistingLink(cursor)) {
          if (open) closeMenu();
          return;
        }

        // Only consider the current line (after the last newline)
        const lineStart = fullText.lastIndexOf("\n", cursor - 1) + 1;
        const before = fullText.slice(lineStart, cursor);
        const lastSlashLocal = before.lastIndexOf("/");

        if (lastSlashLocal === -1) {
          dismissedSlashPosRef.current = null;
          if (open) closeMenu();
          return;
        }

        const slashPos = lineStart + lastSlashLocal;

        // If the user dismissed this exact slash trigger, keep it closed until "/" is removed.
        if (dismissedSlashPosRef.current != null) {
          const dismissedPos = dismissedSlashPosRef.current;

          // If the dismissed "/" no longer exists, clear dismissal.
          if (dismissedPos < 0 || dismissedPos >= fullText.length || fullText[dismissedPos] !== "/") {
            dismissedSlashPosRef.current = null;
          } else if (dismissedPos === slashPos) {
            if (open) closeMenu();
            return;
          } else {
            // Different slash trigger -> allow menu again.
            dismissedSlashPosRef.current = null;
          }
        }

        // Require boundary before "/"
        const prevCh = slashPos > 0 ? fullText[slashPos - 1] : "";
        const boundaryOk = slashPos === 0 || /\s|[([{]/.test(prevCh);
        if (!boundaryOk) {
          if (open) closeMenu();
          return;
        }

        // Don’t allow slash inside a link span
        if (isInsideExistingLink(slashPos)) {
          if (open) closeMenu();
          return;
        }

        // Query is everything after "/" up to cursor, but must be "tokenish"
        const rawQuery = fullText.slice(slashPos + 1, cursor);

        // Close on whitespace/newline or obvious punctuation
        if (rawQuery.length > 0 && /[\s]/.test(rawQuery)) {
          if (open) closeMenu();
          return;
        }
        if (rawQuery.length > 0 && /[.,;:!?()[\]{}"'`]/.test(rawQuery)) {
          if (open) closeMenu();
          return;
        }

        // Must still be a slash at position
        if (fullText[slashPos] !== "/") {
          if (open) closeMenu();
          return;
        }

        triggerStartRef.current = slashPos;
        setQuery(rawQuery);

        const rect = computeCaretRect();
        if (rect) setAnchorRect(rect);

        if (!open) {
          setOpen(true);
          setActiveIndex(0);
        }
      });
    });
  }, [editor, enabled, open, closeMenu, computeCursorIndex, computeCaretRect, isInsideExistingLink]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // If click is inside our menu, ignore (menu handles selection)
      if (target.closest?.("[data-slash-menu='1']")) return;

      closeMenu();
    };

    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closeMenu]);

  if (!enabled || !open || !anchorRect) return null;

  return createPortal(
    <div
      data-slash-menu="1"
      style={{
        position: "fixed",
        left: anchorRect.left,
        top: anchorRect.top,
        zIndex: 9999,
        width: 360,
        maxHeight: 280,
        overflow: "auto",
        borderRadius: 10,
        border: "1px solid var(--border-2)",
        background: "var(--bg-deep)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        padding: 6,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8, padding: "6px 8px" }}>
        Link entity: <span style={{ opacity: 0.9 }}>/</span>
        <span style={{ opacity: 0.9 }}>{query}</span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: "10px 8px", fontSize: 12, opacity: 0.7 }}>
          No matches
        </div>
      ) : (
        filtered.map((it, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={`${it.collectionId}:${it.entityId}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep editor focus
                choose(it);
              }}
              style={{
                display: "flex",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "var(--accent-deep)" : "transparent",
                border: active ? "1px solid var(--accent-bg)" : "1px solid transparent",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: it.collectionColor ?? "var(--text-dim)",
                  flex: "0 0 auto",
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {it.label}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, display: "flex", gap: 8 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.collectionName}
                  </span>
                  <span style={{ opacity: 0.9 }}>/</span>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {it.displayId ?? it.entityId}
                  </span>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>,
    document.body
  );
};

const QuoteDialogueLinkTypeaheadPlugin: React.FC<{
  enabled: boolean;
  items: SlashEntityItem[];
  existingLinks: EntityLink[];
  onCreate: (payload: DialogueQuoteLinkCreatePayload) => void;
}> = ({ enabled, items, existingLinks, onCreate }) => {
  const [editor] = useLexicalComposerContext();

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);

  const rangeRef = React.useRef<{ start: number; end: number } | null>(null);
  const lastCursorRef = React.useRef<number | null>(null);
  const lastHandledClosePosRef = React.useRef<number | null>(null);
  const prevTextRef = React.useRef<string | null>(null);

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    setAnchorRect(null);
    rangeRef.current = null;
  }, []);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    return items
      .filter((it) => {
        const label = it.label.toLowerCase();
        const entityId = it.entityId.toLowerCase();
        const displayId = String(it.displayId ?? it.entityId).toLowerCase();
        const collectionName = it.collectionName.toLowerCase();

        return (
          label.includes(q) ||
          entityId.includes(q) ||
          displayId.includes(q) ||
          collectionName.includes(q)
        );
      })
      .slice(0, 12);
  }, [items, query]);

  const choose = React.useCallback(
    (it: SlashEntityItem) => {
      const r = rangeRef.current;
      if (!r) return;

      onCreate({
        start: r.start,
        end: r.end,
        collectionId: it.collectionId,
        entityId: it.entityId,
      });

      closeMenu();
    },
    [onCreate, closeMenu]
  );

  const computeCaretRectAtCursor = React.useCallback((): DOMRect | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);

    const rects = range.getClientRects();
    if (rects && rects.length > 0) return rects[0] as DOMRect;

    // Fallback: create a 1-char range if possible
    const node = range.startContainer;
    const off = range.startOffset;
    if (node && node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      if (textNode.length > 0) {
        const start = Math.max(0, Math.min(off - 1, textNode.length - 1));
        const end = Math.max(start + 1, Math.min(start + 1, textNode.length));
        const r2 = document.createRange();
        r2.setStart(textNode, start);
        r2.setEnd(textNode, end);
        const rects2 = r2.getClientRects();
        if (rects2 && rects2.length > 0) return rects2[0] as DOMRect;
      }
    }
    return null;
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      closeMenu();
      return;
    }

    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (open) closeMenu();
          return;
        }

        const root = $getRoot();
        const fullText = root.getTextContent();

        // Compute collapsed cursor index into fullText.
        // Use the DOM selection so it stays correct on new/empty lines and includes "\n".
        const cursor = computeCollapsedCursorIndexFromDOM(editor) ?? fullText.length;

        // If menu is open and the caret moves, close it
        if (open && lastCursorRef.current != null && cursor !== lastCursorRef.current) {
          closeMenu();
        }

        // Track caret for "close-on-move" behavior
        const prevCursor = lastCursorRef.current;
        if (open && prevCursor != null && cursor !== prevCursor) {
          closeMenu();
        }
        lastCursorRef.current = cursor;

        // Detect: a single character was inserted, and that character was a closing quote.
        const prevText = prevTextRef.current;
        prevTextRef.current = fullText;

        if (prevText == null) return;

        // Only react to single-character insertions (typing), not pastes / programmatic changes
        if (fullText.length !== prevText.length + 1) return;

        // Find the inserted character index
        let ins = 0;
        while (ins < prevText.length && prevText[ins] === fullText[ins]) ins++;

        // Validate it is truly a single-char insertion
        if (prevText.slice(ins) !== fullText.slice(ins + 1)) return;

        const closePos = ins;
        const closeCh = fullText[closePos];
        const isCloseQuote = closeCh === `"` || closeCh === "”";
        if (!isCloseQuote) return;

        // Don’t re-open for the same closing quote if the user dismissed the menu
        if (lastHandledClosePosRef.current === closePos) return;

        // Find matching opening quote (nearest previous " or “)
        let openPos = -1;
        for (let i = closePos - 1; i >= 0; i--) {
          const ch = fullText[i];
          if (ch === `"` || ch === "“") {
            openPos = i;
            break;
          }
        }
        if (openPos < 0) return;

        // Must contain actual dialogue content; prevents opening on the *next* opening quote:
        // e.g. ... "Wow!" "   (the second quote would otherwise create an empty "quote span")
        const inner = fullText.slice(openPos + 1, closePos);
        if (inner.trim().length === 0) return;

        const start = openPos;
        const end = closePos + 1;

        // Avoid overlapping existing links
        const overlaps = existingLinks.some((l) => !(end <= l.start || start >= l.end));
        if (overlaps) return;

        rangeRef.current = { start, end };
        lastHandledClosePosRef.current = closePos;

        setQuery("");
        setActiveIndex(0);
        setOpen(true);
        setAnchorRect(computeCaretRectAtCursor());
      });
    });
  }, [editor, enabled, existingLinks, computeCaretRectAtCursor, open, closeMenu]);

  React.useEffect(() => {
    if (!open) return;

    const off = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (e: KeyboardEvent) => {
        if (!open) return false;

        if (e.key === "Escape") {
          e.preventDefault();
          closeMenu();
          return true;
        }

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(0, i - 1));
          return true;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const it = filtered[activeIndex];
          if (it) choose(it);
          return true;
        }

        // Backspace/Delete should dismiss the menu (and let the editor delete normally)
        if (e.key === "Backspace" || e.key === "Delete") {
          closeMenu();
          return false;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setQuery((q) => q + e.key);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => off();
  }, [editor, open, filtered, activeIndex, choose, closeMenu]);

  React.useEffect(() => {
    if (!open) return;

    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;

      const menu = document.getElementById("se-quote-dialogue-menu");
      if (menu && menu.contains(t)) return;

      closeMenu();
    };

    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, closeMenu]);

  if (!open || !anchorRect) return null;

  return createPortal(
    <div
      id="se-quote-dialogue-menu"
      style={{
        position: "fixed",
        left: anchorRect.left,
        top: anchorRect.bottom + 6,
        width: 360,
        maxHeight: 320,
        overflow: "auto",
        background: "var(--bg-deep)",
        border: "1px solid var(--border-2)",
        borderRadius: 10,
        boxShadow: "0 12px 30px rgba(0,0,0,0.5)",
        zIndex: 9999,
        padding: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.9 }}>Link dialogue to…</div>
        <div style={{ fontSize: 11, opacity: 0.65, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
          {query ? query : "type to filter"}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: "10px 8px", fontSize: 12, opacity: 0.7 }}>No matches</div>
      ) : (
        filtered.map((it, idx) => {
          const active = idx === activeIndex;
          return (
            <div
              key={`${it.collectionId}:${it.entityId}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(it);
              }}
              style={{
                display: "flex",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "var(--accent-deep)" : "transparent",
                border: active ? "1px solid var(--accent-bg)" : "1px solid transparent",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: it.collectionColor ?? "var(--text-dim)",
                  flex: "0 0 auto",
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {it.label}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, display: "flex", gap: 8 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {it.collectionName}
                  </span>
                  <span style={{ opacity: 0.9 }}>/</span>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {it.displayId ?? it.entityId}
                  </span>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>,
    document.body
  );
};

const StoryEditor: React.FC<StoryEditorProps> = ({
  docKey,
  value,
  onChange,
  richValue,
  onRichChange,
  onSelectionChange,
  onCaretLinkChange,
  entityLinks,
  onHighlightClick,
  onLinksChange,
  linkApiRef,
  slashItems,
  onSlashLinkCreate,
  enableSlashLinking = true,
  dialogueQuoteItems,
  onDialogueQuoteLinkCreate,
  enableDialogueQuoteLinking = true,
}) => {
  const initialConfig = useMemo(
    () => ({
      namespace: "StoryEditor",
      theme,
      onError,
      nodes: [HeadingNode, EntityLinkNode, HorizontalRuleNode],
    }),
    []
  );

  const lastTextRef = React.useRef<string>(value);
  const lastRichRef = React.useRef<string>(richValue ?? "");
  const lastLinksRef = React.useRef<string>("");

  const handleChange = (editorState: EditorState) => {
    editorState.read(() => {
      // `text` must come from the same walk that produces link offsets so they align.
      const { text, links } = collectLinksAndText(docKey);

      if (text !== lastTextRef.current) {
        lastTextRef.current = text;
        onChange(text);
      }
      if (onLinksChange) {
        const sig = JSON.stringify(links);
        if (sig !== lastLinksRef.current) {
          lastLinksRef.current = sig;
          onLinksChange(links);
        }
      }
    });

    if (onRichChange) {
      try {
        const json = JSON.stringify(editorState.toJSON());
        if (json !== lastRichRef.current) {
          lastRichRef.current = json;
          onRichChange(json);
        }
      } catch {
        // ignore serialization errors
      }
    }
  };

  const effectiveLinks = entityLinks ?? [];

  const slashEnabled = !!enableSlashLinking && !!slashItems && slashItems.length > 0 && !!onSlashLinkCreate;

  const dialogueQuoteEnabled =
    !!enableDialogueQuoteLinking &&
    !!dialogueQuoteItems &&
    dialogueQuoteItems.length > 0 &&
    !!onDialogueQuoteLinkCreate;

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 120,
        }}
      >
        <ToolbarPlugin />
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              style={{
                outline: "none",
                width: "100%",
                flex: "1 1 auto",
                minHeight: 96,
                fontFamily: "inherit",
                fontSize: 16,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                padding: "10px 12px 64px",
                boxSizing: "border-box",
                overflowY: "auto",
                overflowX: "hidden",
              }}
            />
          }
          placeholder={
            <div
              style={{
                position: "absolute",
                top: 54,
                left: 12,
                right: 12,
                opacity: 0.4,
                fontSize: 16,
                pointerEvents: "none",
                lineHeight: 1.6,
              }}
            >
              Write your story, notes, ideas.
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>

      <HistoryPlugin />
      <HorizontalRulePlugin />
      <SyncExternalValuePlugin docKey={docKey} value={value} richValue={richValue} lastEmittedRichRef={lastRichRef} />
      <PreventConsecutiveEmptyParagraphsPlugin />
      <OnChangePlugin onChange={handleChange} />
      <SelectionListenerPlugin onSelectionChange={onSelectionChange} />
      <CaretLinkListenerPlugin entityLinks={entityLinks} onCaretLinkChange={onCaretLinkChange} />

      {slashEnabled && (
        <SlashLinkTypeaheadPlugin
          enabled={slashEnabled}
          items={slashItems!}
          existingLinks={effectiveLinks}
          onCreate={onSlashLinkCreate!}
        />
      )}

      {dialogueQuoteEnabled && (
        <QuoteDialogueLinkTypeaheadPlugin
          enabled={dialogueQuoteEnabled}
          items={dialogueQuoteItems!}
          existingLinks={effectiveLinks}
          onCreate={onDialogueQuoteLinkCreate!}
        />
      )}

      {/* Links are chips (EntityLinkNode) that style themselves; this plugin wires
          click-to-open-popover and the host's create/unlink handle. */}
      <LinkApiPlugin linkApiRef={linkApiRef} onHighlightClick={onHighlightClick} />
    </LexicalComposer>
  );
};

export default StoryEditor;
