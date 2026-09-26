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
  /** virus species key — behavior kit; defaults to "scrapbit" */
  species?: string;
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
  /**
   * Virus objective: the agent's id or a structure id. Viruses are here for
   * the site — they only come for the agent when it's close and looks
   * beatable, or run from it when hurt. Reassessed every ~2s.
   */
  targetId?: string;
  /** seconds until the next objective reassessment */
  retargetIn?: number;
  /** running from the agent (hurt) — moves away from it, toward the site */
  fleeing?: boolean;
}

/**
 * A load-bearing node of the website the dive takes place in — the physical
 * site the agent defends. Viruses chew these; lose all three and the dive
 * fails. They slowly recompile (+30% maxHp) between waves.
 */
export interface Structure {
  id: string;
  name: string;
  pos: Vec3;
  hp: number;
  maxHp: number;
}

export interface WorldState {
  fighters: Fighter[];
  events: WorldEvent[];
  /** Operator-set fight style — persists across waves until changed. */
  style?: FightStyle;
  /** The site's nodes. Optional so older snapshots/tests still parse —
   *  the loop spawns them at dive boot and tickWorld normalizes. */
  structures?: Structure[];
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
 * Synchro tiers — coaching quality made mechanical. High synchro means the
 * operator and agent are reading each other: strikes hit harder and the
 * Pulse Arm cycles faster. Low synchro is desync: the agent second-guesses,
 * and hits land soft. Pure function, so the tiers are trivially testable.
 */
export type SynchroTier = "in sync" | "steady" | "desync";
export function synchroTier(synchro: number): {
  tier: SynchroTier;
  damageMult: number;
  cooldownMult: number;
} {
  if (synchro >= 80) return { tier: "in sync", damageMult: 1.25, cooldownMult: 0.8 };
  if (synchro < 30) return { tier: "desync", damageMult: 0.85, cooldownMult: 1.0 };
  return { tier: "steady", damageMult: 1, cooldownMult: 1 };
}

/**
 * The unison finisher — the synchro meter's payoff move. A heavy strike on
 * the agent's current focus target, one use per dive, gated at 80 synchro
 * (in-sync tier). The bond is the damage: higher tiers hit dramatically
 * harder, so the relationship literally powers the finisher.
 */
/** Minimum synchro to fire the unison — the in-sync tier. */
export const UNISON_MIN_SYNCHRO = 80;
/** Synchro is set to this after firing — a real commitment, not a free nuke. */
export const UNISON_SYCHRO_AFTER = 40;
const UNISON_BASE_POWER = 60;
/** Bond tier -> unison damage multiplier. The relationship is the damage. */
const UNISON_BOND_MULT: Record<string, number> = {
  spark: 1,
  ember: 1.1,
  blaze: 1.25,
  inferno: 1.5,
  soulbound: 1.8,
};

export function unisonDamage(synchro: number, bondTier: string): number {
  const syncScale = 1 + Math.max(0, synchro - UNISON_MIN_SYNCHRO) / 200;
  return Math.round(UNISON_BASE_POWER * syncScale * (UNISON_BOND_MULT[bondTier] ?? 1));
}

/**
 * Fire the unison: the agent's heaviest strike, on its current focus target
 * (nearest virus, honoring targetElement like the L0 pick — viruses only,
 * never the site). Flows through strike() so hit/down events hit the feed.
 * Returns damage dealt and the target's name, or null when there's nothing
 * to hit.
 */
export function fireUnison(
  state: WorldState,
  synchro: number,
  bondTier: string,
  targetElement?: Element | null,
): { damage: number; targetName: string } | null {
  const agent = state.fighters.find((f) => f.kind === "agent" && f.hp > 0);
  const viruses = state.fighters.filter((f) => f.kind === "virus" && f.hp > 0);
  if (!agent || viruses.length === 0) return null;
  const pool =
    targetElement && viruses.some((v) => v.element === targetElement)
      ? viruses.filter((v) => v.element === targetElement)
      : viruses;
  const target = pool.reduce((a, b) => (dist(agent.pos, a.pos) <= dist(agent.pos, b.pos) ? a : b));
  const raw = unisonDamage(synchro, bondTier) * elementMultiplier(agent.element, target.element);
  agent.pose = "cast";
  strike(state, agent, target, raw);
  const dealt = Math.max(1, Math.round(raw));
  return { damage: dealt, targetName: target.name };
}

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
  synchro = 50,
): void {
  // Older snapshots and unit tests may not carry structures — normalize.
  state.structures ??= [];
  const agent = state.fighters.find((f) => f.kind === "agent" && f.hp > 0);
  const viruses = state.fighters.filter((f) => f.kind === "virus" && f.hp > 0);
  if (!agent) return;

  for (const f of state.fighters) f.cooldown = Math.max(0, f.cooldown - dt);

  // Coaching made mechanical: the synchro tier scales the agent's basic
  // attacks. Viruses don't get this — the operator's bond is the edge.
  const sync = synchroTier(synchro);

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
  // "protect" is the bodyguard directive: intercept whichever virus is
  // chewing on the site — the one nearest the agent, so the response is fast.
  const siteEaters = viruses.filter((v) =>
    structuresOf(state).some((s) => s.id === v.targetId && s.hp > 0),
  );
  const pick =
    viruses.length > 0
      ? directive === "focus_weakest"
        ? viruses.reduce((a, b) => (a.hp <= b.hp ? a : b))
        : directive === "protect"
          ? nearest(agent, siteEaters.length > 0 ? siteEaters : viruses)!.target
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
        strike(
          state,
          agent,
          pick,
          MELEE_POWER * sync.damageMult * elementMultiplier(agent.element, pick.element),
        );
        agent.cooldown = ATTACK_COOLDOWN * sync.cooldownMult;
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
          strike(
            state,
            agent,
            pick,
            MELEE_POWER * sync.damageMult * elementMultiplier(agent.element, pick.element),
          );
          agent.cooldown = ATTACK_COOLDOWN * sync.cooldownMult;
        }
      } else {
        moveToward(agent, pick.pos, dt);
        agent.pose = "dash";
        // Chip damage at mid range — the Pulse Arm's ranged mode.
        if (band === "mid" && agent.cooldown <= 0 && rand() < 0.5) {
          agent.pose = "ranged_attack";
          strike(
            state,
            agent,
            pick,
            RANGED_POWER * sync.damageMult * elementMultiplier(agent.element, pick.element),
          );
          agent.cooldown = ATTACK_COOLDOWN * sync.cooldownMult;
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

  // --- Virus L0: species-driven, objective-aware. Viruses are here for the
  // site, not the agent: each one works its objective (a node, or the agent
  // when it's close and looks beatable), and runs from the agent when hurt.
  // Spitters hold mid range and spit — jumping won't save a node from spit,
  // intercepting the spitter will. ---
  for (const v of viruses) {
    const sp = speciesOf(v);
    // Reassess the objective every ~2s, staggered so the pack doesn't
    // decide in lockstep.
    v.retargetIn = (v.retargetIn ?? rand() * 2) - dt;
    if (v.retargetIn <= 0) {
      reassessVirusTarget(state, v, agent);
      v.retargetIn = 2;
    }
    const struct = structuresOf(state).find((s) => s.id === v.targetId);
    const node = struct && struct.hp > 0 ? struct : undefined;
    const tgtPos = node ? node.pos : agent.pos;
    const d = dist(v.pos, tgtPos);
    const dAgent = dist(v.pos, agent.pos);
    const fleeing = !!v.fleeing && dAgent < AGGRO_RADIUS;
    if (v.windup != null && v.windup > 0) {
      // Committed to the attack: it lands when the wind-up ends, but only
      // if the target is still in reach. Melee whiffs if kited out or
      // jumped; spit only whiffs if the target leaves mid range entirely —
      // and nodes can't move at all.
      v.windup -= dt;
      v.pose = "windup";
      if (v.windup <= 0) {
        v.windup = 0;
        const band = rangeBandOf(dist(v.pos, tgtPos));
        const inReach = sp.ranged ? band === "melee" || band === "mid" : band === "melee";
        if (inReach) {
          if (node) {
            damageStructure(state, v, node, VIRUS_POWER * sp.powerMul);
          } else if (agent.hp > 0) {
            strike(
              state,
              v,
              agent,
              VIRUS_POWER * sp.powerMul * elementMultiplier(v.element, agent.element),
            );
          } else {
            v.pose = "idle";
          }
        } else {
          v.pose = "idle"; // whiffed — the target read it
        }
        v.cooldown = VIRUS_COOLDOWN;
      }
    } else if (sp.ranged) {
      // Spitter: keeps its distance, backs off if crowded, spits on cooldown.
      const band = rangeBandOf(d);
      if (band === "melee") {
        moveAway(v, fleeing ? agent.pos : tgtPos, dt * sp.speedMul);
        v.pose = "run";
      } else if (band === "mid") {
        if (v.cooldown <= 0 && rand() < (v.aggression ?? 0.6)) {
          v.windup = WINDUP_TIME * sp.windupMul;
          v.pose = "windup";
        } else {
          v.pose = "idle";
        }
      } else if (fleeing) {
        moveAway(v, agent.pos, dt * sp.speedMul);
        v.pose = "run";
      } else {
        moveToward(v, tgtPos, dt * 0.8 * sp.speedMul);
        v.pose = "run";
      }
    } else if (rangeBandOf(d) === "melee") {
      if (v.cooldown <= 0 && rand() < (v.aggression ?? 0.6)) {
        v.windup = WINDUP_TIME * sp.windupMul;
        v.pose = "windup";
      } else {
        v.pose = "melee_attack";
      }
    } else if (fleeing) {
      moveAway(v, agent.pos, dt * sp.speedMul);
      v.pose = "run";
    } else {
      moveToward(v, tgtPos, dt * 0.8 * sp.speedMul);
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
  // You hit it — now it's personal. A virus chewing on the site turns on
  // the agent that struck it instead of running.
  if (target.kind === "virus" && attacker.kind === "agent" && target.hp > 0) {
    target.targetId = attacker.id;
    target.fleeing = false;
  }
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
 *
 * The mix is deterministic per wave — balance-testable, and the agent can
 * genuinely learn it ("wave 3 always brings a spitter" is a memory).
 */
export function waveComposition(wave: number): string[] {
  const comp = ["scrapbit", "scrapbit"];
  if (wave >= 2) comp.push("dasher");
  if (wave >= 3) comp.push("spitter");
  if (wave >= 4) comp.push("bulwark", "dasher");
  if (wave >= 5) comp.push("spitter");
  return comp.slice(0, Math.min(1 + wave, 6));
}

/**
 * Virus species — data-driven behavior kits. Adding a species is a table
 * row, not a new branch: the L0 reads the kit. Names double as the client
 * color key, so no schema changes were needed to tell them apart visually.
 */
interface VirusSpecies {
  name: string;
  element: Element;
  hpMul: number;
  speedMul: number;
  powerMul: number;
  windupMul: number;
  /** spitters hold mid range and spit; everyone else closes to melee */
  ranged: boolean;
  /** hp fraction above which the virus engages a close agent instead of
   *  running — dashers spook easy, bulwarks never back down */
  bravery: number;
}

const VIRUS_SPECIES: Record<string, VirusSpecies> = {
  scrapbit: {
    name: "Scrapbit",
    element: "aqua",
    hpMul: 1,
    speedMul: 1,
    powerMul: 1,
    windupMul: 1,
    ranged: false,
    bravery: 0.35,
  },
  dasher: {
    name: "Dasher",
    element: "elec",
    hpMul: 0.8,
    speedMul: 1.6,
    powerMul: 0.85,
    windupMul: 0.6,
    ranged: false,
    bravery: 0.15,
  },
  spitter: {
    name: "Spitter",
    element: "aqua",
    hpMul: 0.9,
    speedMul: 1.1,
    powerMul: 0.9,
    windupMul: 0.9,
    ranged: true,
    bravery: 0.5,
  },
  bulwark: {
    name: "Bulwark",
    element: "wood",
    hpMul: 2.2,
    speedMul: 0.5,
    powerMul: 1.7,
    windupMul: 1.4,
    ranged: false,
    bravery: 0.8,
  },
};

const speciesOf = (f: Fighter): VirusSpecies =>
  VIRUS_SPECIES[f.species ?? "scrapbit"] ?? VIRUS_SPECIES.scrapbit;

/** The website made physical: three load-bearing nodes in a triangle. */
const SITE_NODES = [
  { id: "site-homepage", name: "Homepage", x: 11, z: 0 },
  { id: "site-database", name: "Database", x: -5.5, z: 9.5 },
  { id: "site-gateway", name: "Gateway", x: -5.5, z: -9.5 },
] as const;

export const STRUCTURE_MAX_HP = 120;
/** Between waves the site recompiles: living nodes regain this fraction. */
export const STRUCTURE_REGEN = 0.3;

/** Build the site's nodes — once per dive, at boot. */
export function spawnStructures(state: WorldState): void {
  state.structures = SITE_NODES.map((n) => ({
    id: n.id,
    name: n.name,
    pos: { x: n.x, y: 0, z: n.z },
    hp: STRUCTURE_MAX_HP,
    maxHp: STRUCTURE_MAX_HP,
  }));
}

const structuresOf = (state: WorldState): Structure[] => state.structures ?? [];

/** How close the agent has to be before a virus decides about it. */
const AGGRO_RADIUS = 7;

export function nearestStructure(state: WorldState, from: Vec3): Structure | null {
  let best: Structure | null = null;
  let bestD = Infinity;
  for (const s of structuresOf(state)) {
    if (s.hp <= 0) continue;
    const d = dist(from, s.pos);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * Viruses want the site, not the agent. Every couple of seconds each virus
 * picks its objective: engage the agent (close and beatable), run from it
 * (close and hurt — it flees toward the site, not away from the fight), or
 * go back to chewing the nearest node.
 */
function reassessVirusTarget(state: WorldState, v: Fighter, agent: Fighter): void {
  const sp = speciesOf(v);
  const dAgent = dist(v.pos, agent.pos);
  if (dAgent < AGGRO_RADIUS) {
    if (v.hp / v.maxHp > (sp.bravery ?? 0.35)) {
      v.targetId = agent.id;
      v.fleeing = false;
    } else {
      v.targetId = nearestStructure(state, v.pos)?.id ?? agent.id;
      v.fleeing = true;
    }
  } else {
    v.targetId = nearestStructure(state, v.pos)?.id ?? agent.id;
    v.fleeing = false;
  }
}

/** A virus strike landing on a site node — flat damage, no jumping away. */
function damageStructure(state: WorldState, attacker: Fighter, s: Structure, raw: number): void {
  if (s.hp <= 0) return;
  const damage = Math.max(1, Math.round(raw));
  s.hp = Math.max(0, s.hp - damage);
  state.events.push({
    type: "hit",
    attackerId: attacker.id,
    targetId: s.id,
    damage,
    element: attacker.element,
  });
  if (s.hp <= 0) state.events.push({ type: "down", fighterId: s.id });
}

export function spawnWave(state: WorldState, wave: number, rand: () => number): void {
  state.fighters = state.fighters.filter((f) => f.kind === "agent" || f.hp > 0);
  const agent = state.fighters.find((f) => f.kind === "agent");
  const ax = agent?.pos.x ?? 0;
  const az = agent?.pos.z ?? 0;
  const baseHp = 40 + wave * 10;
  waveComposition(wave).forEach((key, i) => {
    const sp = VIRUS_SPECIES[key];
    const angle = rand() * Math.PI * 2;
    const d = 7 + rand() * 4;
    const hp = Math.round(baseHp * sp.hpMul);
    const px = ax + Math.cos(angle) * d;
    const pz = az + Math.sin(angle) * d;
    state.fighters.push({
      id: `virus-w${wave}-${i}`,
      kind: "virus",
      species: key,
      name: sp.name,
      pos: { x: px, y: 0, z: pz },
      pose: "idle",
      hp,
      maxHp: hp,
      element: sp.element,
      cooldown: 0,
      aggression: Math.min(0.6 + wave * 0.1, 0.95),
      // Fresh viruses come for the site — the agent has to earn their attention.
      targetId: nearestStructure(state, { x: px, y: 0, z: pz })?.id,
      retargetIn: rand() * 2,
    });
  });
}

export { ELEMENT_BEATS };
