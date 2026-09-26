/**
 * Director entrypoint. Boots the tick loop for one agent's dive.
 *
 *   pnpm dev            # local, against your Convex dev deployment
 *
 * Needs CONVEX_URL + AGENT_ID in .env (copy .env.example).
 * Compile an agent first via the Convex dashboard or:
 *   npx convex run agents:compile '{"name":"AstroMan","ext":"PY"}'
 */
import "dotenv/config";
import { MockMind, type MindProvider } from "./mind.js";
import { vendorMindFromEnv } from "./vendor.js";
import { runDirector } from "./loop.js";

const convexUrl = process.env.CONVEX_URL;
const agentId = process.env.AGENT_ID;
const zoneId = process.env.ZONE_ID ?? "tide-district";

if (!convexUrl || !agentId) {
  console.error("Missing CONVEX_URL or AGENT_ID — copy .env.example to .env and fill it in.");
  process.exit(1);
}

// MindProvider is the seam: MockMind by default ($0, deterministic).
// Set MIND_PROVIDER=gemini (free AI Studio key) or =openai-compatible
// to give the agent a real brain — chase prices forever.
const mind: MindProvider = vendorMindFromEnv() ?? new MockMind();

console.log(`[director] diving ${agentId} into ${zoneId} with mind=${mind.name}`);
const stop = await runDirector({ convexUrl, agentId, zoneId, mind });

process.on("SIGINT", () => {
  console.log("\n[director] surfacing...");
  stop();
  process.exit(0);
});
