import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderServicer } from "./servicer.js";
import { toDynamicValue } from "./encoding.js";
import { Schema, Attribute, Block, NestedBlock } from "./schema.js";
import { types } from "./types.js";
import type {
  Provider,
  Resource,
  ResourceClass,
  DataSourceClass,
  CreateContext,
  ReadContext,
  UpdateContext,
  DeleteContext,
  PlanContext,
} from "./interfaces.js";
import type { DynamicValue } from "../gen/tfplugin6.js";

function dv(value: unknown): DynamicValue {
  return toDynamicValue(value as Record<string, unknown> | null) as unknown as DynamicValue;
}

/** Schema with a string attr + a SET-nested block */
function makeSchemaWithSetBlock(): Schema {
  const inner = new Block([new Attribute("cidr", types.string(), { required: true })]);
  return new Schema(
    [new Attribute("name", types.string(), { required: true })],
    [new NestedBlock("networks", "set", inner)]
  );
}

/** Schema with a NormalizedJson attr (semantic equality ignores key order) */
function makeSchemaWithJsonAttr(): Schema {
  return new Schema([
    new Attribute("name",   types.string(),         { required: true }),
    new Attribute("config", types.normalizedJson(),  { optional: true, computed: true }),
  ]);
}

type Recorder = { planChangedFields: Set<string> | null; applyChangedFields: Set<string> | null };

function makeResourceClass(schema: Schema, recorder: Recorder): ResourceClass {
  return class TestResource implements Resource {
    constructor(_provider: Provider) {}
    getName() { return "item"; }
    getSchema() { return schema; }
    async create(_ctx: CreateContext, planned: unknown) { return planned as Record<string, unknown>; }
    async read(_ctx: ReadContext, current: unknown) { return current as Record<string, unknown>; }
    async update(ctx: UpdateContext, _prior: unknown, planned: unknown) {
      recorder.applyChangedFields = ctx.changedFields;
      return planned as Record<string, unknown>;
    }
    async delete(_ctx: DeleteContext) {}
    async plan(ctx: PlanContext, _prior: unknown, planned: unknown) {
      recorder.planChangedFields = ctx.changedFields;
      return planned as Record<string, unknown>;
    }
  } as unknown as ResourceClass;
}

function makeProvider(resCls: ResourceClass): Provider {
  return {
    getFullName:       () => "registry.terraform.io/test/stub",
    getModelPrefix:    () => "stub",
    getProviderSchema: (_diags) => new Schema([]),
    validateConfig:    (_diags, _config) => {},
    configure:         (_diags, _config) => {},
    getResources:      () => [resCls],
    getDataSources:    (): DataSourceClass[] => [],
    newResource:       (cls) => new cls({} as Provider),
    newDataSource:     (cls) => new cls({} as Provider),
  };
}

void describe("PlanResourceChange — changedFields includes block changes", () => {
  void it("adding a network block reports 'networks' as changed", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", networks: [] });
    const proposed = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }] });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields !== null, "plan() should have been called");
    assert.ok(recorder.planChangedFields!.has("networks"), "expected 'networks' in changedFields");
  });

  void it("removing a network block reports 'networks' as changed", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }] });
    const proposed = dv({ name: "r1", networks: [] });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields!.has("networks"), "expected 'networks' in changedFields");
  });

  void it("unchanged block does NOT appear in changedFields", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const state = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }] });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: state,
      proposedNewState: dv({ name: "r2", networks: [{ cidr: "10.0.0.0/8" }] }),
      config: dv({ name: "r2", networks: [{ cidr: "10.0.0.0/8" }] }),
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(!recorder.planChangedFields!.has("networks"), "unchanged block should not be in changedFields");
    assert.ok(recorder.planChangedFields!.has("name"), "changed attr 'name' should be in changedFields");
  });
});

