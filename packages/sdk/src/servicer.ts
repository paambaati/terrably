/**
 * ProviderServicer – implements the tfplugin6.Provider gRPC service.
 *
 * This is the bridge between Terraform Core's RPC calls and the user's
 * Provider/Resource/DataSource implementations.
 *
 * Design mirrors hfern/tf provider.py but leverages TypeScript types.
 */

import type {
  DeepPartial,
  Schema,

  GetMetadata_Response,
  GetProviderSchema_Response,
  ValidateProviderConfig_Response,
  ValidateResourceConfig_Response,
  ValidateDataResourceConfig_Response,
  UpgradeResourceState_Response,
  ConfigureProvider_Response,
  ReadResource_Response,
  PlanResourceChange_Response,
  ApplyResourceChange_Response,
  ImportResourceState_Response,
  ImportResourceState_ImportedResource,
  MoveResourceState_Response,
  ReadDataSource_Response,
  GetFunctions_Response,
  CallFunction_Response,
  ValidateEphemeralResourceConfig_Response,
  OpenEphemeralResource_Response,
  RenewEphemeralResource_Response,
  CloseEphemeralResource_Response,
  ListResource_Request,
  ListResource_Event,
  ValidateListResourceConfig_Response,
  ValidateStateStore_Response,
  ConfigureStateStore_Response,
  ReadStateBytes_Request,
  ReadStateBytes_Response,
  WriteStateBytes_RequestChunk,
  WriteStateBytes_Response,
  LockState_Response,
  UnlockState_Response,
  GetStates_Response,
  DeleteState_Response,
  PlanAction_Response,
  InvokeAction_Request,
  InvokeAction_Event,
  ValidateActionConfig_Response,
  StopProvider_Response,
  GetResourceIdentitySchemas_Response,
  UpgradeResourceIdentity_Response,
  GenerateResourceConfig_Response,
  FunctionMessage,
  ServerCapabilities} from "../gen/tfplugin6.js";
import {
  Diagnostic_Severity,
  StringKind,
} from "../gen/tfplugin6.js";
import type {
  GetMetadata_Request,
  GetProviderSchema_Request,
  ValidateProviderConfig_Request,
  ValidateResourceConfig_Request,
  ValidateDataResourceConfig_Request,
  UpgradeResourceState_Request,
  ConfigureProvider_Request,
  ReadResource_Request,
  PlanResourceChange_Request,
  ApplyResourceChange_Request,
  ImportResourceState_Request,
  MoveResourceState_Request,
  ReadDataSource_Request,
  GetFunctions_Request,
  CallFunction_Request,
  GetResourceIdentitySchemas_Request,
  UpgradeResourceIdentity_Request,
  GenerateResourceConfig_Request,
} from "../gen/tfplugin6.js";

import type { Provider, Resource, DataSource, ResourceClass, DataSourceClass, FunctionClass, TerrablyFunction, FunctionSignature, PlanContext } from "./interfaces.js";
import { Diagnostics } from "./interfaces.js";
import { readDynamicValue, toDynamicValue, diagsToPb } from "./encoding.js";
import { encodeBlock, decodeBlock, type State, type DescriptionKind } from "./schema.js";
import { Unknown } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse<T extends object>(
  summary: string,
  detail = ""
): T {
  return {
    diagnostics: [
      {
        severity: Diagnostic_Severity.ERROR,
        summary,
        detail,
        attribute: undefined,
      },
    ],
  } as unknown as T;
}

function descKindToPb(kind: DescriptionKind | undefined): StringKind {
  return kind === "plain" ? StringKind.PLAIN : StringKind.MARKDOWN;
}

function signatureToPb(sig: FunctionSignature): FunctionMessage {
  return {
    parameters: sig.parameters.map((p) => ({
      name: p.name,
      type: p.type.tfType(),
      description: p.description ?? "",
      descriptionKind: descKindToPb(p.descriptionKind),
      allowNullValue: p.allowNullValue ?? false,
      allowUnknownValues: p.allowUnknownValues ?? false,
    })),
    variadicParameter: sig.variadicParameter
      ? {
          name: sig.variadicParameter.name,
          type: sig.variadicParameter.type.tfType(),
          description: sig.variadicParameter.description ?? "",
          descriptionKind: descKindToPb(sig.variadicParameter.descriptionKind),
          allowNullValue: sig.variadicParameter.allowNullValue ?? false,
          allowUnknownValues: sig.variadicParameter.allowUnknownValues ?? false,
        }
      : undefined,
    return: { type: sig.returnType.type.tfType() },
    summary: sig.summary ?? "",
    description: sig.description ?? "",
    descriptionKind: descKindToPb(sig.descriptionKind),
    deprecationMessage: sig.deprecationMessage ?? "",
  };
}

