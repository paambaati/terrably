import Long from "long";
import { StringKind } from "../gen/tfplugin6.js";
import type { Schema as PbSchema, Schema_Attribute, Schema_NestedBlock } from "../gen/tfplugin6.js";
import type { TfType } from "./types.js";

export type DescriptionKind = "plain" | "markdown";

// ---------------------------------------------------------------------------
// Attribute
// ---------------------------------------------------------------------------

export interface AttributeOptions {
  description?: string;
  descriptionKind?: DescriptionKind;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  sensitive?: boolean;
  deprecated?: boolean;
  deprecationMessage?: string;
  /** Changing this attribute forces resource replacement. */
  requiresReplace?: boolean;
  /** Default value used in plan for computed+not-set attributes. */
  default?: unknown;
}

export class Attribute {
  readonly name: string;
  readonly type: TfType;
  readonly description: string;
  readonly descriptionKind: DescriptionKind;
  readonly required: boolean;
  readonly optional: boolean;
  readonly computed: boolean;
  readonly sensitive: boolean;
  readonly deprecated: boolean;
  readonly deprecationMessage: string;
  readonly requiresReplace: boolean;
  readonly default: unknown;

  constructor(name: string, type: TfType, opts: AttributeOptions = {}) {
    this.name = name;
    this.type = type;
    this.description = opts.description ?? "";
    this.descriptionKind = opts.descriptionKind ?? "markdown";
    this.required = opts.required ?? false;
    this.optional = opts.optional ?? false;
    this.computed = opts.computed ?? false;
    this.sensitive = opts.sensitive ?? false;
    this.deprecated = opts.deprecated ?? false;
    this.deprecationMessage = opts.deprecationMessage ?? "";
    this.requiresReplace = opts.requiresReplace ?? false;
    this.default = opts.default;
  }

  toPb(): Schema_Attribute {
    return {
      name: this.name,
      type: this.type.tfType(),
      description: this.description,
      descriptionKind: this.descriptionKind === "markdown" ? StringKind.MARKDOWN : StringKind.PLAIN,
      required: this.required,
      optional: this.optional,
      computed: this.computed,
      sensitive: this.sensitive,
      deprecated: this.deprecated,
      deprecationMessage: this.deprecationMessage,
      nestedType: undefined,
      writeOnly: false,
    };
  }
}

// ---------------------------------------------------------------------------
// NestedBlock
// ---------------------------------------------------------------------------

export type NestMode = "single" | "list" | "set" | "map" | "group";

const NEST_MODE_MAP: Record<NestMode, Schema_NestedBlock["nesting"]> = {
  single: 1, // SINGLE
  list: 2,   // LIST
  set: 3,    // SET
  map: 4,    // MAP
  group: 5,  // GROUP
};

export interface NestedBlockOptions {
  minItems?: number;
  maxItems?: number;
}

export class NestedBlock {
  readonly typeName: string;
  readonly nestingMode: NestMode;
  readonly block: Block;
  readonly minItems: number;
  readonly maxItems: number;

  constructor(
    typeName: string,
    nestingMode: NestMode,
    block: Block,
    opts: NestedBlockOptions = {}
  ) {
    this.typeName = typeName;
    this.nestingMode = nestingMode;
    this.block = block;
    this.minItems = opts.minItems ?? 0;
    this.maxItems = opts.maxItems ?? 0;
  }

  toPb(): Schema_NestedBlock {
    return {
      typeName: this.typeName,
      nesting: NEST_MODE_MAP[this.nestingMode],
      block: this.block.toPb(),
      minItems: Long.fromNumber(this.minItems),
      maxItems: Long.fromNumber(this.maxItems),
    };
  }

  encode(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((item) => encodeBlock(this.block, item as State));
  }

  decode(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((item) => decodeBlock(this.block, item as Record<string, unknown>));
  }

  semanticallyEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

export interface BlockOptions {
  description?: string;
  descriptionKind?: DescriptionKind;
  deprecated?: boolean;
}

export class Block {
  readonly attributes: Attribute[];
  readonly blockTypes: NestedBlock[];
  readonly description: string;
  readonly descriptionKind: DescriptionKind;
  readonly deprecated: boolean;

  constructor(
    attributes: Attribute[] = [],
    blockTypes: NestedBlock[] = [],
    opts: BlockOptions = {}
  ) {
    this.attributes = attributes;
    this.blockTypes = blockTypes;
    this.description = opts.description ?? "";
    this.descriptionKind = opts.descriptionKind ?? "markdown";
    this.deprecated = opts.deprecated ?? false;
  }

  attrMap(): Record<string, Attribute> {
    return Object.fromEntries(this.attributes.map((a) => [a.name, a]));
  }

  blockMap(): Record<string, NestedBlock> {
    return Object.fromEntries(this.blockTypes.map((b) => [b.typeName, b]));
  }

  toPb(): PbSchema["block"] {
    return {
      version: Long.fromNumber(0),
      attributes: this.attributes.map((a) => a.toPb()),
      blockTypes: this.blockTypes.map((b) => b.toPb()),
      description: this.description,
      descriptionKind:
        this.descriptionKind === "markdown" ? StringKind.MARKDOWN : StringKind.PLAIN,
      deprecated: this.deprecated,
      deprecationMessage: "",
      computed: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Schema (top-level resource/provider schema)
// ---------------------------------------------------------------------------

export class Schema {
  readonly version: number;
  readonly block: Block;

  constructor(attributes: Attribute[] = [], blockTypes: NestedBlock[] = [], version = 0) {
    this.version = version;
    this.block = new Block(attributes, blockTypes);
  }

  toPb(): PbSchema {
    return {
      version: Long.fromNumber(this.version),
      block: this.block.toPb(),
    };
  }
}

// ---------------------------------------------------------------------------
// State encode/decode helpers (used by the servicer)
// ---------------------------------------------------------------------------

export type State = Record<string, unknown>;

export function encodeBlock(block: Block, state: State | null): State | null {
  if (state === null) return null;
  const out: State = {};
  const attrs = block.attrMap();
  const blocks = block.blockMap();
  for (const [k, v] of Object.entries(state)) {
    if (k in attrs) {
      out[k] = attrs[k].type.encode(v);
    } else if (k in blocks) {
      out[k] = blocks[k].encode(v);
    }
  }
  return out;
}

export function decodeBlock(block: Block, raw: Record<string, unknown> | null): State | null {
  if (raw === null) return null;
  const out: State = {};
  const attrs = block.attrMap();
  const blocks = block.blockMap();
  for (const [k, v] of Object.entries(raw)) {
    if (k in attrs) {
      out[k] = attrs[k].type.decode(v);
    } else if (k in blocks) {
      out[k] = blocks[k].decode(v);
    }
  }
  return out;
}
