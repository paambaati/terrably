import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Unknown,
  TfString,
  TfNumber,
  TfBool,
  TfList,
  TfSet,
  TfMap,
  TfNormalizedJson,
  types,
} from "./types.js";

void describe("Unknown sentinel", () => {
  void it("is a singleton", () => {
    assert.equal(Unknown, Unknown, "Unknown should be === itself (singleton)");
  });

  void it("has a readable toString", () => {
    assert.equal(String(Unknown), "Unknown", "String(Unknown) should produce 'Unknown'");
  });
});

void describe("TfString", () => {
  const t = new TfString();

  void it("encodes a string as-is", () => {
    assert.equal(t.encode("hello"), "hello", "encode should pass strings through unchanged");
  });

  void it("encodes null as null", () => {
    assert.equal(t.encode(null), null, "encode should pass null through unchanged");
  });

  void it("encodes Unknown as Unknown", () => {
    assert.equal(t.encode(Unknown), Unknown, "encode should pass Unknown through unchanged");
  });

  void it("decodes a string value", () => {
    assert.equal(t.decode("world"), "world", "decode should return string as-is");
  });

  void it("decodes a non-string by coercing to string", () => {
    assert.equal(t.decode(42), "42", "decode should coerce non-string to string");
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null, "decode should return null for null");
  });

  void it("decodes Unknown as Unknown", () => {
    assert.equal(t.decode(Unknown), Unknown, "decode should return Unknown for Unknown");
  });

  void it("semanticallyEqual returns true for equal strings", () => {
    assert.ok(t.semanticallyEqual("a", "a"), "equal strings should be semantically equal");
  });

  void it("semanticallyEqual returns false for different strings", () => {
    assert.ok(!t.semanticallyEqual("a", "b"), "different strings should not be semantically equal");
  });

  void it("tfType() returns JSON bytes for 'string'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"', "tfType() should encode to JSON 'string'");
  });
});

void describe("TfNumber", () => {
  const t = new TfNumber();

  void it("encodes a number as-is", () => {
    assert.equal(t.encode(42), 42, "encode should pass number through unchanged");
  });

  void it("decodes a number value", () => {
    assert.equal(t.decode(3.14), 3.14, "decode should return float as-is");
  });

  void it("decodes a string by coercing to number", () => {
    assert.equal(t.decode("7"), 7, "decode should coerce string to number");
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null, "decode should return null for null");
  });

  void it("tfType() returns JSON bytes for 'number'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"number"', "tfType() should encode to JSON 'number'");
  });
});

void describe("TfBool", () => {
  const t = new TfBool();

  void it("encodes true as true", () => {
    assert.equal(t.encode(true), true, "encode should pass boolean through unchanged");
  });

  void it("decodes 1 as true via Boolean()", () => {
    assert.equal(t.decode(1), true, "decode should coerce 1 to true via Boolean()");
  });

  void it("decodes 0 as false via Boolean()", () => {
    assert.equal(t.decode(0), false, "decode should coerce 0 to false via Boolean()");
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null, "decode should return null for null");
  });

  void it("tfType() returns JSON bytes for 'bool'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"bool"', "tfType() should encode to JSON 'bool'");
  });
});

void describe("TfList", () => {
  const t = new TfList(new TfString());

  void it("tfType() returns list type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["list", "string"], "tfType() should produce a list type descriptor");
  });

  void it("encodes an array as-is", () => {
    assert.deepEqual(t.encode(["a", "b"]), ["a", "b"], "encode should pass array through unchanged");
  });

  void it("decodes an array by decoding each element", () => {
    assert.deepEqual(t.decode(["1", "2"]), ["1", "2"], "decode should decode each element");
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null, "decode should return null for null");
  });

  void it("semanticallyEqual compares arrays element-by-element", () => {
    assert.ok(t.semanticallyEqual(["a"], ["a"]), "identical arrays should be semantically equal");
    assert.ok(!t.semanticallyEqual(["a"], ["b"]), "arrays with different elements should not be equal");
    assert.ok(!t.semanticallyEqual(["a"], ["a", "b"]), "arrays of different lengths should not be equal");
  });
});

void describe("TfSet", () => {
  const t = new TfSet(new TfString());

  void it("tfType() returns set type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["set", "string"], "tfType() should produce a set type descriptor");
  });

  void it("semanticallyEqual ignores order", () => {
    assert.ok(t.semanticallyEqual(["b", "a"], ["a", "b"]), "elements in different order should be semantically equal for a set");
  });
});

void describe("TfMap", () => {
  const t = new TfMap(new TfNumber());

  void it("tfType() returns map type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["map", "number"], "tfType() should produce a map type descriptor");
  });

  void it("encodes an object as-is", () => {
    assert.deepEqual(t.encode({ x: 1 }), { x: 1 }, "encode should pass object through unchanged");
  });

  void it("decodes an object by decoding each value", () => {
    assert.deepEqual(t.decode({ x: "3" }), { x: 3 }, "decode should decode each value");
  });

  void it("semanticallyEqual compares object entries", () => {
    assert.ok(t.semanticallyEqual({ a: 1 }, { a: 1 }), "identical maps should be semantically equal");
    assert.ok(!t.semanticallyEqual({ a: 1 }, { a: 2 }), "maps with different values should not be equal");
  });
});

void describe("TfNormalizedJson", () => {
  const t = new TfNormalizedJson();

  void it("tfType() returns string type descriptor (JSON stored as string)", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"', "tfType() should return JSON 'string' since normalizedJson is stored as a string");
  });

  void it("semanticallyEqual compares string values via JSON.stringify", () => {
    assert.ok(t.semanticallyEqual('{"a":1}', '{"a":1}'), "identical JSON strings should be semantically equal");
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"b":1}'), "JSON strings with different keys should not be equal");
  });

  void it("semanticallyEqual returns false for different JSON strings", () => {
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"a":2}'), "JSON strings with different values should not be equal");
  });

  void it("encode normalizes key order", () => {
    const obj = { b: 2, a: 1 };
    const encoded = t.encode(obj) as string;
    assert.equal(encoded, '{"a":1,"b":2}', "encode should sort keys alphabetically");
  });
});

void describe("types factory", () => {
  void it("types.string() returns a TfString", () => {
    assert.ok(types.string() instanceof TfString, "types.string() should return a TfString instance");
  });
  void it("types.number() returns a TfNumber", () => {
    assert.ok(types.number() instanceof TfNumber, "types.number() should return a TfNumber instance");
  });
  void it("types.bool() returns a TfBool", () => {
    assert.ok(types.bool() instanceof TfBool, "types.bool() should return a TfBool instance");
  });
  void it("types.list() returns a TfList", () => {
    assert.ok(types.list(types.string()) instanceof TfList, "types.list() should return a TfList instance");
  });
  void it("types.set() returns a TfSet", () => {
    assert.ok(types.set(types.string()) instanceof TfSet, "types.set() should return a TfSet instance");
  });
  void it("types.map() returns a TfMap", () => {
    assert.ok(types.map(types.string()) instanceof TfMap, "types.map() should return a TfMap instance");
  });
  void it("each factory call returns a new instance", () => {
    assert.notEqual(types.string(), types.string(), "each factory call should return a fresh instance");
  });
});
