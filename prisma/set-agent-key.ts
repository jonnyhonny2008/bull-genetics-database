// Activate the Genetics Intelligence Agent by storing the Anthropic API key in
// the app's key store (EnvironmentConfig row `agent.anthropicApiKey`) — the same
// thing the Admin Settings "Save" button does. Reads the key from the
// environment (ANTHROPIC_API_KEY), so no secret is written into this file.
//
//   npx dotenv -e .env.production -- npx tsx prisma/set-agent-key.ts
//
// After upserting, it pings the Anthropic API once with the configured model to
// confirm the key is valid and the model id is accepted end-to-end.
import { PrismaClient } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

const prisma = new PrismaClient();

async function main() {
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (key.length < 20) throw new Error("ANTHROPIC_API_KEY is not set in the environment.");
  const model = process.env.GENETICS_AGENT_MODEL || "claude-sonnet-5";

  await prisma.environmentConfig.upsert({
    where: { key: "agent.anthropicApiKey" },
    update: { value: key, notes: "Anthropic API key for the Genetics Intelligence Agent" },
    create: { key: "agent.anthropicApiKey", value: key, notes: "Anthropic API key for the Genetics Intelligence Agent" },
  });
  await prisma.environmentConfig.upsert({
    where: { key: "agent.model" },
    update: { value: model },
    create: { key: "agent.model", value: model, notes: "Model id for the Genetics Intelligence Agent" },
  });
  console.log(`[agent] key stored (…${key.slice(-6)}), model = ${model}`);

  // Validate the key + model with a tiny live call.
  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model,
      max_tokens: 16,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
    console.log(`[agent] live check OK — model responded: "${text}" (stop_reason=${res.stop_reason})`);
  } catch (e: any) {
    console.error(`[agent] live check FAILED: ${e?.status ?? ""} ${e?.message ?? e}`);
    console.error("[agent] The key is stored, but the model call failed — check the key/model id above.");
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
