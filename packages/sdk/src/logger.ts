/**
 * Terraform-compatible structured logging via pino.
 *
 * Terraform (go-plugin) reads the provider process's stderr and expects
 * newline-delimited JSON matching the go-hclog schema:
 *
 *   {"@level":"debug","@timestamp":"...","@module":"provider","@message":"..."}
 *
 * All user-supplied key/value fields appear at the root of the JSON object
 * alongside the `@`-prefixed fields, which is the same convention used by
 * `hashicorp/go-hclog` and `terraform-plugin-log`.
 *
 * Level resolution (first match wins):
 *   TF_LOG          — global override (wins over TF_LOG_PROVIDER)
 *   TF_LOG_PROVIDER — provider-specific level
 *   (default)       — "silent" (no output when run outside Terraform)
 *
 * Valid values (case-insensitive): TRACE | DEBUG | INFO | WARN | ERROR | OFF
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import pino = require("pino");

// ---------------------------------------------------------------------------
// Level resolution
// ---------------------------------------------------------------------------

type PinoLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_MAP: Record<string, PinoLevel> = {
  TRACE:   "trace",
  DEBUG:   "debug",
  INFO:    "info",
  WARN:    "warn",
  WARNING: "warn",   // defensive: some tooling uses the full word
  ERROR:   "error",
  OFF:     "silent",
  JSON:    "trace",  // TF_LOG=JSON → force TRACE + JSON (we're always JSON)
};

function resolveLevel(): PinoLevel {
  // TF_LOG wins unconditionally per Terraform's documented behaviour.
  // TF_LOG_PROVIDER is the provider-specific override.
  const raw = (process.env["TF_LOG"] ?? process.env["TF_LOG_PROVIDER"] ?? "off").toUpperCase();
  return LEVEL_MAP[raw] ?? "silent";
}

// ---------------------------------------------------------------------------
// Timestamp: RFC3339 with microsecond precision
// go-hclog format: "2006-01-02T15:04:05.000000Z07:00"
// JS Date.toISOString() gives milliseconds; we pad with three zeros.
// ---------------------------------------------------------------------------

function tfTimestamp(): string {
  return `,"@timestamp":"${new Date().toISOString().replace("Z", "000Z")}"`;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * A Terraform-compatible structured logger. All methods write newline-
 * delimited JSON to stderr in the go-hclog format that Terraform parses and
 * re-emits through its own logging pipeline.
 *
 * Obtain an instance with {@link createLogger}:
 *
 * ```typescript
 * import { createLogger } from "terrably";
 *
 * const log = createLogger("provider");
 *
 * log.info("provider configured", { endpoint: "https://api.example.com" });
 * // stderr → {"@level":"info","@timestamp":"...","@module":"provider",
 * //            "@message":"provider configured","endpoint":"https://api.example.com"}
 * ```
 *
 * Create child loggers for subsystems with {@link Logger.child}:
 *
 * ```typescript
 * const reqLog = log.child({ "@module": "provider.client", request_id: "abc-123" });
 * reqLog.debug("sending HTTP request", { url: "https://api.example.com/v1/servers" });
 * ```
 */
