/**
 * L0 world simulation — pure TypeScript, zero LLM, deterministic given a seed.
 * Range bands are the combat grammar: every fighter is always deciding which
 * band to be in. Juice (hit-stop, flashes) is the client's job.
 */
import {
  ELEMENT_BEATS,
  elementMultiplier,
  rangeBandOf,
  STARTER_SCRIPTS,
  type Element,
  type Pose,
  type RangeBand,
  type Vec3,
} from "@agent-game/shared";

export interface Fighter {
  id: string;
  kind: "agent" | "virus";
  name: string;
  pos: Vec3;
  pose: Pose;
  hp: number;
  maxHp: number;
  element: Element;
  /** seconds until the next basic attack is ready */
  cooldown: number;
  /** viruses only: simple aggression 0..1 */
  aggression?: number;
  /** barrier hp from ward scripts — absorbs damage before hp */
  shield?: number;
}

export interface WorldState {
  fighters: Fighter[];
  events: WorldEvent[];
}

export type WorldEvent =
  | { type: "hit"; attackerId: string; targetId: string; damage: number; element: Element }
  | { type: "down"; fighterId: string };

/** Mulberry32 — seedable RNG so sims are replayable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (a: Vec3, b: Vec3) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const MELEE_POWER = 10;
const RANGED_POWER = 7;
const ATTACK_COOLDOWN = 1.2; // seconds
const MOVE_SPEED = 3.2; // m/s

/**
 * One L0 tick. The agent acts on `directive` ("engage" | "disengage" | ...);
 * viruses run a tiny aggression loop. Mutates state in place, appends events.
 */
export function tickWorld(
  state: WorldState,
  dt: number,
  directive: "engage" | "disengage" | "hold" | "focus_weakest" | "protect",
  rand: () => number,
  targetElement?: Element | null,
): void {
  const agent = state.fighters.find((f) => f.kind === "agent" && f.hp > 0);
  const viruses = state.fighters.filter((f) => f.kind === "virus" && f.hp > 0);
  if (!agent) return;

  for (const f of state.fighters) f.cooldown = Math.max(0, f.cooldown - dt);

  const nearest = (from: Fighter, pool: Fighter[]) => {
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const o of pool) {
      const d = dist(from.pos, o.pos);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ? { target: best, distance: bestD } : null;
  };

  // --- Agent L0 reflex ---
  if (viruses.length > 0) {
    const pick =
      directive === "focus_weakest"
        ? viruses.reduce((a, b) => (a.hp <= b.hp ? a : b))
        : targetElement && viruses.some((v) => v.element === targetElement)
          ? nearest(
              agent,
              viruses.filter((v) => v.element === targetElement),
            )!.target
          : nearest(agent, viruses)!.target;
    const d = dist(agent.pos, pick.pos);
    const band: RangeBand = rangeBandOf(d);

    if (directive === "disengage") {
      moveAway(agent, pick.pos, dt);
      agent.pose = "run";
    } else if (directive === "hold") {
      agent.pose = "idle";
    } else {
      if (band === "melee") {
        agent.pose = "melee_attack";
        if (agent.cooldown <= 0) {
          strike(state, agent, pick, MELEE_POWER * elementMultiplier(agent.element, pick.element));
          agent.cooldown = ATTACK_COOLDOWN;
        }
      } else {
        moveToward(agent, pick.pos, dt);
        agent.pose = "dash";
        // Chip damage at mid range — the Pulse Arm's ranged mode.
        if (band === "mid" && agent.cooldown <= 0 && rand() < 0.5) {
          agent.pose = "ranged_attack";
          strike(state, agent, pick, RANGED_POWER * elementMultiplier(agent.element, pick.element));
          agent.cooldown = ATTACK_COOLDOWN;
        }
      }
    }
  } else {
    agent.pose = "idle";
  }

  // --- Virus L0: drift toward the agent, swipe in melee ---
  for (const v of viruses) {
    const d = dist(v.pos, agent.pos);
    if (rangeBandOf(d) === "melee") {
      v.pose = "melee_attack";
      if (v.cooldown <= 0 && rand() < (v.aggression ?? 0.6)) {
        strike(state, v, agent, MELEE_POWER * 0.8 * elementMultiplier(v.element, agent.element));
        v.cooldown = ATTACK_COOLDOWN * 1.4;
      }
    } else {
      moveToward(v, agent.pos, dt * 0.8);
      v.pose = "run";
    }
  }
}

