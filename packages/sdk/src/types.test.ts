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

describe("Unknown sentinel", () => {
  it("is a singleton", () => {
    assert.equal(Unknown, Unknown);
  });

  it("has a readable toString", () => {
    assert.equal(String(Unknown), "Unknown");
  });
});

describe("TfString", () => {
  const t = new TfString();

  it("encodes a string as-is", () => {
    assert.equal(t.encode("hello"), "hello");
  });

  it("encodes null as null", () => {
    assert.equal(t.encode(null), null);
  });

  it("encodes Unknown as Unknown", () => {
    assert.equal(t.encode(Unknown), Unknown);
  });

  it("decodes a string value", () => {
    assert.equal(t.decode("world"), "world");
  });

  it("decodes a non-string by coercing to string", () => {
    assert.equal(t.decode(42), "42");
  });

  it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  it("decodes Unknown as Unknown", () => {
    assert.equal(t.decode(Unknown), Unknown);
  });

  it("semanticallyEqual returns true for equal strings", () => {
    assert.ok(t.semanticallyEqual("a", "a"));
  });

  it("semanticallyEqual returns false for different strings", () => {
    assert.ok(!t.semanticallyEqual("a", "b"));
  });

  it("tfType() returns JSON bytes for 'string'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"');
  });
});

describe("TfNumber", () => {
  const t = new TfNumber();

  it("encodes a number as-is", () => {
    assert.equal(t.encode(42), 42);
  });

  it("decodes a number value", () => {
    assert.equal(t.decode(3.14), 3.14);
  });

  it("decodes a string by coercing to number", () => {
    assert.equal(t.decode("7"), 7);
  });

  it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  it("tfType() returns JSON bytes for 'number'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"number"');
  });
});

describe("TfBool", () => {
  const t = new TfBool();

  it("encodes true as true", () => {
    assert.equal(t.encode(true), true);
  });

  it("decodes 1 as true via Boolean()", () => {
    assert.equal(t.decode(1), true);
  });

  it("decodes 0 as false via Boolean()", () => {
    assert.equal(t.decode(0), false);
  });

  it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  it("tfType() returns JSON bytes for 'bool'", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"bool"');
  });
});

describe("TfList", () => {
  const t = new TfList(new TfString());

  it("tfType() returns list type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["list", "string"]);
  });

  it("encodes an array as-is", () => {
    assert.deepEqual(t.encode(["a", "b"]), ["a", "b"]);
  });

  it("decodes an array by decoding each element", () => {
    assert.deepEqual(t.decode(["1", "2"]), ["1", "2"]);
  });

  it("decodes null as null", () => {
    assert.equal(t.decode(null), null);
  });

  it("semanticallyEqual compares arrays element-by-element", () => {
    assert.ok(t.semanticallyEqual(["a"], ["a"]));
    assert.ok(!t.semanticallyEqual(["a"], ["b"]));
    assert.ok(!t.semanticallyEqual(["a"], ["a", "b"]));
  });
});

describe("TfSet", () => {
  const t = new TfSet(new TfString());

  it("tfType() returns set type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["set", "string"]);
  });

  it("semanticallyEqual ignores order", () => {
    assert.ok(t.semanticallyEqual(["b", "a"], ["a", "b"]));
  });
});

describe("TfMap", () => {
  const t = new TfMap(new TfNumber());

  it("tfType() returns map type descriptor", () => {
    const parsed = JSON.parse(Buffer.from(t.tfType()).toString());
    assert.deepEqual(parsed, ["map", "number"]);
  });

  it("encodes an object as-is", () => {
    assert.deepEqual(t.encode({ x: 1 }), { x: 1 });
  });

  it("decodes an object by decoding each value", () => {
    assert.deepEqual(t.decode({ x: "3" }), { x: 3 });
  });

  it("semanticallyEqual compares object entries", () => {
    assert.ok(t.semanticallyEqual({ a: 1 }, { a: 1 }));
    assert.ok(!t.semanticallyEqual({ a: 1 }, { a: 2 }));
  });
});

describe("TfNormalizedJson", () => {
  const t = new TfNormalizedJson();

  it("tfType() returns string type descriptor (JSON stored as string)", () => {
    assert.equal(Buffer.from(t.tfType()).toString(), '"string"');
  });

  it("semanticallyEqual compares string values via JSON.stringify", () => {
    assert.ok(t.semanticallyEqual('{"a":1}', '{"a":1}'));
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"b":1}'));
  });

  it("semanticallyEqual returns false for different JSON strings", () => {
    assert.ok(!t.semanticallyEqual('{"a":1}', '{"a":2}'));
  });

  it("encode normalizes key order", () => {
    const obj = { b: 2, a: 1 };
    const encoded = t.encode(obj) as string;
    assert.equal(encoded, '{"a":1,"b":2}');
  });
});

describe("types factory", () => {
  it("types.string() returns a TfString", () => {
    assert.ok(types.string() instanceof TfString);
  });
  it("types.number() returns a TfNumber", () => {
    assert.ok(types.number() instanceof TfNumber);
  });
  it("types.bool() returns a TfBool", () => {
    assert.ok(types.bool() instanceof TfBool);
  });
  it("types.list() returns a TfList", () => {
    assert.ok(types.list(types.string()) instanceof TfList);
  });
  it("types.set() returns a TfSet", () => {
    assert.ok(types.set(types.string()) instanceof TfSet);
  });
  it("types.map() returns a TfMap", () => {
    assert.ok(types.map(types.string()) instanceof TfMap);
  });
  it("each factory call returns a new instance", () => {
    assert.notEqual(types.string(), types.string());
  });
});
