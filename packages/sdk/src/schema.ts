import Long from "long";
import { StringKind, Schema_Object_NestingMode } from "../gen/tfplugin6.js";
import type { Schema as PbSchema, Schema_Attribute, Schema_NestedBlock, Schema_Object } from "../gen/tfplugin6.js";
import type { TfType } from "./types.js";
import { Unknown } from "./types.js";

export type DescriptionKind = "plain" | "markdown";

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
  /** Write-only attribute — value is accepted but never stored in state (Terraform ≥ 1.11). */
  writeOnly?: boolean;
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
  readonly writeOnly: boolean;

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
    this.writeOnly = opts.writeOnly ?? false;
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
      writeOnly: this.writeOnly,
    };
  }
}

export type NestMode = "single" | "list" | "set" | "map" | "group";

// ---------------------------------------------------------------------------
// ObjectAttribute — attribute backed by Schema_Object (nested_type)
// ---------------------------------------------------------------------------

/** Nesting modes for an ObjectAttribute. Mirrors Schema_Object_NestingMode. */
export type ObjNestMode = "single" | "list" | "set" | "map";

const OBJ_NEST_MODE_MAP: Record<ObjNestMode, Schema_Object_NestingMode> = {
  single: Schema_Object_NestingMode.SINGLE,
  list:   Schema_Object_NestingMode.LIST,
  set:    Schema_Object_NestingMode.SET,
  map:    Schema_Object_NestingMode.MAP,
};

/**
 * TfType implementation for nested object attributes (`nested_type` in the
 * Terraform Plugin Protocol). Used internally by ObjectAttribute.
 *
 * Handles all four nesting modes:
 *   - "single" → a single object  `{ field: value, ... }`
 *   - "list"   → an ordered list  `[{ ... },` ...]`
 *   - "set"    → an unordered list `[{ ... }, ...]` (order-insensitive equality)
 *   - "map"    → a string-keyed map `{ key: { ... }, ... }`
 */
export class TfObject implements TfType {
  readonly fields: Attribute[];
  readonly nestingMode: ObjNestMode;

  constructor(fields: Attribute[], nestingMode: ObjNestMode = "single") {
    this.fields = fields;
    this.nestingMode = nestingMode;
  }

  private fieldMap(): Record<string, Attribute> {
    return Object.fromEntries(this.fields.map((f) => [f.name, f]));
  }

  /** Encode a single nested object's fields. */
  private _encodeOne(obj: unknown): unknown {
    if (obj === null || obj === Unknown) return obj;
    const fm = this.fieldMap();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k in fm) out[k] = fm[k].type.encode(v);
    }
    return out;
  }

  /** Decode a single nested object's fields. */
  private _decodeOne(raw: unknown): unknown {
    if (raw === null || raw === Unknown) return raw;
    const fm = this.fieldMap();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k in fm) out[k] = fm[k].type.decode(v);
    }
    return out;
  }

  /** Compare two single nested objects field-by-field using each field's semanticallyEqual. */
  private _equalOne(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (a === Unknown || b === Unknown) return a === b;
    const fm = this.fieldMap();
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return Object.keys(fm).every((k) =>
      fm[k].type.semanticallyEqual(
        ao[k] !== undefined ? ao[k] : null,
        bo[k] !== undefined ? bo[k] : null,
      )
    );
  }

  encode(v: unknown): unknown {
    if (v === null || v === Unknown) return v;
    switch (this.nestingMode) {
      case "single":
        return this._encodeOne(v);
      case "list":
      case "set":
        return (v as unknown[]).map((item) => this._encodeOne(item));
      case "map": {
        const result: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          result[k] = this._encodeOne(val);
        }
        return result;
      }
    }
  }

  decode(v: unknown): unknown {
    if (v === null || v === Unknown) return v;
    switch (this.nestingMode) {
      case "single":
        return this._decodeOne(v);
      case "list":
      case "set":
        return (v as unknown[]).map((item) => this._decodeOne(item));
      case "map": {
        const result: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          result[k] = this._decodeOne(val);
        }
        return result;
      }
    }
  }

  semanticallyEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (a === Unknown || b === Unknown) return a === b;
    switch (this.nestingMode) {
      case "single":
        return this._equalOne(a, b);
      case "list": {
        const aa = a as unknown[];
        const ba = b as unknown[];
        if (aa.length !== ba.length) return false;
        return aa.every((v, i) => this._equalOne(v, ba[i]));
      }
      case "set": {
        const aa = a as unknown[];
        const ba = b as unknown[];
        if (aa.length !== ba.length) return false;
        // Order-insensitive: sort by JSON serialisation.
        const sa = aa.map((v) => JSON.stringify(v)).sort();
        const sb = ba.map((v) => JSON.stringify(v)).sort();
        return sa.every((v, i) => v === sb[i]);
      }
      case "map": {
        const am = a as Record<string, unknown>;
        const bm = b as Record<string, unknown>;
        const aKeys = Object.keys(am).sort();
        const bKeys = Object.keys(bm).sort();
        if (aKeys.join(",") !== bKeys.join(",")) return false;
        return aKeys.every((k) => this._equalOne(am[k], bm[k]));
      }
    }
  }

  /** Returns empty bytes — not used in Schema_Attribute.type when nestedType is set. */
  tfType(): Uint8Array {
    return new Uint8Array();
  }

  /** Build the Schema_Object proto message for use in Schema_Attribute.nestedType. */
  toPbNestedType(): Schema_Object {
    return {
      attributes: this.fields.map((f) => f.toPb()),
      nesting: OBJ_NEST_MODE_MAP[this.nestingMode],
      minItems: Long.fromNumber(0),
      maxItems: Long.fromNumber(0),
    };
  }
}

