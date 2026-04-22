import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Attribute, Block, Schema, NestedBlock } from "./schema.js";
import { types } from "./types.js";

void describe("Attribute", () => {
  void it("stores name and type", () => {
    const a = new Attribute("foo", types.string());
    assert.equal(a.name, "foo");
  });

  void it("defaults: not required, optional, computed, sensitive", () => {
    const a = new Attribute("x", types.string());
    assert.equal(a.required, false);
    assert.equal(a.optional, false);
    assert.equal(a.computed, false);
    assert.equal(a.sensitive, false);
  });

  void it("respects required: true", () => {
    const a = new Attribute("x", types.string(), { required: true });
    assert.equal(a.required, true);
  });

  void it("respects computed + optional", () => {
    const a = new Attribute("x", types.string(), { computed: true, optional: true });
    assert.equal(a.computed, true);
    assert.equal(a.optional, true);
  });

  void it("respects sensitive: true", () => {
    const a = new Attribute("tok", types.string(), { sensitive: true });
    assert.equal(a.sensitive, true);
  });

  void it("toPb() produces a Schema_Attribute with the correct name", () => {
    const a = new Attribute("my_attr", types.number(), { required: true });
    const pb = a.toPb();
    assert.equal(pb.name, "my_attr");
    assert.equal(pb.required, true);
  });

  void it("toPb() embeds the tfType bytes", () => {
    const a = new Attribute("n", types.number());
    const pb = a.toPb();
    assert.equal(Buffer.from(pb.type).toString(), '"number"');
  });
});

void describe("Schema", () => {
  void it("is constructed with a list of Attributes", () => {
    const schema = new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new Attribute("name", types.string(), { required: true }),
    ]);
    assert.ok(schema);
  });

  void it("toPb() returns a PbSchema with block.attributes", () => {
    const schema = new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new Attribute("name", types.string(), { required: true }),
    ]);
    const pb = schema.toPb();
    assert.ok(pb.block);
    assert.equal(pb.block!.attributes.length, 2);
  });

  void it("toPb() preserves attribute names and order", () => {
    const schema = new Schema([
      new Attribute("a", types.string()),
      new Attribute("b", types.number()),
      new Attribute("c", types.bool()),
    ]);
    const attrs = schema.toPb().block!.attributes;
    assert.deepEqual(attrs.map((a) => a.name), ["a", "b", "c"]);
  });

  void it("default version is 0", () => {
    const schema = new Schema([]);
    const pb = schema.toPb();
    // version is a Long; its toNumber() should be 0
    assert.equal(pb.version.toNumber(), 0);
  });

  void it("accepts an explicit schema version", () => {
    const schema = new Schema([], [], 3);
    assert.equal(schema.toPb().version.toNumber(), 3);
  });

  void it("includes nested blocks in toPb()", () => {
    const block = new Block([new Attribute("cidr", types.string())]);
    const nested = new NestedBlock("network", "list", block);
    const schema = new Schema([], [nested]);
    const pb = schema.toPb();
    assert.equal(pb.block!.blockTypes.length, 1);
    assert.equal(pb.block!.blockTypes[0]!.typeName, "network");
  });
});

void describe("NestedBlock", () => {
  void it("toPb() sets the typeName", () => {
    const block = new Block([new Attribute("key", types.string())]);
    const nb = new NestedBlock("tags", "map", block);
    const pb = nb.toPb();
    assert.equal(pb.typeName, "tags");
  });

  void it("supports 'single' nesting mode", () => {
    const nb = new NestedBlock("timeouts", "single", new Block([]));
    const pb = nb.toPb();
    assert.ok(pb.nesting);
  });
});
