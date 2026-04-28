// ── Bun compiled-binary compatibility patch ──────────────────────────────────
// This module MUST be imported FIRST in serve.ts (before @grpc/grpc-js and
// @grpc/proto-loader).
//
// When bundled with esbuild for `bun --compile`, the bundle is ESM and
// `require` is not defined in that scope. @protobufjs/inquire calls
// `require(moduleName)` at runtime; this throws, so protobufjs's util.Long
// and util.fs are left null.
//
// The critical timing issue – @grpc/proto-loader loads
// `protobufjs/ext/descriptor` at module-init time (top-level require, not
// lazy), which immediately calls Root.fromJSON() → resolveAll() →
// util.Long.fromNumber(). If this module is the first import in serve.ts,
// our patch runs before proto-loader's factory executes, setting util.Long
// and util.fs on the single cached protobufjs instance.
// ─────────────────────────────────────────────────────────────────────────────
import _pbjs from "protobufjs";
import _pbjsMin from "protobufjs/minimal";
import _Long from "long";
import * as _fs from "node:fs";
{
  const _lc: unknown = typeof (_Long as unknown as { fromNumber?: unknown }).fromNumber === "function"
    ? _Long
    : (_Long as unknown as { default: unknown }).default;
  function _p(pb: unknown) {
    const p = pb as { util?: { Long?: unknown; fs?: unknown } } | undefined;
    if (p?.util) {
      // util.inquire("long") in a Bun compiled binary resolves "long" as an
      // ESM module (long has "type":"module"), returning the namespace object
      // { default: LongClass } instead of LongClass directly. That object is
      // truthy but has no fromNumber, so we must check the method, not just
      // the presence of util.Long.
      if (typeof (p.util.Long as { fromNumber?: unknown })?.fromNumber !== "function") {
        p.util.Long = _lc;
      }
      if (!p.util.fs) p.util.fs = _fs;
    }
  }
  _p(_pbjs);
  try { _p(_pbjsMin); } catch { /* ok */ }
}
