// Single-line text input that can hold record links (the same EntityLink chips as
// documents), used for condition text results. Link a record by typing "/" and
// picking one, or by selecting text and pressing the link button. Chips are stored in
// `richValue` (Lexical JSON), so record renames update them via reconcileDocChips.
import React from "react";
import { createPortal } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalEditor,
  type PointType,
} from "lexical";
import { EntityLinkNode, $createEntityLinkNode, $isEntityLinkNode } from "./EntityLinkNode";
import { collectLinksAndText, isSingleWord, wrapRangeAsChip } from "./linkEngine";
import type { EntityLink, Id } from "../types";

export type LinkableRecord = {
  collectionId: Id;
  collectionName: string;
  color?: string;
  entityId: Id;       // internal row.id
  displayId?: string; // user-facing ID
  label: string;      // name, id fallback
};

export type LinkedTextChange = { value: string; richValue: string; links: EntityLink[] };

type Props = {
  fieldKey: string; // stable id (e.g. entry id); also stamped on the derived links
  value: string;
  richValue?: string;
  records: LinkableRecord[];
  onChange: (next: LinkedTextChange) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  // Table-cell look: one line that scrolls instead of wrapping, no link button ("/" still links).
  compact?: boolean;
  autoFocus?: boolean; // focus on mount, caret at the end
  onBlur?: () => void;
};

const MAX_ITEMS = 8;
const newLinkId = () => `link_${Date.now()}_${Math.random().toString(16).slice(2)}`;

// Character offset of a selection point within the single paragraph.
function pointOffset(point: PointType): number {
  const para = $getRoot().getFirstChild();
  if (!para || !("getChildren" in para)) return 0;
  const children = (para as unknown as { getChildren: () => { getKey: () => string; getTextContentSize: () => number }[] }).getChildren();
  let offset = 0;
  if (point.type === "element") {
    for (let i = 0; i < Math.min(point.offset, children.length); i++) offset += children[i].getTextContentSize();
    return offset;
  }
  const key = point.getNode().getKey();
  for (const child of children) {
    if (child.getKey() === key) return offset + point.offset;
    offset += child.getTextContentSize();
  }
  return offset;
}

function filterRecords(records: LinkableRecord[], query: string): LinkableRecord[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? records.filter((r) =>
        r.label.toLowerCase().includes(q) ||
        (r.displayId ?? "").toLowerCase().includes(q) ||
        r.collectionName.toLowerCase().includes(q))
    : records;
  return hits.slice(0, MAX_ITEMS);
}

type Menu =
  | { mode: "slash"; query: string; tail: number; rect: DOMRect }
  | { mode: "link"; query: string; rect: DOMRect; start: number; end: number; chipLinkId?: string };

// Keeps the editor in sync with external changes (e.g. a record rename rewriting chips)
// without reloading on the editor's own edits.
const SyncPlugin: React.FC<{ fieldKey: string; value: string; richValue?: string; lastEmittedRef: React.MutableRefObject<string> }> = ({ fieldKey, value, richValue, lastEmittedRef }) => {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => {
    const incoming = richValue ?? "";
    if (incoming) {
      if (incoming === lastEmittedRef.current) return;
      lastEmittedRef.current = incoming;
      try {
        editor.setEditorState(editor.parseEditorState(incoming));
        return;
      } catch { /* fall through to plain text */ }
    }
    const current = editor.getEditorState().read(() => $getRoot().getTextContent());
    if (current === value) return;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      if (value) p.append($createTextNode(value));
      root.append(p);
    });
  }, [editor, fieldKey, value, richValue, lastEmittedRef]);
  return null;
};

