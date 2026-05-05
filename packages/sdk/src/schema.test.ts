import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Attribute, Block, Schema, NestedBlock, ObjectAttribute, TfObject, encodeBlock, decodeBlock, encodeBlockPreserving } from "./schema.js";
import { types, Unknown } from "./types.js";

void describe("Attribute", () => {
  void it("stores name and type", () => {
    const a = new Attribute("foo", types.string());
    assert.equal(a.name, "foo", "attribute name should be stored correctly");
  });

  void it("defaults: not required, optional, computed, sensitive", () => {
    const a = new Attribute("x", types.string());
    assert.equal(a.required, false, "required should default to false");
    assert.equal(a.optional, false, "optional should default to false");
    assert.equal(a.computed, false, "computed should default to false");
    assert.equal(a.sensitive, false, "sensitive should default to false");
  });

  void it("respects required: true", () => {
    const a = new Attribute("x", types.string(), { required: true });
    assert.equal(a.required, true, "required: true should be stored");
  });

  void it("respects computed + optional", () => {
    const a = new Attribute("x", types.string(), { computed: true, optional: true });
    assert.equal(a.computed, true, "computed: true should be stored");
    assert.equal(a.optional, true, "optional: true should be stored");
  });

  void it("respects sensitive: true", () => {
    const a = new Attribute("tok", types.string(), { sensitive: true });
    assert.equal(a.sensitive, true, "sensitive: true should be stored");
  });

  void it("toPb() produces a Schema_Attribute with the correct name", () => {
    const a = new Attribute("my_attr", types.number(), { required: true });
    const pb = a.toPb();
    assert.equal(pb.name, "my_attr", "toPb() should preserve the attribute name");
    assert.equal(pb.required, true, "toPb() should set the required flag");
  });

  void it("toPb() embeds the tfType bytes", () => {
    const a = new Attribute("n", types.number());
    const pb = a.toPb();
    assert.equal(Buffer.from(pb.type).toString(), '"number"', "toPb() should embed the tfType bytes");
  });
});

void describe("Schema", () => {
  void it("is constructed with a list of Attributes", () => {
    const schema = new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new Attribute("name", types.string(), { required: true }),
    ]);
    assert.ok(schema, "Schema should be constructible");
  });

  void it("toPb() returns a PbSchema with block.attributes", () => {
    const schema = new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new Attribute("name", types.string(), { required: true }),
    ]);
    const pb = schema.toPb();
    assert.ok(pb.block, "toPb() should produce a block");
    assert.equal(pb.block!.attributes.length, 2, "block should contain exactly 2 attributes");
  });

  void it("toPb() preserves attribute names and order", () => {
    const schema = new Schema([
      new Attribute("a", types.string()),
      new Attribute("b", types.number()),
      new Attribute("c", types.bool()),
    ]);
    const attrs = schema.toPb().block!.attributes;
    assert.deepEqual(attrs.map((a) => a.name), ["a", "b", "c"], "attribute names should be preserved in declaration order");
  });

  void it("default version is 0", () => {
    const schema = new Schema([]);
    const pb = schema.toPb();
    // version is a Long; its toNumber() should be 0
    assert.equal(pb.version.toNumber(), 0, "default schema version should be 0");
  });

  void it("accepts an explicit schema version", () => {
    const schema = new Schema([], [], 3);
    assert.equal(schema.toPb().version.toNumber(), 3, "explicit schema version should be stored");
  });

  void it("includes nested blocks in toPb()", () => {
    const block = new Block([new Attribute("cidr", types.string())]);
    const nested = new NestedBlock("network", "list", block);
    const schema = new Schema([], [nested]);
    const pb = schema.toPb();
    assert.equal(pb.block!.blockTypes.length, 1, "block should contain exactly 1 nested block type");
    assert.equal(pb.block!.blockTypes[0]!.typeName, "network", "nested block type name should be 'network'");
  });
});

