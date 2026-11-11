// The claim ledger. After an answer is sent, a small model pulls out what was
// asserted (prices, versions, shortlists) so a later "has it changed?" can
// re-check specific claims instead of re-reading old prose.
// Runs after the user already has their answer, so it costs them no time.

import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LEDGER_SYSTEM } from "./prompt.ts";
import { saveLedger, type Source } from "./store.ts";

const MODEL = process.env.LEDGER_MODEL ?? "gemini-3.5-flash-lite";

const Ledger = z.object({
  topic: z.string(),
  claims: z.array(
    z.object({
      entity: z.string(),
      claim: z.string(),
      source_url: z.string().nullable(),
    }),
  ),
});
const LEDGER_SCHEMA = z.toJSONSchema(Ledger);

const pending = new Set<Promise<void>>();

// fire and forget. if this fails we still have the raw chat, so nothing is lost.
export function recordLedger(ai: GoogleGenAI, exchangeId: number, question: string, answer: string, sources: Source[]) {
  const job = extract(ai, exchangeId, question, answer, sources)
    .catch((err) => console.error(`ledger failed for exchange ${exchangeId}:`, err?.message ?? err))
    .finally(() => pending.delete(job));
  pending.add(job);
}

// scripts wait on this before they exit
export async function ledgerIdle() {
  await Promise.all([...pending]);
}

async function extract(ai: GoogleGenAI, exchangeId: number, question: string, answer: string, sources: Source[]) {
  // nothing worth a model call in "thanks!" / "you're welcome"
  if (answer.length < 200 && sources.length === 0) {
    saveLedger(exchangeId, question.slice(0, 80), []);
    return;
  }

  const sourceList = sources.map((s) => `- ${s.title}: ${s.url}`).join("\n") || "none";
  const res = await ai.interactions.create({
    model: MODEL,
    system_instruction: LEDGER_SYSTEM,
    input: `<question>\n${question}\n</question>\n\n<answer>\n${answer}\n</answer>\n\n<sources>\n${sourceList}\n</sources>`,
    // the model must reply in this exact JSON shape
    response_format: { type: "text", mime_type: "application/json", schema: LEDGER_SCHEMA },
    store: false,
  });

  // still check it ourselves: a schema on the request is a promise, not a proof
  const out = Ledger.parse(JSON.parse(res.output_text ?? ""));
  saveLedger(
    exchangeId,
    out.topic,
    out.claims.slice(0, 30).map((c) => ({ entity: c.entity, claim: c.claim, sourceUrl: c.source_url })),
  );
}
