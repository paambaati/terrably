import { types, Attribute, Schema } from "@tfjs/sdk";
import type {
  Resource,
  Provider,
  CreateContext,
  ReadContext,
  UpdateContext,
  DeleteContext,
  State,
} from "@tfjs/sdk";

/**
 * example_item resource.
 *
 * A minimal resource that stores a name and derives a computed id from it.
 * Replace this with real API calls once you have an actual backend.
 */
export class ExampleItem implements Resource {
  constructor(_provider: Provider) {}

  getName(): string {
    // Terraform resource type = getModelPrefix() + "_" + getName()
    // e.g. "example_item"
    return "item";
  }

  getSchema(): Schema {
    return new Schema([
      new Attribute("id",   types.string(), { computed: true }),
      new Attribute("name", types.string(), { required: true }),
    ]);
  }

  async create(_ctx: CreateContext, planned: State): Promise<State> {
    // Called on `terraform apply` for a new resource.
    // Return the full state that should be stored.
    return {
      id:   `item-${planned["name"]}`,
      name: planned["name"],
    };
  }

  async read(_ctx: ReadContext, current: State): Promise<State | null> {
    // Called during `terraform refresh` / plan.
    // Return null if the resource no longer exists.
    return current;
  }

  async update(_ctx: UpdateContext, _prior: State, planned: State): Promise<State> {
    // Called when in-place update is possible (no requiresReplace attributes changed).
    return {
      id:   `item-${planned["name"]}`,
      name: planned["name"],
    };
  }

  async delete(_ctx: DeleteContext, _current: State): Promise<void> {
    // Called on `terraform destroy` or when the resource is removed from config.
  }
}