void describe("NestedBlock", () => {
  void it("toPb() sets the typeName", () => {
    const block = new Block([new Attribute("key", types.string())]);
    const nb = new NestedBlock("tags", "map", block);
    const pb = nb.toPb();
    assert.equal(pb.typeName, "tags", "toPb() should set the typeName");
  });

  void it("supports 'single' nesting mode", () => {
    const nb = new NestedBlock("timeouts", "single", new Block([]));
    const pb = nb.toPb();
    assert.ok(pb.nesting, "nesting should be non-zero for 'single' mode");
  });

  void describe("semanticallyEqual — SET nesting is order-insensitive", () => {
    const inner = new Block([new Attribute("cidr", types.string())]);
    const nb = new NestedBlock("networks", "set", inner);

    void it("same order → equal", () => {
      const a = [{ cidr: "10.0.0.0/8" }, { cidr: "192.168.0.0/16" }];
      assert.ok(nb.semanticallyEqual(a, [...a]), "identical arrays should be semantically equal");
    });

    void it("different order → still equal for set", () => {
      const a = [{ cidr: "10.0.0.0/8" }, { cidr: "192.168.0.0/16" }];
      const b = [{ cidr: "192.168.0.0/16" }, { cidr: "10.0.0.0/8" }];
      assert.ok(nb.semanticallyEqual(a, b), "set nesting should treat differently-ordered arrays as equal");
    });

    void it("different content → not equal", () => {
      const a = [{ cidr: "10.0.0.0/8" }];
      const b = [{ cidr: "172.16.0.0/12" }];
      assert.ok(!nb.semanticallyEqual(a, b), "sets with different content should not be equal");
    });

    void it("different length → not equal", () => {
      const a = [{ cidr: "10.0.0.0/8" }, { cidr: "192.168.0.0/16" }];
      const b = [{ cidr: "10.0.0.0/8" }];
      assert.ok(!nb.semanticallyEqual(a, b), "sets of different lengths should not be equal");
    });
  });

  void describe("semanticallyEqual — LIST nesting is order-sensitive", () => {
    const inner = new Block([new Attribute("val", types.string())]);
    const nb = new NestedBlock("items", "list", inner);

    void it("same order → equal", () => {
      const a = [{ val: "a" }, { val: "b" }];
      assert.ok(nb.semanticallyEqual(a, [...a]), "identical list arrays should be semantically equal");
    });

    void it("different order → NOT equal for list", () => {
      const a = [{ val: "a" }, { val: "b" }];
      const b = [{ val: "b" }, { val: "a" }];
      assert.ok(!nb.semanticallyEqual(a, b), "list nesting should be order-sensitive");
    });
  });
});

void describe("BlockOptions — deprecationMessage and computed", () => {
  void it("Block defaults deprecationMessage to empty string and computed to false", () => {
    const b = new Block([]);
    const pb = b.toPb()!;
    assert.equal(pb.deprecationMessage, "", "deprecationMessage should default to empty string");
    assert.equal(pb.computed, false, "computed should default to false");
  });

  void it("Block.toPb() forwards deprecationMessage", () => {
    const b = new Block([], [], { deprecated: true, deprecationMessage: "use new_block instead" });
    const pb = b.toPb()!;
    assert.equal(pb.deprecationMessage, "use new_block instead", "deprecationMessage should be forwarded to proto");
    assert.equal(pb.deprecated, true, "deprecated flag should be true");
  });

  void it("Block.toPb() forwards computed: true", () => {
    const b = new Block([], [], { computed: true });
    const pb = b.toPb()!;
    assert.equal(pb.computed, true, "computed: true should be forwarded to proto");
  });

  void it("Schema 4th blockOpts arg forwards deprecationMessage", () => {
    const schema = new Schema([], [], 0, { deprecationMessage: "legacy resource" });
    const pb = schema.toPb();
    assert.equal(pb.block!.deprecationMessage, "legacy resource", "Schema blockOpts should forward deprecationMessage"); // block is always present
  });
});

/** Two-field object type used across many tests below. */
function metadataFields() {
  return [
    new Attribute("owner",       types.string(), { optional: true, computed: true }),
    new Attribute("environment", types.string(), { optional: true, computed: true }),
  ];
}

