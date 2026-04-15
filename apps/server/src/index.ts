import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "./runManager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "../../../.env.local"),
  resolve(__dirname, "../../../.env"),
  resolve(__dirname, "../../.env.local"),
  resolve(__dirname, "../../.env"),
];

for (const p of envCandidates) {
  if (existsSync(p)) {
    loadEnv({ path: p, override: false });
  }
}

const port = Number(process.env.PORT || 8787);
const manager = new RunManager();

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

const cors = { "Access-Control-Allow-Origin": "*" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    });
    res.end();
    return;
  }

  // POST /runs — start a new run
  if (req.method === "POST" && url.pathname === "/runs") {
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const prompt =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : "Please analyze this project and suggest next steps.";

    if (prompt.length > 10000) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Prompt too long (max 10000 chars)" }));
      return;
    }

    const runId = randomUUID();
    const projectPath = typeof body.projectPath === "string" && body.projectPath.trim().length > 0
      ? body.projectPath.trim()
      : undefined;
    manager.startRun(runId, prompt, projectPath);
    res.writeHead(201, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ runId }));
    return;
  }

  // GET /runs/:id/stream — SSE stream
  const streamMatch = url.pathname.match(/^\/runs\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const runId = streamMatch[1];
    const lastIdHeader = req.headers["last-event-id"];
    const lastSeq = Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader || "0");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...cors,
    });

    manager.addClient(runId, res, Number.isNaN(lastSeq) ? 0 : lastSeq);
    req.on("close", () => manager.removeClient(runId, res));
    return;
  }

  // POST /runs/:id/intervene — HITL checkpoint decision
  const interveneMatch = url.pathname.match(/^\/runs\/([^/]+)\/intervene$/);
  if (req.method === "POST" && interveneMatch) {
    const runId = interveneMatch[1];
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const checkpointId = body.checkpointId;
    const decision = body.decision || "accept";
    const note = typeof body.note === "string" ? body.note : undefined;
    const modifications = typeof body.modifications === "object" && body.modifications !== null
      ? body.modifications as Record<string, unknown>
      : undefined;

    if (typeof checkpointId !== "string" || !checkpointId) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Missing checkpointId" }));
      return;
    }

    const result = manager.intervene(runId, checkpointId, String(decision), note, modifications);
    res.writeHead(result ? 200 : 404, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: result }));
    return;
  }

  // POST /runs/:id/interrupt — user active intervention
  const interruptMatch = url.pathname.match(/^\/runs\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const runId = interruptMatch[1];
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const type = String(body.type || "");
    const content = typeof body.content === "string" ? body.content : undefined;

    if (!type) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Missing type (inject_message | pause | abort)" }));
      return;
    }

    const result = manager.interrupt(runId, type, content);
    res.writeHead(result ? 200 : 404, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: result }));
    return;
  }

  // GET /runs/:id/events — get all events
  const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const runId = eventsMatch[1];
    const events = manager.getEvents(runId);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ runId, count: events.length, events }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[acv-server] Port ${port} is already in use. ` +
        `Stop the existing process or run with another port.`,
    );
    process.exit(1);
  }
  console.error("[acv-server] unexpected server error:", err);
  process.exit(1);
});

server.listen(port, () => {
  const addr = server.address() as AddressInfo;
  console.log(`[acv-server] listening on http://localhost:${addr.port}`);
});
