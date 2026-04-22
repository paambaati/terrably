/**
 * TfType system – mirrors hfern/tf types.py, adapted for TypeScript.
 *
 * Every concrete type provides:
 *   encode(value)  → wire-safe representation (numbers, strings, plain objects)
 *   decode(value)  → JS-idiomatic representation
 *   semanticallyEqual(a, b) → whether two decoded values represent the same state
 *   tfType()       → the JSON bytes Terraform expects for the `type` field in Schema.Attribute
 */

/** Sentinel for Terraform's "unknown at plan time" value. */
class _Unknown {
  toString() {
    return "Unknown";
  }
}
export const Unknown = new _Unknown();
export type UnknownType = typeof Unknown;

export type TfValue = unknown;

export interface TfType<T = unknown> {
  encode(value: T | null | UnknownType): TfValue;
  decode(value: TfValue): T | null | UnknownType;
  semanticallyEqual(a: T | null | UnknownType, b: T | null | UnknownType): boolean;
  /** JSON bytes for the Terraform type descriptor (e.g. `"string"`, `["list","number"]`) */
  tfType(): Uint8Array;
}

// ---------------------------------------------------------------------------
// Scalar primitives
// ---------------------------------------------------------------------------

export class TfString implements TfType<string> {
  encode(v: string | null | UnknownType) {
    return v;
  }
  decode(v: TfValue): string | null | UnknownType {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    return String(v as string | number | boolean);
  }
  semanticallyEqual(a: TfValue, b: TfValue) {
    return a === b;
  }
  tfType() {
    return Buffer.from('"string"');
  }
}

export class TfNumber implements TfType<number> {
  encode(v: number | null | UnknownType) {
    return v;
  }
  decode(v: TfValue): number | null | UnknownType {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    return Number(v);
  }
  semanticallyEqual(a: TfValue, b: TfValue) {
    return a === b;
  }
  tfType() {
    return Buffer.from('"number"');
  }
}

export class TfBool implements TfType<boolean> {
  encode(v: boolean | null | UnknownType) {
    return v;
  }
  decode(v: TfValue): boolean | null | UnknownType {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    return Boolean(v);
  }
  semanticallyEqual(a: TfValue, b: TfValue) {
    return a === b;
  }
  tfType() {
    return Buffer.from('"bool"');
  }
}

/**
 * NormalizedJson – stored as a string but round-tripped through JSON.parse/stringify
 * with sorted keys so Terraform never sees a spurious diff from key reordering.
 */
export class TfNormalizedJson implements TfType<unknown> {
  encode(v: unknown): TfValue {
    if (v instanceof _Unknown || v === null) return v;
    return JSON.stringify(v, Object.keys(v as object).sort());
  }
  decode(v: TfValue): unknown {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    try {
      return JSON.parse(v as string);
    } catch {
      return v;
    }
  }
  semanticallyEqual(a: TfValue, b: TfValue) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  tfType() {
    return Buffer.from('"string"');
  }
}

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

export class TfList<T> implements TfType<T[]> {
  constructor(public readonly elementType: TfType<T>) {}

  encode(v: T[] | null | UnknownType): TfValue {
    if (v instanceof _Unknown || v === null) return v;
    return (v as T[]).map((e) => this.elementType.encode(e));
  }
  decode(v: TfValue): T[] | null | UnknownType {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    return (v as unknown[]).map((e) => this.elementType.decode(e) as T);
  }
  semanticallyEqual(a: T[] | null | UnknownType, b: T[] | null | UnknownType) {
    if (a === b) return true;
    if (a instanceof _Unknown || b instanceof _Unknown) return false;
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    return a.every((v, i) => this.elementType.semanticallyEqual(v, b[i]));
  }
  tfType() {
    return Buffer.from(`["list",${Buffer.from(this.elementType.tfType()).toString()}]`);
  }
}

export class TfSet<T> extends TfList<T> {
  semanticallyEqual(a: T[] | null | UnknownType, b: T[] | null | UnknownType) {
    if (a === b) return true;
    if (a instanceof _Unknown || b instanceof _Unknown) return false;
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    // Order-insensitive comparison via string serialisation (matches hfern/tf approach)
    const sa = [...a].map(String).sort();
    const sb = [...b].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  tfType() {
    return Buffer.from(`["set",${Buffer.from(this.elementType.tfType()).toString()}]`);
  }
}

export class TfMap<T> implements TfType<Record<string, T>> {
  constructor(public readonly elementType: TfType<T>) {}

  encode(v: Record<string, T> | null | UnknownType): TfValue {
    if (v instanceof _Unknown || v === null) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, T>).map(([k, e]) => [k, this.elementType.encode(e)])
    );
  }
  decode(v: TfValue): Record<string, T> | null | UnknownType {
    if (v instanceof _Unknown || v === null) return v as UnknownType | null;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, e]) => [
        k,
        this.elementType.decode(e) as T,
      ])
    );
  }
  semanticallyEqual(a: Record<string, T> | null | UnknownType, b: Record<string, T> | null | UnknownType) {
    if (a === b) return true;
    if (a instanceof _Unknown || b instanceof _Unknown) return false;
    if (a === null || b === null) return a === b;
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.join(",") !== bKeys.join(",")) return false;
    return aKeys.every((k) => this.elementType.semanticallyEqual(a[k], b[k]));
  }
  tfType() {
    return Buffer.from(`["map",${Buffer.from(this.elementType.tfType()).toString()}]`);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory (mirrors Python's `from tf import types as t`)
// ---------------------------------------------------------------------------
export const types = {
  string: () => new TfString(),
  number: () => new TfNumber(),
  bool: () => new TfBool(),
  normalizedJson: () => new TfNormalizedJson(),
  list: <T>(el: TfType<T>) => new TfList(el),
  set: <T>(el: TfType<T>) => new TfSet(el),
  map: <T>(el: TfType<T>) => new TfMap(el),
} as const;