function moveToward(f: Fighter, target: Vec3, dt: number): void {
  const dx = target.x - f.pos.x;
  const dz = target.z - f.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  f.pos.x += (dx / len) * MOVE_SPEED * dt;
  f.pos.z += (dz / len) * MOVE_SPEED * dt;
}

function moveAway(f: Fighter, from: Vec3, dt: number): void {
  const dx = f.pos.x - from.x;
  const dz = f.pos.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  f.pos.x += (dx / len) * MOVE_SPEED * dt;
  f.pos.z += (dz / len) * MOVE_SPEED * dt;
}

function strike(state: WorldState, attacker: Fighter, target: Fighter, raw: number): void {
  let damage = Math.max(1, Math.round(raw));
  // Barrier shields absorb first.
  const shield = target.shield ?? 0;
  if (shield > 0) {
    const absorbed = Math.min(shield, damage);
    target.shield = shield - absorbed;
    damage -= absorbed;
  }
  target.hp = Math.max(0, target.hp - damage);
  target.pose = target.hp <= 0 ? "down" : "hit";
  state.events.push({
    type: "hit",
    attackerId: attacker.id,
    targetId: target.id,
    damage,
    element: attacker.element,
  });
  if (target.hp <= 0) state.events.push({ type: "down", fighterId: target.id });
}

/**
 * Apply an operator-slotted script to the world. Damage/heal/barrier/stun are
 * real; buff/summon/terrain/phase are flavor-only in v1 (no L0 mechanics yet).
 * Returns a one-line description for the feed, or null if nothing happened.
 */
export function applyScript(
  state: WorldState,
  scriptId: string,
  targetElement?: Element | null,
): string | null {
  const def = STARTER_SCRIPTS.find((s) => s.id === scriptId);
  if (!def) return null;
  const agent = state.fighters.find((f) => f.kind === "agent" && f.hp > 0);
  const viruses = state.fighters.filter((f) => f.kind === "virus" && f.hp > 0);
  const pickTarget = (): Fighter | null => {
    if (viruses.length === 0) return null;
    const pool =
      targetElement && viruses.some((v) => v.element === targetElement)
        ? viruses.filter((v) => v.element === targetElement)
        : viruses;
    return pool.reduce((a, b) => (a.hp <= b.hp ? a : b));
  };

  switch (def.effect.kind) {
    case "damage": {
      const target = pickTarget();
      if (!target || !agent) return null;
      strike(
        state,
        agent,
        target,
        def.effect.power * elementMultiplier(def.element, target.element),
      );
      return `${def.name} slams ${target.name}.`;
    }
    case "heal": {
      if (!agent) return null;
      agent.hp = Math.min(agent.maxHp, agent.hp + def.effect.power);
      return `${def.name} knits ${agent.name} back together.`;
    }
    case "barrier": {
      if (!agent) return null;
      agent.shield = (agent.shield ?? 0) + def.effect.power;
      return `${def.name} up — hard-light barrier holding.`;
    }
    case "stun": {
      const target = pickTarget();
      if (!target) return null;
      target.cooldown = Math.max(target.cooldown, 3);
      return `${def.name} locks ${target.name} down.`;
    }
    default:
      // buff / summon / terrain / phase: no L0 mechanics in v1 yet.
      return null;
  }
}

export { ELEMENT_BEATS };
