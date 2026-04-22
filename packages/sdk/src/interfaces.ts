import type { Schema, DescriptionKind } from "./schema.js";
import type { State } from "./schema.js";
import type { TfType } from "./types.js";

// ---------------------------------------------------------------------------
// Context objects passed to resource/data-source handlers
// ---------------------------------------------------------------------------

export class Diagnostics {
  readonly items: DiagnosticItem[] = [];

  addError(summary: string, detail = "", path: string[] = []): this {
    this.items.push({ severity: "error", summary, detail, path });
    return this;
  }

  addWarning(summary: string, detail = "", path: string[] = []): this {
    this.items.push({ severity: "warning", summary, detail, path });
    return this;
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

export interface DiagnosticItem {
  severity: "error" | "warning";
  summary: string;
  detail: string;
  path: string[];
}

export interface BaseContext {
  readonly diagnostics: Diagnostics;
  readonly typeName: string;
}

export interface CreateContext extends BaseContext {}
export interface ReadContext extends BaseContext {}
export interface UpdateContext extends BaseContext {
  readonly changedFields: Set<string>;
}
export interface DeleteContext extends BaseContext {}
export interface PlanContext extends BaseContext {
  readonly changedFields: Set<string>;
}
export interface ImportContext extends BaseContext {}
export interface UpgradeContext extends BaseContext {}
export interface ReadDataContext extends BaseContext {}

// ---------------------------------------------------------------------------
// Resource interface
// ---------------------------------------------------------------------------

export interface Resource {
  /** Static: type name suffix, e.g. "server". Combined with provider prefix → "mycloud_server". */
  getName(): string;
  /** Static: schema definition. */
  getSchema(): Schema;

  validate?(diags: Diagnostics, typeName: string, config: State): void;

  create(ctx: CreateContext, planned: State): State | Promise<State>;
  read(ctx: ReadContext, current: State): State | null | Promise<State | null>;
  update(ctx: UpdateContext, current: State, planned: State): State | Promise<State>;
  delete(ctx: DeleteContext, current: State): void | Promise<void>;

  /** Optional: custom planning logic. Default: return planned unchanged. */
  plan?(ctx: PlanContext, current: State | null, planned: State): State | Promise<State>;

  /** Optional: import by ID. */
  import?(ctx: ImportContext, id: string): State | null | Promise<State | null>;

  /** Optional: upgrade old state to the current schema version. */
  upgrade?(ctx: UpgradeContext, version: number, old: State): State | Promise<State>;
}

export type ResourceClass = new (provider: Provider) => Resource;

// ---------------------------------------------------------------------------
// DataSource interface
// ---------------------------------------------------------------------------

export interface DataSource {
  getName(): string;
  getSchema(): Schema;

  validate?(diags: Diagnostics, typeName: string, config: State): void;
  read(ctx: ReadDataContext, config: State): State | null | Promise<State | null>;
}

export type DataSourceClass = new (provider: Provider) => DataSource;

// ---------------------------------------------------------------------------
// Provider-defined functions (Terraform >= 1.8)
// ---------------------------------------------------------------------------

export interface FunctionCallContext {
  readonly diagnostics: Diagnostics;
  readonly functionName: string;
}

export interface FunctionParameter {
  name: string;
  type: TfType;
  description?: string;
  descriptionKind?: DescriptionKind;
  /** When true, null may be passed as an argument value. Default: false. */
  allowNullValue?: boolean;
  /**
   * When true, unknown values may be passed. When false (default), Terraform
   * skips the call entirely and treats the result as unknown.
   */
  allowUnknownValues?: boolean;
}

export interface FunctionReturn {
  type: TfType;
}

export interface FunctionSignature {
  parameters: FunctionParameter[];
  returnType: FunctionReturn;
  /** Optional final parameter that accepts zero or more additional arguments of the same type. */
  variadicParameter?: FunctionParameter;
  summary?: string;
  description?: string;
  descriptionKind?: DescriptionKind;
  deprecationMessage?: string;
}

export interface TerrablyFunction {
  getName(): string;
  getSignature(): FunctionSignature;
  call(ctx: FunctionCallContext, args: unknown[]): unknown | Promise<unknown>;
}

export type FunctionClass = new (provider: Provider) => TerrablyFunction;

export interface Provider {
  /** Registry prefix, e.g. "mycloud_". All resource/datasource names are prefixed with this. */
  getModelPrefix(): string;

  /** Full registry name, e.g. "registry.terraform.io/example/mycloud". */
  getFullName(): string;

  getProviderSchema(diags: Diagnostics): Schema;
  validateConfig(diags: Diagnostics, config: State): void;
  configure(diags: Diagnostics, config: State): void | Promise<void>;

  getResources(): ResourceClass[];
  getDataSources(): DataSourceClass[];
  /** Return all function types this provider exposes. Default: [] */
  getFunctions?(): FunctionClass[];

  newResource(cls: ResourceClass): Resource;
  newDataSource(cls: DataSourceClass): DataSource;
  /** Instantiate a function. Default: new cls(this). */
  newFunction?(cls: FunctionClass): TerrablyFunction;
}
