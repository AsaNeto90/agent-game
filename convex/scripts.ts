import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Seed the script library (run once after `convex dev` generates tables). */
export const seedLibrary = mutation({
  args: {
    scripts: v.array(
      v.object({
        scriptId: v.string(),
        name: v.string(),
        category: v.string(),
        element: v.string(),
        tags: v.array(v.string()),
        rarity: v.string(),
        description: v.string(),
        effect: v.any(),
      }),
    ),
  },
  handler: async (ctx, { scripts }) => {
    let inserted = 0;
    for (const s of scripts) {
      const exists = await ctx.db
        .query("scriptDefs")
        .withIndex("by_scriptId", (q) => q.eq("scriptId", s.scriptId))
        .first();
      if (!exists) {
        await ctx.db.insert("scriptDefs", s);
        inserted++;
      }
    }
    return { inserted };
  },
});

export const library = query({
  args: {},
  handler: (ctx) => ctx.db.query("scriptDefs").collect(),
});

export const hand = query({
  args: { agentId: v.id("agents") },
  handler: (ctx, { agentId }) =>
    ctx.db
      .query("inventory")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .collect(),
});

/**
 * Compile a script from fragments (bad-luck protection: grind guarantees
 * what luck won't). Cost scales with rarity.
 */
const COMPILE_COST: Record<string, number> = { spark: 10, ember: 25, blaze: 60, inferno: 150 };

export const compile = mutation({
  args: { agentId: v.id("agents"), scriptId: v.string() },
  handler: async (ctx, { agentId, scriptId }) => {
    const def = await ctx.db
      .query("scriptDefs")
      .withIndex("by_scriptId", (q) => q.eq("scriptId", scriptId))
      .first();
    if (!def) throw new Error("unknown script");
    const cost = COMPILE_COST[def.rarity] ?? 10;
    const frag = await ctx.db
      .query("fragments")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .filter((q) => q.eq(q.field("element"), def.element))
      .first();
    if (!frag || frag.qty < cost) throw new Error("not enough fragments");
    await ctx.db.patch(frag._id, { qty: frag.qty - cost });
    const inv = await ctx.db
      .query("inventory")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .filter((q) => q.eq(q.field("scriptId"), scriptId))
      .first();
    if (inv) await ctx.db.patch(inv._id, { qty: inv.qty + 1 });
    else await ctx.db.insert("inventory", { agentId, scriptId, qty: 1 });
    return { ok: true };
  },
});

/** Shatter a duplicate into fragments. No dead drops, ever. */
export const shatter = mutation({
  args: { agentId: v.id("agents"), scriptId: v.string() },
  handler: async (ctx, { agentId, scriptId }) => {
    const def = await ctx.db
      .query("scriptDefs")
      .withIndex("by_scriptId", (q) => q.eq("scriptId", scriptId))
      .first();
    if (!def) throw new Error("unknown script");
    const inv = await ctx.db
      .query("inventory")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .filter((q) => q.eq(q.field("scriptId"), scriptId))
      .first();
    if (!inv || inv.qty < 1) throw new Error("nothing to shatter");
    await ctx.db.patch(inv._id, { qty: inv.qty - 1 });
    const yield_ = { spark: 4, ember: 10, blaze: 24, inferno: 60 }[def.rarity] ?? 4;
    const frag = await ctx.db
      .query("fragments")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .filter((q) => q.eq(q.field("element"), def.element))
      .first();
    if (frag) await ctx.db.patch(frag._id, { qty: frag.qty + yield_ });
    else await ctx.db.insert("fragments", { agentId, element: def.element, qty: yield_ });
    return { fragments: yield_ };
  },
});
