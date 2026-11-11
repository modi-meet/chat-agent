import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDates } from "./dates.ts";

// Wednesday 11 November 2026, 2pm
const NOW = new Date(2026, 10, 11, 14, 0);
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const starts = (text: string) => resolveDates(text, NOW).map((r) => ymd(r.start));

test("a bare weekday means the most recent one", () => {
  assert.deepEqual(starts("On Monday we shortlisted 5 CRM tools"), ["2026-11-9"]);
});

test("a weekday that hasn't come yet this week rolls back a week", () => {
  assert.deepEqual(starts("what did we discuss on Friday"), ["2026-11-6"]);
});

test("'last Tuesday' keeps both readings", () => {
  assert.deepEqual(starts("Last Tuesday I asked you about Postgres hosting"), ["2026-11-10", "2026-11-3"]);
});

test("an explicit date resolves to that day", () => {
  const [r] = resolveDates("What did I ask you on 3 November?", NOW);
  assert.equal(ymd(r.start), "2026-11-3");
  assert.equal(ymd(r.end), "2026-11-4");
});

test("a date later in the year means last year", () => {
  assert.deepEqual(starts("what did we discuss on 20 December"), ["2025-12-20"]);
});

test("last week is Monday to Sunday", () => {
  const [r] = resolveDates("last week we talked about hosting", NOW);
  assert.equal(ymd(r.start), "2026-11-2");
  assert.equal(ymd(r.end), "2026-11-9");
});

test("a month is the whole month, in the past", () => {
  const [r] = resolveDates("what did I ask in March", NOW);
  assert.equal(ymd(r.start), "2026-3-1");
  assert.equal(ymd(r.end), "2026-4-1");
});

test("yesterday and no date at all", () => {
  assert.deepEqual(starts("what did I ask yesterday"), ["2026-11-10"]);
  assert.deepEqual(starts("may I ask what a CRM is"), []);
});
