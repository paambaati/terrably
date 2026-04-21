/**
 * DummyCloud Terraform provider.
 *
 * Provider schema:
 *   api_url (string, optional) - base URL of DummyCloud API.
 *                                Defaults to http://127.0.0.1:8765
 */

import {
  types,
  Attribute,
  Schema,
  Diagnostics,
} from "@tfjs/sdk";
import type { Provider, Resource, DataSource, ResourceClass, DataSourceClass, State } from "@tfjs/sdk";
import { DummyCloudServer } from "./resources/server.js";

export class DummyCloudProvider implements Provider {
  /** Filled in by configure() after Terraform applies provider config. */
  apiUrl = "http://127.0.0.1:8765";

  getFullName(): string {
    return "registry.terraform.io/example/dummycloud";
  }

  getModelPrefix(): string {
    return "dummycloud";
  }

  getProviderSchema(_diags: Diagnostics): Schema {
    return new Schema(
      [
        new Attribute("api_url", types.string(), { optional: true }),
      ],
      [],
      1
    );
  }

  validateConfig(_diags: Diagnostics, _config: State): void {
    // Nothing to validate
  }

  configure(_diags: Diagnostics, config: State): void {
    if (typeof config["api_url"] === "string") {
      this.apiUrl = config["api_url"];
    }
  }

  getResources(): ResourceClass[] {
    return [DummyCloudServer];
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

