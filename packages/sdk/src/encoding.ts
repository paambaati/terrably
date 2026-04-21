/**
 * Encode/decode Terraform DynamicValue fields.
 *
 * Terraform always sends state as msgpack; we always respond with msgpack.
 * The JSON field in DynamicValue is a fallback we also handle on read.
 *
 * Terraform's msgpack encoding of "unknown" is the extension type 0 with
 * a single zero byte (msgpack ext8 with type=0, data=0x00).
 */

import { decode, encode, ExtensionCodec } from "@msgpack/msgpack";
import { Unknown } from "./types.js";
import type { DynamicValue } from "../gen/tfplugin6.js";

// ---------------------------------------------------------------------------
// Extension type 0 = Terraform Unknown value
// ---------------------------------------------------------------------------
const TF_UNKNOWN_EXT = 0;

const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: TF_UNKNOWN_EXT,
  encode(input: unknown) {
    if (input === Unknown) {
      return new Uint8Array([0x00]);
    }
    return null; // not handled by this codec
  },
  decode(_data: Uint8Array) {
    return Unknown;
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Decode a DynamicValue into a plain JS object (or null for null/empty). */
export function readDynamicValue(dv: DynamicValue): Record<string, unknown> | null {
  if (dv.msgpack && dv.msgpack.length > 0) {
    const decoded = decode(dv.msgpack, { extensionCodec });
    if (decoded === null || decoded === undefined) return null;
    return decoded as Record<string, unknown>;
  }
  if (dv.json && dv.json.length > 0) {
    const text = Buffer.from(dv.json).toString("utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || parsed === undefined) return null;
    return parsed as Record<string, unknown>;
  }
  return null;
}

/** Encode a plain JS object (or null) into a DynamicValue using msgpack. */
export function toDynamicValue(value: Record<string, unknown> | null): DynamicValue {
  return {
    msgpack: Buffer.from(encode(value, { extensionCodec, forceIntegerToFloat: false })),
    json: new Uint8Array(),
  };
}

/** Convert SDK DiagnosticItem[] to proto Diagnostic[] */
import type { DiagnosticItem } from "./interfaces.js";
import { Diagnostic_Severity } from "../gen/tfplugin6.js";
import type { Diagnostic, AttributePath } from "../gen/tfplugin6.js";

export function diagsToPb(items: DiagnosticItem[]): Diagnostic[] {
  return items.map((d) => ({
    severity:
      d.severity === "error" ? Diagnostic_Severity.ERROR : Diagnostic_Severity.WARNING,
    summary: d.summary,
    detail: d.detail,
    attribute: pathToPb(d.path),
  }));
}

function pathToPb(path: string[]): AttributePath | undefined {
  if (!path || path.length === 0) return undefined;
  return {
    steps: path.map((p) => ({ attributeName: p })),
  };
}
