// Builds the memory block that goes in front of every question.
// No model call here: date lookup + keyword search + a short timeline, all local.
// This is why memory isn't a tool. It's already in context when the model starts.

import { formatDay, formatDayTime } from "./clock.ts";
import { resolveDates } from "./dates.ts";
import {
  claimsFor,
  exchangesBetween,
  searchExchanges,
  timeline,
  type Claim,
  type Exchange,
} from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_DAYS = 45;

// words that say nothing about the topic
const STOP = new Set(
  `the and for are but not you your with have has had was were this that these those what when where which who whom
  why how did does any all can could would should will shall about from into than then them they their there here
  been being its our out over under just also still yet since ago last next today yesterday tomorrow week month year
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august
  september october november december asked ask told tell said say answer question correct changed change anything
  something some one two three four five big`.split(/\s+/),
);

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.-]+$/, "")).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 8);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} ... [cut]`;
}

function renderChat(e: Exchange, claims: Claim[], answerMax: number): string {
  const lines = [`<chat when="${formatDayTime(new Date(e.ts))}"${e.topic ? ` topic="${e.topic}"` : ""}>`];
  lines.push(`user asked: ${clip(e.question, 1000)}`);
  lines.push(`you answered: ${clip(e.answer, answerMax)}`);
  if (claims.length > 0) {
    lines.push("claims you made then:");
    for (const c of claims) lines.push(`- [${c.entity}] ${c.claim}${c.sourceUrl ? ` (${c.sourceUrl})` : ""}`);
  }
  lines.push("</chat>");
  return lines.join("\n");
}

export type Recall = { block: string; dated: number; related: number };

export function recall(message: string, now: Date, skipIds: Set<number> = new Set()): Recall {
  const ranges = resolveDates(message, now);
  const shown = new Set<number>(skipIds);
  const parts: string[] = [];
  let dated = 0;

  // 1. chats from the days the user pointed at
  for (const r of ranges) {
    const hits = exchangesBetween(r.start.getTime(), r.end.getTime()).filter((e) => !shown.has(e.id));
    const claims = claimsFor(hits.map((e) => e.id));
    const lastDay = new Date(r.end.getTime() - 1);
    const span =
      r.end.getTime() - r.start.getTime() <= DAY_MS + 3_600_000
        ? formatDay(r.start)
        : `${formatDay(r.start)} to ${formatDay(lastDay)}`;
    const body =
      hits.length === 0
        ? "nothing recorded for this date"
        : hits.map((e) => renderChat(e, claims.get(e.id) ?? [], 6000)).join("\n");
    parts.push(`<date_lookup user_said="${r.label}" resolved_to="${span}">\n${body}\n</date_lookup>`);
    for (const e of hits) shown.add(e.id);
    dated += hits.length;
  }

  // 2. chats about the same thing, whatever day they were on
  const related = searchExchanges(keywords(message), now.getTime(), 6)
    .filter((e) => !shown.has(e.id))
    .slice(0, 3);
  if (related.length > 0) {
    const claims = claimsFor(related.map((e) => e.id));
    parts.push(
      `<related_by_topic>\n${related.map((e) => renderChat(e, claims.get(e.id) ?? [], 2000)).join("\n")}\n</related_by_topic>`,
    );
    for (const e of related) shown.add(e.id);
  }

  // 3. one line per recent chat, so "what did we talk about lately" always works
  const recent = timeline(now.getTime() - TIMELINE_DAYS * DAY_MS, now.getTime());
  if (recent.length > 0) {
    const lines = recent.map((e) => `- ${formatDayTime(new Date(e.ts))}: ${e.topic ?? clip(e.question, 90)}`);
    parts.push(`<timeline last_days="${TIMELINE_DAYS}">\n${lines.join("\n")}\n</timeline>`);
  }

  const memory = parts.length > 0 ? parts.join("\n\n") : "no past conversations stored yet";
  const block = `<now>${formatDayTime(now)}</now>\n<memory>\n${memory}\n</memory>`;
  return { block, dated, related: related.length };
}
