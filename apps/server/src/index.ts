import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "./runManager";
import { assertEnv } from "./env";
import { MAX_PROMPT_LENGTH } from "./config";
import { handleJsonPost, writeJson, CORS_HEADERS } from "./http";

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

try {
  assertEnv();
} catch (err) {
  console.error(`[acv-server] ${(err as Error).message}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8787);
const manager = new RunManager();

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
    return handleJsonPost(req, res, (body) => {
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim().length > 0
          ? body.prompt.trim()
          : "Please analyze this project and suggest next steps.";

      if (prompt.length > MAX_PROMPT_LENGTH) {
        return writeJson(res, 400, { error: `Prompt too long (max ${MAX_PROMPT_LENGTH} chars)` });
      }

      const runId = randomUUID();
      const projectPath =
        typeof body.projectPath === "string" && body.projectPath.trim().length > 0
          ? body.projectPath.trim()
          : undefined;
      manager.startRun(runId, prompt, projectPath);
      writeJson(res, 201, { runId });
    });
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
      ...CORS_HEADERS,
    });

    manager.addClient(runId, res, Number.isNaN(lastSeq) ? 0 : lastSeq);
    return;
  }

  // POST /runs/:id/intervene — HITL checkpoint decision
  const interveneMatch = url.pathname.match(/^\/runs\/([^/]+)\/intervene$/);
  if (req.method === "POST" && interveneMatch) {
    const runId = interveneMatch[1];
    return handleJsonPost(req, res, (body) => {
      const checkpointId = body.checkpointId;
      const decision = body.decision || "accept";
      const note = typeof body.note === "string" ? body.note : undefined;
      const modifications =
        typeof body.modifications === "object" && body.modifications !== null
          ? (body.modifications as Record<string, unknown>)
          : undefined;

      if (typeof checkpointId !== "string" || !checkpointId) {
        return writeJson(res, 400, { error: "Missing checkpointId" });
      }

      const ok = manager.intervene(runId, checkpointId, String(decision), note, modifications);
      writeJson(res, ok ? 200 : 404, { ok });
    });
  }

  // POST /runs/:id/interrupt — user active intervention
  const interruptMatch = url.pathname.match(/^\/runs\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const runId = interruptMatch[1];
    return handleJsonPost(req, res, (body) => {
      const type = String(body.type || "");
      const content = typeof body.content === "string" ? body.content : undefined;

      if (!type) {
        return writeJson(res, 400, { error: "Missing type (inject_message | pause | abort)" });
      }

      const ok = manager.interrupt(runId, type, content);
      writeJson(res, ok ? 200 : 404, { ok });
    });
  }

  // GET /runs/:id/events — get all events
  const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const runId = eventsMatch[1];
    const events = manager.getEvents(runId);
    writeJson(res, 200, { runId, count: events.length, events });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
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
