// Integration check for the Genetics Agent's WRITE tools (not part of the app):
//
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server prisma/smoke-agent-tools.ts
//
// This proves the whole read+write tool surface loads under the real server
// runtime (the write tools pull server-only libs via dynamic import) and that
// the permission + confirmation gates behave against the live database. It makes
// NO changes: it only exercises read paths, permission REFUSALS, and the
// "confirm needed" gate (which by design mutates nothing).

import { AGENT_TOOLS, AGENT_TOOL_MAP, type AgentContext } from "../src/lib/agent/tools";
import { AGENT_TOOL_NAMES } from "../src/lib/agent/agent"; // ensures agent.ts imports cleanly too
import { prisma } from "../src/lib/db";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const admin: AgentContext = { actor: { uid: "smoke-admin", name: "Smoke Admin", role: "admin" } };
const sales: AgentContext = { actor: { uid: "smoke-sales", name: "Smoke Sales", role: "sales" } };
const anon: AgentContext = { actor: null };

async function run(name: string, input: Record<string, unknown>, ctx: AgentContext) {
  const tool = AGENT_TOOL_MAP.get(name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool.run(input, ctx);
}

async function main() {
  console.log(`\n  ${AGENT_TOOLS.length} tools registered; ${AGENT_TOOL_NAMES.length} names exported.\n`);

  // Tool registry is well-formed.
  const names = AGENT_TOOLS.map((t) => t.name);
  check("tool names are unique", new Set(names).size === names.length);
  check("every tool has description + schema + run",
    AGENT_TOOLS.every((t) => t.description && t.input_schema && typeof t.run === "function"));
  const writeNames = ["create_or_update_animal", "archive_animal", "add_animal_note", "add_proof", "add_milk_record", "add_classification", "manage_breed", "manage_trait", "manage_source", "manage_priority_rule", "manage_user", "delete_user", "manage_agent_settings", "import_bulls", "resolve_import", "resolve_review_item", "list_reference_data", "import_animals"];
  check("all write/action tools are present", writeNames.every((n) => AGENT_TOOL_MAP.has(n)), `${writeNames.length} expected`);

  // --- READ still works with no actor (reads are open) ---
  const s = await run("search_animals", { limit: 3 }, anon);
  check("read tool works without an actor", Array.isArray((s.records as unknown[])), s.summary);

  const ref = await run("list_reference_data", { kind: "breeds" }, anon);
  check("list_reference_data breeds (open) works for anon", Array.isArray(ref.records), ref.summary);

  // --- Permission REFUSALS (no mutation) ---
  let refused = false;
  try { await run("add_animal_note", { body: "x" }, anon); } catch (e) { refused = /No signed-in user/.test((e as Error).message); }
  check("write refuses with no actor", refused);

  refused = false;
  try { await run("add_proof", { traits: { LPI: 1 } }, sales); } catch (e) { refused = /isn't allowed/.test((e as Error).message); }
  check("write refuses a Sales user", refused);

  refused = false;
  try { await run("list_reference_data", { kind: "users" }, sales); } catch (e) { refused = /isn't allowed/.test((e as Error).message); }
  check("listing users refuses a Sales user (needs user:write)", refused);

  // calculate_mating_pa can trigger a live external fetch + (with save) a write:
  // it must refuse a caller with no read-capable actor BEFORE doing any of that.
  refused = false;
  try { await run("calculate_mating_pa", { sireReg: "HOCANM1", damReg: "HOCANF1", saveToDatabase: true }, anon); } catch (e) { refused = /No signed-in user/.test((e as Error).message); }
  check("calculate_mating_pa refuses with no actor (before any Lactanet fetch)", refused);

  // --- Admin passes the gate; still no mutation on these paths ---
  const status = await run("manage_agent_settings", { action: "status" }, admin);
  check("admin reads agent status", !!(status.records as { configured?: boolean }), status.summary);

  const noUser = await run("delete_user", { id: "does-not-exist", confirm: true }, admin);
  check("delete_user on a missing id changes nothing", /No user with id/.test(noUser.summary), noUser.summary);

  // Confirm-gate: archive without confirm must NOT mutate — pick a real animal.
  const someAnimal = await prisma.animal.findFirst({ where: { archived: false }, select: { primaryName: true } });
  if (someAnimal) {
    const gate = await run("archive_animal", { name: someAnimal.primaryName }, admin);
    const rec = gate.records as { confirmRequired?: boolean } | null;
    check("archive_animal refuses without confirm (no mutation)", rec?.confirmRequired === true, gate.summary);
    const still = await prisma.animal.findFirst({ where: { primaryName: someAnimal.primaryName }, select: { archived: true } });
    check("the animal is still not archived", still?.archived === false);
  } else {
    check("archive_animal confirm-gate (skipped — no animal)", true);
    check("the animal is still not archived (skipped)", true);
  }

  // Animal import + Lactanet lookup fallback — gating / validation / confirm
  // only (no real Lactanet fetch is triggered by these inputs).
  let refusedImp = false;
  try { await run("import_animals", { regs: ["HOCANM13486161"] }, sales); } catch (e) { refusedImp = /isn't allowed/.test((e as Error).message); }
  check("import_animals refuses a Sales user", refusedImp);

  const impGarbage = await run("import_animals", { regs: ["not-a-reg", "xyz"] }, admin);
  check("import_animals rejects input with no valid registrations", (impGarbage.records as { tooMany?: boolean } | null) == null || /No valid registration/.test(impGarbage.summary));

  const impConfirm = await run("import_animals", { regs: ["HOCANM13486161"] }, admin); // no confirm → gate, no fetch
  check("import_animals refuses without confirm (no import, no Lactanet fetch)", (impConfirm.records as { confirmRequired?: boolean } | null)?.confirmRequired === true, impConfirm.summary);

  const lookupBad = await run("get_animal_full_profile", { reg: "INVALIDREG" }, admin); // not internal, bad format → no network
  check("get_animal_full_profile external fallback rejects a non-registration cleanly", /not a registration number/.test(lookupBad.summary), lookupBad.summary);

  let refusedTrace = false;
  try { await run("trace_maternal_line", { reg: "HOCANF12345678" }, anon); } catch (e) { refusedTrace = /No signed-in user/.test((e as Error).message); }
  check("trace_maternal_line requires a read-capable actor", refusedTrace);

  const traceBad = await run("trace_maternal_line", { reg: "NOTAREG" }, admin); // bad format → no network
  check("trace_maternal_line rejects a non-registration cleanly (no Lactanet fetch)", /not a registration number/.test(traceBad.summary), traceBad.summary);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`  FAILED: ${failed.map((f) => f.name).join(", ")}`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { console.error("\n  THREW:", e); await prisma.$disconnect(); process.exit(1); });
