/**
 * Dummy Cloud API server.
 *
 * Mimics a cloud provider REST API that manages "servers" (VMs).
 * All state is stored in memory – perfect for E2E testing.
 *
 * Endpoints:
 *   GET    /servers          → list all servers
 *   POST   /servers          → create a server (body: {name, size})
 *   GET    /servers/:id      → read a server
 *   PUT    /servers/:id      → update a server (body: {name, size})
 *   DELETE /servers/:id      → delete a server
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import * as crypto from "node:crypto";

export interface Server {
  id: string;
  name: string;
  size: string;
  status: string;
  created_at: string;
}

const db = new Map<string, Server>();

const app = new Hono();

// List
app.get("/servers", (c) => {
  return c.json(Array.from(db.values()));
});

// Create
app.post("/servers", async (c) => {
  const { name, size } = await c.req.json<{ name?: string; size?: string }>();
  if (!name || !size) {
    return c.json({ error: "name and size are required" }, 400);
  }
  const id = crypto.randomUUID();
  const server: Server = {
    id,
    name,
    size,
    status: "running",
    created_at: new Date().toISOString(),
  };
  db.set(id, server);
  return c.json(server, 201);
});

// Read
app.get("/servers/:id", (c) => {
  const server = db.get(c.req.param("id"));
  if (!server) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(server);
});

// Update
app.put("/servers/:id", async (c) => {
  const server = db.get(c.req.param("id"));
  if (!server) {
    return c.json({ error: "not found" }, 404);
  }
  const { name, size } = await c.req.json<{ name?: string; size?: string }>();
  if (name) server.name = name;
  if (size) server.size = size;
  db.set(server.id, server);
  return c.json(server);
});

// Delete
app.delete("/servers/:id", (c) => {
  if (!db.has(c.req.param("id"))) {
    return c.json({ error: "not found" }, 404);
  }
  db.delete(c.req.param("id"));
  return new Response(null, { status: 204 });
});

export default app;

// ---------------------------------------------------------------------------
// Start when run directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = Number(process.env["PORT"] ?? 8765);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    process.stdout.write(`DummyCloud API listening on http://127.0.0.1:${port}\n`);
  });
}
