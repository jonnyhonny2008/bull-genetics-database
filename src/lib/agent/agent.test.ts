// ---------------------------------------------------------------------------
// Genetics Intelligence Agent — tests.
//
// Runs with Node's built-in test runner via tsx (no extra dependency):
//   npm run test:agent
//
// The agent loop is exercised with a MOCKED Anthropic client and MOCKED tools,
// so nothing here touches the network or the database. The pure helpers
// (traitCol, clamp, maskKey) are unit-tested directly.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { askGeneticsAgent, type MessagesClient, type AgentDeps, type AgentStream } from "./agent";
import type { AgentConfig } from "./config";
import { maskKey } from "./config";
import { traitCol, usTraitCol, systemOf, clamp, type AgentTool, AGENT_TOOLS, requireCap, confirmGate, type AgentContext } from "./tools";
import { AGENT_SYSTEM_PROMPT } from "./instructions";
import { cleanText, extractCharts, splitFollowups } from "./answer-format";
import { slugify, recordsToRows, rowsToCsv, reportMarkdown } from "./answer-export";

const TEST_CONFIG: AgentConfig = {
  apiKey: "sk-ant-test-key-0000000000",
  model: "claude-sonnet-5-test",
  maxTokens: 1024,
  temperature: null,
  configured: true,
  source: "settings",
};

// A message the loop can read: it only inspects .stop_reason and .content.
function msg(stop_reason: string, content: unknown[]): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "x", stop_reason, stop_sequence: null, content } as unknown as Anthropic.Message;
}

// A mock client that plays back a scripted list of responses, one per turn.
function scriptedClient(script: Anthropic.Message[]): { client: MessagesClient; calls: () => number } {
  let i = 0;
  const client: MessagesClient = {
    messages: {
      create: async () => {
        const r = script[Math.min(i, script.length - 1)];
        i++;
        return r;
      },
    },
  };
  return { client, calls: () => i };
}

// A fake tool that returns two records without any DB access.
function fakeStatsTool(spy: { ran: boolean }): AgentTool {
  return {
    name: "fake_stats",
    description: "test tool",
    input_schema: { type: "object", properties: {} },
    run: async () => { spy.ran = true; return { summary: "2 sires", records: [{ name: "A" }, { name: "B" }] }; },
  };
}

test("runs a retrieval→answer cycle: calls a tool, then answers with its records", async () => {
  const spy = { ran: false };
  const { client, calls } = scriptedClient([
    msg("tool_use", [{ type: "tool_use", id: "tu_1", name: "fake_stats", input: {} }]),
    msg("end_turn", [{ type: "text", text: "There are 2 sires.\nFollow-ups: Which is best?" }]),
  ]);

  const deps: AgentDeps = { config: TEST_CONFIG, createClient: () => client, tools: [fakeStatsTool(spy)], log: false };
  const res = await askGeneticsAgent("How many sires?", [], deps);

  assert.equal(spy.ran, true, "the tool should have executed");
  assert.equal(calls(), 2, "the loop should have made two model calls");
  assert.match(res.answer, /2 sires/);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, "fake_stats");
  assert.equal(res.toolCalls[0].summary, "2 sires");
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0].tool, "fake_stats");
  assert.deepEqual(res.records[0].records, [{ name: "A" }, { name: "B" }]);
  assert.equal(res.refused, false);
  assert.equal(res.model, "claude-sonnet-5-test");
});

test("streams text deltas and a tool-status event when onEvent is provided", async () => {
  const script = [
    msg("tool_use", [{ type: "tool_use", id: "tu_1", name: "fake_stats", input: {} }]),
    msg("end_turn", [{ type: "text", text: "There are 2 sires." }]),
  ];
  let i = 0;
  const client: MessagesClient = {
    messages: {
      create: async () => script[Math.min(i, script.length - 1)],
      stream: () => {
        const cur = script[Math.min(i, script.length - 1)];
        i++;
        const texts = (cur.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "");
        const handlers: Record<string, (t: string) => void> = {};
        const s: AgentStream = {
          on(ev, cb) { handlers[ev] = cb; return s; },
          async finalMessage() { for (const t of texts) handlers["text"]?.(t); return cur; },
        };
        return s;
      },
    },
  };
  const events: { type: string; text: string }[] = [];
  const spy = { ran: false };
  const res = await askGeneticsAgent("How many sires?", [], {
    config: TEST_CONFIG, createClient: () => client, tools: [fakeStatsTool(spy)], log: false,
    onEvent: (e) => events.push(e),
  });
  assert.equal(spy.ran, true);
  assert.match(res.answer, /2 sires/);
  assert.ok(events.some((e) => e.type === "status"), "should emit a tool-status event");
  assert.ok(events.some((e) => e.type === "delta" && /2 sires/.test(e.text)), "should emit a text delta");
});

