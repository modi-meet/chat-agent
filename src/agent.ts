// One turn of the agent: remember, ask the model, stream, save, then ledger.
// The model has exactly one tool (web search, run by Anthropic's servers).
// Memory is not a tool: recall() puts it in context before the model starts.

import Anthropic from "@anthropic-ai/sdk";
import { now } from "./clock.ts";
import { recordLedger } from "./ledger.ts";
import { SYSTEM } from "./prompt.ts";
import { recall } from "./recall.ts";
import { saveExchange, sessionExchanges, type Source } from "./store.ts";

const MODEL = process.env.CHAT_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.EFFORT ?? "low") as "low" | "medium" | "high";
const HISTORY_TURNS = 10; // older turns come back through recall, not replay
const MAX_SEARCHES = 8;
const MAX_RESUMES = 3; // how many times we continue a paused search turn

export const client = new Anthropic();

// what the browser gets. every stream ends with "done" or "error", never silence.
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "cite"; source: Source }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; exchangeId: number }
  | { type: "error"; message: string };

type Turn = {
  sessionId: string;
  message: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

export async function runTurn({ sessionId, message, emit, signal }: Turn): Promise<void> {
  const askedAt = now();

  // short-term: this session, word for word. long-term: recall, by date and topic.
  const history = sessionExchanges(sessionId, HISTORY_TURNS);
  const memory = recall(message, askedAt, new Set(history.map((e) => e.id)));

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.flatMap((e): Anthropic.Beta.BetaMessageParam[] => [
      { role: "user", content: e.question },
      { role: "assistant", content: e.answer },
    ]),
    {
      role: "user",
      content: [
        { type: "text", text: memory.block },
        { type: "text", text: message },
      ],
    },
  ];

  let answer = "";
  const found = new Map<string, Source>(); // every page search returned
  const cited = new Map<string, Source>(); // the ones the answer leans on

  try {
    for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          system: SYSTEM,
          // thinking is always on for this model, effort is the speed dial
          output_config: { effort: EFFORT },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
          // if the model declines a request, the API retries it on a fallback model
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages,
        },
        { signal },
      );

      // search queries arrive as json fragments, keyed by block index
      const queries = new Map<number, string>();

      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
          queries.set(event.index, "");
          emit({ type: "status", text: "Searching the web" });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            answer += event.delta.text;
            emit({ type: "text", text: event.delta.text });
          } else if (event.delta.type === "input_json_delta" && queries.has(event.index)) {
            queries.set(event.index, queries.get(event.index) + event.delta.partial_json);
          } else if (event.delta.type === "citations_delta" && "url" in event.delta.citation) {
            const c = event.delta.citation;
            const source = { url: c.url, title: c.title ?? c.url };
            if (!cited.has(source.url)) cited.set(source.url, source);
            emit({ type: "cite", source });
          }
        } else if (event.type === "content_block_stop" && queries.has(event.index)) {
          const query = readQuery(queries.get(event.index)!);
          if (query) emit({ type: "status", text: `Searching: ${query}` });
        }
      }

      const final = await stream.finalMessage();

      // a successful search is a list of results, a failed one is a single error object
      for (const block of final.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) found.set(r.url, { url: r.url, title: r.title });
        }
      }

      if (final.stop_reason === "pause_turn") {
        // long search turn: hand the partial turn back and the server carries on
        messages.push({ role: "assistant", content: final.content });
        continue;
      }
      if (final.stop_reason === "refusal" && !answer) {
        answer = "I can't help with that one.";
        emit({ type: "text", text: answer });
      }
      break;
    }
  } catch (err) {
    if (signal?.aborted) return; // user closed the tab, nothing to say
    console.error("turn failed:", err);
    emit({ type: "error", message: friendly(err) });
    return;
  }

  if (!answer.trim()) {
    emit({ type: "error", message: "I didn't get an answer back. Try again?" });
    return;
  }

  // cited pages first, then the rest of what search turned up
  const sources = [...cited.values(), ...[...found.values()].filter((s) => !cited.has(s.url))].slice(0, 12);
  if (sources.length > 0) emit({ type: "sources", sources });

  const exchangeId = saveExchange({ sessionId, ts: askedAt.getTime(), question: message, answer, sources });
  emit({ type: "done", exchangeId });

  // the user already has their answer. now write down what we claimed.
  recordLedger(client, exchangeId, message, answer, sources);
}

function readQuery(json: string): string | null {
  try {
    const query = JSON.parse(json).query;
    return typeof query === "string" ? query : null;
  } catch {
    return null; // not a plain search call, the generic status is enough
  }
}

function friendly(err: unknown): string {
  const noKey = err instanceof Error && err.message.includes("Could not resolve authentication");
  if (noKey || err instanceof Anthropic.AuthenticationError) return "The API key is missing or wrong. Check ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited. Give it a few seconds and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the model. Check your connection.";
  if (err instanceof Anthropic.APIError) return `The model returned an error (${err.status ?? "unknown"}). Try again.`;
  return "Something went wrong on my side. Try again.";
}