void describe("PlanResourceChange — SET block reorder is not a change", () => {
  void it("reordered set items → 'networks' NOT in changedFields", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }, { cidr: "192.168.0.0/16" }] });
    const proposed = dv({ name: "r1", networks: [{ cidr: "192.168.0.0/16" }, { cidr: "10.0.0.0/8" }] });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields !== null, "plan() should have been called");
    assert.ok(!recorder.planChangedFields!.has("networks"),
      "reordered set elements should NOT appear as changed");
  });
});

void describe("PlanResourceChange — NormalizedJson semantic equality", () => {
  void it("JSON with different key order is NOT a change", async () => {
    const schema   = makeSchemaWithJsonAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    // prior has {"b":2,"a":1}, proposed has {"a":1,"b":2} — semantically equal
    const prior    = dv({ name: "r1", config: JSON.stringify({ b: 2, a: 1 }) });
    const proposed = dv({ name: "r1", config: JSON.stringify({ a: 1, b: 2 }) });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields !== null);
    assert.ok(!recorder.planChangedFields!.has("config"),
      "semantically identical JSON should not appear as changed");
  });

  void it("JSON with different values IS a change", async () => {
    const schema   = makeSchemaWithJsonAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", config: JSON.stringify({ a: 1 }) });
    const proposed = dv({ name: "r1", config: JSON.stringify({ a: 2 }) });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields!.has("config"), "changed JSON value should appear in changedFields");
  });
});

void describe("ApplyResourceChange — changedFields includes block changes", () => {
  void it("adding a network block reports 'networks' as changed", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", networks: [] });
    const planned  = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }] });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(recorder.applyChangedFields !== null, "update() should have been called");
    assert.ok(recorder.applyChangedFields!.has("networks"), "expected 'networks' in changedFields");
  });

  void it("unchanged block does NOT appear in apply changedFields", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const nets = [{ cidr: "10.0.0.0/8" }];
    const prior   = dv({ name: "r1", networks: nets });
    const planned = dv({ name: "r2", networks: nets });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(!recorder.applyChangedFields!.has("networks"), "unchanged block should not be in changedFields");
    assert.ok(recorder.applyChangedFields!.has("name"), "changed 'name' should be in changedFields");
  });
});

void describe("ApplyResourceChange — SET block reorder is not a change", () => {
  void it("reordered set items → 'networks' NOT in apply changedFields", async () => {
    const schema   = makeSchemaWithSetBlock();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior   = dv({ name: "r1", networks: [{ cidr: "10.0.0.0/8" }, { cidr: "192.168.0.0/16" }] });
    const planned = dv({ name: "r1", networks: [{ cidr: "192.168.0.0/16" }, { cidr: "10.0.0.0/8" }] });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(!recorder.applyChangedFields!.has("networks"),
      "reordered set elements should NOT appear as changed in apply");
  });
});

void describe("ApplyResourceChange — NormalizedJson semantic equality", () => {
  void it("JSON with different key order is NOT a change", async () => {
    const schema   = makeSchemaWithJsonAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior   = dv({ name: "r1", config: JSON.stringify({ b: 2, a: 1 }) });
    const planned = dv({ name: "r1", config: JSON.stringify({ a: 1, b: 2 }) });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(!recorder.applyChangedFields!.has("config"),
      "semantically identical JSON should not appear as changed in apply");
  });
});

// ---------------------------------------------------------------------------
// Helpers for panic / error-handling tests
// ---------------------------------------------------------------------------

import { ObjectAttribute } from "./schema.js";
import { readDynamicValue } from "./encoding.js";