export interface Logger {
  /**
   * Log at TRACE level (most verbose). Emitted only when `TF_LOG=TRACE`.
   * Use for very fine-grained diagnostic information: individual attribute
   * values, serialised request/response bodies, etc.
   */
  trace(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Log at DEBUG level. Emitted when `TF_LOG=DEBUG` or `TF_LOG=TRACE`.
   * Use for developer-facing information: API calls, state transitions,
   * computed diffs.
   */
  debug(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Log at INFO level. Emitted when `TF_LOG=INFO`, `DEBUG`, or `TRACE`.
   * Use for high-level lifecycle events: provider configured, resource
   * created, import completed.
   */
  info(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Log at WARN level. Emitted for all levels except `TF_LOG=ERROR` / `OFF`.
   * Use for recoverable issues that don't fail the operation: deprecated
   * configuration keys, retried API calls.
   */
  warn(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Log at ERROR level. Always emitted unless `TF_LOG=OFF`.
   * Prefer returning Terraform `Diagnostics` for user-visible errors; use
   * this for internal/unexpected errors that supplement a diagnostic.
   */
  error(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Create a child logger that inherits the current configuration but merges
   * additional persistent fields into every subsequent log line.
   *
   * The most common use is overriding `@module` for a subsystem:
   *
   * ```typescript
   * const clientLog = log.child({ "@module": "provider.http_client" });
   * clientLog.debug("connection established", { host: "api.example.com" });
   * ```
   *
   * Any other key/value pairs become persistent fields on the child:
   *
   * ```typescript
   * const reqLog = log.child({ request_id: ctx.requestId, resource: "server" });
   * reqLog.debug("plan computed");   // includes request_id and resource
   * reqLog.debug("apply complete");  // includes request_id and resource
   * ```
   */
  child(fields: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Implementation (wraps a pino logger instance)
// ---------------------------------------------------------------------------

class PinoBackedLogger implements Logger {
  // _root is the bare pino instance (no bindings). We re-create children from
  // root so that overriding "@module" never produces duplicate JSON keys.
  private readonly _root: pino.Logger;
  private readonly _bindings: Record<string, unknown>;
  private readonly _pino: pino.Logger;

  constructor(root: pino.Logger, bindings: Record<string, unknown>) {
    this._root = root;
    this._bindings = bindings;
    this._pino = root.child(bindings);
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    if (fields) this._pino.trace(fields, msg);
    else this._pino.trace(msg);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    if (fields) this._pino.debug(fields, msg);
    else this._pino.debug(msg);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    if (fields) this._pino.info(fields, msg);
    else this._pino.info(msg);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    if (fields) this._pino.warn(fields, msg);
    else this._pino.warn(msg);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    if (fields) this._pino.error(fields, msg);
    else this._pino.error(msg);
  }

  child(fields: Record<string, unknown>): Logger {
    // Merge new fields over current bindings so that keys like "@module" are
    // deduplicated rather than stacked, which would produce duplicate JSON keys.
    return new PinoBackedLogger(this._root, { ...this._bindings, ...fields });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Terraform-compatible structured logger.
 *
 * The `module` argument sets the `@module` field on every log line. Terraform
 * displays this as a subsystem prefix in its log output. Use dot-separated
 * hierarchies: `"provider"`, `"provider.client"`, `"provider.server_resource"`.
 *
 * Log level is resolved automatically from the environment:
 *
 * | Env var            | Wins over        | Valid values                     |
 * |--------------------|------------------|----------------------------------|
 * | `TF_LOG`           | everything       | TRACE, DEBUG, INFO, WARN, ERROR, OFF |
 * | `TF_LOG_PROVIDER`  | (default)        | same                             |
 * | *(default)*        | —                | silent (no output)               |
 *
 * When neither variable is set, the logger is silent so the provider does not
 * produce unexpected output when run outside of Terraform.
 *
 * @example Basic provider-level logger
 * ```typescript
 * import { createLogger } from "terrably";
 *
 * const log = createLogger("provider");
 *
 * // TF_LOG=DEBUG terraform apply
 * log.debug("configuring provider", { endpoint: "https://api.example.com" });
 * // stderr: {"@level":"debug","@timestamp":"...","@module":"provider",
 * //          "@message":"configuring provider","endpoint":"https://api.example.com"}
 * ```
 *
 * @example Subsystem / child logger
 * ```typescript
 * const clientLog = createLogger("provider.http_client");
 * // or via child():
 * const clientLog2 = log.child({ "@module": "provider.http_client" });
 * ```
 *
 * @example Persistent fields on a child
 * ```typescript
 * function handleCreate(ctx: CreateContext, config: Record<string, unknown>) {
 *   const reqLog = log.child({ resource_type: "server", name: config["name"] });
 *   reqLog.debug("creating resource");
 *   // ... API call ...
 *   reqLog.info("resource created", { id: newServer.id });
 * }
 * ```
 *
 * @param module - The `@module` value written to every log line (default: `"provider"`)
 */
export function createLogger(module = "provider"): Logger {
  const root = pino(
    {
      level: resolveLevel(),
      base: null,              // remove pid, hostname from every line
      messageKey: "@message",
      timestamp: tfTimestamp,
      formatters: {
        level: (label: string) => ({ "@level": label === "fatal" ? "error" : label }),
      },
    },
    process.stderr
  );
  return new PinoBackedLogger(root, { "@module": module });
}

// ---------------------------------------------------------------------------
// SDK-internal logger
// ---------------------------------------------------------------------------

/**
 * Internal logger used by terrably's own serve() and gRPC dispatch layer.
 * Emits under `@module: "provider"`.
 * @internal
 */
export const sdkLog: Logger = createLogger("provider");
