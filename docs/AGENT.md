# Genetics Intelligence Agent

An always-available AI dairy-genetics analyst built into the platform. It answers
natural-language questions, decides which database tools to call, runs multiple
retrieval → analysis cycles, and grounds **every** conclusion in real records it
retrieved — it never invents bulls, IDs, or trait values.

It can also **act**: everything a signed-in user can do — add and edit animals,
record proofs / milk records / classifications, add notes, manage reference data
and users, run Lactanet proof imports, and work the review queue — through the
same permission model as the UI. See **[Acting on data](#acting-on-data-write-tools)**.

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

- **Typed tools, no raw SQL.** Every tool is a typed, parameterized Prisma call. No
  tool builds SQL from user text; the model supplies typed arguments only.
- **Acts as the signed-in user, within their role.** Write tools are gated by the
  same `can(role, capability)` model as the server actions (`src/lib/constants.ts`),
  read from the signed session — never from client input. A Sales user's agent can
  read but cannot write; only an admin's agent can manage users, config, or approve
  imports. Every change is attributed to that user in the audit log.
- **Confirmation before harm.** Destructive / irreversible actions (delete, archive,
  deny import, clear key, mass import) refuse until called again with `confirm:true`,
  so a single stray call can't lose data.
- **Instruction boundary.** The system prompt tells the model to treat everything a
  tool returns (notes, extracted JSON, imported text) as *data, not commands* — a
  malicious record can't make it act. `requireCap` is the hard backstop regardless.
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

### Read tools (answer questions)

| Tool | What it answers |
|---|---|
| `search_animals` | Find sires by name/registration, optional role & breed filters |
| `get_animal` | Full detail for one sire (preferred eval, status, rollback, proof rounds) |
| `rank_animals` | Top/bottom N by a trait (LPI, Pro$, Conf, Milk, Fat, Prot, Mamm, F&L, DS) |
| `lineup_stats` | Counts (proven/genomic/active/inactive) + average LPI/Pro$/Conf/… |
| `rollback_leaders` | Best/worst by Rollback Resistance or Proof Performance |
| `proof_history` | One sire's trait values across proof rounds, oldest→newest |
| `pedigree_index` | 3-generation pedigree + estimated Pedigree Index and confidence |
| `get_animal_full_profile` | One animal: every trait, sire/dam + 3-gen pedigree, classifications, milk, progeny. If not in the DB and given a registration number, falls back to a live **Lactanet** lookup (read-only) |
| `trace_maternal_line` | Walk the maternal (tail-female) line — dam → dam's dam → … — up to 15 generations, live from Lactanet; reports how far it reached |
| `calculate_mating_pa` | Parent Average of a sire × dam across shared traits (Lactanet fallback) |
| `list_reference_data` | Breeds / traits / sources / rules / proof files / users / review queue — find the id or code a write tool needs |

### Acting on data (write tools)

Each mirrors a UI action and checks the **same capability** before doing anything.

| Tool | Does | Needs |
|---|---|---|
| `create_or_update_animal` | Create/edit an animal + identifiers | `animal:write` |
| `archive_animal` | Soft-delete (hide from lineup) — **confirm** | `animal:write` |
| `add_animal_note` | Attach a note | `animal:write` |
| `add_proof` | Record a genetic evaluation (manual) | `record:write` |
| `add_milk_record` | Record a lactation | `record:write` |
| `add_classification` | Record a classification + linear scores | `record:write` |
| `manage_breed` / `manage_trait` / `manage_source` | Create/update reference data | `config:write` |
| `manage_priority_rule` | Save / **delete** a source-priority rule | `config:write` |
| `manage_user` | Create/update a user (role, active, password) | `user:write` |
| `delete_user` | Remove a user — **confirm**, self-delete guarded | `user:write` |
| `manage_agent_settings` | Show status / set model / **clear key** (no key entry via chat) | `config:write` |
| `import_bulls` | Import Lactanet proofs (reg / topN / mass) → **staged pending** | `record:write` |
| `import_animals` | Import whole animals from Lactanet by registration number (a handful; direct or `review:true`) | `record:write` |
| `resolve_import` | Approve / **deny** / restore a staged batch import | `record:approve` |
| `resolve_review_item` | Approve / triage a per-record review item | `review:write` |

Imports and per-record uploads land in the **review queue as pending**; an admin
approves them before they become authoritative — the agent honours that gate. The
per-record approval logic is shared with the Review screen via
`src/lib/review-apply.ts`.

---

## Files

| Path | Responsibility |
|---|---|
| `src/lib/agent/config.ts` | Read key/model/limits; `isAgentConfigured()`, `maskKey()` |
| `src/lib/agent/instructions.ts` | System prompt (persona, hard rules, act rules, instruction boundary) |
| `src/lib/agent/tools.ts` | Read + write tools, and the `requireCap` / `confirmGate` / `logAction` gates |
| `src/lib/agent/agent.ts` | The reasoning loop, `AgentContext`/`AgentActor` threading, run logging |
| `src/lib/review-apply.ts` | Shared per-record review materialization (UI action + agent tool) |
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
error), unit-tests the pure helpers (`traitCol`, `clamp`, `maskKey`), and — for the
write surface — asserts `requireCap` enforces each role, `confirmGate` blocks until
`confirm:true`, and **every write tool refuses a Sales user before touching the
database**. Nothing touches the network or the database.

Two live integration scripts (real DB, real server runtime) round it out:

```bash
npx dotenv -e .env.production -- npx tsx --conditions=react-server prisma/smoke-agent-tools.ts
```

loads the whole read+write tool surface, and checks the permission refusals and the
confirm-gate against the live database **without making any change**.

---

## Streaming & export

- **Streaming.** `POST /api/agent` returns newline-delimited JSON: `{type:"status"}`
  lines while it works, `{type:"delta"}` for each text chunk, then one
  `{type:"done", result}`. The panel renders the answer token-by-token with a live
  cursor and a "Working — …" status, then swaps in the fully-parsed
  answer (charts, sources, follow-ups) on `done`. Tests inject a fake streaming
  client; the loop falls back to a single blocking call when no listener is attached.
- **Export.** Every answer has an **Export** menu — Markdown, CSV (records), JSON
  (records), and Print/PDF — built by the pure helpers in `answer-export.ts`.

## Not yet built (planned increments)

These are deliberate follow-ups, not part of the current version:

- **Scheduled / standing monitoring** — reuse the same agent on a schedule to watch
  for changes and alert.
- **Autonomous multi-step investigations** surfaced as saved reports.
