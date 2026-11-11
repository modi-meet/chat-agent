// Everything the agent remembers lives in one SQLite file.
// Two tables: exchanges (what was said) and claims (what was asserted as fact).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Source = { url: string; title: string };

export type Exchange = {
  id: number;
  sessionId: string;
  ts: number; // ms since epoch, when the question was asked
  question: string;
  answer: string;
  sources: Source[];
  topic: string | null; // filled in later by the ledger
};

export type Claim = {
  exchangeId: number;
  ts: number;
  entity: string; // "HubSpot", "Neon"
  claim: string; // "Starter plan is $20 per seat per month"
  sourceUrl: string | null;
};

const file = process.env.DB_PATH ?? path.join(process.cwd(), "data", "memory.db");
if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS exchanges (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    topic TEXT
  );
  CREATE INDEX IF NOT EXISTS exchanges_ts ON exchanges (ts);
  CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges (session_id, ts);

  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY,
    exchange_id INTEGER NOT NULL REFERENCES exchanges (id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    entity TEXT NOT NULL,
    claim TEXT NOT NULL,
    source_url TEXT
  );
  CREATE INDEX IF NOT EXISTS claims_exchange ON claims (exchange_id);

  -- keyword search over past chats. rowid = exchange id.
  CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (question, answer, ledger, tokenize = 'porter');
`);

type Row = {
  id: number;
  session_id: string;
  ts: number;
  question: string;
  answer: string;
  sources: string;
  topic: string | null;
};

function toExchange(r: Row): Exchange {
  return {
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    question: r.question,
    answer: r.answer,
    sources: JSON.parse(r.sources),
    topic: r.topic,
  };
}

export function saveExchange(e: Omit<Exchange, "id" | "topic">): number {
  const info = db
    .prepare("INSERT INTO exchanges (session_id, ts, question, answer, sources) VALUES (?, ?, ?, ?, ?)")
    .run(e.sessionId, e.ts, e.question, e.answer, JSON.stringify(e.sources));
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO search (rowid, question, answer, ledger) VALUES (?, ?, ?, '')").run(
    id,
    e.question,
    e.answer,
  );
  return id;
}

// called once the background extraction is done
export function saveLedger(exchangeId: number, topic: string, claims: Omit<Claim, "exchangeId" | "ts">[]) {
  const ex = db.prepare("SELECT ts FROM exchanges WHERE id = ?").get(exchangeId) as { ts: number } | undefined;
  if (!ex) return;
  const insert = db.prepare(
    "INSERT INTO claims (exchange_id, ts, entity, claim, source_url) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("UPDATE exchanges SET topic = ? WHERE id = ?").run(topic, exchangeId);
    db.prepare("DELETE FROM claims WHERE exchange_id = ?").run(exchangeId);
    for (const c of claims) insert.run(exchangeId, ex.ts, c.entity, c.claim, c.sourceUrl);
    const ledgerText = [topic, ...claims.map((c) => `${c.entity} ${c.claim}`)].join("\n");
    db.prepare("UPDATE search SET ledger = ? WHERE rowid = ?").run(ledgerText, exchangeId);
  })();
}

export function exchangesBetween(start: number, end: number, limit = 8): Exchange[] {
  const rows = db
    .prepare("SELECT * FROM exchanges WHERE ts >= ? AND ts < ? ORDER BY ts LIMIT ?")
    .all(start, end, limit) as Row[];
  return rows.map(toExchange);
}

export function sessionExchanges(sessionId: string, limit = 20): Exchange[] {
  const rows = db
    .prepare("SELECT * FROM exchanges WHERE session_id = ? ORDER BY ts DESC LIMIT ?")
    .all(sessionId, limit) as Row[];
  return rows.reverse().map(toExchange);
}

// one line per past chat, newest last. the cheap "table of contents" of memory.
export function timeline(since: number, before: number, limit = 40): Exchange[] {
  const rows = db
    .prepare("SELECT * FROM exchanges WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?")
    .all(since, before, limit) as Row[];
  return rows.reverse().map(toExchange);
}

export function searchExchanges(words: string[], before: number, limit = 4): Exchange[] {
  if (words.length === 0) return [];
  // quote each word so user text can never break the fts query
  const query = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT e.* FROM search s JOIN exchanges e ON e.id = s.rowid
       WHERE search MATCH ? AND e.ts < ? ORDER BY bm25(search, 3.0, 1.0, 3.0) LIMIT ?`,
    )
    .all(query, before, limit) as Row[];
  return rows.map(toExchange);
}

export function claimsFor(exchangeIds: number[]): Map<number, Claim[]> {
  const out = new Map<number, Claim[]>();
  if (exchangeIds.length === 0) return out;
  const marks = exchangeIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT exchange_id, ts, entity, claim, source_url FROM claims WHERE exchange_id IN (${marks}) ORDER BY id`)
    .all(...exchangeIds) as { exchange_id: number; ts: number; entity: string; claim: string; source_url: string | null }[];
  for (const r of rows) {
    const list = out.get(r.exchange_id) ?? [];
    list.push({ exchangeId: r.exchange_id, ts: r.ts, entity: r.entity, claim: r.claim, sourceUrl: r.source_url });
    out.set(r.exchange_id, list);
  }
  return out;
}

// used by the seed script so re-seeding never touches real chats
export function removeSession(sessionId: string) {
  db.transaction(() => {
    db.prepare("DELETE FROM search WHERE rowid IN (SELECT id FROM exchanges WHERE session_id = ?)").run(sessionId);
    db.prepare("DELETE FROM claims WHERE exchange_id IN (SELECT id FROM exchanges WHERE session_id = ?)").run(sessionId);
    db.prepare("DELETE FROM exchanges WHERE session_id = ?").run(sessionId);
  })();
}
