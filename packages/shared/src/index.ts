/**
 * @agent-game/shared — the API contract between the brain (Convex + director)
 * and every client (web demo, Expo deck, Godot, anything).
 *
 * Rule: clients NEVER run game logic. They send intents, render snapshots.
 * Everything here is validated with zod on both sides of the seam.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Elements (canon-flavored, generic words — safe)
// Fire > Wood > Elec > Aqua > Fire. Null is unaffiliated.
// ---------------------------------------------------------------------------

export const Element = z.enum(["fire", "aqua", "elec", "wood", "null"]);
export type Element = z.infer<typeof Element>;

export const ELEMENT_BEATS: Record<Exclude<Element, "null">, Exclude<Element, "null">> = {
  fire: "wood",
  wood: "elec",
  elec: "aqua",
  aqua: "fire",
};

export function elementMultiplier(attacker: Element, defender: Element): number {
  if (attacker === "null" || defender === "null") return 1;
  if (ELEMENT_BEATS[attacker] === defender) return 2;
  if (ELEMENT_BEATS[defender] === attacker) return 0.5;
  return 1;
}

// ---------------------------------------------------------------------------
// Combat grammar: range bands. The whole melee/ranged feel lives here.
// ---------------------------------------------------------------------------

export const RangeBand = z.enum(["melee", "mid", "long"]);
export type RangeBand = z.infer<typeof RangeBand>;

export const RANGE_BAND_METERS = { melee: 2.5, mid: 8 } as const;

export function rangeBandOf(distanceMeters: number): RangeBand {
  if (distanceMeters <= RANGE_BAND_METERS.melee) return "melee";
  if (distanceMeters <= RANGE_BAND_METERS.mid) return "mid";
  return "long";
}

// ---------------------------------------------------------------------------
// Bond tiers — the relationship IS the XP bar.
// ---------------------------------------------------------------------------

export const BondTier = z.enum(["spark", "ember", "blaze", "inferno", "soulbound"]);
export type BondTier = z.infer<typeof BondTier>;

export const BOND_TIER_THRESHOLDS: { tier: BondTier; xp: number }[] = [
  { tier: "spark", xp: 0 },
  { tier: "ember", xp: 100 },
  { tier: "blaze", xp: 300 },
  { tier: "inferno", xp: 600 },
  { tier: "soulbound", xp: 1000 },
];

export function bondTierForXp(xp: number): BondTier {
  let tier: BondTier = "spark";
  for (const t of BOND_TIER_THRESHOLDS) if (xp >= t.xp) tier = t.tier;
  return tier;
}

// ---------------------------------------------------------------------------
// Scripts — verbs, not stat sticks. Categories + tag chaining.
// ---------------------------------------------------------------------------

export const ScriptCategory = z.enum([
  "strike", // direct damage with personality
  "ward", // defense / recovery
  "trick", // disruption / utility
  "surge", // buffs
  "summon", // ally echoes
  "terrain", // rewrite the battlefield
  "venom", // dark. power with rot.
]);
export type ScriptCategory = z.infer<typeof ScriptCategory>;

export const ScriptRarity = z.enum(["spark", "ember", "blaze", "inferno"]);
export type ScriptRarity = z.infer<typeof ScriptRarity>;

export const ScriptDef = z.object({
  id: z.string(),
  name: z.string(),
  category: ScriptCategory,
  element: Element,
  /** Tags: scripts sharing a tag can be CHAINED into one command. */
  tags: z.array(z.string()),
  rarity: ScriptRarity,
  description: z.string(),
  /** Machine-readable effect summary for the director. Keep it data, not prose. */
  effect: z.object({
    kind: z.enum(["damage", "heal", "barrier", "stun", "buff", "summon", "terrain", "phase"]),
    power: z.number(),
    range: RangeBand,
  }),
});
export type ScriptDef = z.infer<typeof ScriptDef>;

// ---------------------------------------------------------------------------
// Client -> brain: intents. The operator's entire verb set.
// ---------------------------------------------------------------------------

export const ClientIntent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), text: z.string().min(1).max(140) }),
  z.object({ type: z.literal("slot_script"), scriptId: z.string() }),
  z.object({ type: z.literal("suggest_destination"), zoneId: z.string() }),
  z.object({ type: z.literal("chat"), text: z.string().min(1).max(500) }),
]);
export type ClientIntent = z.infer<typeof ClientIntent>;

// ---------------------------------------------------------------------------
// Brain -> client: snapshots + events. Semantic actions, never raw frames.
// ---------------------------------------------------------------------------

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const Pose = z.enum([
  "idle",
  "run",
  "dash",
  "windup",
  "melee_attack",
  "ranged_attack",
  "cast",
  "hit",
  "dodge",
  "jump",
  "down",
  "victory",
]);
export type Pose = z.infer<typeof Pose>;

export const EntitySnapshot = z.object({
  id: z.string(),
  kind: z.enum(["agent", "virus"]),
  name: z.string(),
  position: Vec3,
  pose: Pose,
  hp: z.number(),
  maxHp: z.number(),
  element: Element,
});
export type EntitySnapshot = z.infer<typeof EntitySnapshot>;

export const BrainEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dialogue"), speaker: z.string(), text: z.string() }),
  z.object({
    type: z.literal("hit"),
    attackerId: z.string(),
    targetId: z.string(),
    damage: z.number(),
    element: Element,
  }),
  z.object({ type: z.literal("script_fired"), scriptId: z.string(), byId: z.string() }),
  z.object({ type: z.literal("synchro_changed"), value: z.number() }),
  z.object({ type: z.literal("bond_changed"), xp: z.number(), tier: BondTier }),
  z.object({ type: z.literal("energy_changed"), value: z.number() }),
  z.object({ type: z.literal("down"), fighterId: z.string() }),
  z.object({ type: z.literal("digest"), text: z.string() }),
]);
export type BrainEvent = z.infer<typeof BrainEvent>;

export const SessionSnapshot = z.object({
  sessionId: z.string(),
  tick: z.number(),
  zoneId: z.string(),
  entities: z.array(EntitySnapshot),
  /** Drained since last snapshot — clients append these to their feed. */
  events: z.array(BrainEvent),
  synchro: z.number(),
  energy: z.number(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

// ---------------------------------------------------------------------------
// Decision traces — the flight recorder. Every L1/L2 decision persists.
// ---------------------------------------------------------------------------

export const DecisionTrace = z.object({
  sessionId: z.string(),
  tick: z.number(),
  level: z.enum(["L0", "L1", "L2"]),
  provider: z.string(),
  latencyMs: z.number(),
  tokens: z.number(),
  costUsd: z.number(),
  action: z.string(),
  rationale: z.string(),
});
export type DecisionTrace = z.infer<typeof DecisionTrace>;

/** The 12-Script Starter Kit every new operator gets. */
export { STARTER_SCRIPTS } from "./starter-scripts.js";

/** The compile flow: identity, temperament, chassis hook, wake. */
export * from "./compile.js";