/**
 * An attribute backed by a nested object schema (Schema_Object / `nested_type`).
 *
 * Unlike a plain `Attribute` (which uses Terraform's scalar/collection type
 * system), an `ObjectAttribute` defines the shape of a structured object
 * inline on the attribute — without block HCL syntax.
 *
 * Nesting modes:
 *   - "single" → `attr = { field = value }`
 *   - "list"   → `attr = [{ field = value }, ...]`
 *   - "set"    → same HCL, set semantics (unordered)
 *   - "map"    → `attr = { key = { field = value } }`
 */
export class ObjectAttribute extends Attribute {
  readonly objectType: TfObject;

  constructor(
    name: string,
    fields: Attribute[],
    nestingMode: ObjNestMode = "single",
    opts: AttributeOptions = {},
  ) {
    const obj = new TfObject(fields, nestingMode);
    super(name, obj, opts);
    this.objectType = obj;
  }

  override toPb(): Schema_Attribute {
    return {
      name: this.name,
      type: new Uint8Array(),   // empty — nestedType takes precedence
      nestedType: this.objectType.toPbNestedType(),
      description: this.description,
      descriptionKind: this.descriptionKind === "markdown" ? StringKind.MARKDOWN : StringKind.PLAIN,
      required: this.required,
      optional: this.optional,
      computed: this.computed,
      sensitive: this.sensitive,
      deprecated: this.deprecated,
      deprecationMessage: this.deprecationMessage,
      writeOnly: this.writeOnly,
    };
  }
}

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
    if (!Array.isArray(a) || !Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    if (a.length !== b.length) return false;
    if (this.nestingMode === "set" || this.nestingMode === "map") {
      // Order-insensitive: sort serialized elements before comparing.
      const sa = (a as unknown[]).map((x) => JSON.stringify(x)).sort();
      const sb = (b as unknown[]).map((x) => JSON.stringify(x)).sort();
      return sa.every((v, i) => v === sb[i]);
    }
    return a.every((v, i) => JSON.stringify(v) === JSON.stringify((b as unknown[])[i]));
  }
}

export interface BlockOptions {
  description?: string;
  descriptionKind?: DescriptionKind;
  deprecated?: boolean;
  deprecationMessage?: string;
  computed?: boolean;
}

export class Block {
  readonly attributes: Attribute[];
  readonly blockTypes: NestedBlock[];
  readonly description: string;
  readonly descriptionKind: DescriptionKind;
  readonly deprecated: boolean;
  readonly deprecationMessage: string;
  readonly computed: boolean;

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
    this.deprecationMessage = opts.deprecationMessage ?? "";
    this.computed = opts.computed ?? false;
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
      deprecationMessage: this.deprecationMessage,
      computed: this.computed,
    };
  }
}

export class Schema {
  readonly version: number;
  readonly block: Block;

  constructor(attributes: Attribute[] = [], blockTypes: NestedBlock[] = [], version = 0, blockOpts: BlockOptions = {}) {
    this.version = version;
    this.block = new Block(attributes, blockTypes, blockOpts);
  }

  toPb(): PbSchema {
    return {
      version: Long.fromNumber(this.version),
      block: this.block.toPb(),
    };
  }
}

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

/**
 * Like encodeBlock, but reuses the raw prior-encoded bytes for any field that
 * is semantically unchanged. This prevents spurious msgpack/JSON diffs when the
 * same logical value is serialised differently (e.g. JSON with keys in a different
 * order) — mirroring the behaviour of hfern/tf's `_encode_state_d`.
 */
export function encodeBlockPreserving(
  block: Block,
  state: State | null,
  priorRaw: State | null
): State | null {
  if (state === null) return null;
  const out: State = {};
  const attrs = block.attrMap();
  const blocks = block.blockMap();
  for (const [k, v] of Object.entries(state)) {
    if (k in attrs) {
      if (
        priorRaw !== null &&
        k in priorRaw &&
        attrs[k].type.semanticallyEqual(attrs[k].type.decode(priorRaw[k]), v)
      ) {
        out[k] = priorRaw[k]; // preserve prior wire bytes — no semantic change
      } else {
        out[k] = attrs[k].type.encode(v);
      }
    } else if (k in blocks) {
      if (
        priorRaw !== null &&
        k in priorRaw &&
        blocks[k].semanticallyEqual(blocks[k].decode(priorRaw[k]), v)
      ) {
        out[k] = priorRaw[k];
      } else {
        out[k] = blocks[k].encode(v);
      }
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
