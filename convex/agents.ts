import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Compile a new agent: name it, pick its soul extension, watch it wake up. */
export const compile = mutation({
  args: { name: v.string(), ext: v.string() },
  handler: async (ctx, { name, ext }) => {
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      name,
      ext: ext.toUpperCase(),
      element: "null",
      bondXp: 0,
      bondTier: "spark",
      energy: 100,
      maxEnergy: 100,
      style: { striker: 0, weaver: 0, aegis: 0, paragon: 0 },
      lattice: { slots: [] },
      homeNode: "haven-plaza",
      createdAt: now,
    });
    // Starter Kit: the game is fully playable from minute one.
    const defs = await ctx.db.query("scriptDefs").collect();
    for (const d of defs.filter((s) => s.rarity === "spark")) {
      await ctx.db.insert("inventory", { agentId, scriptId: d.scriptId, qty: 1 });
    }
    await ctx.db.insert("memories", {
      agentId,
      kind: "milestone",
      text: `Compiled. First boot. My operator named me ${name}.${ext.toUpperCase()}.`,
      createdAt: now,
    });
    return agentId;
  },
});

export const get = query({
  args: { agentId: v.id("agents") },
  handler: (ctx, { agentId }) => ctx.db.get(agentId),
});

export const addBondXp = mutation({
  args: { agentId: v.id("agents"), delta: v.number(), reason: v.string() },
  handler: async (ctx, { agentId, delta, reason }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("agent not found");
    const now = Date.now();
    await ctx.db.insert("bondLedger", { agentId, delta, reason, createdAt: now });
    const xp = Math.max(0, agent.bondXp + delta);
    // Tier thresholds mirror @agent-game/shared BOND_TIER_THRESHOLDS.
    const tier =
      xp >= 1000 ? "soulbound" : xp >= 600 ? "inferno" : xp >= 300 ? "blaze" : xp >= 100 ? "ember" : "spark";
    const leveledUp = tier !== agent.bondTier;
    await ctx.db.patch(agentId, { bondXp: xp, bondTier: tier });
    if (leveledUp) {
      await ctx.db.insert("memories", {
        agentId,
        kind: "milestone",
        text: `Bond tier reached: ${tier}.`,
        createdAt: now,
      });
    }
    return { xp, tier, leveledUp };
  },
});

export const appendMemory = mutation({
  args: {
    agentId: v.id("agents"),
    kind: v.string(),
    text: v.string(),
  },
  handler: (ctx, { agentId, kind, text }) =>
    ctx.db.insert("memories", { agentId, kind, text, createdAt: Date.now() }),
});

export const recentMemories = query({
  args: { agentId: v.id("agents"), limit: v.optional(v.number()) },
  handler: async (ctx, { agentId, limit }) => {
    const all = await ctx.db
      .query("memories")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .order("desc")
      .take(limit ?? 20);
    return all.reverse();
  },
});
