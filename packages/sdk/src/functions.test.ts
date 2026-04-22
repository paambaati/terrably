/**
 * Unit tests for provider-defined functions.
 *
 * Tests cover:
 *   - GetFunctions returns correct schema (parameters, return type, variadic)
 *   - CallFunction dispatches to the right function instance
 *   - Positional arguments decoded per parameter type
 *   - Variadic arguments decoded with the variadic parameter type
 *   - Arity validation: too few / too many arguments
 *   - Error diagnostic from call() surfaces as FunctionError
 *   - Exception thrown from call() surfaces as FunctionError
 *   - Return value encoded correctly
 *   - Provider with no getFunctions() → empty maps
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderServicer } from "./servicer.js";
import { toDynamicValue, readDynamicValue } from "./encoding.js";
import { Schema, Attribute } from "./schema.js";
import { types } from "./types.js";
import { Diagnostics } from "./interfaces.js";
import type { DynamicValue } from "../gen/tfplugin6.js";
import type {
  Provider,
  ResourceClass,
  DataSourceClass,
  FunctionClass,
  TerrablyFunction,
  FunctionSignature,
  FunctionCallContext,
} from "./interfaces.js";

// Suppress unused import lint — Attribute and Diagnostics used implicitly via Provider stub
void Attribute;
void Diagnostics;

// ---------------------------------------------------------------------------
// Minimal stub provider
// ---------------------------------------------------------------------------

function makeProvider(functionClasses: FunctionClass[] = []): Provider {
  return {
    getFullName:       () => "registry.terraform.io/test/stub",
    getModelPrefix:    () => "stub",
    getProviderSchema: (_diags) => new Schema([]),
    validateConfig:    (_diags, _config) => {},
    configure:         (_diags, _config) => {},
    getResources:      (): ResourceClass[] => [],
    getDataSources:    (): DataSourceClass[] => [],
    getFunctions:      () => functionClasses,
    newResource:       (cls) => new cls({} as Provider),
    newDataSource:     (cls) => new cls({} as Provider),
  };
}

/** Build a DynamicValue wrapping a raw decoded value (already the final JS value). */
function dv(value: unknown): DynamicValue {
  return toDynamicValue(value as Record<string, unknown> | null) as unknown as DynamicValue;
}

// ---------------------------------------------------------------------------
// Fixture functions
// ---------------------------------------------------------------------------

/**
 * uppercase(input: string) → string
 * Converts a string to uppercase.
 */
class UppercaseFunction implements TerrablyFunction {
  constructor(_provider: Provider) {}

  getName() { return "uppercase"; }

  getSignature(): FunctionSignature {
    return {
      parameters: [{ name: "input", type: types.string(), description: "String to uppercase" }],
      returnType: { type: types.string() },
      summary: "Convert a string to uppercase",
    };
  }

  call(_ctx: FunctionCallContext, args: unknown[]): unknown {
    return String(args[0]).toUpperCase();
  }
}

/**
 * add(a: number, b: number) → number
 */
class AddFunction implements TerrablyFunction {
  constructor(_provider: Provider) {}

  getName() { return "add"; }

  getSignature(): FunctionSignature {
    return {
      parameters: [
        { name: "a", type: types.number() },
        { name: "b", type: types.number() },
      ],
      returnType: { type: types.number() },
      summary: "Add two numbers",
    };
  }

  call(_ctx: FunctionCallContext, args: unknown[]): unknown {
    return (args[0] as number) + (args[1] as number);
  }
}

/**
 * concat(separator: string, ...values: string[]) → string
 * Joins any number of strings with a separator.
 */
class ConcatFunction implements TerrablyFunction {
  constructor(_provider: Provider) {}

  getName() { return "concat"; }

  getSignature(): FunctionSignature {
    return {
      parameters: [{ name: "separator", type: types.string() }],
      variadicParameter: { name: "values", type: types.string() },
      returnType: { type: types.string() },
      summary: "Join strings with a separator",
    };
  }

  call(_ctx: FunctionCallContext, args: unknown[]): unknown {
    const [separator, ...values] = args as string[];
    return values.join(separator);
  }
}

/**
 * fail_always() → string
 * Always adds a diagnostic error.
 */
class AlwaysFailFunction implements TerrablyFunction {
  constructor(_provider: Provider) {}

  getName() { return "fail_always"; }

  getSignature(): FunctionSignature {
    return {
      parameters: [],
      returnType: { type: types.string() },
      summary: "Always fails with a diagnostic error",
    };
  }

  call(ctx: FunctionCallContext, _args: unknown[]): unknown {
    ctx.diagnostics.addError("Intentional failure", "This function always fails");
    return "";
  }
}

/**
 * throw_always() → string
 * Always throws a JavaScript exception.
 */
class AlwaysThrowFunction implements TerrablyFunction {
  constructor(_provider: Provider) {}

  getName() { return "throw_always"; }

  getSignature(): FunctionSignature {
    return {
      parameters: [],
      returnType: { type: types.string() },
    };
  }

  call(_ctx: FunctionCallContext, _args: unknown[]): unknown {
    throw new Error("Explosion!");
  }
}

// ---------------------------------------------------------------------------
// GetFunctions
// ---------------------------------------------------------------------------