function makePanicResourceClass(schema: Schema, panicOn: "create" | "read" | "update" | "delete" | "plan" | "import"): ResourceClass {
  return class PanicResource implements Resource {
    constructor(_provider: Provider) {}
    getName() { return "item"; }
    getSchema() { return schema; }
    async create(_ctx: CreateContext, planned: unknown) {
      if (panicOn === "create") throw new Error("boom in create");
      return planned as Record<string, unknown>;
    }
    async read(_ctx: ReadContext, current: unknown) {
      if (panicOn === "read") throw new Error("boom in read");
      return current as Record<string, unknown>;
    }
    async update(_ctx: UpdateContext, _prior: unknown, planned: unknown) {
      if (panicOn === "update") throw new Error("boom in update");
      return planned as Record<string, unknown>;
    }
    async delete(_ctx: DeleteContext) {
      if (panicOn === "delete") throw new Error("boom in delete");
    }
    async plan(_ctx: PlanContext, _prior: unknown, planned: unknown) {
      if (panicOn === "plan") throw new Error("boom in plan");
      return planned as Record<string, unknown>;
    }
    async import(_ctx: ImportContext, _id: string) {
      if (panicOn === "import") throw new Error("boom in import");
      return null;
    }
  } as unknown as ResourceClass;
}

import type { ImportContext } from "./interfaces.js";

// ---------------------------------------------------------------------------
// 7. Exception handling: errors become diagnostics, not crashed plugins
// ---------------------------------------------------------------------------

void describe("Exception handling — panics become error diagnostics", () => {
  const schema = new Schema([new Attribute("name", types.string(), { required: true })]);

  void it("create() throwing returns error diagnostic, not a crash", async () => {
    const svc = new ProviderServicer(makeProvider(makePanicResourceClass(schema, "create")));
    const resp = await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: dv(null),
      plannedState: dv({ name: "r1" }),
      config: dv({ name: "r1" }),
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);
    const diags = resp.diagnostics ?? [];
    assert.ok(diags.length > 0, "expected error diagnostic");
    assert.match(String(diags[0]!.summary), /panicked|Provider/i);
    assert.match(String(diags[0]!.detail ?? ""), /boom in create/);
  });

  void it("read() throwing returns error diagnostic and preserves prior state", async () => {
    const svc = new ProviderServicer(makeProvider(makePanicResourceClass(schema, "read")));
    const prior = dv({ name: "r1" });
    const resp = await svc.ReadResource({
      typeName: "stub_item",
      currentState: prior,
      private: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      currentIdentity: undefined,
    }, null);
    const diags = resp.diagnostics ?? [];
    assert.ok(diags.length > 0, "expected error diagnostic");
    assert.match(String(diags[0]!.detail ?? ""), /boom in read/);
    // Prior state must be preserved — not null — to prevent a spurious destroy plan
    assert.ok(resp.newState !== undefined, "newState should not be undefined");
    const returnedState = readDynamicValue(resp.newState as { msgpack: Uint8Array; json: Uint8Array });
    assert.deepEqual(returnedState, { name: "r1" });
  });

  void it("update() throwing returns error diagnostic and preserves prior state", async () => {
    const svc = new ProviderServicer(makeProvider(makePanicResourceClass(schema, "update")));
    const prior = dv({ name: "r1" });
    const resp = await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: dv({ name: "r2" }),
      config: dv({ name: "r2" }),
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);
    const diags = resp.diagnostics ?? [];
    assert.ok(diags.length > 0, "expected error diagnostic");
    assert.match(String(diags[0]!.detail ?? ""), /boom in update/);
    const returnedState = readDynamicValue(resp.newState as { msgpack: Uint8Array; json: Uint8Array });
    assert.deepEqual(returnedState, { name: "r1" }, "prior state should be returned on error");
  });

  void it("plan() throwing returns error diagnostic", async () => {
    const svc = new ProviderServicer(makeProvider(makePanicResourceClass(schema, "plan")));
    const prior = dv({ name: "r1" });
    const proposed = dv({ name: "r2" });
    const resp = await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      plannedPrivate: new Uint8Array(),
      priorIdentity: undefined,
      providerMeta: dv({}),
      clientCapabilities: undefined,
    }, null);
    const diags = resp.diagnostics ?? [];
    assert.ok(diags.length > 0, "expected error diagnostic");
    assert.match(String(diags[0]!.detail ?? ""), /boom in plan/);
  });

  void it("import() throwing returns error diagnostic", async () => {
    const svc = new ProviderServicer(makeProvider(makePanicResourceClass(schema, "import")));
    const resp = await svc.ImportResourceState({
      typeName: "stub_item",
      id: "abc",
      clientCapabilities: undefined,
      identity: undefined,
    }, null);
    const diags = resp.diagnostics ?? [];
    assert.ok(diags.length > 0, "expected error diagnostic");
    assert.match(String(diags[0]!.detail ?? ""), /boom in import/);
  });
});

