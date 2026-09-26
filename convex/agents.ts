import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { compileProfile } from "@agent-game/shared";

/**
 * Compile a new agent: name it, pick its soul extension, answer three
 * temperament questions, watch it wake up. The temperament -> drives/traits
 * derivation runs here, server-side, from @agent-game/shared — the client
 * renders the questions but never invents the profile.
 */
export const compile = mutation({
  args: { name: v.string(), ext: v.string(), answers: v.array(v.string()) },
  handler: async (ctx, { name, ext, answers }) => {
    // Throws on invalid input (bad name, bad ext, wrong answers) — Convex
    // surfaces the message as the mutation error for the client to show.
    const profile = compileProfile({ name, ext, answers });
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      name: profile.name,
      ext: profile.ext,
      element: profile.element,
      bondXp: 0,
      bondTier: "spark",
      energy: 100,
      maxEnergy: 100,
      style: { striker: 0, weaver: 0, aegis: 0, paragon: 0 },
      traits: profile.traits,
      drives: profile.drives,
      chassis: profile.chassis,
      voice: profile.voice,
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
      text: `Compiled. First boot. My operator named me ${profile.name}.${profile.ext}.`,
      createdAt: now,
    });
    return agentId;
  },
});

/** Every live (non-retired) agent, newest first — the deck's agent picker. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("agents")
      .filter((q) => q.neq(q.field("retired"), true))
      .collect();
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Retire an agent. The recompile flow calls this after a successful compile:
 * compiling over an existing agent replaces the diver but keeps the history.
 */
export const decommission = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    await ctx.db.patch(agentId, { retired: true });
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