// ---------------------------------------------------------------------------
// ProviderServicer
// ---------------------------------------------------------------------------

export class ProviderServicer {
  private readonly provider: Provider;

  // Lazy caches
  private resMap: Map<string, ResourceClass> | null = null;
  private dsMap: Map<string, DataSourceClass> | null = null;
  private fnMap: Map<string, FunctionClass> | null = null;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  // ---------------------------------------------------------------------------
  // Cache loaders
  // ---------------------------------------------------------------------------

  private loadResMap(): Map<string, ResourceClass> {
    if (!this.resMap) {
      const prefix = this.provider.getModelPrefix();
      this.resMap = new Map(
        this.provider.getResources().map((cls) => {
          const inst = this.provider.newResource(cls);
          return [`${prefix}_${inst.getName()}`, cls];
        })
      );
    }
    return this.resMap;
  }

  private loadDsMap(): Map<string, DataSourceClass> {
    if (!this.dsMap) {
      const prefix = this.provider.getModelPrefix();
      this.dsMap = new Map(
        this.provider.getDataSources().map((cls) => {
          const inst = this.provider.newDataSource(cls);
          return [`${prefix}_${inst.getName()}`, cls];
        })
      );
    }
    return this.dsMap;
  }

  private getResCls(typeName: string): ResourceClass {
    const cls = this.loadResMap().get(typeName);
    if (!cls) throw new Error(`Unknown resource type: ${typeName}`);
    return cls;
  }

  private getDsCls(typeName: string): DataSourceClass {
    const cls = this.loadDsMap().get(typeName);
    if (!cls) throw new Error(`Unknown data source type: ${typeName}`);
    return cls;
  }

  private resInstance(typeName: string): Resource {
    return this.provider.newResource(this.getResCls(typeName));
  }

  private dsInstance(typeName: string): DataSource {
    return this.provider.newDataSource(this.getDsCls(typeName));
  }

  private loadFnMap(): Map<string, FunctionClass> {
    if (!this.fnMap) {
      this.fnMap = new Map(
        (this.provider.getFunctions?.() ?? []).map((cls) => {
          const inst: TerrablyFunction = this.provider.newFunction
            ? this.provider.newFunction(cls)
            : new cls(this.provider);
          return [inst.getName(), cls];
        })
      );
    }
    return this.fnMap;
  }

  private fnInstance(name: string): TerrablyFunction {
    const cls = this.loadFnMap().get(name);
    if (!cls) throw new Error(`Unknown function: ${name}`);
    return this.provider.newFunction
      ? this.provider.newFunction(cls)
      : new cls(this.provider);
  }

  // ---------------------------------------------------------------------------
  // Capabilities / Metadata
  // ---------------------------------------------------------------------------

