// One turn of the agent: remember, ask the model, stream, save, then ledger.
// The model has exactly one tool (Google Search, run on Gemini's side).
// Memory is not a tool: recall() puts it in context before the model starts.

import { GoogleGenAI } from "@google/genai";
import { now } from "./clock.ts";
import { recordLedger } from "./ledger.ts";
import { SYSTEM } from "./prompt.ts";
import { recall } from "./recall.ts";
import { saveExchange, sessionExchanges, type Source } from "./store.ts";

// default is the one model with free Google Search. on a paid key, gemini-3.8-flash is better.
const MODEL = process.env.CHAT_MODEL ?? "gemini-2.5-flash";
const THINKING = (process.env.THINKING_LEVEL ?? "low") as "low" | "medium" | "high";
const HISTORY_TURNS = 10; // older turns come back through recall, not replay

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" }) // 2.5 only does search on v1beta;

// what the browser gets. every stream ends with "done" or "error", never silence.
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "reset" } // throw away the text so far, a better answer is starting
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
  const cited = new Map<string, Source>();

  // gemini 2.5 sometimes writes some text, searches, then carries on in the same step
  // with nothing in between ("...April 2027.On Tuesday..."). two cases:
  //  - it starts the same answer over: drop the first draft, it was written before the search
  //  - it just carries on: put the missing paragraph break back
  // we hold the first few chars after such a seam to see which one it is.
  const PEEK = 24;
  let stepStart = 0; // where this text step begins in `answer`
  let raw = 0; // chars the model has sent in this step, before our edits
  let seamAt = 0; // raw position of the last seam
  let shift = 0; // what to add to a citation offset that sits after the seam
  let droppedDraft = false;
  let held: string | null = null;

  const add = (text: string) => {
    answer += text;
    emit({ type: "text", text });
  };
  const settle = () => {
    if (held === null) return;
    const draft = answer.slice(stepStart);
    const n = Math.min(PEEK, held.length);
    if (n >= 8 && draft.startsWith(held.slice(0, n))) {
      answer = answer.slice(0, stepStart);
      emit({ type: "reset" });
      if (answer) emit({ type: "text", text: answer });
      shift = -seamAt;
      droppedDraft = true;
    } else {
      add("\n\n");
      shift += 2;
    }
    add(held);
    held = null;
  };

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
        // some models put the queries on the start event, others send them in a delta
        if (event.step.type === "google_search_call" && event.step.arguments?.queries?.length) {
          emit({ type: "status", text: searching(event.step.arguments.queries) });
        }
        if (event.step.type === "model_output") {
          stepStart = answer.length;
          raw = seamAt = shift = 0;
          droppedDraft = false;
        }
      } else if (event.event_type === "step.stop") {
        settle();
      } else if (event.event_type === "step.delta") {
        const d = event.delta;
        if (d.type === "text") {
          if (held !== null) {
            held += d.text;
            if (held.length >= PEEK) settle();
          } else if (answer.length > stepStart && /[.!?:]$/.test(answer) && /^[A-Z#]/.test(d.text)) {
            seamAt = raw;
            held = d.text;
            if (held.length >= PEEK) settle();
          } else {
            add(d.text);
          }
          raw += d.text.length;
        } else if (d.type === "google_search_call") {
          emit({ type: "status", text: searching(d.arguments?.queries) });
        } else if (d.type === "text_annotation_delta") {
          settle();
          for (const a of d.annotations ?? []) {
            if (a.type !== "url_citation" || !a.url) continue;
            const end = a.end_index;
            if (end !== undefined && droppedDraft && end <= seamAt) continue; // pointed into the dropped draft
            const source = { url: a.url, title: a.title ?? a.url };
            if (!cited.has(source.url)) cited.set(source.url, source);
            emit({ type: "cite", source, at: end === undefined ? undefined : stepStart + end + (end > seamAt ? shift : 0) });
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
