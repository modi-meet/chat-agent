// Puts a few past conversations into memory so you can ask about
// "Monday", "last Tuesday" and "3 November" without waiting a week.
// This is sample data: the prices are what the agent "said then", not gospel.
// Only touches its own rows. Run it again any time.

import "dotenv/config";
import { formatDay, now } from "../src/clock.ts";
import { removeSession, saveExchange, saveLedger } from "../src/store.ts";

const SESSION = "seed";
const today = now();

// most recent given weekday strictly before today (0 = Sunday)
function lastWeekday(weekday: number, hour: number): Date {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, 12);
  do d.setDate(d.getDate() - 1);
  while (d.getDay() !== weekday);
  return d;
}

// 3 November, this year if it has passed, otherwise last year
function third(): Date {
  const d = new Date(today.getFullYear(), 10, 3, 16, 40);
  if (d > today) d.setFullYear(d.getFullYear() - 1);
  return d;
}

const chats = [
  {
    when: lastWeekday(1, 11),
    question: "We need a CRM for a 20-person sales team. Can you shortlist 5 tools with pricing?",
    answer: `Here's a shortlist of 5 for a 20-person sales team:

| Tool | Plan that fits | Price |
|---|---|---|
| HubSpot Sales Hub | Professional | $100 per seat per month |
| Pipedrive | Professional | $49 per seat per month, billed annually |
| Salesforce Sales Cloud | Pro Suite | $100 per user per month |
| Zoho CRM | Professional | $23 per user per month, billed annually |
| Close | Growth | $99 per seat per month, billed annually |

Zoho is the cheapest, Pipedrive is the easiest to roll out, and HubSpot or Salesforce make sense if marketing will share the system.`,
    topic: "CRM shortlist for 20-person sales team",
    claims: [
      ["HubSpot Sales Hub", "Shortlisted. Professional plan is $100 per seat per month.", "https://www.hubspot.com/pricing/sales"],
      ["Pipedrive", "Shortlisted. Professional plan is $49 per seat per month, billed annually.", "https://www.pipedrive.com/en/pricing"],
      ["Salesforce Sales Cloud", "Shortlisted. Pro Suite is $100 per user per month.", "https://www.salesforce.com/sales/pricing/"],
      ["Zoho CRM", "Shortlisted. Professional plan is $23 per user per month, billed annually.", "https://www.zoho.com/crm/zohocrm-pricing.html"],
      ["Close", "Shortlisted. Growth plan is $99 per seat per month, billed annually.", "https://www.close.com/pricing"],
    ],
  },
  {
    when: lastWeekday(2, 10),
    question: "What are good managed Postgres hosting options for a small SaaS, and what do they cost?",
    answer: `Three solid options for a small SaaS:

- **Neon**: serverless Postgres with a free tier. The Launch plan is usage-based with no monthly minimum.
- **Supabase**: Postgres plus auth and storage. The Pro plan is $25 per month per organisation and includes $10 of compute credit.
- **Amazon RDS for PostgreSQL**: the conventional choice. A db.t4g.micro instance is about $0.016 per hour in us-east-1, before storage.

For a small team I'd start on Neon or Supabase and move to RDS only if you need tight AWS networking.`,
    topic: "Managed Postgres hosting options and pricing",
    claims: [
      ["Neon", "Has a free tier. Launch plan is usage-based with no monthly minimum.", "https://neon.com/pricing"],
      ["Supabase", "Pro plan is $25 per month per organisation and includes $10 of compute credit.", "https://supabase.com/pricing"],
      ["Amazon RDS for PostgreSQL", "db.t4g.micro is about $0.016 per hour in us-east-1, before storage.", "https://aws.amazon.com/rds/postgresql/pricing/"],
    ],
  },
  {
    when: third(),
    question: "What's the latest LTS version of Node.js?",
    answer: "The latest LTS line is Node.js 24 (codename Krypton). Node.js 22 is still in maintenance LTS.",
    topic: "Latest Node.js LTS version",
    claims: [
      ["Node.js", "The latest LTS line is Node.js 24 (Krypton).", "https://nodejs.org/en/about/previous-releases"],
      ["Node.js", "Node.js 22 is in maintenance LTS.", "https://nodejs.org/en/about/previous-releases"],
    ],
  },
] as const;

removeSession(SESSION);
for (const c of chats) {
  const sources = [...new Set(c.claims.map((x) => x[2]))].map((url) => ({ url, title: new URL(url).hostname }));
  const id = saveExchange({ sessionId: SESSION, ts: c.when.getTime(), question: c.question, answer: c.answer, sources });
  saveLedger(id, c.topic, c.claims.map(([entity, claim, sourceUrl]) => ({ entity, claim, sourceUrl })));
  console.log(`${formatDay(c.when)}: ${c.topic}`);
}
console.log(`\nseeded ${chats.length} past chats. today is ${formatDay(today)}.`);