test("answers directly when no tool is needed", async () => {
  const { client } = scriptedClient([msg("end_turn", [{ type: "text", text: "Hello." }])]);
  const res = await askGeneticsAgent("hi", [], { config: TEST_CONFIG, createClient: () => client, tools: [], log: false });
  assert.equal(res.toolCalls.length, 0);
  assert.match(res.answer, /Hello/);
});

test("honours a model refusal without inventing an answer", async () => {
  const { client } = scriptedClient([msg("refusal", [])]);
  const res = await askGeneticsAgent("do something disallowed", [], { config: TEST_CONFIG, createClient: () => client, tools: [], log: false });
  assert.equal(res.refused, true);
  assert.match(res.answer, /can't help/i);
});

test("reports an unknown tool back to the model instead of crashing", async () => {
  const { client } = scriptedClient([
    msg("tool_use", [{ type: "tool_use", id: "tu_x", name: "does_not_exist", input: {} }]),
    msg("end_turn", [{ type: "text", text: "Recovered." }]),
  ]);
  const res = await askGeneticsAgent("q", [], { config: TEST_CONFIG, createClient: () => client, tools: [], log: false });
  assert.match(res.answer, /Recovered/);
  assert.equal(res.records.length, 0);
});

test("throws AgentNotConfiguredError when no key is present", async () => {
  const notConfigured: AgentConfig = { ...TEST_CONFIG, apiKey: null, configured: false, source: null };
  await assert.rejects(
    () => askGeneticsAgent("q", [], { config: notConfigured, log: false }),
    /not configured/i,
  );
});

test("traitCol maps friendly trait names to evaluation columns", () => {
  assert.equal(traitCol("LPI"), "lpi");
  assert.equal(traitCol("pro$"), "proDollar");
  assert.equal(traitCol("conformation"), "conf");
  assert.equal(traitCol("Feet & Legs"), "fl");
  assert.equal(traitCol(undefined), "lpi");
  assert.equal(traitCol("nonsense"), "lpi"); // safe default, never raw SQL
});

test("usTraitCol maps the American vocabulary and never falls back to a Canadian column", () => {
  assert.equal(usTraitCol("gtpi"), "tpi");
  assert.equal(usTraitCol("NM$"), "nmDollar");
  assert.equal(usTraitCol("net merit"), "nmDollar");
  assert.equal(usTraitCol("ptat"), "ptat");
  assert.equal(usTraitCol("rump angle"), "rpa");
  assert.equal(usTraitCol(undefined), "tpi");
  assert.equal(usTraitCol("nonsense"), "tpi");
  // "milk" and "protein" exist in both vocabularies and must resolve to the US
  // column here — a Canadian column name would be a kilogram value in a pounds
  // answer, the single worst bug this feature can have.
  assert.equal(usTraitCol("milk"), "milk");
  assert.equal(usTraitCol("protein"), "pro");
  assert.notEqual(usTraitCol("protein"), traitCol("protein"));
  assert.equal(usTraitCol("lpi"), "tpi"); // a Canadian index has no US column
});

test("systemOf defaults to Canada and only 'us' switches systems", () => {
  assert.equal(systemOf({}), "ca");
  assert.equal(systemOf({ system: "ca" }), "ca");
  assert.equal(systemOf({ system: "US" }), "us");
  assert.equal(systemOf({ system: " us " }), "us");
  assert.equal(systemOf({ system: "america" }), "ca"); // anything unrecognised stays Canadian
  assert.equal(systemOf({ system: 1 }), "ca");
});

test("every read tool that reads evaluations offers the system argument", () => {
  const dualSystem = ["search_animals", "get_animal", "rank_animals", "lineup_stats", "rollback_leaders", "proof_history", "get_animal_full_profile"];
  for (const name of dualSystem) {
    const t = AGENT_TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} is missing`);
    const props = (t!.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props.system?.enum, ["ca", "us"], `${name} has no system argument`);
  }
});

test("the US side refuses what has no American meaning", async () => {
  const ctx: AgentContext = { actor: { uid: "u", name: "U", role: "admin" } };
  // Rollback Resistance measures Canada's annual April re-basing; the US does not
  // re-base annually, so the tool must refuse rather than return Canadian scores.
  const rollback = await AGENT_TOOLS.find((t) => t.name === "rollback_leaders")!.run({ system: "us" }, ctx);
  assert.equal(rollback.records, null);
  assert.match(rollback.summary, /do not exist on the American side/i);

  // Rump angle has an intermediate optimum — there is no top of that list.
  const ranked = await AGENT_TOOLS.find((t) => t.name === "rank_animals")!.run({ system: "us", trait: "rpa" }, ctx);
  assert.equal(ranked.records, null);
  assert.match(ranked.summary, /INTERMEDIATE OPTIMUM/);

  // A breed CDCB does not publish is named, not silently filtered to nothing.
  const searched = await AGENT_TOOLS.find((t) => t.name === "search_animals")!.run({ system: "us", breed: "Zebu" }, ctx);
  assert.equal(searched.records, null);
  assert.match(searched.summary, /CDCB publishes bull evaluations for/);
});

test("the instructions state the rules that keep the two systems apart", () => {
  // These are product requirements, not prose preferences: an agent that loses
  // any one of them can produce a confidently wrong cross-country answer.
  assert.match(AGENT_SYSTEM_PROMPT, /POUNDS/);
  assert.match(AGENT_SYSTEM_PROMPT, /KILOGRAMS/);
  assert.match(AGENT_SYSTEM_PROMPT, /NOT comparable/i);
  assert.match(AGENT_SYSTEM_PROMPT, /GTPI is CALCULATED/i);
  assert.match(AGENT_SYSTEM_PROMPT, /Holstein Association USA/);
  assert.match(AGENT_SYSTEM_PROMPT, /THERE IS NO INTERIM PROOF/);
  assert.match(AGENT_SYSTEM_PROMPT, /NO ROLLBACK RESISTANCE/);
  assert.match(AGENT_SYSTEM_PROMPT, /INTERMEDIATE OPTIMUM/);
  assert.match(AGENT_SYSTEM_PROMPT, /PER TRAIT GROUP/);
  assert.match(AGENT_SYSTEM_PROMPT, /AI-status file/);
});

test("clamp bounds numeric input and falls back on garbage", () => {
  assert.equal(clamp("15", 1, 50, 10), 15);
  assert.equal(clamp(999, 1, 50, 10), 50);
  assert.equal(clamp(0, 1, 50, 10), 1);
  assert.equal(clamp("abc", 1, 50, 10), 10);
  assert.equal(clamp(undefined, 1, 30, 5), 5);
});

test("maskKey never leaks the full key", () => {
  assert.equal(maskKey(null), "not set");
  assert.equal(maskKey(""), "not set");
  assert.equal(maskKey("short"), "set");
  const masked = maskKey("sk-ant-abcdefghijklmnop");
  assert.match(masked, /^sk-ant…mnop$/);
  assert.ok(!masked.includes("abcdefghij"));
});

test("cleanText strips markdown and leaves clean text-message prose", () => {
  const out = cleanText("**Stantons Alligator** leads.\n## Notes\n* first\n* second\n`code` and | a | b |");
  assert.ok(!out.includes("**"), "no bold markers");
  assert.ok(!out.includes("#"), "no headings");
  assert.ok(!out.includes("`"), "no code ticks");
  assert.ok(!/\|/.test(out), "no table pipes");
  assert.match(out, /- first/);
  assert.match(out, /- second/);
  assert.match(out, /Stantons Alligator leads\./);
});

test("cleanText normalises every bullet style to a hyphen", () => {
  assert.match(cleanText("• one"), /^- one$/);
  assert.match(cleanText("* two"), /^- two$/);
  assert.match(cleanText("– three"), /^- three$/);
});

test("extractCharts pulls a chart block out and leaves the prose", () => {
  const answer = 'His LPI climbed.\n```chart\n{"type":"line","title":"LPI","series":[{"label":"X","points":[{"x":"2022","y":10}]}]}\n```\nUp 200 points.';
  const { text, charts } = extractCharts(answer);
  assert.equal(charts.length, 1);
  assert.equal(charts[0].type, "line");
  assert.equal(charts[0].title, "LPI");
  assert.ok(!text.includes("```"), "chart block removed from prose");
  assert.match(text, /His LPI climbed/);
  assert.match(text, /Up 200 points/);
});

test("extractCharts drops a malformed chart block without throwing", () => {
  const { text, charts } = extractCharts("Here.\n```chart\n{not valid json}\n```\nDone.");
  assert.equal(charts.length, 0);
  assert.ok(!text.includes("```"));
  assert.match(text, /Here/);
  assert.match(text, /Done/);
});

test("splitFollowups separates the answer body from suggestion chips", () => {
  const { body, followups } = splitFollowups("The answer.\nFollow-ups: What about Conformation? How does he compare?");
  assert.equal(body, "The answer.");
  assert.equal(followups.length, 2);
  assert.match(followups[0], /Conformation/);
});

test("slugify makes a safe filename base", () => {
  assert.equal(slugify("Chart BLONDIN DAKOTA's LPI!"), "chart-blondin-dakota-s-lpi");
  assert.equal(slugify(""), "genetics-report");
  assert.equal(slugify("   "), "genetics-report");
});

test("recordsToRows flattens tool records and tags each with its source", () => {
  const rows = recordsToRows([
    { tool: "rank_animals", records: [{ name: "A", lpi: 4065 }, { name: "B", lpi: 3980 }] },
    { tool: "lineup_stats", records: { total: 300, proofRounds: 14000 } },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source, "rank_animals");
  assert.equal(rows[0].name, "A");
  assert.equal(rows[2].source, "lineup_stats");
  assert.equal(rows[2].total, 300);
});

test("rowsToCsv writes a header and RFC-4180-quotes commas and quotes", () => {
  const csv = rowsToCsv([{ name: "STANTONS ALLIGATOR", note: 'a, b "c"' }, { name: "X", lpi: 10 }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "name,note,lpi");
  assert.match(lines[1], /"a, b ""c"""/);
  assert.equal(lines[2], "X,,10");
});

test("reportMarkdown includes question, answer, sources and records", () => {
  const md = reportMarkdown({
    question: "Who leads on LPI?",
    answer: "Stantons Alligator leads at 4065.",
    tools: [{ name: "rank_animals", summary: "Top 1 by lpi." }],
    records: [{ tool: "rank_animals", records: [{ name: "Stantons Alligator", lpi: 4065 }] }],
  });
  assert.match(md, /^# Genetics report/);
  assert.match(md, /Question: Who leads on LPI\?/);
  assert.match(md, /Stantons Alligator leads at 4065\./);
  assert.match(md, /## Sources/);
  assert.match(md, /- rank_animals: Top 1 by lpi\./);
  assert.match(md, /## Records/);
});

// ---------------------------------------------------------------------------
// Write-tool guardrails. These are the security boundary that lets the agent
// act "as the signed-in user" without ever exceeding their role. They run
// without a database because every write tool checks the permission FIRST.
// ---------------------------------------------------------------------------

test("requireCap enforces the role's capabilities", () => {
  const admin: AgentContext = { actor: { uid: "u1", name: "Admin", role: "admin" } };
  const sales: AgentContext = { actor: { uid: "u2", name: "Sales", role: "sales" } };
  const none: AgentContext = { actor: null };

  assert.doesNotThrow(() => requireCap(admin, "animal:write", "edit animals"));
  assert.doesNotThrow(() => requireCap(admin, "user:write", "manage users"));
  assert.doesNotThrow(() => requireCap(sales, "animal:read", "read animals")); // sales can read
  assert.throws(() => requireCap(sales, "animal:write", "edit animals"), /isn't allowed/);
  assert.throws(() => requireCap(sales, "record:write", "add records"), /isn't allowed/);
  assert.throws(() => requireCap(none, "animal:write", "edit animals"), /No signed-in user/);
});

test("confirmGate blocks a destructive action until confirm:true", () => {
  const blocked = confirmGate({}, "Delete the thing.");
  assert.ok(blocked, "returns a gate result when not confirmed");
  assert.match(blocked!.summary, /CONFIRM NEEDED/);
  assert.equal((blocked!.records as { confirmRequired?: boolean }).confirmRequired, true);
  assert.equal(confirmGate({ confirm: true }, "Delete the thing."), null); // proceeds
  assert.ok(confirmGate({ confirm: "true" }, "x"), "only the boolean true confirms, not the string");
});

test("every write tool refuses a Sales user before touching the database", async () => {
  const sales: AgentContext = { actor: { uid: "u", name: "Sales", role: "sales" } };
  const writeTools = [
    "create_or_update_animal", "archive_animal", "add_animal_note", "add_proof", "add_milk_record",
    "add_classification", "manage_breed", "manage_trait", "manage_source", "manage_priority_rule",
    "manage_user", "delete_user", "manage_agent_settings", "import_bulls", "resolve_import", "resolve_review_item", "import_animals",
  ];
  for (const name of writeTools) {
    const tool = AGENT_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `write tool ${name} is registered`);
    await assert.rejects(
      () => tool!.run({}, sales),
      /isn't allowed|No signed-in user/,
      `${name} must refuse a Sales user`,
    );
  }
});

test("write tools refuse when there is no signed-in actor", async () => {
  const none: AgentContext = { actor: null };
  const tool = AGENT_TOOLS.find((t) => t.name === "create_or_update_animal")!;
  await assert.rejects(() => tool.run({ primaryName: "X" }, none), /No signed-in user/);
});
