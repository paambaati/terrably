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
