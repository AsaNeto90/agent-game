import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Soul store. Agents, their memories, bond ledger, sessions, live entities,
 * intents from operators, script economy, and the decision-trace flight
 * recorder. All state the director needs is here — the director itself
 * stays stateless and disposable.
 */
export default defineSchema({
  agents: defineTable({
    name: v.string(), // e.g. "AstroMan"
    ext: v.string(), // soul-file extension: "PY" | "SH" | "MD" ...
    element: v.union(
      v.literal("fire"),
      v.literal("aqua"),
      v.literal("elec"),
      v.literal("wood"),
      v.literal("null"),
    ),
    bondXp: v.number(),
    bondTier: v.string(),
    energy: v.number(),
    maxEnergy: v.number(),
    // Behavior-derived style vector — the Style Change system.
    style: v.object({
      striker: v.number(),
      weaver: v.number(),
      aegis: v.number(),
      paragon: v.number(),
    }),
    // Compile-flow profile (w-compile). Optional until existing agents are
    // backfilled — new compiles always write these.
    traits: v.optional(v.array(v.string())),
    drives: v.optional(
      v.object({
        curiosity: v.number(),
        sociability: v.number(),
        duty: v.number(),
        ambition: v.number(),
      }),
    ),
    chassis: v.optional(v.string()),
    voice: v.optional(v.string()), // voice profile stub
    retired: v.optional(v.boolean()), // set by decommission; list() hides these
    lattice: v.any(), // woven program parts config
    homeNode: v.string(),
    createdAt: v.number(),
  }),

  // Append-only episodic memory. Summarized by L2 on a slow cadence.
  memories: defineTable({
    agentId: v.id("agents"),
    kind: v.string(), // "battle" | "social" | "milestone" | "note"
    text: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  // Every point of bond XP is a ledger row. The relationship is auditable.
  bondLedger: defineTable({
    agentId: v.id("agents"),
    delta: v.number(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  sessions: defineTable({
    agentId: v.id("agents"),
    zoneId: v.string(),
    status: v.union(v.literal("active"), v.literal("resting"), v.literal("closed")),
    tick: v.number(),
    synchro: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  }).index("by_agent_status", ["agentId", "status"]),

  // Live combat entities, written by the director each tick, read by clients
  // via realtime subscription. Ephemeral — cleared when a session closes.
  sessionEntities: defineTable({
    sessionId: v.id("sessions"),
    entityId: v.string(),
    kind: v.union(v.literal("agent"), v.literal("virus"), v.literal("structure")),
    name: v.string(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    pose: v.string(),
    hp: v.number(),
    maxHp: v.number(),
    element: v.string(),
  }).index("by_session", ["sessionId"]),

  // Operator intents. Clients write, director consumes (status -> "consumed").
  intents: defineTable({
    sessionId: v.id("sessions"),
    type: v.union(
      v.literal("command"),
      v.literal("slot_script"),
      v.literal("suggest_destination"),
      v.literal("chat"),
    ),
    payload: v.any(),
    status: v.union(v.literal("pending"), v.literal("consumed")),
    createdAt: v.number(),
  }).index("by_session_status", ["sessionId", "status"]),

  // Drained event feed per session — dialogue, hits, synchro/bond changes.
  sessionEvents: defineTable({
    sessionId: v.id("sessions"),
    tick: v.number(),
    event: v.any(), // BrainEvent (validated in shared)
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),

  // Script economy.
  scriptDefs: defineTable({
    scriptId: v.string(),
    name: v.string(),
    category: v.string(),
    element: v.string(),
    tags: v.array(v.string()),
    rarity: v.string(),
    description: v.string(),
    effect: v.any(),
  }).index("by_scriptId", ["scriptId"]),

  inventory: defineTable({
    agentId: v.id("agents"),
    scriptId: v.string(),
    qty: v.number(),
  }).index("by_agent", ["agentId"]),

  // Crafting currency, per element. Duplicates shatter into these.
  fragments: defineTable({
    agentId: v.id("agents"),
    element: v.string(),
    qty: v.number(),
  }).index("by_agent", ["agentId"]),

  // The flight recorder. Every L1/L2 decision persists.
  decisionTraces: defineTable({
    sessionId: v.id("sessions"),
    tick: v.number(),
    level: v.union(v.literal("L0"), v.literal("L1"), v.literal("L2")),
    provider: v.string(),
    latencyMs: v.number(),
    tokens: v.number(),
    costUsd: v.number(),
    action: v.string(),
    rationale: v.string(),
    createdAt: v.number(),
  }).index("by_session", ["sessionId"]),
});
