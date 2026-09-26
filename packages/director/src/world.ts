/**
 * L0 world simulation — pure TypeScript, zero LLM, deterministic given a seed.
 * Range bands are the combat grammar: every fighter is always deciding which
 * band to be in. Juice (hit-stop, flashes) is the client's job.
 */
import {
  ELEMENT_BEATS,
  elementMultiplier,
  RANGE_BAND_METERS,
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
  /**
   * seconds left in an attack wind-up. While winding up the fighter is
   * committed: the strike lands when it hits 0, but only if the target is
   * still in range — kiting out dodges it, killing the attacker cancels it.
   */
  windup?: number;
  /** seconds left airborne — a jumping fighter leaps clean over melee swings */
  airborne?: number;
}

export interface WorldState {
  fighters: Fighter[];
  events: WorldEvent[];
  /** Operator-set fight style — persists across waves until changed. */
  style?: FightStyle;
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
const WINDUP_TIME = 0.75; // seconds of telegraph before a virus strike lands
const VIRUS_POWER = 6; // viruses hit softer than the agent — the operator's job is coaching, not tanking
const VIRUS_COOLDOWN = 2.4; // seconds between virus swings (plus wind-up)
const MOVE_SPEED = 3.2; // m/s

/**
 * One L0 tick. The agent acts on `directive` ("engage" | "disengage" | ...);
 * viruses run a tiny aggression loop. Mutates state in place, appends events.
 */
/** How long a jump keeps the fighter airborne (seconds). */
export const JUMP_DURATION = 0.6;

/** Operator-set fight style: "balanced" is the default; "evasive" dodges on its own. */
export type FightStyle = "balanced" | "evasive";

/**
 * The operator's micro-override for one tick: a movement step, a jump, or both.
 * Movement is camera-relative — the camera never rotates, so right is always
 * +x, forward (away from the camera) is always -z.
 */
export interface OperatorNudge {
  move?: {
    dx: number;
    dz: number;
    dash: boolean;
    flee?: boolean;
    /** circle the nearest virus instead of moving dx/dz — "pivot around them" */
    orbit?: boolean;
  } | null;
  jump?: boolean;
}

export function tickWorld(
  state: WorldState,
  dt: number,
  directive: "engage" | "disengage" | "hold" | "focus_weakest" | "protect",
  rand: () => number,
  targetElement?: Element | null,
  nudge?: OperatorNudge | null,
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
  // Target selection only matters while something is alive to fight.
  const pick =
    viruses.length > 0
      ? directive === "focus_weakest"
        ? viruses.reduce((a, b) => (a.hp <= b.hp ? a : b))
        : targetElement && viruses.some((v) => v.element === targetElement)
          ? nearest(
              agent,
              viruses.filter((v) => v.element === targetElement),
            )!.target
          : nearest(agent, viruses)!.target
      : null;

  const mv = nudge?.move;
  if (mv && (mv.dx !== 0 || mv.dz !== 0 || mv.flee || mv.orbit)) {
    // Operator micro-override: highest priority, and it works even with no
    // live viruses — the breather between waves is the playground.
    let dx = mv.dx;
    let dz = mv.dz;
    if (mv.flee) {
      const threat = nearest(agent, viruses)?.target;
      if (threat) {
        dx = agent.pos.x - threat.pos.x;
        dz = agent.pos.z - threat.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
      }
    } else if (mv.orbit) {
      const threat = nearest(agent, viruses)?.target;
      if (threat) {
        // Tangent around the threat — pivot around them, holding distance.
        // Recomputed live every tick, so the circle tracks a moving target.
        const rx = agent.pos.x - threat.pos.x;
        const rz = agent.pos.z - threat.pos.z;
        const l = Math.hypot(rx, rz) || 1;
        dx = -rz / l;
        dz = rx / l;
      } else {
        dx = 0;
        dz = 0;
      }
    }
    moveToward(
      agent,
      { x: agent.pos.x + dx * 6, y: 0, z: agent.pos.z + dz * 6 },
      mv.dash ? dt * 1.8 : dt,
    );
    agent.pose = mv.dash ? "dash" : "run";
    // Still swings if a virus is in reach — walk and punch.
    if (pick) {
      const band = rangeBandOf(dist(agent.pos, pick.pos));
      if (band === "melee" && agent.cooldown <= 0) {
        agent.pose = "melee_attack";
        strike(state, agent, pick, MELEE_POWER * elementMultiplier(agent.element, pick.element));
        agent.cooldown = ATTACK_COOLDOWN;
      }
    }
  } else if (pick) {
    const d = dist(agent.pos, pick.pos);
    const band: RangeBand = rangeBandOf(d);

    if (directive === "disengage") {
      moveAway(agent, pick.pos, dt);
      agent.pose = "run";
    } else if (directive === "hold") {
      agent.pose = "idle";
    } else {
      const evasive = (state.style ?? "balanced") === "evasive";
      // Evasive style: leap a swing that's about to land — timed late so the
      // 0.6s of airtime covers the impact. The jump physics below arcs it.
      const imminent = evasive
        ? viruses.filter(
            (v) =>
              (v.windup ?? 0) > 0 &&
              (v.windup ?? 0) <= 0.5 &&
              dist(agent.pos, v.pos) < RANGE_BAND_METERS.melee + 1.5,
          )
        : [];
      if (imminent.length > 0 && (agent.airborne ?? 0) <= 0) {
        agent.airborne = JUMP_DURATION;
      } else {
        // Autonomous footwork: the agent reads the fight itself. If viruses
        // are winding up swings in reach, it gives ground on its own —
        // the operator's "fall back" is a nudge, not a steering wheel.
        // Evasive style reacts to a single wind-up; balanced waits for two.
        const closingIn = viruses.filter(
          (v) => (v.windup ?? 0) > 0 && dist(agent.pos, v.pos) < RANGE_BAND_METERS.melee + 2.5,
        );
        if (closingIn.length >= (evasive ? 1 : 2)) {
          const cx = closingIn.reduce((s, v) => s + v.pos.x, 0) / closingIn.length;
          const cz = closingIn.reduce((s, v) => s + v.pos.z, 0) / closingIn.length;
          moveAway(agent, { x: cx, y: 0, z: cz }, evasive ? dt * 1.6 : dt);
          agent.pose = evasive ? "dash" : "run";
        } else if (band === "melee") {
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
    }
  } else {
    agent.pose = "idle";
  }

  // Jump physics: trigger, arc, land. Airborne beats melee swings.
  // Works anywhere — hop around the breather all you like.
  if (nudge?.jump && (agent.airborne ?? 0) <= 0) agent.airborne = JUMP_DURATION;
  if ((agent.airborne ?? 0) > 0) {
    agent.airborne! -= dt;
    const p = 1 - Math.max(0, agent.airborne!) / JUMP_DURATION;
    agent.pos.y = 1.6 * Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
    agent.pose = "jump";
  } else {
    agent.pos.y = 0;
  }

  // --- Virus L0: drift toward the agent, telegraph, then swipe in melee ---
  for (const v of viruses) {
    const d = dist(v.pos, agent.pos);
    if (v.windup != null && v.windup > 0) {
      // Committed to the swing: the strike lands when the wind-up ends,
      // but only if the target is still in reach.
      v.windup -= dt;
      v.pose = "windup";
      if (v.windup <= 0) {
        v.windup = 0;
        if (agent.hp > 0 && rangeBandOf(dist(v.pos, agent.pos)) === "melee") {
          strike(state, v, agent, VIRUS_POWER * elementMultiplier(v.element, agent.element));
        } else {
          v.pose = "idle"; // whiffed — the operator kited it out
        }
        v.cooldown = VIRUS_COOLDOWN;
      }
    } else if (rangeBandOf(d) === "melee") {
      if (v.cooldown <= 0 && rand() < (v.aggression ?? 0.6)) {
        v.windup = WINDUP_TIME;
        v.pose = "windup";
      } else {
        v.pose = "melee_attack";
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
  // A jumping fighter leaps clean over melee swings — time it right.
  if ((target.airborne ?? 0) > 0 && rangeBandOf(dist(attacker.pos, target.pos)) === "melee") return;
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

/**
 * Spawn a wave of viruses around the agent. Wave 1 is the dive's opening
 * pair; later waves get more numerous, tougher, and meaner. Corpses from
 * earlier waves are cleared.
 */
const VIRUS_POOL: { name: string; element: Element }[] = [
  { name: "Scrapbit", element: "aqua" },
  { name: "Glitchwasp", element: "elec" },
  { name: "Cindercub", element: "fire" },
  { name: "Mossmite", element: "wood" },
  { name: "Frostmite", element: "aqua" },
  { name: "Voltvulture", element: "elec" },
];

export function spawnWave(state: WorldState, wave: number, rand: () => number): void {
  state.fighters = state.fighters.filter((f) => f.kind === "agent" || f.hp > 0);
  const agent = state.fighters.find((f) => f.kind === "agent");
  const ax = agent?.pos.x ?? 0;
  const az = agent?.pos.z ?? 0;
  const count = Math.min(1 + wave, 6);
  const hp = 40 + wave * 10;
  for (let i = 0; i < count; i++) {
    const def = VIRUS_POOL[(wave + i) % VIRUS_POOL.length];
    const angle = rand() * Math.PI * 2;
    const d = 7 + rand() * 4;
    state.fighters.push({
      id: `virus-w${wave}-${i}`,
      kind: "virus",
      name: def.name,
      pos: { x: ax + Math.cos(angle) * d, y: 0, z: az + Math.sin(angle) * d },
      pose: "idle",
      hp,
      maxHp: hp,
      element: def.element,
      cooldown: 0,
      aggression: Math.min(0.6 + wave * 0.1, 0.95),
    });
  }
}

export { ELEMENT_BEATS };
