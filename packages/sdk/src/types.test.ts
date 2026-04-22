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
    assert.equal(Unknown, Unknown);
  });

  void it("has a readable toString", () => {
    assert.equal(String(Unknown), "Unknown");
  });
});

void describe("TfString", () => {
  const t = new TfString();

  void it("encodes a string as-is", () => {
    assert.equal(t.encode("hello"), "hello");
  });

  void it("encodes null as null", () => {
    assert.equal(t.encode(null), null);
  });

  void it("encodes Unknown as Unknown", () => {
    assert.equal(t.encode(Unknown), Unknown);
  });

  void it("decodes a string value", () => {
    assert.equal(t.decode("world"), "world");
  });

  void it("decodes a non-string by coercing to string", () => {
    assert.equal(t.decode(42), "42");
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  void it("decodes Unknown as Unknown", () => {
    assert.equal(t.decode(Unknown), Unknown);
  });

  void it("semanticallyEqual returns true for equal strings", () => {
    assert.ok(t.semanticallyEqual("a", "a"));
  });

  void it("semanticallyEqual returns false for different strings", () => {
    assert.ok(!t.semanticallyEqual("a", "b"));
  });

  void it("tfType() returns JSON bytes for 'string'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"');
  });
});

void describe("TfNumber", () => {
  const t = new TfNumber();

  void it("encodes a number as-is", () => {
    assert.equal(t.encode(42), 42);
  });

  void it("decodes a number value", () => {
    assert.equal(t.decode(3.14), 3.14);
  });

  void it("decodes a string by coercing to number", () => {
    assert.equal(t.decode("7"), 7);
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  void it("tfType() returns JSON bytes for 'number'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"number"');
  });
});

void describe("TfBool", () => {
  const t = new TfBool();

  void it("encodes true as true", () => {
    assert.equal(t.encode(true), true);
  });

  void it("decodes 1 as true via Boolean()", () => {
    assert.equal(t.decode(1), true);
  });

  void it("decodes 0 as false via Boolean()", () => {
    assert.equal(t.decode(0), false);
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  void it("tfType() returns JSON bytes for 'bool'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"bool"');
  });
});

void describe("TfList", () => {
  const t = new TfList(new TfString());

  void it("tfType() returns list type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["list", "string"]);
  });

  void it("encodes an array as-is", () => {
    assert.deepEqual(t.encode(["a", "b"]), ["a", "b"]);
  });

  void it("decodes an array by decoding each element", () => {
    assert.deepEqual(t.decode(["1", "2"]), ["1", "2"]);
  });

  void it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  void it("semanticallyEqual compares arrays element-by-element", () => {
    assert.ok(t.semanticallyEqual(["a"], ["a"]));
    assert.ok(!t.semanticallyEqual(["a"], ["b"]));
    assert.ok(!t.semanticallyEqual(["a"], ["a", "b"]));
  });
});

void describe("TfSet", () => {
  const t = new TfSet(new TfString());

  void it("tfType() returns set type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["set", "string"]);
  });

  void it("semanticallyEqual ignores order", () => {
    assert.ok(t.semanticallyEqual(["b", "a"], ["a", "b"]));
  });
});

void describe("TfMap", () => {
  const t = new TfMap(new TfNumber());

  void it("tfType() returns map type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["map", "number"]);
  });

  void it("encodes an object as-is", () => {
    assert.deepEqual(t.encode({ x: 1 }), { x: 1 });
  });

  void it("decodes an object by decoding each value", () => {
    assert.deepEqual(t.decode({ x: "3" }), { x: 3 });
  });

  void it("semanticallyEqual compares object entries", () => {
    assert.ok(t.semanticallyEqual({ a: 1 }, { a: 1 }));
    assert.ok(!t.semanticallyEqual({ a: 1 }, { a: 2 }));
  });
});

void describe("TfNormalizedJson", () => {
  const t = new TfNormalizedJson();

  void it("tfType() returns string type descriptor (JSON stored as string)", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"');
  });

  void it("semanticallyEqual compares string values via JSON.stringify", () => {
    assert.ok(t.semanticallyEqual('{"a":1}', '{"a":1}'));
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"b":1}'));
  });

  void it("semanticallyEqual returns false for different JSON strings", () => {
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"a":2}'));
  });

  void it("encode normalizes key order", () => {
    const obj = { b: 2, a: 1 };
    const encoded = t.encode(obj) as string;
    assert.equal(encoded, '{"a":1,"b":2}');
  });
});

void describe("types factory", () => {
  void it("types.string() returns a TfString", () => {
    assert.ok(types.string() instanceof TfString);
  });
  void it("types.number() returns a TfNumber", () => {
    assert.ok(types.number() instanceof TfNumber);
  });
  void it("types.bool() returns a TfBool", () => {
    assert.ok(types.bool() instanceof TfBool);
  });
  void it("types.list() returns a TfList", () => {
    assert.ok(types.list(types.string()) instanceof TfList);
  });
  void it("types.set() returns a TfSet", () => {
    assert.ok(types.set(types.string()) instanceof TfSet);
  });
  void it("types.map() returns a TfMap", () => {
    assert.ok(types.map(types.string()) instanceof TfMap);
  });
  void it("each factory call returns a new instance", () => {
    assert.notEqual(types.string(), types.string());
  });
});
