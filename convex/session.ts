import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Session lifecycle + the intent inbox. The director owns the tick loop;
 * these functions are the seam it reads and writes through.
 */

export const start = mutation({
  args: { agentId: v.id("agents"), zoneId: v.string() },
  handler: async (ctx, { agentId, zoneId }) => {
    // Close any dangling active session first — one dive at a time.
    const active = await ctx.db
      .query("sessions")
      .withIndex("by_agent_status", (q) => q.eq("agentId", agentId).eq("status", "active"))
      .first();
    if (active) await ctx.db.patch(active._id, { status: "closed", endedAt: Date.now() });
    return ctx.db.insert("sessions", {
      agentId,
      zoneId,
      status: "active",
      tick: 0,
      synchro: 50,
      startedAt: Date.now(),
    });
  },
});

export const getActive = query({
  args: { agentId: v.id("agents") },
  handler: (ctx, { agentId }) =>
    ctx.db
      .query("sessions")
      .withIndex("by_agent_status", (q) => q.eq("agentId", agentId).eq("status", "active"))
      .first(),
});

/** Operator sends an intent — command, script slot, destination, chat. */
export const sendIntent = mutation({
  args: {
    sessionId: v.id("sessions"),
    type: v.union(
      v.literal("command"),
      v.literal("slot_script"),
      v.literal("suggest_destination"),
      v.literal("chat"),
    ),
    payload: v.any(),
  },
  handler: (ctx, { sessionId, type, payload }) =>
    ctx.db.insert("intents", {
      sessionId,
      type,
      payload,
      status: "pending",
      createdAt: Date.now(),
    }),
});

/** Director: pull pending intents (and mark consumed) each tick. */
export const consumeIntents = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const pending = await ctx.db
      .query("intents")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "pending"))
      .order("asc")
      .collect();
    for (const i of pending) await ctx.db.patch(i._id, { status: "consumed" });
    return pending.map(({ type, payload }) => ({ type, payload }));
  },
});

/** Director: write the per-tick world snapshot (entities + tick + synchro). */
export const writeTick = mutation({
  args: {
    sessionId: v.id("sessions"),
    tick: v.number(),
    synchro: v.number(),
    entities: v.array(
      v.object({
        entityId: v.string(),
        kind: v.union(v.literal("agent"), v.literal("virus")),
        name: v.string(),
        x: v.number(),
        y: v.number(),
        z: v.number(),
        pose: v.string(),
        hp: v.number(),
        maxHp: v.number(),
        element: v.string(),
      }),
    ),
  },
  handler: async (ctx, { sessionId, tick, synchro, entities }) => {
    await ctx.db.patch(sessionId, { tick, synchro });
    const existing = await ctx.db
      .query("sessionEntities")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const byEntityId = new Map(existing.map((e) => [e.entityId, e._id]));
    for (const e of entities) {
      const id = byEntityId.get(e.entityId);
      if (id) await ctx.db.patch(id, { ...e });
      else await ctx.db.insert("sessionEntities", { sessionId, ...e });
    }
    // Remove entities that left the world (deleted viruses).
    const live = new Set(entities.map((e) => e.entityId));
    for (const e of existing) if (!live.has(e.entityId)) await ctx.db.delete(e._id);
  },
});

/** Live snapshot for clients: entities + newly arrived events. */
export const snapshot = query({
  args: { sessionId: v.id("sessions"), sinceTick: v.optional(v.number()) },
  handler: async (ctx, { sessionId, sinceTick }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    const entities = await ctx.db
      .query("sessionEntities")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const events = (
      await ctx.db
        .query("sessionEvents")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .order("desc")
        .take(50)
    )
      .reverse()
      .filter((e) => (sinceTick === undefined ? true : e.tick > sinceTick));
    return {
      sessionId,
      tick: session.tick,
      zoneId: session.zoneId,
      status: session.status,
      entities: entities.map(({ entityId, kind, name, x, y, z, pose, hp, maxHp, element }) => ({
        id: entityId,
        kind,
        name,
        position: { x, y, z },
        pose,
        hp,
        maxHp,
        element,
      })),
      events: events.map((e) => e.event),
      synchro: session.synchro,
    };
  },
});

export const pushEvent = mutation({
  args: { sessionId: v.id("sessions"), tick: v.number(), event: v.any() },
  handler: (ctx, { sessionId, tick, event }) =>
    ctx.db.insert("sessionEvents", { sessionId, tick, event, createdAt: Date.now() }),
});

export const rest = mutation({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, { sessionId }) =>
    ctx.db.patch(sessionId, { status: "resting", endedAt: Date.now() }),
});

export const logTrace = mutation({
  args: {
    sessionId: v.id("sessions"),
    tick: v.number(),
    level: v.union(v.literal("L0"), v.literal("L1"), v.literal("L2")),
    provider: v.string(),
    latencyMs: v.number(),
    tokens: v.number(),
    costUsd: v.number(),
    action: v.string(),
    rationale: v.string(),
  },
  handler: (ctx, args) => ctx.db.insert("decisionTraces", { ...args, createdAt: Date.now() }),
});