void describe("ObjectAttribute — toPb()", () => {
  void it("sets nestedType and leaves type empty", () => {
    const oa = new ObjectAttribute("metadata", metadataFields(), "single", { optional: true });
    const pb = oa.toPb();
    assert.equal(pb.name, "metadata", "attribute name should be 'metadata'");
    assert.ok(pb.nestedType, "nestedType should be populated");
    assert.equal(pb.type.length, 0, "type bytes should be empty when nestedType is set");
  });

  void it("nestedType.nesting is SINGLE (1) for \"single\" mode", () => {
    const oa = new ObjectAttribute("m", metadataFields(), "single");
    assert.equal(oa.toPb().nestedType!.nesting, 1 /* SINGLE */, "'single' mode should produce nesting value 1 (SINGLE)");
  });

  void it("nestedType.nesting is LIST (2) for \"list\" mode", () => {
    const oa = new ObjectAttribute("m", metadataFields(), "list");
    assert.equal(oa.toPb().nestedType!.nesting, 2 /* LIST */, "'list' mode should produce nesting value 2 (LIST)");
  });

  void it("nestedType.nesting is SET (3) for \"set\" mode", () => {
    const oa = new ObjectAttribute("m", metadataFields(), "set");
    assert.equal(oa.toPb().nestedType!.nesting, 3 /* SET */, "'set' mode should produce nesting value 3 (SET)");
  });

  void it("nestedType.nesting is MAP (4) for \"map\" mode", () => {
    const oa = new ObjectAttribute("m", metadataFields(), "map");
    assert.equal(oa.toPb().nestedType!.nesting, 4 /* MAP */, "'map' mode should produce nesting value 4 (MAP)");
  });

  void it("nestedType.attributes lists the child fields", () => {
    const oa = new ObjectAttribute("metadata", metadataFields(), "single");
    const childAttrs = oa.toPb().nestedType!.attributes;
    assert.equal(childAttrs.length, 2, "nestedType should list exactly 2 child attributes");
    assert.equal(childAttrs[0]!.name, "owner", "first child attribute name should be 'owner'");
    assert.equal(childAttrs[1]!.name, "environment", "second child attribute name should be 'environment'");
  });

  void it("forwards optional/computed/sensitive from opts", () => {
    const oa = new ObjectAttribute("m", metadataFields(), "single", {
      optional: true, computed: true, sensitive: true,
    });
    const pb = oa.toPb();
    assert.equal(pb.optional, true, "optional should be forwarded from opts");
    assert.equal(pb.computed, true, "computed should be forwarded from opts");
    assert.equal(pb.sensitive, true, "sensitive should be forwarded from opts");
  });

  void it("appears correctly in Schema.toPb() block attributes", () => {
    const schema = new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new ObjectAttribute("meta", metadataFields(), "single", { optional: true }),
    ]);
    const attrs = schema.toPb().block!.attributes;
    assert.equal(attrs.length, 2, "schema block should contain exactly 2 attributes");
    assert.equal(attrs[1]!.name, "meta", "second attribute name should be 'meta'");
    assert.ok(attrs[1]!.nestedType, "second attribute should have nestedType populated");
    assert.equal(attrs[1]!.type.length, 0, "second attribute type bytes should be empty when nestedType is set");
  });
});

void describe("TfObject — SINGLE nesting encode/decode round-trip", () => {
  const obj = new TfObject(metadataFields(), "single");

  void it("encodes and decodes a plain object", () => {
    const val = { owner: "alice", environment: "prod" };
    const enc = obj.encode(val);
    assert.deepEqual(obj.decode(enc), val, "decoded value should match the original");
  });

  void it("encode passes through null", () => {
    assert.equal(obj.encode(null), null, "encode should pass null through unchanged");
  });

  void it("decode passes through null", () => {
    assert.equal(obj.decode(null), null, "decode should pass null through unchanged");
  });

  void it("encode passes through Unknown", () => {
    assert.equal(obj.encode(Unknown), Unknown, "encode should pass Unknown through unchanged");
  });

  void it("decode passes through Unknown", () => {
    assert.equal(obj.decode(Unknown), Unknown, "decode should pass Unknown through unchanged");
  });

  void it("field-level Unknown is preserved through encode and decode", () => {
    const val = { owner: Unknown, environment: "prod" };
    const enc = obj.encode(val) as Record<string, unknown>;
    assert.equal(enc["owner"], Unknown, "field-level Unknown should survive encode");
    const dec = obj.decode(enc) as Record<string, unknown>;
    assert.equal(dec["owner"], Unknown, "field-level Unknown should survive decode");
  });

  void it("unknown schema fields are dropped during encode", () => {
    const val = { owner: "alice", environment: "prod", extra: "ignored" };
    const enc = obj.encode(val) as Record<string, unknown>;
    assert.ok(!("extra" in enc), "extra field should be dropped");
  });
});

