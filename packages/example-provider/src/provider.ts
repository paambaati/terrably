import { types, Attribute, Schema, Diagnostics } from "terrably";
import type {
  Provider,
  Resource,
  DataSource,
  ResourceClass,
  DataSourceClass,
  State,
} from "terrably";
import { ExampleItem } from "./resources/item.js";

export class ExampleProvider implements Provider {
  getFullName(): string {
    // Must match the `source` field in your Terraform required_providers block.
    // Format: <hostname>/<namespace>/<type>
    return "registry.terraform.io/example/example";
  }

  getModelPrefix(): string {
    // Prefix used to derive resource/data-source type names.
    // e.g. "example" → resource "example_item"
    return "example";
  }

  getProviderSchema(_diags: Diagnostics): Schema {
    // Declare provider-level configuration attributes here.
    // Return an empty Schema if the provider needs no configuration.
    return new Schema([
      new Attribute("api_url", types.string(), { optional: true }),
    ]);
  }

  validateConfig(_diags: Diagnostics, _config: State): void {
    // Validate the provider configuration before any resources are managed.
  }

  configure(_diags: Diagnostics, _config: State): void {
    // Apply the provider configuration (e.g. store api_url for later use).
  }

  getResources(): ResourceClass[] {
    return [ExampleItem];
  }

  getDataSources(): DataSourceClass[] {
    return [];
  }

  newResource(cls: ResourceClass): Resource {
    return new cls(this);
  }

  newDataSource(cls: DataSourceClass): DataSource {
    return new cls(this);
  }
}
