import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encode, ExtensionCodec } from "@msgpack/msgpack";
import { readDynamicValue, toDynamicValue } from "./encoding.js";
import { Unknown } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a DynamicValue-like object backed by raw msgpack bytes (no extension codec). */
function dvMsgpack(value: unknown) {
  return {
    msgpack: Buffer.from(encode(value)),
    json: new Uint8Array(),
  };
}

/** Build a DynamicValue-like object backed by JSON bytes. */
function dvJson(value: unknown) {
  return {
    msgpack: new Uint8Array(),
    json: Buffer.from(JSON.stringify(value)),
  };
}

// ---------------------------------------------------------------------------
// readDynamicValue
// ---------------------------------------------------------------------------

void describe("readDynamicValue", () => {
  void it("decodes a simple msgpack object", () => {
    const dv = dvMsgpack({ name: "hello", count: 42 });
    const result = readDynamicValue(dv);
    assert.deepEqual(result, { name: "hello", count: 42 }, "should decode msgpack object fields correctly");
  });

  void it("decodes from JSON bytes as fallback when msgpack is empty", () => {
    const dv = dvJson({ foo: "bar" });
    const result = readDynamicValue(dv);
    assert.deepEqual(result, { foo: "bar" }, "should fall back to JSON bytes when msgpack is empty");
  });

  void it("returns null when both msgpack and json are empty", () => {
    const dv = { msgpack: new Uint8Array(), json: new Uint8Array() };
    assert.equal(readDynamicValue(dv), null, "should return null when both msgpack and json are empty");
  });

  void it("returns null when msgpack encodes null", () => {
    const dv = dvMsgpack(null);
    assert.equal(readDynamicValue(dv), null, "should return null when msgpack encodes null");
  });

  void it("preserves string values", () => {
    const dv = dvMsgpack({ id: "abc-123" });
    assert.equal((readDynamicValue(dv) as Record<string, unknown>)["id"], "abc-123", "should preserve string field value");
  });

  void it("preserves numeric values", () => {
    const dv = dvMsgpack({ count: 7 });
    assert.equal((readDynamicValue(dv) as Record<string, unknown>)["count"], 7, "should preserve numeric field value");
  });

  void it("decodes the Unknown sentinel from extension type 0", () => {
    // Build a DynamicValue whose msgpack encodes Unknown (ext type 0, data 0x00)
    const codec = new ExtensionCodec();
    codec.register({
      type: 0,
      encode(input: unknown) {
        return input === Unknown ? new Uint8Array([0x00]) : null;
      },
      decode() {
        return Unknown;
      },
    });
    const dv = {
      msgpack: Buffer.from(encode({ status: Unknown }, { extensionCodec: codec })),
      json: new Uint8Array(),
    };
    const result = readDynamicValue(dv) as Record<string, unknown>;
    assert.equal(result["status"], Unknown, "extension type 0 should decode to the Unknown sentinel");
  });
});

// ---------------------------------------------------------------------------
// toDynamicValue
// ---------------------------------------------------------------------------

void describe("toDynamicValue", () => {
  void it("encodes a plain object to msgpack", () => {
    const dv = toDynamicValue({ a: "1", b: 2 });
    assert.ok(dv.msgpack.length > 0, "msgpack bytes should be non-empty");
    // round-trip
    const back = readDynamicValue(dv);
    assert.deepEqual(back, { a: "1", b: 2 });
  });

  void it("encodes null", () => {
    const dv = toDynamicValue(null);
    assert.ok(dv.msgpack.length > 0, "msgpack bytes should be non-empty when encoding null");
    assert.equal(readDynamicValue(dv), null, "round-tripping null should yield null");
  });

  void it("round-trips a nested object", () => {
    const state = { id: "x", tags: ["a", "b"], meta: { k: "v" } };
    const dv = toDynamicValue(state as Record<string, unknown>);
    assert.deepEqual(readDynamicValue(dv), state, "nested object should round-trip through encode→decode");
  });

  void it("round-trips the Unknown sentinel", () => {
    const dv = toDynamicValue({ pending: Unknown as unknown } as Record<string, unknown>);
    const back = readDynamicValue(dv) as Record<string, unknown>;
    assert.equal(back["pending"], Unknown, "Unknown sentinel should survive encode→decode round-trip");
  });

  void it("json field is always an empty Uint8Array on output", () => {
    const dv = toDynamicValue({ x: 1 });
    assert.equal(dv.json.length, 0, "json field should always be an empty Uint8Array on toDynamicValue output");
  });
});