void describe("TfObject — LIST nesting encode/decode round-trip", () => {
  const obj = new TfObject(metadataFields(), "list");

  void it("encodes and decodes an array of objects", () => {
    const val = [
      { owner: "alice", environment: "prod" },
      { owner: "bob",   environment: "staging" },
    ];
    assert.deepEqual(obj.decode(obj.encode(val)), val, "should round-trip an array of objects");
  });

  void it("encode/decode empty list", () => {
    assert.deepEqual(obj.decode(obj.encode([])), [], "should round-trip an empty array");
  });
});

void describe("TfObject — SET nesting encode/decode round-trip", () => {
  const obj = new TfObject(metadataFields(), "set");

  void it("encodes and decodes an array (same as list)", () => {
    const val = [{ owner: "alice", environment: "prod" }];
    assert.deepEqual(obj.decode(obj.encode(val)), val, "should round-trip a set element");
  });
});

void describe("TfObject — MAP nesting encode/decode round-trip", () => {
  const obj = new TfObject(metadataFields(), "map");

  void it("encodes and decodes a map of objects", () => {
    const val = {
      dev:  { owner: "alice", environment: "dev" },
      prod: { owner: "bob",   environment: "prod" },
    };
    assert.deepEqual(obj.decode(obj.encode(val)), val, "should round-trip a map of objects");
  });

  void it("encode/decode empty map", () => {
    assert.deepEqual(obj.decode(obj.encode({})), {}, "should round-trip an empty map");
  });
});

void describe("TfObject — semanticallyEqual (SINGLE)", () => {
  const obj = new TfObject(metadataFields(), "single");

  void it("identical objects are equal", () => {
    assert.ok(obj.semanticallyEqual(
      { owner: "alice", environment: "prod" },
      { owner: "alice", environment: "prod" },
    ), "identical objects should be semantically equal");
  });

  void it("different field value → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      { owner: "alice", environment: "prod" },
      { owner: "alice", environment: "staging" },
    ), "objects with different values should not be equal");
  });

  void it("null vs null → equal", () => {
    assert.ok(obj.semanticallyEqual(null, null), "null and null should be equal");
  });

  void it("null vs object → not equal", () => {
    assert.ok(!obj.semanticallyEqual(null, { owner: "alice", environment: "prod" }), "null and an object should not be equal");
  });

  void it("Unknown vs Unknown → equal", () => {
    assert.ok(obj.semanticallyEqual(Unknown, Unknown), "Unknown and Unknown should be equal");
  });

  void it("Unknown vs object → not equal", () => {
    assert.ok(!obj.semanticallyEqual(Unknown, { owner: "alice", environment: "prod" }), "Unknown and an object should not be equal");
  });

  void it("field-level Unknown: same on both sides → equal", () => {
    assert.ok(obj.semanticallyEqual(
      { owner: Unknown, environment: "prod" },
      { owner: Unknown, environment: "prod" },
    ), "objects with matching Unknown fields should be semantically equal");
  });

  void it("field-level Unknown vs known value → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      { owner: Unknown, environment: "prod" },
      { owner: "alice", environment: "prod" },
    ), "Unknown field vs known value should not be equal");
  });
});

void describe("TfObject — semanticallyEqual (LIST)", () => {
  const obj = new TfObject(metadataFields(), "list");

  void it("same order → equal", () => {
    const a = [{ owner: "alice", environment: "prod" }];
    assert.ok(obj.semanticallyEqual(a, [...a]), "identical lists should be semantically equal");
  });

  void it("different order → NOT equal (list is ordered)", () => {
    const a = [{ owner: "alice", environment: "prod" }, { owner: "bob", environment: "staging" }];
    const b = [{ owner: "bob",   environment: "staging" }, { owner: "alice", environment: "prod" }];
    assert.ok(!obj.semanticallyEqual(a, b), "list nesting should be order-sensitive");
  });

  void it("different length → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      [{ owner: "alice", environment: "prod" }],
      [],
    ), "lists of different lengths should not be equal");
  });
});

