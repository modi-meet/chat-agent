// One turn of the agent: remember, ask the model, stream, save, then ledger.
// The model has exactly one tool (Google Search, run on Gemini's side).
// Memory is not a tool: recall() puts it in context before the model starts.

import { GoogleGenAI } from "@google/genai";
import { now } from "./clock.ts";
import { recordLedger } from "./ledger.ts";
import { SYSTEM } from "./prompt.ts";
import { recall } from "./recall.ts";
import { saveExchange, sessionExchanges, type Source } from "./store.ts";

const MODEL = process.env.CHAT_MODEL ?? "gemini-3.8-flash";
const THINKING = (process.env.THINKING_LEVEL ?? "low") as "low" | "medium" | "high";
const HISTORY_TURNS = 10; // older turns come back through recall, not replay

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// what the browser gets. every stream ends with "done" or "error", never silence.
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "cite"; source: Source; at?: number } // at = where in the answer the citation belongs
  | { type: "sources"; sources: Source[] }
  | { type: "done"; exchangeId: number }
  | { type: "error"; message: string };

type Turn = {
  sessionId: string;
  message: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
};

const userStep = (...texts: string[]) => ({
  type: "user_input" as const,
  content: texts.map((text) => ({ type: "text" as const, text })),
});
const modelStep = (text: string) => ({
  type: "model_output" as const,
  content: [{ type: "text" as const, text }],
});

export async function runTurn({ sessionId, message, emit, signal }: Turn): Promise<void> {
  const askedAt = now();

  // short-term: this session, word for word. long-term: recall, by date and topic.
  const history = sessionExchanges(sessionId, HISTORY_TURNS);
  const memory = recall(message, askedAt, new Set(history.map((e) => e.id)));

  const input = [
    ...history.flatMap((e) => [userStep(e.question), modelStep(e.answer)]),
    userStep(memory.block, message),
  ];

  let answer = "";
  let stepStart = 0; // citation offsets are relative to the text step they sit in
  const cited = new Map<string, Source>();

  try {
    const stream = await ai.interactions.create(
      {
        model: MODEL,
        input,
        system_instruction: SYSTEM,
        tools: [{ type: "google_search" }],
        generation_config: { thinking_level: THINKING }, // the speed dial
        stream: true,
        store: false, // we keep our own history, nothing lives on Google's side
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.event_type === "step.start") {
        if (event.step.type === "google_search_call") emit({ type: "status", text: searching(event.step.arguments.queries) });
        if (event.step.type === "model_output") stepStart = answer.length;
      } else if (event.event_type === "step.delta") {
        const d = event.delta;
        if (d.type === "text") {
          answer += d.text;
          emit({ type: "text", text: d.text });
        } else if (d.type === "google_search_call") {
          emit({ type: "status", text: searching(d.arguments.queries) });
        } else if (d.type === "text_annotation_delta") {
          for (const a of d.annotations ?? []) {
            if (a.type !== "url_citation" || !a.url) continue;
            const source = { url: a.url, title: a.title ?? a.url };
            if (!cited.has(source.url)) cited.set(source.url, source);
            emit({ type: "cite", source, at: a.end_index === undefined ? undefined : stepStart + a.end_index });
          }
        }
      } else if (event.event_type === "error") {
        throw new Error(event.error?.message ?? "stream error");
      }
    }
  } catch (err) {
    if (signal?.aborted) return; // user closed the tab, nothing to say
    console.error("turn failed:", err);
    // once words are on screen we don't retry: the user would see them twice
    emit({ type: "error", message: friendly(err) });
    return;
  }

  if (!answer.trim()) {
    emit({ type: "error", message: "I didn't get an answer back. Try again?" });
    return;
  }

  const sources = [...cited.values()].slice(0, 12);
  if (sources.length > 0) emit({ type: "sources", sources });

  const exchangeId = saveExchange({ sessionId, ts: askedAt.getTime(), question: message, answer, sources });
  emit({ type: "done", exchangeId });

  // the user already has their answer. now write down what we claimed.
  recordLedger(ai, exchangeId, message, answer, sources);
}

function searching(queries?: string[]): string {
  return queries?.length ? `Searching: ${queries.slice(0, 3).join(" · ")}` : "Searching the web";
}

function friendly(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const text = err instanceof Error ? err.message : "";
  if (!process.env.GEMINI_API_KEY || status === 401 || status === 403 || /api key/i.test(text)) {
    return "The API key is missing or wrong. Check GEMINI_API_KEY in .env.";
  }
  if (status === 429) return "Rate limited. Give it a few seconds and try again.";
  if (status) return `The model returned an error (${status}). Try again.`;
  return "Something went wrong on my side. Try again.";
}
