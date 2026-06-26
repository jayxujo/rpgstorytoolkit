import {
  TextNode,
  type SerializedTextNode,
  type NodeKey,
  type EditorConfig,
  type LexicalNode,
} from "lexical";

// A linked span in a document. `label` chips track the linked record's display
// name (id fallback) and update automatically when it's renamed; `text` chips keep
// the author's typed phrase (used for multi-word selections) and are static.
export type EntityLinkMode = "label" | "text";

export interface EntityLinkData {
  linkId: string;
  collectionId: string;
  entityId: string;
  linkMode: EntityLinkMode;
  color?: string;
}

// NOTE: TextNode's own serialized `mode` (normal/token/segmented) is separate from
// our `linkMode`, hence the distinct field name to avoid a JSON key collision.
export interface SerializedEntityLinkNode extends SerializedTextNode {
  linkId: string;
  collectionId: string;
  entityId: string;
  linkMode: EntityLinkMode;
  color?: string;
}

const DEFAULT_COLOR = "#4f8cff";

export class EntityLinkNode extends TextNode {
  __linkId: string;
  __collectionId: string;
  __entityId: string;
  __linkMode: EntityLinkMode;
  __color: string;

  static getType(): string {
    return "entity-link";
  }

  static clone(node: EntityLinkNode): EntityLinkNode {
    return new EntityLinkNode(
      node.__text,
      {
        linkId: node.__linkId,
        collectionId: node.__collectionId,
        entityId: node.__entityId,
        linkMode: node.__linkMode,
        color: node.__color,
      },
      node.__key
    );
  }

  constructor(text: string, data: EntityLinkData, key?: NodeKey) {
    super(text, key);
    this.__linkId = data.linkId;
    this.__collectionId = data.collectionId;
    this.__entityId = data.entityId;
    this.__linkMode = data.linkMode;
    this.__color = data.color ?? DEFAULT_COLOR;
  }

  private applyChipStyle(dom: HTMLElement): void {
    const c = this.__color || DEFAULT_COLOR;
    dom.style.borderRadius = "4px";
    dom.style.padding = "0 1px";
    dom.style.cursor = "pointer";
    dom.style.backgroundColor = c + "26"; // ~15% alpha
    dom.style.boxShadow = `inset 0 -1.5px 0 ${c}`;
    dom.setAttribute("data-entity-link", this.__linkId);
    dom.setAttribute("data-collection-id", this.__collectionId);
    dom.setAttribute("data-entity-id", this.__entityId);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    this.applyChipStyle(dom);
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode, dom, config);
    this.applyChipStyle(dom);
    return updated;
  }

  static importJSON(serialized: SerializedEntityLinkNode): EntityLinkNode {
    const node = $createEntityLinkNode(serialized.text ?? "", {
      linkId: serialized.linkId,
      collectionId: serialized.collectionId,
      entityId: serialized.entityId,
      linkMode: serialized.linkMode === "text" ? "text" : "label",
      color: serialized.color,
    });
    node.setFormat(serialized.format);
    node.setDetail(serialized.detail);
    node.setStyle(serialized.style);
    return node;
  }

  exportJSON(): SerializedEntityLinkNode {
    return {
      ...super.exportJSON(),
      type: "entity-link",
      version: 1,
      linkId: this.__linkId,
      collectionId: this.__collectionId,
      entityId: this.__entityId,
      linkMode: this.__linkMode,
      color: this.__color,
    };
  }

  // Atomic: never merge with neighbouring text so the chip stays one unit.
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }

  getLinkId(): string {
    return this.getLatest().__linkId;
  }
  getCollectionId(): string {
    return this.getLatest().__collectionId;
  }
  getEntityId(): string {
    return this.getLatest().__entityId;
  }
  getLinkMode(): EntityLinkMode {
    return this.getLatest().__linkMode;
  }
  getColor(): string {
    return this.getLatest().__color;
  }

  setColor(color: string): void {
    const self = this.getWritable();
    self.__color = color;
  }

  setEntityRef(collectionId: string, entityId: string): void {
    const self = this.getWritable();
    self.__collectionId = collectionId;
    self.__entityId = entityId;
  }

  setLinkMode(mode: EntityLinkMode): void {
    const self = this.getWritable();
    self.__linkMode = mode;
  }
}

export function $createEntityLinkNode(text: string, data: EntityLinkData): EntityLinkNode {
  const node = new EntityLinkNode(text, data);
  // Token mode makes the chip behave as a single atomic unit: you can't place the
  // caret inside it, and selecting + typing replaces it (which is how editing unlinks).
  node.setMode("token");
  return node;
}

export function $isEntityLinkNode(node: LexicalNode | null | undefined): node is EntityLinkNode {
  return node instanceof EntityLinkNode;
}
