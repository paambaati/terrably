/**
 * serve() – starts the gRPC server and prints the go-plugin handshake to stdout.
 *
 * Handshake format (6 pipe-separated fields):
 *   CORE_PROTO_VER|APP_PROTO_VER|NETWORK_TYPE|ADDR|PROTOCOL|BASE64_DER_CERT
 *
 * The 6th field is the server's self-signed TLS certificate in DER format,
 * base64-encoded without padding. Terraform uses this to verify the server.
 *
 * go-plugin also requires two extra gRPC services beyond tfplugin6.Provider:
 *   - plugin.GRPCController  (Shutdown RPC)
 *   - plugin.GRPCStdio       (StreamStdio RPC – we return empty stream)
 *
 * Env vars:
 *   TF_PLUGIN_MAGIC_COOKIE  – must equal the magic cookie value below
 *   TF_REATTACH_PROVIDERS   – when set by Terraform for debug reattach
 *   TF_LOG / TF_LOG_PROVIDER – structured log level (see logger.ts)
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import { ProviderServicer } from "./servicer.js";
import type { Provider } from "./interfaces.js";
import { sdkLog } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC_COOKIE_KEY = "TF_PLUGIN_MAGIC_COOKIE" as const;
const MAGIC_COOKIE_VALUE =
  "d602bf8f470bc67ca7faa0386276bbdd4330efaf76d1a219cb4d6991ca9872b2" as const;

const TF_PROTOCOL_VERSION = 6;
const GO_PLUGIN_CORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ServeOptions {
  socketPath?: string;
  dev?: boolean;
  /**
   * Override the directory from which the three tfplugin6 `.proto` files are
   * loaded. Use this when building a Node.js Single Executable Application
   * (SEA): extract the proto files from SEA assets at startup and pass the
   * temp directory here.
   *
   * Defaults to `<sdk-package-root>/proto` when running from source/dist.
   */
  protoDir?: string;
}

// ---------------------------------------------------------------------------
// TLS certificate (self-signed, cached)
// ---------------------------------------------------------------------------

interface CachedCert {
  certPem: string;
  keyPem: string;
  certDerB64: string;
  expiresAt: number;
}

let _certCache: CachedCert | null = null;

async function getSelfSignedCert(): Promise<CachedCert> {
  if (_certCache && _certCache.expiresAt > Date.now()) return _certCache;

  const cacheDir = path.join(os.homedir(), ".cache", "tf-js-provider");
  const cachePath = path.join(cacheDir, "ssl_cert.json");

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedCert;
    if (raw.expiresAt > Date.now() + 60_000) {
      _certCache = raw;
      return _certCache;
    }
  } catch {
    // ignore – will regenerate
  }

  // Generate using the selfsigned package (pure-JS, no native dependencies)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const selfsigned = require("selfsigned") as typeof import("selfsigned");
  const attrs = [{ name: "commonName", value: "localhost" }];
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: 7,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
  } as Parameters<typeof selfsigned.generate>[1]);

  const certDer = Buffer.from(
    pems.cert.replace(/-----BEGIN CERTIFICATE-----|\s|-----END CERTIFICATE-----/g, ""),
    "base64"
  );

  _certCache = {
    certPem: pems.cert,
    keyPem: pems.private,
    certDerB64: certDer.toString("base64").replace(/=/g, ""),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };

  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath, JSON.stringify(_certCache), { mode: 0o600 });
  } catch {
    // non-fatal
  }

  return _certCache;
}

// ---------------------------------------------------------------------------
// Load proto service definitions via proto-loader (runtime)
// ---------------------------------------------------------------------------

function loadServiceDefinitions(protoDir: string): {
  provider: grpc.ServiceDefinition;
  controller: grpc.ServiceDefinition;
  stdio: grpc.ServiceDefinition;
} {
  const opts: protoLoader.Options = {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  };

  const tfPkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(protoDir, "tfplugin6.proto"), opts)
  );
  const ctrlPkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(protoDir, "grpc_controller.proto"), opts)
  );
  const stdioPkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(path.join(protoDir, "grpc_stdio.proto"), opts)
  );

  const provider = (
    (tfPkg["tfplugin6"] as Record<string, unknown>)["Provider"] as grpc.ServiceClientConstructor
  ).service;
  const controller = (
    (ctrlPkg["plugin"] as Record<string, unknown>)["GRPCController"] as grpc.ServiceClientConstructor
  ).service;
  const stdio = (
    (stdioPkg["plugin"] as Record<string, unknown>)["GRPCStdio"] as grpc.ServiceClientConstructor
  ).service;

  return { provider, controller, stdio };
}

// ---------------------------------------------------------------------------
// Build grpc.UntypedServiceImplementation from servicer
// ---------------------------------------------------------------------------

