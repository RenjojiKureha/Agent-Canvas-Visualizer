import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { RunManager } from "./runManager";

const port = Number(process.env.PORT || 8787);
const manager = new RunManager();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID"
    });
    res.end();
    return;
  }

  const cors = { "Access-Control-Allow-Origin": "*" };

  if (req.method === "POST" && url.pathname === "/runs") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const prompt = typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : "请给出这个项目的下一步实施建议。";

      const runId = randomUUID();
      manager.startRun(runId, prompt);

      res.writeHead(201, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ runId }));
    });
    return;
  }

  const streamMatch = url.pathname.match(/^\/runs\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const runId = streamMatch[1];
    const lastIdHeader = req.headers["last-event-id"];
    const lastSeq = Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader || "0");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...cors
    });

    manager.addClient(runId, res, Number.isNaN(lastSeq) ? 0 : lastSeq);
    req.on("close", () => manager.removeClient(runId, res));
    return;
  }

  const interveneMatch = url.pathname.match(/^\/runs\/([^/]+)\/intervene$/);
  if (req.method === "POST" && interveneMatch) {
    const runId = interveneMatch[1];
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const result = manager.intervene(runId, body.checkpointId, body.decision || "accept", body.note);
      res.writeHead(result ? 200 : 404, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: result }));
    });
    return;
  }

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
        `Stop the existing process or run with another port, e.g. ` +
        `"$env:PORT=8788; npm run dev:server".`
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
