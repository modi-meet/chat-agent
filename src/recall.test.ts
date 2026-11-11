import assert from "node:assert/strict";
import { test } from "node:test";

// in-memory database, set before the store module loads
process.env.DB_PATH = ":memory:";
const { saveExchange, saveLedger } = await import("./store.ts");
const { recall, keywords } = await import("./recall.ts");

const NOW = new Date(2026, 10, 11, 14, 0); // Wednesday 11 November 2026
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime();

const crm = saveExchange({ sessionId: "a", ts: at(9), question: "Shortlist 5 CRM tools", answer: "HubSpot, Pipedrive...", sources: [] });
saveLedger(crm, "CRM shortlist", [{ entity: "HubSpot", claim: "Professional is $100 per seat", sourceUrl: "https://hubspot.com/pricing" }]);
const pg = saveExchange({ sessionId: "b", ts: at(3), question: "Good Postgres hosting?", answer: "Neon, Supabase, RDS", sources: [] });
saveLedger(pg, "Postgres hosting options", [{ entity: "Supabase", claim: "Pro is $25 per month", sourceUrl: null }]);

test("a date pulls in that day's chat with its claims", () => {
  const r = recall("On Monday we shortlisted 5 CRM tools. Anything changed?", NOW);
  assert.equal(r.dated, 1);
  assert.match(r.block, /resolved_to="Monday 9 November 2026"/);
  assert.match(r.block, /\[HubSpot\] Professional is \$100 per seat \(https:\/\/hubspot\.com\/pricing\)/);
});

test("'last Tuesday' finds the chat a week back and says the other day was empty", () => {
  const r = recall("Last Tuesday I asked you about Postgres hosting", NOW);
  assert.equal(r.dated, 1);
  assert.match(r.block, /resolved_to="Tuesday 10 November 2026">\nnothing recorded/);
  assert.match(r.block, /resolved_to="Tuesday 3 November 2026">\n<chat/);
});

test("an empty day is stated, not skipped", () => {
  const r = recall("What did I ask you on 5 November?", NOW);
  assert.equal(r.dated, 0);
  assert.match(r.block, /nothing recorded for this date/);
});

test("no date still finds the chat by topic", () => {
  const r = recall("has the Supabase price moved?", NOW);
  assert.equal(r.related, 1);
  assert.match(r.block, /<related_by_topic>/);
});

test("the timeline lists every recent chat and the clock is included", () => {
  const r = recall("hello", NOW);
  assert.match(r.block, /<now>Wednesday 11 November 2026, 14:00<\/now>/);
  assert.match(r.block, /Monday 9 November 2026, 10:00: CRM shortlist/);
  assert.match(r.block, /Tuesday 3 November 2026, 10:00: Postgres hosting options/);
});

test("chats already in the current thread are not repeated", () => {
  const r = recall("On Monday we shortlisted 5 CRM tools", NOW, new Set([crm]));
  assert.equal(r.dated, 0);
});

test("keywords drop filler and date words", () => {
  assert.deepEqual(keywords("Last Tuesday I asked you about Postgres hosting"), ["postgres", "hosting"]);
});