// ---------------------------------------------------------------------------
// 8. Encoding preservation — read() returning same logical value preserves wire bytes
// ---------------------------------------------------------------------------

void describe("encodeBlockPreserving — no spurious diffs on read", () => {
  void it("read() returning semantically identical NormalizedJson preserves wire bytes", async () => {
    // Prior state: config stored as '{"b":2,"a":1}'
    // read() returns the parsed object, re-encoded as '{"a":1,"b":2}'
    // encodeBlockPreserving should use the original bytes.

    const schema = new Schema([
      new Attribute("name",   types.string(),        { required: true }),
      new Attribute("config", types.normalizedJson(), { optional: true }),
    ]);

    const originalJsonBytes = JSON.stringify({ b: 2, a: 1 }); // the wire-level bytes

    let returnedFromRead: unknown = null;

    const resCls: ResourceClass = class implements Resource {
      constructor(_p: Provider) {}
      getName() { return "item"; }
      getSchema() { return schema; }
      async create(_ctx: CreateContext, p: unknown) { return p as Record<string, unknown>; }
      async delete(_ctx: DeleteContext) {}
      async update(_ctx: UpdateContext, _p: unknown, pl: unknown) { return pl as Record<string, unknown>; }
      async read(_ctx: ReadContext, current: unknown) {
        // Return same logical value — read() returns decoded object, not re-encoded string
        return current as Record<string, unknown>;
      }
    } as unknown as ResourceClass;

    const svc = new ProviderServicer(makeProvider(resCls));
    const prior = dv({ name: "r1", config: originalJsonBytes });

    const resp = await svc.ReadResource({
      typeName: "stub_item",
      currentState: prior,
      private: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      currentIdentity: undefined,
    }, null);

    returnedFromRead = readDynamicValue(resp.newState as { msgpack: Uint8Array; json: Uint8Array });
    const returnedConfig = (returnedFromRead as Record<string, unknown>)["config"];

    // The wire bytes must be the original (not re-sorted) to prevent spurious diff
    assert.equal(returnedConfig, originalJsonBytes,
      "wire bytes should be preserved when value is semantically unchanged");
  });

  void it("read() returning changed value uses new encoding", async () => {
    const schema = new Schema([
      new Attribute("name",   types.string(),        { required: true }),
      new Attribute("config", types.normalizedJson(), { optional: true }),
    ]);

    const resCls: ResourceClass = class implements Resource {
      constructor(_p: Provider) {}
      getName() { return "item"; }
      getSchema() { return schema; }
      async create(_ctx: CreateContext, p: unknown) { return p as Record<string, unknown>; }
      async delete(_ctx: DeleteContext) {}
      async update(_ctx: UpdateContext, _p: unknown, pl: unknown) { return pl as Record<string, unknown>; }
      async read(_ctx: ReadContext, _current: unknown) {
        // API returned a different config value
        return { name: "r1", config: { x: 99 } };
      }
    } as unknown as ResourceClass;

    const svc = new ProviderServicer(makeProvider(resCls));
    const prior = dv({ name: "r1", config: JSON.stringify({ a: 1 }) });

    const resp = await svc.ReadResource({
      typeName: "stub_item",
      currentState: prior,
      private: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      currentIdentity: undefined,
    }, null);

    const returnedState = readDynamicValue(resp.newState as { msgpack: Uint8Array; json: Uint8Array });
    const returnedConfig = (returnedState as Record<string, unknown>)["config"];
    // Should be normalised {"x":99}
    assert.equal(returnedConfig, JSON.stringify({ x: 99 }), "changed value should use new encoding");
  });
});

