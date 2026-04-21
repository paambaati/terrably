// Public API surface of @tfjs/sdk
export { serve } from "./serve.js";
export type { ServeOptions } from "./serve.js";

export { ProviderServicer } from "./servicer.js";

export { Schema, Attribute, NestedBlock, Block } from "./schema.js";
export type { State, AttributeOptions, NestedBlockOptions, BlockOptions, NestMode, DescriptionKind } from "./schema.js";

export type {
  Provider,
  Resource,
  DataSource,
  ResourceClass,
  DataSourceClass,
  BaseContext,
  CreateContext,
  ReadContext,
  UpdateContext,
  DeleteContext,
  PlanContext,
  ImportContext,
  UpgradeContext,
  ReadDataContext,
  DiagnosticItem,
} from "./interfaces.js";
export { Diagnostics } from "./interfaces.js";

export { Unknown } from "./types.js";
export type { TfType, TfValue, UnknownType } from "./types.js";
export {
  TfString,
  TfNumber,
  TfBool,
  TfNormalizedJson,
  TfList,
  TfSet,
  TfMap,
  types,
} from "./types.js";

export { readDynamicValue, toDynamicValue, diagsToPb } from "./encoding.js";
