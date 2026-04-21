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
} from "../gen/tfplugin6.js";
import {
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
  ServerCapabilities,
  Diagnostic_Severity,
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

import type { Provider, Resource, DataSource, ResourceClass, DataSourceClass } from "./interfaces.js";
import { Diagnostics } from "./interfaces.js";
import { readDynamicValue, toDynamicValue, diagsToPb } from "./encoding.js";
import { encodeBlock, decodeBlock, type State } from "./schema.js";
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

// ---------------------------------------------------------------------------
// ProviderServicer
// ---------------------------------------------------------------------------

export class ProviderServicer {
  private readonly provider: Provider;

  // Lazy caches
  private resMap: Map<string, ResourceClass> | null = null;
  private dsMap: Map<string, DataSourceClass> | null = null;

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

    return {
      serverCapabilities: caps,
      diagnostics: [],
      resources,
      dataSources,
      functions: [],
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

    return {
      provider: providerSchema,
      providerMeta: emptyProviderMeta,
      resourceSchemas,
      dataSourceSchemas,
      functions: {},
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

    const ctx: import("./interfaces.js").PlanContext = {
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
    const config = readDynamicValue(req.config!) ?? {};
    const state = await inst.read({ diagnostics: diags, typeName: req.typeName }, config);
    return {
      state: toDynamicValue(state ?? null),
      diagnostics: diagsToPb(diags.items),
    };
  }

  // ---------------------------------------------------------------------------
  // Functions (stub — not yet implemented)
  // ---------------------------------------------------------------------------

  async GetFunctions(_req: GetFunctions_Request, _ctx: unknown): Promise<DeepPartial<GetFunctions_Response>> {
    return { functions: {}, diagnostics: [] };
  }

  async CallFunction(_req: CallFunction_Request, _ctx: unknown): Promise<DeepPartial<CallFunction_Response>> {
    return { error: { text: "Functions not implemented", functionArgument: undefined } };
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
