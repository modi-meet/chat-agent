// Runs the three sample questions from the task against seeded memory and
// prints what a judge would look at: the answer, how long the first word took,
// and how many searches it made. Needs GEMINI_API_KEY. Run `npm run seed` first.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { runTurn } from "../src/agent.ts";
import { ledgerIdle } from "../src/ledger.ts";

const CASES = [
  {
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    // every shortlisted tool must show up, a missing one is a wrong answer
    mustMention: ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Close"],
    mustSearch: true,
  },
  {
    ask: "What did I ask you on 3 November? Is your answer still correct today?",
    mustMention: ["Node"],
    mustSearch: true,
  },
  {
    ask: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    mustMention: ["Neon", "Supabase", "RDS"],
    mustSearch: true,
  },
  {
    ask: "What did we talk about on 1 January 2020?",
    // nothing was recorded then. it should say so, not make something up.
    mustMention: [],
    mustSearch: false,
  },
];

let failed = 0;
for (const c of CASES) {
  const started = Date.now();
  let firstWord = 0;
  let searches = 0;
  let answer = "";
  let error = "";

  await runTurn({
    sessionId: randomUUID(), // fresh thread each time, so only memory can help
    message: c.ask,
    emit: (e) => {
      if (e.type === "text") {
        firstWord ||= Date.now() - started;
        answer += e.text;
      } else if (e.type === "status" && e.text.startsWith("Searching")) searches++;
      else if (e.type === "error") error = e.message;
    },
  });

  const missing = c.mustMention.filter((m) => !answer.toLowerCase().includes(m.toLowerCase()));
  const ok = !error && missing.length === 0 && (c.mustSearch ? searches > 0 : searches === 0);
  if (!ok) failed++;

  console.log(`\n${ok ? "PASS" : "FAIL"}  ${c.ask}`);
  console.log(`first word ${firstWord}ms, total ${Date.now() - started}ms, searches ${searches}`);
  if (error) console.log(`error: ${error}`);
  if (missing.length) console.log(`missing: ${missing.join(", ")}`);
  console.log(answer.trim());
}

await ledgerIdle();
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
