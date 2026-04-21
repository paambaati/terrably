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

import express, { Request, Response, Express } from "express";
import * as crypto from "node:crypto";

export interface Server {
  id: string;
  name: string;
  size: string;
  status: string;
  created_at: string;
}

const db = new Map<string, Server>();

const app: Express = express();
app.use(express.json());

// List
app.get("/servers", (_req: Request, res: Response) => {
  res.json(Array.from(db.values()));
});

// Create
app.post("/servers", (req: Request, res: Response) => {
  const { name, size } = req.body as { name?: string; size?: string };
  if (!name || !size) {
    res.status(400).json({ error: "name and size are required" });
    return;
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
  res.status(201).json(server);
});

// Read
app.get("/servers/:id", (req: Request, res: Response) => {
  const server = db.get(req.params["id"]!);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(server);
});

// Update
app.put("/servers/:id", (req: Request, res: Response) => {
  const server = db.get(req.params["id"]!);
  if (!server) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { name, size } = req.body as { name?: string; size?: string };
  if (name) server.name = name;
  if (size) server.size = size;
  db.set(server.id, server);
  res.json(server);
});

// Delete
app.delete("/servers/:id", (req: Request, res: Response) => {
  if (!db.has(req.params["id"]!)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  db.delete(req.params["id"]!);
  res.status(204).send();
});

export default app;

// ---------------------------------------------------------------------------
// Start when run directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  const port = Number(process.env["PORT"] ?? 8765);
  app.listen(port, "127.0.0.1", () => {
    process.stdout.write(`DummyCloud API listening on http://127.0.0.1:${port}\n`);
  });
}