// ---------------------------------------------------------------------------
// 9. ObjectAttribute — changedFields detection via PlanResourceChange
// ---------------------------------------------------------------------------

function makeSchemaWithObjectAttr(): Schema {
  return new Schema([
    new Attribute("name", types.string(), { required: true }),
    new ObjectAttribute("meta", [
      new Attribute("owner",       types.string(), { optional: true }),
      new Attribute("environment", types.string(), { optional: true }),
    ], "single", { optional: true, computed: true }),
  ]);
}

void describe("ObjectAttribute in PlanResourceChange — changedFields", () => {
  void it("changing a nested field puts the attribute name in changedFields", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior    = dv({ name: "r1", meta: { owner: "alice", environment: "prod" } });
    const proposed = dv({ name: "r1", meta: { owner: "alice", environment: "staging" } });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: prior,
      proposedNewState: proposed,
      config: proposed,
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields !== null);
    assert.ok(recorder.planChangedFields!.has("meta"),
      "changed nested field should put 'meta' in changedFields");
  });

  void it("identical nested object does NOT appear in changedFields", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const state = dv({ name: "r1", meta: { owner: "alice", environment: "prod" } });

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState: state,
      proposedNewState: dv({ name: "r2", meta: { owner: "alice", environment: "prod" } }),
      config:          dv({ name: "r2", meta: { owner: "alice", environment: "prod" } }),
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(!recorder.planChangedFields!.has("meta"),
      "unchanged nested object should NOT appear in changedFields");
    assert.ok(recorder.planChangedFields!.has("name"),
      "changed 'name' should still appear in changedFields");
  });

  void it("null → object transition is detected as a change", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState:      dv({ name: "r1", meta: null }),
      proposedNewState: dv({ name: "r1", meta: { owner: "alice", environment: "prod" } }),
      config:           dv({ name: "r1", meta: { owner: "alice", environment: "prod" } }),
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields!.has("meta"),
      "null → object should appear in changedFields");
  });

  void it("object → null transition is detected as a change", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    await svc.PlanResourceChange({
      typeName: "stub_item",
      priorState:      dv({ name: "r1", meta: { owner: "alice", environment: "prod" } }),
      proposedNewState: dv({ name: "r1", meta: null }),
      config:           dv({ name: "r1", meta: null }),
      priorPrivate: new Uint8Array(),
      providerMeta: dv({}),
      clientCapabilities: undefined,
      priorIdentity: undefined,
      plannedPrivate: new Uint8Array(),
    }, null);

    assert.ok(recorder.planChangedFields!.has("meta"),
      "object → null should appear in changedFields");
  });
});

void describe("ObjectAttribute in ApplyResourceChange — changedFields", () => {
  void it("changing a nested field puts the attribute name in apply changedFields", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const prior   = dv({ name: "r1", meta: { owner: "alice", environment: "prod" } });
    const planned = dv({ name: "r1", meta: { owner: "alice", environment: "staging" } });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(recorder.applyChangedFields!.has("meta"),
      "changed nested object field should appear in apply changedFields");
  });

  void it("identical nested object does NOT appear in apply changedFields", async () => {
    const schema   = makeSchemaWithObjectAttr();
    const recorder: Recorder = { planChangedFields: null, applyChangedFields: null };
    const svc = new ProviderServicer(makeProvider(makeResourceClass(schema, recorder)));

    const meta  = { owner: "alice", environment: "prod" };
    const prior   = dv({ name: "r1", meta });
    const planned = dv({ name: "r2", meta });

    await svc.ApplyResourceChange({
      typeName: "stub_item",
      priorState: prior,
      plannedState: planned,
      config: planned,
      plannedPrivate: new Uint8Array(),
      plannedIdentity: undefined,
      providerMeta: dv({}),
    }, null);

    assert.ok(!recorder.applyChangedFields!.has("meta"),
      "unchanged nested object should NOT appear in apply changedFields");
    assert.ok(recorder.applyChangedFields!.has("name"),
      "'name' should still appear in apply changedFields");
  });
});
