# Genetics Intelligence Agent

An always-available AI dairy-genetics analyst built into the platform. It answers
natural-language questions, decides which database tools to call, runs multiple
retrieval → analysis cycles, and grounds **every** conclusion in real records it
retrieved — it never invents bulls, IDs, or trait values.

The agent appears as a floating button in the lower-right of every page. Clicking
it opens a slide-out chat panel.

---

## Turning it on

The agent is **off until an administrator saves an Anthropic API key**. Nothing is
ever sent to Anthropic until then.

1. Sign in as an admin.
2. Go to **Admin Settings → AI Genetics Assistant**.
3. Paste an Anthropic API key (`sk-ant-…`) and click **Save**.
4. The badge flips to **Live** and the floating assistant starts answering.

The key is stored server-side in `EnvironmentConfig` (key `agent.anthropicApiKey`),
read only by server code, and never sent back to the browser (the field shows a
masked hint like `sk-ant…mnop`). **Remove key** turns the assistant back off.

Alternatively, set `ANTHROPIC_API_KEY` in the environment — a saved settings key
takes precedence over the env var.

### Model

Defaults to **`claude-sonnet-5`**. Override per environment with
`GENETICS_AGENT_MODEL`, or per install in the Admin Settings **Model** field
(stored as `agent.model`). There is no silent fallback to another model — the
configured model is the one used.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Key fallback if none saved in settings |
| `GENETICS_AGENT_MODEL` | `claude-sonnet-5` | Model id |
| `GENETICS_AGENT_MAX_TOKENS` | `4096` | Max output tokens per turn |

---

## How it works

A **manual tool-use loop** (`src/lib/agent/agent.ts`), deliberately not tied to any
one SDK helper so it stays robust across `@anthropic-ai/sdk` versions:

1. Send the question + system instructions + tool definitions to the model.
2. If the model requests tools, execute each against the real Prisma data layer and
   feed the rows back as `tool_result`.
3. Repeat (up to `MAX_ITERATIONS = 8`) until the model answers.
4. Return the answer **plus** every tool call and the records it examined, so the UI
   can show sources and the run can be logged.

Each run is written to the **audit log** (`entityType: "agent"`): the question, the
tools called, how many rows were examined, iteration count, and an answer preview.

### Safety properties

- **Read-only.** Every tool is a typed, parameterized Prisma query. No tool builds
  SQL from user text; the model supplies typed arguments only.
- **Grounded.** The system prompt forbids inventing data; "not in the database" is a
  valid answer. Trait names are mapped through a fixed allow-list (`traitCol`), never
  interpolated.
- **Gated.** No key → the API route returns `503 not_configured` and the panel shows
  a "switch me on" message instead of failing.
- **Bounded.** Hard iteration cap; tool results are truncated before being sent back;
  the question is length-capped and each user is rate-limited (20 req/min, in-memory)
  so an authenticated client can't run up token cost.
- **No HTML injection.** Charts are rendered from a structured JSON spec by the app's
  own trusted SVG components — the model never emits HTML that the browser executes.

## Understanding names & pedigrees

The system prompt teaches the agent to read registered names as **prefix + name**:
- "Stantons Alligator" → prefix *Stantons*, bull's name *Alligator* (never call the bull "Stantons").
- Cows read **prefix + sire + her name**: "Kings Ransom Hot Debbie" → prefix *Kings Ransom*, sire *Hot* (short for **Hotline**), her name *Debbie*.
- It recognises that the middle token of a cow's name is often an abbreviation of the sire, and reads pedigrees by relationship (Sire, Dam, MGS, …) with the male line driving the Pedigree Index.

## Visualizations (charts)

The agent can draw a **real chart** instead of an ASCII one. When a trend or comparison
helps, it emits a fenced block in its answer:

```
​```chart
{"type":"line","title":"…","yLabel":"LPI","series":[{"label":"…","points":[{"x":"2022-04","y":3980}]}]}
​```
```

`type` is `line` or `bars`. The panel ([answer-format.ts](../src/lib/agent/answer-format.ts))
extracts the block, drops it from the prose, and renders it with the app's `LineChart` /
`CompareBars` SVG components. Every chart has a **Full screen** button (Esc closes). The
agent may only chart values it actually retrieved — the same grounding rule as text.

### Clean, text-message output

Answers render as plain text, so the prompt tells the agent to write like a clear text
message — no markdown, and any list uses a simple "- " hyphen bullet. `cleanText()` is a
safety net that scrubs stray `**`, `#`, backticks and tables and normalises bullets.

---

## Tools

Defined in `src/lib/agent/tools.ts`. Add a capability by appending one entry
(`name`, `description`, `input_schema`, `run`) — the model reads the description to
decide when to call it.

| Tool | What it answers |
|---|---|
| `search_animals` | Find sires by name/registration, optional role & breed filters |
| `get_animal` | Full detail for one sire (preferred eval, status, rollback, proof rounds) |
| `rank_animals` | Top/bottom N by a trait (LPI, Pro$, Conf, Milk, Fat, Prot, Mamm, F&L, DS) |
| `lineup_stats` | Counts (proven/genomic/active/inactive) + average LPI/Pro$/Conf/… |
| `rollback_leaders` | Best/worst by Rollback Resistance or Proof Performance |
| `proof_history` | One sire's trait values across proof rounds, oldest→newest |
| `pedigree_index` | 3-generation pedigree + estimated Pedigree Index and confidence |

---

## Files

| Path | Responsibility |
|---|---|
| `src/lib/agent/config.ts` | Read key/model/limits; `isAgentConfigured()`, `maskKey()` |
| `src/lib/agent/instructions.ts` | System prompt (persona + hard rules) |
| `src/lib/agent/tools.ts` | The 7 parameterized data tools |
| `src/lib/agent/agent.ts` | The reasoning loop + run logging |
| `src/lib/agent/answer-format.ts` | Pure helpers: clean text, extract charts, split follow-ups |
| `src/lib/agent/agent.test.ts` | Tests (mocked client + mocked tools, no DB/network) |
| `src/app/api/agent/route.ts` | `GET` = configured?, `POST` = ask a question |
| `src/components/GeneticsAssistant.tsx` | Floating button + slide-out panel |
| `src/app/(app)/admin/actions.ts` | `saveAgentSettings`, `clearAgentKey` |

---

## Tests

```bash
npm run test:agent
```

Runs Node's built-in test runner via `tsx` — no extra dependency. It exercises the
full loop with a **mocked Anthropic client and mocked tools** (a retrieval→answer
cycle, a no-tool answer, a refusal, an unknown-tool recovery, the not-configured
error) and unit-tests the pure helpers (`traitCol`, `clamp`, `maskKey`). Nothing
touches the network or the database.

---

## Streaming & export

- **Streaming.** `POST /api/agent` returns newline-delimited JSON: `{type:"status"}`
  lines while it calls the database, `{type:"delta"}` for each text chunk, then one
  `{type:"done", result}`. The panel renders the answer token-by-token with a live
  cursor and a "Checking the database — …" status, then swaps in the fully-parsed
  answer (charts, sources, follow-ups) on `done`. Tests inject a fake streaming
  client; the loop falls back to a single blocking call when no listener is attached.
- **Export.** Every answer has an **Export** menu — Markdown, CSV (records), JSON
  (records), and Print/PDF — built by the pure helpers in `answer-export.ts`.

## Not yet built (planned increments)

These are deliberate follow-ups, not part of the current version:

- **Scheduled / standing monitoring** — reuse the same agent on a schedule to watch
  for changes and alert.
- **Autonomous multi-step investigations** surfaced as saved reports.