  async GetMetadata(
    _req: GetMetadata_Request,
    _ctx: unknown
  ): Promise<DeepPartial<GetMetadata_Response>> {
    const caps: ServerCapabilities = {
      planDestroy: true,
      getProviderSchemaOptional: true,
      moveResourceState: false,
      generateResourceConfig: false,
    };

    const resources = [...this.loadResMap().keys()].map((typeName) => ({ typeName }));
    const dataSources = [...this.loadDsMap().keys()].map((typeName) => ({ typeName }));
    const functions = [...this.loadFnMap().keys()].map((name) => ({ name }));

    return {
      serverCapabilities: caps,
      diagnostics: [],
      resources,
      dataSources,
      functions,
      ephemeralResources: [],
      listResources: [],
      stateStores: [],
      actions: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  async GetProviderSchema(
    _req: GetProviderSchema_Request,
    _ctx: unknown
  ): Promise<DeepPartial<GetProviderSchema_Response>> {
    const diags = new Diagnostics();
    const providerSchema = this.provider.getProviderSchema(diags).toPb();
    const emptyProviderMeta = { version: 0, block: { version: 0, attributes: [], blockTypes: [], description: "", descriptionKind: 0, deprecated: false, deprecationMessage: "", computed: false } };

    const resourceSchemas: Record<string, Schema> = {};
    for (const [typeName, cls] of this.loadResMap()) {
      const inst = this.provider.newResource(cls);
      resourceSchemas[typeName] = inst.getSchema().toPb() as Schema;
    }

    const dataSourceSchemas: Record<string, Schema> = {};
    for (const [typeName, cls] of this.loadDsMap()) {
      const inst = this.provider.newDataSource(cls);
      dataSourceSchemas[typeName] = inst.getSchema().toPb() as Schema;
    }

    const functionSchemas: Record<string, FunctionMessage> = {};
    for (const [name, cls] of this.loadFnMap()) {
      const inst = this.provider.newFunction ? this.provider.newFunction(cls) : new cls(this.provider);
      functionSchemas[name] = signatureToPb(inst.getSignature());
    }

    return {
      provider: providerSchema,
      providerMeta: emptyProviderMeta,
      resourceSchemas,
      dataSourceSchemas,
      functions: functionSchemas,
      ephemeralResourceSchemas: {},
      listResourceSchemas: {},
      stateStoreSchemas: {},
      actionSchemas: {},
      diagnostics: diagsToPb(diags.items),
      serverCapabilities: {
        planDestroy: true,
        getProviderSchemaOptional: true,
        moveResourceState: false,
        generateResourceConfig: false,
      },
    };
  }

  async GetResourceIdentitySchemas(
    _req: GetResourceIdentitySchemas_Request,
    _ctx: unknown
  ): Promise<DeepPartial<GetResourceIdentitySchemas_Response>> {
    return { identitySchemas: {}, diagnostics: [] };
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  async ValidateProviderConfig(
    req: ValidateProviderConfig_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ValidateProviderConfig_Response>> {
    const config = readDynamicValue(req.config!) ?? {};
    const diags = new Diagnostics();
    this.provider.validateConfig(diags, config);
    return { diagnostics: diagsToPb(diags.items) };
  }

  async ValidateResourceConfig(
    req: ValidateResourceConfig_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ValidateResourceConfig_Response>> {
    const diags = new Diagnostics();
    const config = readDynamicValue(req.config!) ?? {};
    const inst = this.resInstance(req.typeName);
    inst.validate?.(diags, req.typeName, config);
    return { diagnostics: diagsToPb(diags.items) };
  }

  async ValidateDataResourceConfig(
    req: ValidateDataResourceConfig_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ValidateDataResourceConfig_Response>> {
    const diags = new Diagnostics();
    const config = readDynamicValue(req.config!) ?? {};
    const inst = this.dsInstance(req.typeName);
    inst.validate?.(diags, req.typeName, config);
    return { diagnostics: diagsToPb(diags.items) };
  }

  // ---------------------------------------------------------------------------
  // State upgrade
  // ---------------------------------------------------------------------------

  async UpgradeResourceState(
    req: UpgradeResourceState_Request,
    _ctx: unknown
  ): Promise<DeepPartial<UpgradeResourceState_Response>> {
    const diags = new Diagnostics();
    let state: State;

    if (req.rawState!.json.length > 0) {
      state = JSON.parse(Buffer.from(req.rawState!.json).toString("utf8"));
    } else {
      diags.addError(
        "UpgradeResourceState with flatmap not supported",
        "Legacy flatmap format is not supported. This is a bug in the provider SDK."
      );
      return { diagnostics: diagsToPb(diags.items) };
    }

    const inst = this.resInstance(req.typeName);
    const schema = inst.getSchema();
    const oldVersion = Number(req.version);
    const newVersion = schema.version;

    if (inst.upgrade && oldVersion < newVersion) {
      state = await inst.upgrade({ diagnostics: diags, typeName: req.typeName }, oldVersion, state);
    }

    return {
      upgradedState: toDynamicValue(state),
      diagnostics: diagsToPb(diags.items),
    };
  }

  async UpgradeResourceIdentity(
    _req: UpgradeResourceIdentity_Request,
    _ctx: unknown
  ): Promise<DeepPartial<UpgradeResourceIdentity_Response>> {
    return { diagnostics: [] };
  }

  // ---------------------------------------------------------------------------
  // Provider configuration
  // ---------------------------------------------------------------------------

  async ConfigureProvider(
    req: ConfigureProvider_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ConfigureProvider_Response>> {
    const config = readDynamicValue(req.config!) ?? {};
    const diags = new Diagnostics();
    await this.provider.configure(diags, config);
    return { diagnostics: diagsToPb(diags.items) };
  }

  // ---------------------------------------------------------------------------
  // Managed resource lifecycle
  // ---------------------------------------------------------------------------

  async ReadResource(
    req: ReadResource_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ReadResource_Response>> {
    const diags = new Diagnostics();
    const inst = this.resInstance(req.typeName);
    const block = inst.getSchema().block;

    const rawCurrent = readDynamicValue(req.currentState!);
    if (rawCurrent === null) {
      diags.addError(`ReadResource ${req.typeName} called with null state`);
      return { diagnostics: diagsToPb(diags.items) };
    }

    const currentState = decodeBlock(block, rawCurrent)!;
    const newState = await inst.read({ diagnostics: diags, typeName: req.typeName }, currentState);

    return {
      newState: toDynamicValue(newState ? encodeBlock(block, newState) : null),
      diagnostics: diagsToPb(diags.items),
    };
  }

  async PlanResourceChange(
    req: PlanResourceChange_Request,
    _ctx: unknown
  ): Promise<DeepPartial<PlanResourceChange_Response>> {
    const diags = new Diagnostics();
    const inst = this.resInstance(req.typeName);
    const schema = inst.getSchema();
    const block = schema.block;
    const attrs = block.attrMap();

    const rawPrior = readDynamicValue(req.priorState!);
    const rawProposed = readDynamicValue(req.proposedNewState!);

    const priorState = rawPrior ? decodeBlock(block, rawPrior) : null;
    const proposedState = rawProposed ? decodeBlock(block, rawProposed) : null;

    // ---- CREATE ----
    if (priorState === null && proposedState !== null) {
      const planned: State = {};
      for (const [k, v] of Object.entries(proposedState)) {
        if (k in attrs) {
          planned[k] = v !== null ? v : (attrs[k].computed ? attrs[k].default ?? Unknown : null);
        } else {
          planned[k] = v;
        }
      }
      return {
        plannedState: toDynamicValue(encodeBlock(block, planned)),
        diagnostics: diagsToPb(diags.items),
      };
    }

    // ---- DELETE (plan_destroy = true means we'll get called here) ----
    if (proposedState === null && priorState !== null) {
      return {
        plannedState: toDynamicValue(null),
        diagnostics: diagsToPb(diags.items),
      };
    }

    // ---- UPDATE ----
    const prior = priorState!;
    const proposed = proposedState!;

    const changedFields = new Set<string>(
      Object.keys(proposed).filter((k) => {
        if (!(k in attrs)) return false;
        return !attrs[k].type.semanticallyEqual(prior[k], proposed[k]);
      })
    );

    const requiresReplace = [...changedFields]
      .filter((k) => k in attrs && attrs[k].requiresReplace)
      .map((k) => ({ steps: [{ attributeName: k }] }));

    const ctx: PlanContext = {
      diagnostics: diags,
      typeName: req.typeName,
      changedFields,
    };

    let plannedState: State;
    if (inst.plan) {
      plannedState = await inst.plan(ctx, { ...prior }, { ...proposed });
    } else {
      plannedState = { ...proposed };
    }

    return {
      plannedState: toDynamicValue(encodeBlock(block, plannedState)),
      requiresReplace,
      diagnostics: diagsToPb(diags.items),
    };
  }

  async ApplyResourceChange(
    req: ApplyResourceChange_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ApplyResourceChange_Response>> {
    const diags = new Diagnostics();
    const inst = this.resInstance(req.typeName);
    const block = inst.getSchema().block;

    const rawPrior = readDynamicValue(req.priorState!);
    const rawPlanned = readDynamicValue(req.plannedState!);

    const priorState = rawPrior ? decodeBlock(block, rawPrior) : null;
    const plannedState = rawPlanned ? decodeBlock(block, rawPlanned) : null;

    let newState: State | null;

    if (priorState === null && plannedState !== null) {
      // CREATE
      newState = await inst.create(
        { diagnostics: diags, typeName: req.typeName },
        plannedState
      );
    } else if (priorState !== null && plannedState === null) {
      // DELETE
      await inst.delete({ diagnostics: diags, typeName: req.typeName }, priorState);
      newState = null;
    } else if (priorState !== null && plannedState !== null) {
      // UPDATE
      const changedFields = new Set(
        Object.keys(plannedState).filter(
          (k) => JSON.stringify(priorState[k]) !== JSON.stringify(plannedState[k])
        )
      );
      newState = await inst.update(
        { diagnostics: diags, typeName: req.typeName, changedFields },
        priorState,
        plannedState
      );
    } else {
      diags.addError("Both prior and planned states are null — this is a Terraform bug");
      return { diagnostics: diagsToPb(diags.items) };
    }

    return {
      newState: toDynamicValue(newState ? encodeBlock(block, newState) : null),
      diagnostics: diagsToPb(diags.items),
    };
  }

  async ImportResourceState(
    req: ImportResourceState_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ImportResourceState_Response>> {
    const diags = new Diagnostics();
    const inst = this.resInstance(req.typeName);

    if (!inst.import) {
      diags.addError(
        `${req.typeName} does not support import`,
        `Resource ${req.typeName} has not implemented import()`
      );
      return { diagnostics: diagsToPb(diags.items) };
    }

    const block = inst.getSchema().block;
    const state = await inst.import({ diagnostics: diags, typeName: req.typeName }, req.id);

    if (diags.hasErrors() || state === null) {
      return { diagnostics: diagsToPb(diags.items) };
    }

    const imported: ImportResourceState_ImportedResource = {
      typeName: req.typeName,
      state: toDynamicValue(encodeBlock(block, state)),
      private: new Uint8Array(),
      identity: undefined,
    };

    return {
      importedResources: [imported],
      diagnostics: diagsToPb(diags.items),
    };
  }

  async MoveResourceState(
    _req: MoveResourceState_Request,
    _ctx: unknown
  ): Promise<DeepPartial<MoveResourceState_Response>> {
    return errorResponse("MoveResourceState is not implemented");
  }

  async GenerateResourceConfig(
    _req: GenerateResourceConfig_Request,
    _ctx: unknown
  ): Promise<DeepPartial<GenerateResourceConfig_Response>> {
    return errorResponse("GenerateResourceConfig is not implemented");
  }

  // ---------------------------------------------------------------------------
  // Data sources
  // ---------------------------------------------------------------------------

  async ReadDataSource(
    req: ReadDataSource_Request,
    _ctx: unknown
  ): Promise<DeepPartial<ReadDataSource_Response>> {
    const diags = new Diagnostics();
    const inst = this.dsInstance(req.typeName);
    const block = inst.getSchema().block;
    const rawConfig = readDynamicValue(req.config!) ?? {};
    const config = decodeBlock(block, rawConfig) ?? {};
    const state = await inst.read({ diagnostics: diags, typeName: req.typeName }, config);
    return {
      state: toDynamicValue(state ? encodeBlock(block, state) : null),
      diagnostics: diagsToPb(diags.items),
    };
  }

  // ---------------------------------------------------------------------------
  // Functions (stub — not yet implemented)
  // ---------------------------------------------------------------------------

  async GetFunctions(_req: GetFunctions_Request, _ctx: unknown): Promise<DeepPartial<GetFunctions_Response>> {
    const functions: Record<string, FunctionMessage> = {};
    for (const [name, cls] of this.loadFnMap()) {
      const inst = this.provider.newFunction ? this.provider.newFunction(cls) : new cls(this.provider);
      functions[name] = signatureToPb(inst.getSignature());
    }
    return { functions, diagnostics: [] };
  }

  async CallFunction(req: CallFunction_Request, _ctx: unknown): Promise<DeepPartial<CallFunction_Response>> {
    const diags = new Diagnostics();
    let inst: TerrablyFunction;
    try {
      inst = this.fnInstance(req.name);
    } catch {
      return { error: { text: `Function '${req.name}' not found`, functionArgument: undefined } };
    }

    const sig = inst.getSignature();

    // Validate argument count
    const minArgs = sig.parameters.length;
    const maxArgs = sig.variadicParameter ? Infinity : minArgs;
    if (req.arguments.length < minArgs) {
      return { error: { text: `Too few arguments for '${req.name}': expected ${minArgs}, got ${req.arguments.length}`, functionArgument: undefined } };
    }
    if (req.arguments.length > maxArgs) {
      return { error: { text: `Too many arguments for '${req.name}': expected ${minArgs}, got ${req.arguments.length}`, functionArgument: req.arguments.length - 1 } };
    }

    // Decode arguments
    const decoded: unknown[] = [];
    for (let i = 0; i < req.arguments.length; i++) {
      const raw = readDynamicValue(req.arguments[i]);
      const param = i < sig.parameters.length ? sig.parameters[i] : sig.variadicParameter!;
      decoded.push(param.type.decode(raw));
    }

    // Call
    let result: unknown;
    try {
      result = await inst.call({ diagnostics: diags, functionName: req.name }, decoded);
    } catch (err) {
      return { error: { text: `Function execution error: ${String(err)}`, functionArgument: undefined } };
    }

    if (diags.hasErrors()) {
      const first = diags.items.find((d) => d.severity === "error")!;
      return { error: { text: first.summary, functionArgument: undefined } };
    }

    const encoded = sig.returnType.type.encode(result) as Record<string, unknown> | null;
    return { result: toDynamicValue(encoded), error: undefined };
  }

  // ---------------------------------------------------------------------------
  // Ephemeral resources (stubs)
  // ---------------------------------------------------------------------------

  async ValidateEphemeralResourceConfig(_req: unknown, _ctx: unknown): Promise<DeepPartial<ValidateEphemeralResourceConfig_Response>> {
    return errorResponse("Ephemeral resources not supported");
  }

  async OpenEphemeralResource(_req: unknown, _ctx: unknown): Promise<DeepPartial<OpenEphemeralResource_Response>> {
    return errorResponse("Ephemeral resources not supported");
  }

  async RenewEphemeralResource(_req: unknown, _ctx: unknown): Promise<DeepPartial<RenewEphemeralResource_Response>> {
    return errorResponse("Ephemeral resources not supported");
  }

  async CloseEphemeralResource(_req: unknown, _ctx: unknown): Promise<DeepPartial<CloseEphemeralResource_Response>> {
    return errorResponse("Ephemeral resources not supported");
  }

  // ---------------------------------------------------------------------------
  // List resources (stubs)
  // ---------------------------------------------------------------------------

  async *ListResource(_req: ListResource_Request, _ctx: unknown): AsyncIterable<DeepPartial<ListResource_Event>> {
    // No-op stream
  }

  async ValidateListResourceConfig(_req: unknown, _ctx: unknown): Promise<DeepPartial<ValidateListResourceConfig_Response>> {
    return { diagnostics: [] };
  }

  // ---------------------------------------------------------------------------
  // State stores (stubs)
  // ---------------------------------------------------------------------------

  async ValidateStateStoreConfig(_req: unknown, _ctx: unknown): Promise<DeepPartial<ValidateStateStore_Response>> {
    return errorResponse("State stores not supported");
  }

  async ConfigureStateStore(_req: unknown, _ctx: unknown): Promise<DeepPartial<ConfigureStateStore_Response>> {
    return errorResponse("State stores not supported");
  }

  async *ReadStateBytes(_req: ReadStateBytes_Request, _ctx: unknown): AsyncIterable<DeepPartial<ReadStateBytes_Response>> {}

  async WriteStateBytes(_req: AsyncIterable<WriteStateBytes_RequestChunk>, _ctx: unknown): Promise<DeepPartial<WriteStateBytes_Response>> {
    return errorResponse("State stores not supported");
  }

  async LockState(_req: unknown, _ctx: unknown): Promise<DeepPartial<LockState_Response>> {
    return errorResponse("State stores not supported");
  }

  async UnlockState(_req: unknown, _ctx: unknown): Promise<DeepPartial<UnlockState_Response>> {
    return errorResponse("State stores not supported");
  }

  async GetStates(_req: unknown, _ctx: unknown): Promise<DeepPartial<GetStates_Response>> {
    return errorResponse("State stores not supported");
  }

  async DeleteState(_req: unknown, _ctx: unknown): Promise<DeepPartial<DeleteState_Response>> {
    return errorResponse("State stores not supported");
  }

  // ---------------------------------------------------------------------------
  // Actions (stubs)
  // ---------------------------------------------------------------------------

  async PlanAction(_req: unknown, _ctx: unknown): Promise<DeepPartial<PlanAction_Response>> {
    return errorResponse("Actions not supported");
  }

  async *InvokeAction(_req: InvokeAction_Request, _ctx: unknown): AsyncIterable<DeepPartial<InvokeAction_Event>> {}

  async ValidateActionConfig(_req: unknown, _ctx: unknown): Promise<DeepPartial<ValidateActionConfig_Response>> {
    return errorResponse("Actions not supported");
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async StopProvider(_req: unknown, _ctx: unknown): Promise<DeepPartial<StopProvider_Response>> {
    return { Error: "" };
  }
}
