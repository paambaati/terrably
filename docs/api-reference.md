# @tfjs/sdk — API Reference

Complete reference for every public export from `@tfjs/sdk`.

---

## Table of contents

1. [Types — `TfType` system](#types)
2. [Schema — `Attribute`, `Block`, `NestedBlock`, `Schema`](#schema)
3. [Interfaces — `Provider`, `Resource`, `DataSource`](#interfaces)
4. [Context objects](#context-objects)
5. [Diagnostics](#diagnostics)
6. [State](#state)
7. [Unknown sentinel](#unknown-sentinel)
8. [`serve()`](#serve)

---

## Types

Every attribute in a schema requires a `TfType`. Types are created via the `types` factory (each call returns a fresh instance):

```typescript
import { types } from "@tfjs/sdk";
```

| Factory call | Terraform type | TypeScript type |
|---|---|---|
| `types.string()` | `string` | `string` |
| `types.number()` | `number` | `number` |
| `types.bool()` | `bool` | `boolean` |
| `types.normalizedJson()` | `string` (JSON round-tripped) | `unknown` |
| `types.list(elementType)` | `list(T)` | `T[]` |
| `types.set(elementType)` | `set(T)` | `T[]` |
| `types.map(elementType)` | `map(T)` | `Record<string, T>` |

**Examples:**

```typescript
types.string()                      // string
types.number()                      // number
types.list(types.string())          // list of strings
types.map(types.number())           // map of numbers
types.set(types.string())           // set of strings
types.list(types.map(types.bool())) // list of maps of booleans
```

> **`normalizedJson`** stores arbitrary JSON as a Terraform string. The value is round-tripped through `JSON.parse`/`JSON.stringify` with sorted keys, so Terraform never generates spurious diffs from key reordering.

### `TfType<T>` interface

You can define custom types by implementing this interface:

```typescript
interface TfType<T = unknown> {
  encode(value: T | null | UnknownType): unknown;
  decode(value: unknown): T | null | UnknownType;
  semanticallyEqual(a: T | null, b: T | null): boolean;
  tfType(): Uint8Array; // JSON bytes, e.g. Buffer.from('"string"')
}
```

---

## Schema

### `Attribute`

Describes a single attribute in a resource or provider schema.

```typescript
import { Attribute, types } from "@tfjs/sdk";

new Attribute(name: string, type: TfType, options?: AttributeOptions)
```

#### `AttributeOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `required` | `boolean` | `false` | User must set this attribute |
| `optional` | `boolean` | `false` | User may set this attribute |
| `computed` | `boolean` | `false` | Provider sets this (read-only from user perspective) |
| `sensitive` | `boolean` | `false` | Value is redacted in plan output |
| `requiresReplace` | `boolean` | `false` | Changing this attribute destroys and recreates the resource |
| `description` | `string` | `""` | Shown in `terraform providers schema` |
| `descriptionKind` | `"plain"` \| `"markdown"` | `"markdown"` | Format of description |
| `deprecated` | `boolean` | `false` | Shows deprecation warning |
| `deprecationMessage` | `string` | `""` | Custom deprecation text |
| `default` | `unknown` | `undefined` | Default value used during planning |

Attributes can be combined (e.g. `optional: true, computed: true` means the user can set it or let the provider compute it).

**Examples:**

```typescript
// Required input
new Attribute("name", types.string(), { required: true })

// Server-assigned, read-only
new Attribute("id", types.string(), { computed: true })

// User may set; if not set, provider fills in a default
new Attribute("size", types.string(), { optional: true, computed: true, default: "small" })

// Sensitive — masked in plan output
new Attribute("token", types.string(), { required: true, sensitive: true })

// Force-replace when this changes
new Attribute("region", types.string(), { required: true, requiresReplace: true })
```

---

### `Block`

Groups a set of attributes and nested blocks. Rarely constructed directly — `Schema` builds one for you.

```typescript
import { Block } from "@tfjs/sdk";

new Block(
  attributes: Attribute[] = [],
  blockTypes: NestedBlock[] = [],
  options?: BlockOptions
)
```

---

### `NestedBlock`

Represents a block that can appear multiple times (like a list of `network_interface` blocks).

```typescript
import { NestedBlock, Block, Attribute, types } from "@tfjs/sdk";

new NestedBlock(
  typeName: string,
  nestingMode: NestMode,
  block: Block,
  options?: NestedBlockOptions
)
```

| `NestMode` value | Terraform equivalent |
|---|---|
| `"single"` | At most one block |
| `"list"` | Ordered list of blocks |
| `"set"` | Unordered set of blocks |
| `"map"` | Map of blocks keyed by a label |
| `"group"` | Exactly one block (implicit) |

**Example — resource with a `tags` nested block:**

```typescript
import { Schema, Attribute, Block, NestedBlock, types } from "@tfjs/sdk";

new Schema([
  new Attribute("id",   types.string(), { computed: true }),
  new Attribute("name", types.string(), { required: true }),
], [
  new NestedBlock("tags", "set", new Block([
    new Attribute("key",   types.string(), { required: true }),
    new Attribute("value", types.string(), { required: true }),
  ]), { minItems: 0, maxItems: 10 }),
])
```

---

### `Schema`

Top-level schema for a resource, data source, or provider.

```typescript
import { Schema } from "@tfjs/sdk";

new Schema(
  attributes: Attribute[] = [],
  blockTypes: NestedBlock[] = [],
  version: number = 0
)
```

`version` should be incremented when breaking schema changes are made and you implement `upgrade()` to migrate old state. Start at `0`; increment when you rename or remove attributes.

---

## Interfaces

### `Provider`

```typescript
interface Provider {
  // Terraform registry identifier, e.g. "registry.terraform.io/myorg/mycloud"
  getFullName(): string;

  // Prefix for all resource/datasource type names, e.g. "mycloud"
  // Resource named "server" → Terraform type "mycloud_server"
  getModelPrefix(): string;

  // Return the schema for provider-level configuration block
  getProviderSchema(diags: Diagnostics): Schema;

  // Optional: validate provider config before configure() is called
  validateConfig(diags: Diagnostics, config: State): void;

  // Called once with the resolved provider config; store credentials etc. here
  configure(diags: Diagnostics, config: State): void | Promise<void>;

  // Return the list of resource classes this provider manages
  getResources(): ResourceClass[];

  // Return the list of data source classes
  getDataSources(): DataSourceClass[];

  // Factory methods — typically just `new cls(this)`
  newResource(cls: ResourceClass): Resource;
  newDataSource(cls: DataSourceClass): DataSource;
}
```

### `Resource`

```typescript
interface Resource {
  // Short type name, e.g. "server" → "mycloud_server"
  getName(): string;

  // Schema for this resource's attributes
  getSchema(): Schema;

  // --- Lifecycle methods (all may be async) ---

  // Called during terraform apply when creating a new resource.
  // `planned` is the user's config with computed fields set to Unknown.
  // Return the full new state including all computed fields.
  create(ctx: CreateContext, planned: State): State | Promise<State>;

  // Called during terraform refresh and before plan/apply to check drift.
  // Return null if the resource no longer exists (triggers recreation on next apply).
  read(ctx: ReadContext, current: State): State | null | Promise<State | null>;

  // Called during terraform apply when updating an existing resource.
  // `prior` is the current state; `planned` is the desired state.
  update(ctx: UpdateContext, prior: State, planned: State): State | Promise<State>;

  // Called during terraform destroy.
  delete(ctx: DeleteContext, current: State): void | Promise<void>;

  // --- Optional methods ---

  // Custom validation during terraform validate / plan.
  validate?(diags: Diagnostics, typeName: string, config: State): void;

  // Override default plan behaviour (return modified planned state).
  plan?(ctx: PlanContext, prior: State | null, planned: State): State | Promise<State>;

  // Support for `terraform import`. Return state matching the given ID, or null.
  import?(ctx: ImportContext, id: string): State | null | Promise<State | null>;

  // State schema migration — called when stored state version < current schema version.
  upgrade?(ctx: UpgradeContext, version: number, old: State): State | Promise<State>;
}

// Constructor signature — the provider is always injected
type ResourceClass = new (provider: Provider) => Resource;
```

### `DataSource`

```typescript
interface DataSource {
  getName(): string;       // e.g. "regions" → "mycloud_regions"
  getSchema(): Schema;

  validate?(diags: Diagnostics, typeName: string, config: State): void;

  // Called during terraform plan. Return the fetched data or null.
  read(ctx: ReadDataContext, config: State): State | null | Promise<State | null>;
}

type DataSourceClass = new (provider: Provider) => DataSource;
```

---

## Context objects

Every lifecycle method receives a context as its first argument.

### `BaseContext`

```typescript
interface BaseContext {
  readonly diagnostics: Diagnostics; // Add errors/warnings here
  readonly typeName: string;         // Full type name, e.g. "mycloud_server"
}
```

### `CreateContext`, `ReadContext`, `DeleteContext`, `ImportContext`, `UpgradeContext`, `ReadDataContext`

Extend `BaseContext` with no extra fields.

### `UpdateContext`

```typescript
interface UpdateContext extends BaseContext {
  readonly changedFields: Set<string>; // Attribute names that differ between prior and planned
}
```

### `PlanContext`

```typescript
interface PlanContext extends BaseContext {
  readonly changedFields: Set<string>;
}
```

---

## Diagnostics

```typescript
class Diagnostics {
  // Add an error. Terraform will abort the operation and display it.
  addError(summary: string, detail?: string, path?: string[]): this;

  // Add a warning. Terraform shows it but continues.
  addWarning(summary: string, detail?: string, path?: string[]): this;

  hasErrors(): boolean;

  readonly items: DiagnosticItem[];
}
```

`path` is an optional list of attribute names pointing to the problematic field, e.g. `["network_interface", "ip_address"]`. Terraform uses this to highlight the exact attribute in plan output.

**Pattern — validate required fields:**

```typescript
validateConfig(diags: Diagnostics, config: State): void {
  if (!config["token"]) {
    diags.addError(
      "Missing required attribute",
      'Set `token` or the MYCLOUD_TOKEN environment variable.',
      ["token"]
    );
  }
}
```

---

## State

```typescript
type State = Record<string, unknown>;
```

State is a plain JavaScript object whose keys match attribute names in your schema. Values are decoded from Terraform's msgpack wire format before reaching your code, and encoded back after you return.

| Terraform type | JavaScript value |
|---|---|
| `string` | `string` |
| `number` | `number` |
| `bool` | `boolean` |
| `list(T)` | `T[]` |
| `set(T)` | `T[]` |
| `map(T)` | `Record<string, T>` |
| not-yet-known | `Unknown` sentinel |
| null / absent | `null` |

---

## Unknown sentinel

```typescript
import { Unknown } from "@tfjs/sdk";
```

`Unknown` is a singleton that represents a Terraform value that is not yet known at plan time (displayed as `(known after apply)`). The framework automatically sets computed attributes to `Unknown` during planning. You can also use it explicitly in `plan()` to mark attributes that will be determined only after an API call:

```typescript
plan(ctx: PlanContext, _prior: State | null, planned: State): State {
  return {
    ...planned,
    ip_address: Unknown, // will be set by the API on create
  };
}
```

---

## `serve()`

Start the gRPC server and perform the go-plugin handshake with Terraform.

```typescript
import { serve } from "@tfjs/sdk";

serve(provider: Provider, opts?: ServeOptions): Promise<void>
```

### `ServeOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `socketPath` | `string` | auto-generated temp path | Unix socket path to listen on |
| `dev` | `boolean` | `false` | Dev mode: insecure socket, prints `TF_REATTACH_PROVIDERS` to stdout |

### Normal mode (Terraform manages the process)

Terraform sets `TF_PLUGIN_MAGIC_COOKIE` before spawning your binary. The process must print the handshake line on stdout and then block until Terraform is done.

```typescript
serve(new MyProvider());
```

The SDK validates the magic cookie, generates a self-signed TLS certificate (cached at `~/.cache/tf-js-provider/ssl_cert.json` for 7 days), starts the server, and prints the handshake.

### Dev mode (you manage the process)

Set `dev: true` or `TF_PLUGIN_DEBUG=1`. The server uses an insecure socket and prints a `TF_REATTACH_PROVIDERS` line instead of the handshake. Copy the export command into your shell and then run Terraform normally.

```typescript
serve(new MyProvider(), { dev: true });
// stdout: Dev mode — set this env var:
//         export TF_REATTACH_PROVIDERS='{"registry.terraform.io/myorg/mycloud":{"Protocol":"grpc",...}}'
```

### Environment variables

| Variable | Effect |
|---|---|
| `TF_PLUGIN_MAGIC_COOKIE` | **Must** equal the Terraform magic value; validated on startup |
| `TF_PLUGIN_DEBUG` | `"1"` enables verbose stderr logging and dev mode |
