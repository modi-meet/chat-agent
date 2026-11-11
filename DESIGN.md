# Design

## The idea in one line
Remember claims, not just chats. Every sample question is "something we discussed on day X, is it still true?", so the agent keeps a dated ledger of what it asserted and re-checks those exact claims with search.

## How a turn works
```
message
  -> dates.ts    "Monday", "last Tuesday", "3 November" become real day ranges (code, no model)
  -> recall.ts   pull chats from those days + chats on the same topic + a one-line timeline (local SQLite, no model call)
  -> agent.ts    one streamed model call. context = <now> + <memory> + the question. one tool: web search
  -> browser     text, search status and citations stream as they happen. always ends in done or error
  -> store.ts    save the question, answer and sources with a timestamp
  -> ledger.ts   after the reply is sent, a small model writes down the claims (entity, fact, source)
```
Next week's "has HubSpot's price changed since Monday?" gets Monday's claims handed to it, searches each one, and answers then versus now.

## Why it's built this way
- **Memory is context, not a tool.** The task says one tool. Recall is deterministic and local, so it's in the prompt before the model starts. No extra round trip, and the model can't forget to look.
- **Dates are resolved in code.** Models are shaky at "what date was last Tuesday". A parser plus a few rules is exact and testable. Loose phrases keep both readings ("last Tuesday" on a Wednesday is yesterday or a week ago) and the stored chats settle it. An empty day is stated outright, so the agent says "nothing recorded" instead of inventing a chat.
- **Three ways in.** By date, by topic (full-text search), and a 45-day timeline. If the user gets the day wrong, topic or timeline still finds it and the agent names the real date.
- **The ledger runs after the answer.** It costs the user zero wait. If it fails, the raw chat is still there, so recall degrades instead of breaking.
- **Search runs on the model provider's side.** Gemini's built-in Google Search: the model sends several queries in one go and citations come back tied to the exact sentence. One API key, no search client to maintain.
- **Fast by default.** A Flash model for chat and Flash-Lite for the ledger, streaming, low thinking level, no search for small talk or pure memory questions, and only the last 10 turns are replayed (older ones come back through recall).
- **The system prompt never changes.** Time and memory travel with the user message, so the prompt stays stable and easy to reason about.
- **Boring storage.** One SQLite file, two tables. `npm install` is the whole setup.

## Considered and rejected
- **Memory as a second tool.** Breaks the one-tool rule and adds a model round trip to every memory question.
- **Embeddings / vector DB.** The hard part here is *when*, not fuzzy meaning. Dates plus keyword search cover it with no extra service or key.
- **Stuffing all history into the prompt.** Works for a week, then gets slow and expensive, and the model still has to find the claims in prose.
- **Planner + sub-agents + verifier.** Several model calls before the first word. It doesn't help memory questions at all. I kept the one useful part: parallel searches.
- **Summarising old chats.** Summaries drop the exact numbers, and exact numbers are the whole point of "has pricing changed".
- **My own search API client (Brave/Tavily).** More control, but a second key and result-cleaning code for no gain at this size.
- **A framework.** The loop is about 100 lines. Owning it means I can explain every line.

## What I'd do with another week
- **Re-check in the background.** A nightly job that re-verifies stored claims, so "has it changed?" answers instantly and can even tell you first.
- **Fetch the cited page** for price claims instead of trusting a search snippet.
- **Claim history.** Link a re-checked claim to the old one, so the agent can show how a price moved over time.
- **Bigger eval set with a judge model**, plus a scripted fake model so the loop can be tested with no key.
- **Per-user memory and timezones.** Today it's one user, and dates use the machine's timezone.
- **Let the user fix memory** ("that's wrong, forget it").