void describe("GetFunctions", () => {
  void it("returns an empty map when provider has no functions", async () => {
    const svc = new ProviderServicer(makeProvider());
    const res = await svc.GetFunctions({} as never, {});
    assert.deepEqual(res.functions, {});
    assert.deepEqual(res.diagnostics, []);
  });

  void it("returns a schema entry for each registered function", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction, AddFunction]));
    const res = await svc.GetFunctions({} as never, {});
    assert.ok("uppercase" in (res.functions ?? {}), "uppercase should be present");
    assert.ok("add" in (res.functions ?? {}), "add should be present");
  });

  void it("populates parameter name and type for a single-parameter function", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.GetFunctions({} as never, {});
    const fn = res.functions!["uppercase"]!;
    assert.equal(fn.parameters?.[0]?.name, "input");
    // Type bytes should encode the JSON string '"string"'
    assert.equal(Buffer.from(fn.parameters![0]!.type!).toString(), '"string"');
  });

  void it("populates summary", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.GetFunctions({} as never, {});
    assert.equal(res.functions!["uppercase"]!.summary, "Convert a string to uppercase");
  });

  void it("populates variadic_parameter when present", async () => {
    const svc = new ProviderServicer(makeProvider([ConcatFunction]));
    const res = await svc.GetFunctions({} as never, {});
    const fn = res.functions!["concat"]!;
    assert.equal(fn.variadicParameter?.name, "values");
  });

  void it("returns undefined variadic_parameter for non-variadic functions", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.GetFunctions({} as never, {});
    assert.equal(res.functions!["uppercase"]!.variadicParameter, undefined);
  });

  void it("includes function schemas in GetProviderSchema.functions", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.GetProviderSchema({} as never, {});
    assert.ok("uppercase" in (res.functions ?? {}), "function should appear in provider schema");
  });
});

// ---------------------------------------------------------------------------
// CallFunction
// ---------------------------------------------------------------------------

void describe("CallFunction — basic dispatch", () => {
  void it("calls uppercase and returns uppercased string", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.CallFunction(
      { name: "uppercase", arguments: [dv("hello")] },
      {}
    );
    assert.equal(res.error, undefined);
    const result = readDynamicValue(res.result as unknown as DynamicValue);
    assert.equal(result, "HELLO");
  });

  void it("calls add and returns the sum", async () => {
    const svc = new ProviderServicer(makeProvider([AddFunction]));
    const res = await svc.CallFunction(
      { name: "add", arguments: [dv(3), dv(4)] },
      {}
    );
    assert.equal(res.error, undefined);
    assert.equal(readDynamicValue(res.result as unknown as DynamicValue), 7);
  });
});

void describe("CallFunction — variadic", () => {
  void it("joins values with the separator", async () => {
    const svc = new ProviderServicer(makeProvider([ConcatFunction]));
    const res = await svc.CallFunction(
      { name: "concat", arguments: [dv(", "), dv("a"), dv("b"), dv("c")] },
      {}
    );
    assert.equal(res.error, undefined);
    assert.equal(readDynamicValue(res.result as unknown as DynamicValue), "a, b, c");
  });

  void it("works with zero variadic args (only required parameter provided)", async () => {
    const svc = new ProviderServicer(makeProvider([ConcatFunction]));
    const res = await svc.CallFunction(
      { name: "concat", arguments: [dv(",")] },
      {}
    );
    assert.equal(res.error, undefined);
    assert.equal(readDynamicValue(res.result as unknown as DynamicValue), "");
  });
});

void describe("CallFunction — arity errors", () => {
  void it("returns error when too few arguments are passed", async () => {
    const svc = new ProviderServicer(makeProvider([AddFunction]));
    // add() requires 2; pass only 1
    const res = await svc.CallFunction(
      { name: "add", arguments: [dv(1)] },
      {}
    );
    assert.ok(res.error, "should have an error");
    assert.match(res.error!.text ?? "", /too few/i);
  });

  void it("returns error when too many arguments are passed (non-variadic)", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    // uppercase() takes 1; pass 2
    const res = await svc.CallFunction(
      { name: "uppercase", arguments: [dv("a"), dv("b")] },
      {}
    );
    assert.ok(res.error, "should have an error");
    assert.match(res.error!.text ?? "", /too many/i);
  });
});

void describe("CallFunction — unknown function", () => {
  void it("returns FunctionError when function name is not registered", async () => {
    const svc = new ProviderServicer(makeProvider([UppercaseFunction]));
    const res = await svc.CallFunction({ name: "nonexistent", arguments: [] }, {});
    assert.ok(res.error, "should have an error");
    assert.match(res.error!.text ?? "", /not found/i);
  });
});

void describe("CallFunction — diagnostic error in call()", () => {
  void it("converts a diagnostic error to FunctionError", async () => {
    const svc = new ProviderServicer(makeProvider([AlwaysFailFunction]));
    const res = await svc.CallFunction({ name: "fail_always", arguments: [] }, {});
    assert.ok(res.error, "should have an error");
    assert.equal(res.error!.text ?? "", "Intentional failure");
  });
});

void describe("CallFunction — exception thrown in call()", () => {
  void it("converts a thrown exception to FunctionError", async () => {
    const svc = new ProviderServicer(makeProvider([AlwaysThrowFunction]));
    const res = await svc.CallFunction({ name: "throw_always", arguments: [] }, {});
    assert.ok(res.error, "should have an error");
    assert.match(res.error!.text ?? "", /Explosion/);
  });
});