void describe("TfObject — semanticallyEqual (SET)", () => {
  const obj = new TfObject(metadataFields(), "set");

  void it("same elements in different order → equal", () => {
    const a = [{ owner: "alice", environment: "prod" }, { owner: "bob", environment: "staging" }];
    const b = [{ owner: "bob",   environment: "staging" }, { owner: "alice", environment: "prod" }];
    assert.ok(obj.semanticallyEqual(a, b), "elements in different order should be semantically equal for set nesting");
  });

  void it("different elements → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      [{ owner: "alice", environment: "prod" }],
      [{ owner: "charlie", environment: "prod" }],
    ), "sets with different elements should not be equal");
  });
});

void describe("TfObject — semanticallyEqual (MAP)", () => {
  const obj = new TfObject(metadataFields(), "map");

  void it("same map → equal", () => {
    const m = { dev: { owner: "alice", environment: "dev" } };
    assert.ok(obj.semanticallyEqual(m, { ...m }), "identical maps should be semantically equal");
  });

  void it("different value → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      { dev: { owner: "alice", environment: "dev" } },
      { dev: { owner: "bob",   environment: "dev" } },
    ), "maps with different nested values should not be equal");
  });

  void it("different keys → not equal", () => {
    assert.ok(!obj.semanticallyEqual(
      { dev: { owner: "alice", environment: "dev" } },
      { prod: { owner: "alice", environment: "dev" } },
    ), "maps with different keys should not be equal");
  });
});

void describe("encodeBlock / decodeBlock with ObjectAttribute", () => {
  const schema = new Schema([
    new Attribute("id",       types.string(),                          { computed: true }),
    new ObjectAttribute("meta", metadataFields(), "single",            { optional: true }),
  ]);
  const block = schema.block;

  void it("encodeBlock round-trips an ObjectAttribute value", () => {
    const state = { id: "1", meta: { owner: "alice", environment: "prod" } };
    const encoded = encodeBlock(block, state);
    assert.deepEqual(decodeBlock(block, encoded as Record<string, unknown>), state, "decoded value should match the original state");
  });

  void it("encodeBlock handles null ObjectAttribute value", () => {
    const state = { id: "1", meta: null };
    const encoded = encodeBlock(block, state);
    assert.deepEqual((encoded as Record<string, unknown>)["meta"], null, "encoded null ObjectAttribute should be null");
  });

  void it("decodeBlock handles null ObjectAttribute value", () => {
    const decoded = decodeBlock(block, { id: "1", meta: null });
    assert.equal(decoded!["meta"], null, "decoded null ObjectAttribute should be null");
  });
});

void describe("encodeBlockPreserving with ObjectAttribute", () => {
  const schema = new Schema([
    new Attribute("id",   types.string(),                       { computed: true }),
    new ObjectAttribute("meta", metadataFields(), "single",     { optional: true }),
  ]);
  const block = schema.block;

  void it("preserves prior wire bytes when ObjectAttribute is semantically unchanged", () => {
    // Simulate: prior raw has meta as a plain object; new state has identical value.
    const priorRaw = { id: "1", meta: { owner: "alice", environment: "prod" } };
    const newState = { id: "1", meta: { owner: "alice", environment: "prod" } };

    const encoded = encodeBlockPreserving(block, newState, priorRaw);
    // The wire representation should be the same object reference (prior preserved).
    assert.equal(
      (encoded as Record<string, unknown>)["meta"],
      priorRaw["meta"],
      "prior wire bytes should be reused for unchanged ObjectAttribute",
    );
  });

  void it("uses new encoding when ObjectAttribute value changes", () => {
    const priorRaw = { id: "1", meta: { owner: "alice", environment: "prod" } };
    const newState  = { id: "1", meta: { owner: "bob",   environment: "prod" } };

    const encoded = encodeBlockPreserving(block, newState, priorRaw);
    assert.deepEqual(
      (encoded as Record<string, unknown>)["meta"],
      { owner: "bob", environment: "prod" },
    );
    // Must NOT be the prior reference.
    assert.notEqual(
      (encoded as Record<string, unknown>)["meta"],
      priorRaw["meta"],
      "changed ObjectAttribute should use new encoding, not the prior reference",
    );
  });
});
