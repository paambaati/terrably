/**
 * dummycloud_server resource.
 *
 * Manages a virtual server in the DummyCloud API.
 *
 * Schema:
 *   id          (string, computed) - assigned by API
 *   name        (string, required) - display name
 *   size        (string, required) - e.g. "small", "medium", "large"
 *   status      (string, computed) - "running" | "stopped"
 *   created_at  (string, computed) - ISO timestamp
 */

import type { State } from "terrably";
import {
  types,
  Attribute,
  Schema,
} from "terrably";
import type {
  Resource,
  CreateContext,
  ReadContext,
  UpdateContext,
  DeleteContext,
  Provider,
} from "terrably";

interface ApiServer {
  id: string;
  name: string;
  size: string;
  status: string;
  created_at: string;
}

async function apiFetch(
  method: string,
  url: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { ok: true, status: 204, data: null };
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export class DummyCloudServer implements Resource {
  private readonly apiBase: string;

  constructor(provider: Provider) {
    // Provider stores configured api_url after configure() is called
    // Access it via a cast since the SDK Provider interface is generic
    this.apiBase =
      ((provider as unknown) as { apiUrl?: string }).apiUrl ?? "http://127.0.0.1:8765";
  }

  getName(): string {
    return "server";
  }

  getSchema(): Schema {
    return new Schema(
      [
        new Attribute("id", types.string(), { computed: true }),
        new Attribute("name", types.string(), { required: true }),
        new Attribute("size", types.string(), { required: true }),
        new Attribute("status", types.string(), { computed: true }),
        new Attribute("created_at", types.string(), { computed: true }),
      ],
      [],
      1
    );
  }

  async create(ctx: CreateContext, planned: State): Promise<State> {
    const result = await apiFetch("POST", `${this.apiBase}/servers`, {
      name: planned["name"],
      size: planned["size"],
    });
    if (!result.ok) {
      ctx.diagnostics.addError("API error creating server", JSON.stringify(result.data));
      return planned;
    }
    const s = result.data as ApiServer;
    return { id: s.id, name: s.name, size: s.size, status: s.status, created_at: s.created_at };
  }

  async read(ctx: ReadContext, current: State): Promise<State | null> {
    if (!current["id"]) return null;
    const result = await apiFetch("GET", `${this.apiBase}/servers/${current["id"]}`);
    if (result.status === 404) return null;
    if (!result.ok) {
      ctx.diagnostics.addError("API error reading server", JSON.stringify(result.data));
      return current;
    }
    const s = result.data as ApiServer;
    return { id: s.id, name: s.name, size: s.size, status: s.status, created_at: s.created_at };
  }

  async update(ctx: UpdateContext, prior: State, planned: State): Promise<State> {
    const result = await apiFetch("PUT", `${this.apiBase}/servers/${prior["id"]}`, {
      name: planned["name"],
      size: planned["size"],
    });
    if (!result.ok) {
      ctx.diagnostics.addError("API error updating server", JSON.stringify(result.data));
      return prior;
    }
    const s = result.data as ApiServer;
    return { id: s.id, name: s.name, size: s.size, status: s.status, created_at: s.created_at };
  }

  async delete(ctx: DeleteContext, current: State): Promise<void> {
    const result = await apiFetch("DELETE", `${this.apiBase}/servers/${current["id"]}`);
    if (!result.ok && result.status !== 404) {
      ctx.diagnostics.addError("API error deleting server", JSON.stringify(result.data));
    }
  }

  async import(_ctx: unknown, id: string): Promise<State | null> {
    const result = await apiFetch("GET", `${this.apiBase}/servers/${id}`);
    if (result.status === 404) return null;
    const s = result.data as ApiServer;
    return { id: s.id, name: s.name, size: s.size, status: s.status, created_at: s.created_at };
  }
}