// Detects "/query" before the caret, keeps the field single-line, and routes menu keys.
const ControllerPlugin: React.FC<{
  onEditor: (e: LexicalEditor) => void;
  onSlash: (query: string | null, tail?: number) => void;
  menuOpen: boolean;
  onMenuKey: (key: "up" | "down" | "enter" | "escape") => void;
}> = ({ onEditor, onSlash, menuOpen, onMenuKey }) => {
  const [editor] = useLexicalComposerContext();
  const menuOpenRef = React.useRef(menuOpen);
  const onMenuKeyRef = React.useRef(onMenuKey);
  React.useEffect(() => {
    menuOpenRef.current = menuOpen;
    onMenuKeyRef.current = onMenuKey;
  });

  React.useEffect(() => onEditor(editor), [editor, onEditor]);

  React.useEffect(() => {
    const unsubs = [
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || !sel.isCollapsed()) return onSlash(null);
          const node = sel.anchor.getNode();
          if (!$isTextNode(node) || $isEntityLinkNode(node)) return onSlash(null);
          const text = node.getTextContent();
          const m = text.slice(0, sel.anchor.offset).match(/(?:^|\s)\/([^\s/]*)$/);
          // A word right after the caret ("/" typed before "Essence") joins the search.
          const tail = m ? (text.slice(sel.anchor.offset).match(/^[^\s.,;:!?()[\]{}"'`/]+/)?.[0] ?? "") : "";
          onSlash(m ? m[1] + tail : null, tail.length);
        });
      }),
      // Single line: Enter never inserts a paragraph (it picks from the menu instead).
      editor.registerCommand(KEY_ENTER_COMMAND, (e) => {
        e?.preventDefault();
        if (menuOpenRef.current) onMenuKeyRef.current("enter");
        return true;
      }, COMMAND_PRIORITY_HIGH),
      ...([
        [KEY_ARROW_DOWN_COMMAND, "down"],
        [KEY_ARROW_UP_COMMAND, "up"],
        [KEY_ESCAPE_COMMAND, "escape"],
        [KEY_TAB_COMMAND, "enter"],
      ] as const).map(([cmd, key]) =>
        editor.registerCommand(cmd, (e: KeyboardEvent | null) => {
          if (!menuOpenRef.current) return false;
          e?.preventDefault();
          onMenuKeyRef.current(key);
          return true;
        }, COMMAND_PRIORITY_HIGH)
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [editor, onSlash]);
  return null;
};

const LinkedTextField: React.FC<Props> = ({ fieldKey, value, richValue, records, onChange, placeholder, style, compact, autoFocus, onBlur }) => {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<LexicalEditor | null>(null);
  const lastEmittedRef = React.useRef<string>(richValue ?? "");
  const [menu, setMenu] = React.useState<Menu | null>(null);
  const [active, setActive] = React.useState(0);

  const items = React.useMemo(() => (menu ? filterRecords(records, menu.query) : []), [menu, records]);

  const [initialConfig] = React.useState(() => ({
    namespace: `linked-text-${fieldKey}`,
    nodes: [EntityLinkNode],
    onError: (e: Error) => console.error(e),
    editorState: (editor: LexicalEditor) => {
      if (richValue) {
        try {
          editor.setEditorState(editor.parseEditorState(richValue));
          return;
        } catch { /* fall back to plain text */ }
      }
      const p = $createParagraphNode();
      if (value) p.append($createTextNode(value));
      $getRoot().append(p);
    },
  }));

  const handleChange = (state: EditorState) => {
    const json = JSON.stringify(state.toJSON());
    if (json === lastEmittedRef.current) return;
    let out = { text: "", links: [] as EntityLink[] };
    state.read(() => { out = collectLinksAndText(fieldKey); });
    lastEmittedRef.current = json;
    onChange({ value: out.text, richValue: json, links: out.links });
  };

  const onSlash = React.useCallback((query: string | null, tail = 0) => {
    setMenu((m) => {
      if (query == null) return m?.mode === "slash" ? null : m;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return m;
      if (m?.mode === "slash" && m.query === query && m.tail === tail) return m;
      return { mode: "slash", query, tail, rect };
    });
    setActive(0);
  }, []);
  const onEditor = React.useCallback((e: LexicalEditor) => {
    editorRef.current = e;
    if (autoFocus) e.focus(undefined, { defaultSelection: "rootEnd" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insertChip = (rec: LinkableRecord) => {
    const editor = editorRef.current;
    if (!editor || !menu) return;
    const data = { linkId: newLinkId(), collectionId: rec.collectionId, entityId: rec.entityId, color: rec.color };
    if (menu.mode === "slash") {
      const typed = `/${menu.query}`;
      editor.update(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        const node = sel.anchor.getNode();
        if (!$isTextNode(node)) return;
        const end = sel.anchor.offset + menu.tail;
        const start = end - typed.length;
        if (start < 0) return;
        const parts = node.splitText(start, end);
        const target = parts.find((n) => n.getTextContent() === typed);
        if (!target) return;
        const chip = $createEntityLinkNode(rec.label, { ...data, linkMode: "label" });
        target.replace(chip);
        // Caret after the chip; add a space only if one doesn't already follow.
        const next = chip.getNextSibling();
        if ($isTextNode(next) && !$isEntityLinkNode(next) && /^\s/.test(next.getTextContent())) {
          next.select(1, 1);
        } else {
          const space = $createTextNode(" ");
          chip.insertAfter(space);
          space.select(1, 1);
        }
      });
    } else {
      const { start, end } = menu;
      editor.update(() => {
        const text = $getRoot().getTextContent().slice(start, end);
        const single = isSingleWord(text);
        wrapRangeAsChip(start, end, single ? rec.label : text, { ...data, linkMode: single ? "label" : "text" });
      });
      editor.focus();
    }
    setMenu(null);
  };

  const unlinkChip = (linkId: string) => {
    editorRef.current?.update(() => {
      for (const n of $getRoot().getAllTextNodes()) {
        if ($isEntityLinkNode(n) && n.getLinkId() === linkId) n.replace($createTextNode(n.getTextContent()));
      }
    });
    setMenu(null);
  };

  const openLinkMenu = () => {
    const editor = editorRef.current;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!editor || !rect) return;
    let range: { start: number; end: number; chipLinkId?: string } | null = null;
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      const node = sel.anchor.getNode();
      const chipLinkId = $isEntityLinkNode(node) ? node.getLinkId() : undefined;
      const a = pointOffset(sel.anchor);
      const f = pointOffset(sel.focus);
      range = { start: Math.min(a, f), end: Math.max(a, f), chipLinkId };
    });
    const r = range as { start: number; end: number; chipLinkId?: string } | null;
    if (!r || (r.start === r.end && !r.chipLinkId)) {
      // Nothing selected: start a "/" search at the caret instead.
      editor.update(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) sel.insertText("/");
        else $getRoot().selectEnd().insertText("/");
      });
      editor.focus();
      return;
    }
    setMenu({ mode: "link", query: "", rect, start: r.start, end: r.end, chipLinkId: r.chipLinkId });
    setActive(0);
  };

  const onMenuKey = (key: "up" | "down" | "enter" | "escape") => {
    if (key === "escape") return setMenu(null);
    if (key === "down") return setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
    if (key === "up") return setActive((i) => Math.max(0, i - 1));
    if (items[active]) insertChip(items[active]);
  };

  const menuNode = menu && createPortal(
    <div
      onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); }}
      style={{
        position: "fixed",
        left: menu.rect.left,
        top: menu.rect.bottom + 4,
        width: Math.max(240, Math.min(menu.rect.width, 360)),
        zIndex: 1000,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-3)",
        borderRadius: 8,
        boxShadow: "0 8px 24px var(--overlay-3, rgba(0,0,0,0.3))",
        padding: 4,
        fontSize: 12,
      }}
    >
      {menu.mode === "link" && menu.chipLinkId && (
        <button
          type="button"
          onClick={() => unlinkChip(menu.chipLinkId!)}
          style={{ width: "100%", textAlign: "left", padding: "6px 8px", border: "none", borderRadius: 6, background: "transparent", color: "var(--danger-text)", cursor: "pointer", fontSize: 12 }}
        >
          Unlink
        </button>
      )}
      {menu.mode === "link" && (
        <input
          autoFocus
          value={menu.query}
          placeholder="Search records…"
          onChange={(e) => { const query = e.target.value; setMenu((m) => (m ? { ...m, query } : m)); setActive(0); }}
          onKeyDown={(e) => {
            const map: Record<string, "up" | "down" | "enter" | "escape"> = { ArrowDown: "down", ArrowUp: "up", Enter: "enter", Escape: "escape" };
            const k = map[e.key];
            if (k) { e.preventDefault(); onMenuKey(k); }
          }}
          onBlur={() => setTimeout(() => setMenu((m) => (m?.mode === "link" ? null : m)), 150)}
          style={{ width: "100%", boxSizing: "border-box", marginBottom: 4, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-2)", background: "var(--bg-surface)", color: "var(--text)", fontSize: 12 }}
        />
      )}
      {items.length === 0 ? (
        <div style={{ padding: "6px 8px", opacity: 0.6 }}>No matching records</div>
      ) : (
        items.map((r, i) => (
          <div
            key={`${r.collectionId}:${r.entityId}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => insertChip(r)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer", background: i === active ? "var(--bg-hover)" : "transparent" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, background: r.color ?? "var(--accent)", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{r.label}</span>
            <span style={{ opacity: 0.55, whiteSpace: "nowrap" }}>{r.collectionName}</span>
          </div>
        ))
      )}
    </div>,
    document.body
  );

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center", ...style }}>
      <LexicalComposer initialConfig={initialConfig}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                aria-label={placeholder}
                onBlur={() => {
                  setTimeout(() => setMenu((m) => (m?.mode === "slash" ? null : m)), 150);
                  onBlur?.();
                }}
                style={{
                  outline: "none",
                  minHeight: 18,
                  lineHeight: "18px",
                  padding: compact ? "4px 6px" : "4px 30px 4px 6px",
                  ...(compact
                    ? { whiteSpace: "pre", overflowX: "auto", scrollbarWidth: "none" }
                    : { whiteSpace: "pre-wrap", wordBreak: "break-word" }),
                }}
              />
            }
            placeholder={
              <div style={{ position: "absolute", left: 6, top: 4, lineHeight: "18px", opacity: 0.4, pointerEvents: "none" }}>
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
        <SyncPlugin fieldKey={fieldKey} value={value} richValue={richValue} lastEmittedRef={lastEmittedRef} />
        <ControllerPlugin onEditor={onEditor} onSlash={onSlash} menuOpen={!!menu && items.length > 0} onMenuKey={onMenuKey} />
      </LexicalComposer>
      {!compact && <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={openLinkMenu}
        title="Link to a record: select text first, or type / to search"
        style={{ position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)", width: 22, height: 20, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 12, padding: 0 }}
      >
        🔗
      </button>}
      {menuNode}
    </div>
  );
};

// Read-only look of a LinkedTextField (plain text with chips), shown in table cells until
// clicked so big tables don't mount one editor per cell. Same box metrics as `compact`.
export const LinkedTextPreview: React.FC<{
  value: string;
  links?: EntityLink[];
  records: LinkableRecord[];
  style?: React.CSSProperties;
  onActivate: () => void;
}> = ({ value, links, records, style, onActivate }) => {
  const parts: React.ReactNode[] = [];
  let pos = 0;
  [...(links ?? [])]
    .filter((l) => l.end > l.start && l.start >= pos)
    .sort((a, b) => a.start - b.start)
    .forEach((l) => {
      if (l.start < pos) return;
      if (l.start > pos) parts.push(value.slice(pos, l.start));
      const c = records.find((r) => r.collectionId === l.collectionId)?.color || "#4f8cff";
      parts.push(
        <span key={l.id} style={{ borderRadius: 4, padding: "0 1px", backgroundColor: c + "26", boxShadow: `inset 0 -1.5px 0 ${c}` }}>
          {value.slice(l.start, l.end)}
        </span>
      );
      pos = l.end;
    });
  if (pos < value.length) parts.push(value.slice(pos));
  return (
    <div
      tabIndex={0}
      onClick={onActivate}
      onFocus={onActivate}
      style={{ display: "flex", alignItems: "center", cursor: "text", ...style }}
    >
      <div style={{ flex: 1, minWidth: 0, minHeight: 18, lineHeight: "18px", padding: "4px 6px", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
        {parts}
      </div>
    </div>
  );
};

export default LinkedTextField;