function buildGrpcHandlers(servicer: ProviderServicer): grpc.UntypedServiceImplementation {
  const out: grpc.UntypedServiceImplementation = {};
  const proto = Object.getPrototypeOf(servicer) as Record<string, unknown>;
  const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");

  for (const rawMethod of methods) {
    const fn = proto[rawMethod];
    if (typeof fn !== "function") continue;

    // gRPC method names are camelCase matching the service definition
    const methodName = rawMethod.charAt(0).toLowerCase() + rawMethod.slice(1);

    out[methodName] = async (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      const start = Date.now();
      sdkLog.trace(`rpc: ${methodName}`);
      try {
        const result = await (fn as Function).call(servicer, call.request, {});
        sdkLog.trace(`rpc ok: ${methodName}`, { duration_ms: Date.now() - start });
        callback(null, result);
      } catch (err) {
        sdkLog.error(`rpc error: ${methodName}`, { error: String(err), duration_ms: Date.now() - start });
        callback({ code: grpc.status.INTERNAL, message: String(err) } as grpc.ServiceError, null);
      }
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function serve(provider: Provider, opts: ServeOptions = {}): Promise<void> {
  // 1. Validate magic cookie
  const cookie = process.env[MAGIC_COOKIE_KEY];
  if (cookie !== MAGIC_COOKIE_VALUE) {
    process.stderr.write(
      `\nThis binary is a Terraform provider plugin.\n` +
        `It should be executed by Terraform, not directly.\n\n` +
        `Expected ${MAGIC_COOKIE_KEY}=${MAGIC_COOKIE_VALUE}\n`
    );
    process.exit(1);
  }

  // Locate proto files:
  //   1. Explicit opts.protoDir (passed by caller)
  //   2. TF_PROTO_DIR env var (set by the SEA entry-point preamble at startup,
  //      which extracts embedded proto assets into a temp dir before main runs)
  //   3. SDK package's own proto/ directory (normal dev / tsx mode)
  const protoDir =
    opts.protoDir ??
    process.env["TF_PROTO_DIR"] ??
    path.resolve(__dirname, "..", "..", "proto");

  // 2. Create socket path
  const socketPath =
    opts.socketPath ??
    path.join(os.tmpdir(), `tf-js-provider-${process.pid}-${Date.now()}.sock`);

  // 3. Build servicer + load gRPC service definitions
  const servicer = new ProviderServicer(provider);
  const { provider: providerSvc, controller: controllerSvc, stdio: stdioSvc } =
    loadServiceDefinitions(protoDir);

  const handlers = buildGrpcHandlers(servicer);

  // 4. Create gRPC server
  const server = new grpc.Server({
    "grpc.max_send_message_length": 256 * 1024 * 1024,
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
  });

  server.addService(providerSvc, handlers);

  server.addService(controllerSvc, {
    shutdown: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      cb(null, {});
      process.nextTick(() => {
        server.tryShutdown(() => process.exit(0));
      });
    },
  });

  server.addService(stdioSvc, {
    streamStdio: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.end();
    },
  });

  // 5. Choose credentials
  let creds: grpc.ServerCredentials;
  let certDerB64 = "";

  if (opts.dev) {
    creds = grpc.ServerCredentials.createInsecure();
  } else {
    const cert = await getSelfSignedCert();
    certDerB64 = cert.certDerB64;
    creds = grpc.ServerCredentials.createSsl(
      null,
      [{ cert_chain: Buffer.from(cert.certPem), private_key: Buffer.from(cert.keyPem) }],
      false
    );
  }

  // 6. Bind and start
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`unix://${socketPath}`, creds, (err) => {
      if (err) return reject(err);
      server.start();
      resolve();
    });
  });

  if (opts.dev) {
    const reattach = JSON.stringify({
      [provider.getFullName()]: {
        Protocol: "grpc",
        ProtocolVersion: TF_PROTOCOL_VERSION,
        Pid: process.pid,
        Test: true,
        Addr: { Network: "unix", String: socketPath },
      },
    });
    process.stdout.write(`\nDev mode — set this env var:\n\n\texport TF_REATTACH_PROVIDERS='${reattach}'\n\n`);
    sdkLog.debug("listening (insecure)", { socket: socketPath });
  } else {
    // 7. Print the go-plugin handshake
    const handshake = [
      GO_PLUGIN_CORE_VERSION,
      TF_PROTOCOL_VERSION,
      "unix",
      socketPath,
      "grpc",
      certDerB64,
    ].join("|");
    process.stdout.write(handshake + "\n");
    sdkLog.debug("provider started", { socket: socketPath, tls: true });
  }

  // 8. Graceful shutdown
  const shutdown = () => {
    sdkLog.debug("shutting down");
    server.tryShutdown(() => {
      fs.rmSync(socketPath, { force: true });
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep alive
  await new Promise<void>(() => {});
}

