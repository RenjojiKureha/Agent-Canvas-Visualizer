import type { IncomingMessage, ServerResponse } from "node:http";

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * Read + parse a JSON POST body, then invoke `handler` with the parsed body.
 * Replies 400 if JSON is invalid. Handler is responsible for the success response.
 */
export async function handleJsonPost(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const raw = await readBody(req);
  const body = parseJson(raw);
  if (!body) {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }
  await handler(body);
}

export { CORS_HEADERS };
