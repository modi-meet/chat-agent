// Tiny HTTP server: one page, one chat endpoint that streams.
// No framework. There are three routes.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, type AgentEvent } from "./agent.ts";
import { formatDayTime, now } from "./clock.ts";
import { sessionExchanges } from "./store.ts";

const PORT = Number(process.env.PORT ?? 3000);
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(PAGE));
    } else if (req.method === "GET" && url.pathname === "/api/session") {
      // lets a page reload pick the chat back up
      const id = url.searchParams.get("id") ?? "";
      json(res, 200, { now: formatDayTime(now()), exchanges: sessionExchanges(id, 50) });
    } else if (req.method === "POST" && url.pathname === "/api/chat") {
      await chat(req, res);
    } else {
      json(res, 404, { error: "not found" });
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

async function chat(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!sessionId || !message) return json(res, 400, { error: "sessionId and message are required" });
  if (message.length > 8000) return json(res, 400, { error: "message is too long" });

  // server-sent events over the POST response
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const emit = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  // stop paying for a turn nobody is reading
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  await runTurn({ sessionId, message, emit, signal: abort.signal });
  res.end();
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

server.listen(PORT, () => {
  console.log(`chat agent on http://localhost:${PORT}  (it's ${formatDayTime(now())})`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add it.");
});
