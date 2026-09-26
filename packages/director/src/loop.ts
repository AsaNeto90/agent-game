/**
 * The tick loop. 4Hz: consume intents -> L0 sim -> write snapshot -> traces.
 * Stateless: all durable state lives in Convex. Kill it anytime.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { MockMind, estimateCostUsd, type MindDecision, type MindProvider } from "./mind.js";
import {
  applyScript,
  rng,
  spawnWave,
  synchroTier,
  tickWorld,
  type Fighter,
  type FightStyle,
  type WorldState,
} from "./world.js";
import { rangeBandOf, type Element } from "@agent-game/shared";

const TICK_MS = 250;
const ENERGY_DRAIN_PER_TICK = 0.08; // ~100 energy ≈ 5 min of diving

/**
 * A single movement primitive the agent can perform. Steps are camera-relative
 * (the camera never rotates: right = +x, forward = -z, away from the camera).
 */
export interface MovePrimitive {
  kind: "step" | "circle" | "jump" | "orbit";
  dx: number;
  dz: number;
  dash: boolean;
  /** dash directly away from the nearest virus ("dodge!" with no direction) */
  flee?: boolean;
  turns: number;
  secs: number;
}

/** Words that already mean something tactical — they win over movement parsing. */
const TACTICAL_RE =
  /retreat|fall back|disengage|hold|wait|steady|focus|weakest|thin|protect|guard|cover|attack|hit|flank/;

/**
 * Parse a freeform movement command into an executable primitive queue.
 * "do 3 circles and jump" -> [circle x3, jump]. "go right then dodge left"
 * -> [step right, dash left]. Returns [] when nothing movement-like is found.
 */
export function parseMoveSequence(text: string): MovePrimitive[] {
  const clauses = text.toLowerCase().split(/\bthen\b|\band\b|,|;/);
  const out: MovePrimitive[] = [];
  for (const raw of clauses) {
    const c = raw.trim();
    if (!c) continue;
    // "pivot around them", "orbit the virus" — circle the ENEMY, not yourself.
    // Plain "do 3 circles" stays a circle in place (the acrobatic kind).
    if (
      /\bpivot\w*|\borbit\w*/.test(c) ||
      (/\baround\b/.test(c) && /\b(them|him|it|viruses?|enemy|enemies)\b/.test(c))
    ) {
      const n = c.match(/(\d+)\s*(times?|circles?|loops?|orbits?)/);
      const turns = Math.min(
        n ? parseInt(n[1], 10) : /\btwice\b|two times/.test(c) ? 2 : 1,
        3,
      );
      out.push({
        kind: "orbit",
        dx: 0,
        dz: 0,
        dash: /\bdash\b|\bquick\b/.test(c),
        turns,
        secs: 3 * turns,
      });
      continue;
    }
    const circleMatch = c.match(/(\d+)?\s*(circles?|spins?|loops?)/);
    if (circleMatch || /\bspin\b/.test(c)) {
      const turns = Math.min(circleMatch?.[1] ? parseInt(circleMatch[1], 10) : 1, 5);
      out.push({ kind: "circle", dx: 0, dz: 0, dash: false, turns, secs: 1.2 * turns });
      continue;
    }
    if (/\bjump\b|\bhop\b/.test(c)) {
      const n = /\btwice\b|two times|x ?2/.test(c) ? 2 : 1;
      for (let i = 0; i < n; i++)
        out.push({ kind: "jump", dx: 0, dz: 0, dash: false, turns: 0, secs: 0.75 });
      continue;
    }
    let dx = 0;
    let dz = 0;
    if (/\bright\b/.test(c)) dx += 1;
    if (/\bleft\b/.test(c)) dx -= 1;
    if (/\bforward\b|\badvance\b|push (forward|up)|\bmove up\b/.test(c)) dz -= 1;
    if (/\bback\b/.test(c)) dz += 1;
    const dash = /\bdodge\b|\bdash\b|\bquick/.test(c);
    // "dodge!" with no direction = dash away from the nearest virus.
    if (dx === 0 && dz === 0) {
      if (!dash) continue;
      out.push({ kind: "step", dx: 0, dz: 0, dash: true, flee: true, turns: 0, secs: 0.75 });
      continue;
    }
    const l = Math.hypot(dx, dz);
    out.push({ kind: "step", dx: dx / l, dz: dz / l, dash, turns: 0, secs: dash ? 0.75 : 1.5 });
  }
  return out;
}

/**
 * Standing fight-style requests: "incorporate some jumps", "dodge more",
 * "fight evasive" -> the agent dodges on its own until told otherwise.
 * "fight normal" / "go aggressive" -> back to balanced.
 */
export function parseFightStyle(text: string): "evasive" | "balanced" | null {
  const t = text.toLowerCase();
  if (/evasive|dodge more|defensive|play it safe|incorporat\w* (some )?jumps?/.test(t)) return "evasive";
  if (/aggressive|all ?out|stop dodging|fight normal|balanced/.test(t)) return "balanced";
  return null;
}

export function isTacticalCommand(text: string): boolean {
  return TACTICAL_RE.test(text.toLowerCase());
}

function describePrimitive(p: MovePrimitive): string {
  if (p.kind === "jump") return "jump";
  if (p.kind === "circle") return p.turns === 1 ? "circle" : `${p.turns} circles`;
  if (p.kind === "orbit") return p.dash ? "quick pivot around them" : "pivot around them";
  if (p.flee) return "dodge away";
  const dir = p.dx > 0.5 ? "right" : p.dx < -0.5 ? "left" : p.dz > 0.5 ? "back" : "forward";
  return `${p.dash ? "dash" : "step"} ${dir}`;
}

interface QueuedMove extends MovePrimitive {
  startedAt: number;
  until: number;
}

/**
 * Translate the queue's head step into this tick's sim nudge. Pure — tested.
 */
export function nudgeForStep(
  step: QueuedMove | null,
  tick: number,
): {
  move: { dx: number; dz: number; dash: boolean; flee?: boolean; orbit?: boolean } | null;
  jump: boolean;
} {
  if (!step) return { move: null, jump: false };
  if (step.kind === "jump") return { move: null, jump: true };
  if (step.kind === "orbit")
    return { move: { dx: 0, dz: 0, dash: step.dash, orbit: true }, jump: false };
  if (step.kind === "circle") {
    const span = Math.max(1, step.until - step.startedAt);
    const a = (2 * Math.PI * step.turns * (tick - step.startedAt)) / span;
    return { move: { dx: Math.cos(a), dz: Math.sin(a), dash: false }, jump: false };
  }
  return { move: { dx: step.dx, dz: step.dz, dash: step.dash, flee: step.flee }, jump: false };
}

/**
 * Phrases that tell the agent to start the next wave. Only honored while
 * resting between waves — mid-fight they're just coaching words.
 */
export function isReadyCommand(text: string): boolean {
  return /next wave|ready|bring (it|them) on|send them/i.test(text);
}

/**
 * Maneuvers are temporary orders — the agent executes, then resumes its own
 * judgment. Stances (engage/hold/protect) persist until countermanded.
 * Returns the tick the maneuver expires, or null for stances.
 */
export function maneuverExpiry(
  directive: "engage" | "disengage" | "hold" | "focus_weakest" | "protect",
  tick: number,
): number | null {
  if (directive === "disengage") return tick + 16; // 4s of giving ground
  if (directive === "focus_weakest") return tick + 24; // 6s of focused fire
  return null;
}

/**
 * Corpses linger 4 ticks (1s) in the "down" pose so the death reads, then
 * vanish from the snapshot — no more standing corpses confusing the operator.
 */
export function visibleFighters(
  fighters: Fighter[],
  downAt: Map<string, number>,
  tick: number,
): Fighter[] {
  return fighters.filter((f) => f.hp > 0 || tick - (downAt.get(f.id) ?? -100) < 4);
}

/**
 * The wave debrief: distill what just happened into a memory the agent keeps.
 * Deterministic ($0, testable) — the remembering is factual, the *reasoning*
 * over it happens in the vendor mind, which gets these in its prompt.
 */
export interface WaveDebriefInput {
  wave: number;
  ticksTaken: number;
  hpStart: number;
  hpEnd: number;
  maxHp: number;
  minHp: number;
  virusesKilled: number;
  operatorCommands: number;
  mindActions: string[];
  style: string;
}

export interface WaveDebrief {
  /** persisted to Convex — short, factual, LLM-digestible */
  memory: string;
  bondDelta: number;
  bondReason: string;
  /** the agent's spoken reflection during the rest phase */
  reflection: string;
}

const MIND_ACTION_VERBS: Record<string, string> = {
  engage: "pressed the attack",
  disengage: "gave ground",
  hold: "held position",
  focus_weakest: "focused the weakest",
  protect: "covered the operator",
  dodge: "dashed clear",
  jump: "leapt swings",
  orbit: "pivoted around them",
  strafe: "sidestepped",
};

export function buildWaveDebrief(i: WaveDebriefInput): WaveDebrief {
  const secs = Math.round(i.ticksTaken / 4);
  const damage = Math.max(0, i.hpStart - i.hpEnd);
  const flawless = damage === 0;
  const closeCall = i.minHp < i.maxHp * 0.3;
  const verbs = [...new Set(i.mindActions)]
    .map((a) => MIND_ACTION_VERBS[a] ?? a)
    .filter(Boolean);
  const parts = [
    `Wave ${i.wave} (${secs}s): cleared.`,
    `Damage ${damage} (${i.hpStart}->${i.hpEnd}hp).`,
    `${i.virusesKilled} virus${i.virusesKilled === 1 ? "" : "es"} deleted.`,
    `Style ${i.style}.`,
  ];
  if (verbs.length > 0) parts.push(`I ${verbs.join(", ")}.`);
  if (i.operatorCommands > 0)
    parts.push(`Operator gave ${i.operatorCommands} command${i.operatorCommands === 1 ? "" : "s"}.`);
  if (closeCall) parts.push(`Close call — dropped to ${i.minHp}hp.`);
  if (flawless) parts.push(`Flawless — not a scratch.`);

  let reflection: string;
  if (flawless) {
    reflection = `Flawless — not a scratch on me. Whatever we did, let's do it again.`;
  } else if (closeCall) {
    reflection = `That got hairy — down to ${i.minHp}hp at one point. Glad you were coaching.`;
  } else if (i.mindActions.includes("orbit") && i.operatorCommands > 0) {
    reflection = `Pivoting around them worked — noted. I'll remember that.`;
  } else {
    reflection = `Wave ${i.wave} down: ${i.virusesKilled} deleted, ${damage} damage taken.`;
  }

  return {
    memory: parts.join(" "),
    bondDelta: 10 + (flawless ? 5 : 0),
    bondReason: `cleared wave ${i.wave}${flawless ? " flawless" : ""}`,
    reflection,
  };
}
/**
 * Compact tactical snapshot for the mind's decide() — cheap enough to send
 * every 4s, even to a vendor LLM. Read it like a radar readout:
 *   "w2 | 3v: aqua40 melee SWING!, null25 mid WINDUP | agent 70% melee | style balanced"
 * SWING! = a swing landing within ~0.5s (jump now or eat it).
 * WINDUP  = telegraphing, still time to reposition.
 */
export function tacticalSituation(world: WorldState, wave: number): string {
  const agent = world.fighters.find((f) => f.kind === "agent");
  if (!agent) return `w${wave} | agent down`;
  const dist2d = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);
  const viruses = world.fighters.filter((f) => f.kind === "virus" && f.hp > 0);
  const parts = viruses.map((v) => {
    const band = rangeBandOf(dist2d(agent.pos, v.pos));
    const w = v.windup ?? 0;
    const mark = w > 0.5 ? " WINDUP" : w > 0 ? " SWING!" : "";
    return `${v.element}${v.hp} ${band}${mark}`;
  });
  const nearest = viruses.length
    ? rangeBandOf(Math.min(...viruses.map((v) => dist2d(agent.pos, v.pos))))
    : "far";
  const agentHp = Math.round((agent.hp / agent.maxHp) * 100);
  return `w${wave} | ${viruses.length}v: ${parts.join(", ")} | agent ${agentHp}% ${nearest} | style ${world.style ?? "balanced"}`;
}

/** How the mind's decisions reach the sim — same primitives the operator uses. */
export interface MindActuators {
  /** Enqueue a one-shot impulse (dodge/jump). */
  queue: (seq: MovePrimitive[], tick: number) => void;
  /** Set a temporary maneuver — same machinery as operator orders. */
  maneuver: (
    d: "engage" | "disengage" | "hold" | "focus_weakest" | "protect",
    untilTick: number,
  ) => void;
  /** Flip the persistent fight style. */
  setStyle: (s: FightStyle) => void;
}

/** Mind maneuvers last 4s — the mind reassesses on its own cadence anyway. */
export const MIND_MANEUVER_TICKS = 16;

/**
 * Apply the mind's autonomous decision to the sim. Returns a short summary
 * for the flight recorder. Stances become temporary maneuvers; dodge/jump
 * are one-shot impulses; style flips the persistent stance unless the
 * operator locked it with their own word.
 */
export function applyMindDecision(
  world: WorldState,
  decision: MindDecision,
  tick: number,
  act: MindActuators,
  opts: { styleLocked: boolean; queueBusy: boolean },
): string {
  const done: string[] = [];
  const a = decision.action;
  if (a === "dodge") {
    if (!opts.queueBusy) {
      act.queue([{ kind: "step", dx: 0, dz: 0, dash: true, flee: true, turns: 0, secs: 0.75 }], tick);
      done.push("dodge");
    } else {
      done.push("dodge(skipped: operator moving)");
    }
  } else if (a === "jump") {
    if (!opts.queueBusy) {
      act.queue([{ kind: "jump", dx: 0, dz: 0, dash: false, turns: 0, secs: 0 }], tick);
      done.push("jump");
    } else {
      done.push("jump(skipped: operator moving)");
    }
  } else if (a === "orbit") {
    // Pivot around the nearest threat for ~3s, holding distance.
    if (!opts.queueBusy) {
      act.queue([{ kind: "orbit", dx: 0, dz: 0, dash: false, turns: 0, secs: 3 }], tick);
      done.push("orbit");
    } else {
      done.push("orbit(skipped: operator moving)");
    }
  } else if (a === "strafe") {
    // A strafe is a quick lateral dash around the threat — same orbit
    // machinery, short and fast: sidestep without giving ground.
    if (!opts.queueBusy) {
      act.queue([{ kind: "orbit", dx: 0, dz: 0, dash: true, turns: 0, secs: 0.75 }], tick);
      done.push("strafe");
    } else {
      done.push("strafe(skipped: operator moving)");
    }
  } else {
    act.maneuver(a, tick + MIND_MANEUVER_TICKS);
    done.push(`maneuver:${a}`);
  }
  if (decision.style && !opts.styleLocked && decision.style !== (world.style ?? "balanced")) {
    act.setStyle(decision.style);
    done.push(`style:${decision.style}`);
  }
  return done.join(" ");
}

interface DirectorConfig {
  convexUrl: string;
  agentId: string;
  zoneId: string;
  mind: MindProvider;
}

export async function runDirector(cfg: DirectorConfig): Promise<() => void> {
  const convex = new ConvexHttpClient(cfg.convexUrl);
  const rand = rng(Date.now() % 2 ** 31);

  // Boot: agent record + attach to the live dive (or start one).
  // Either boot order works: director-first creates the session, client-first
  // leaves one for the director to adopt. One session per agent, always.
  const agent = await convex.query(api.agents.get, {
    agentId: cfg.agentId as Id<"agents">,
  });
  if (!agent) throw new Error(`agent ${cfg.agentId} not found — compile one first (agents:compile)`);

  // Recall: what the agent remembers from past dives. Loaded once at boot,
  // appended locally after each wave debrief — no re-query mid-dive.
  const memoryLines = (
    await convex.query(api.agents.recentMemories, {
      agentId: cfg.agentId as Id<"agents">,
      limit: 8,
    })
  ).map((m) => m.text);
  if (memoryLines.length > 0)
    console.log(`[director] recalled ${memoryLines.length} memories for ${agent.name}.${agent.ext}`);
  const existingSession = await convex.query(api.session.getActive, {
    agentId: cfg.agentId as Id<"agents">,
  });
  const isNewSession = !existingSession;
  const sessionId = (
    existingSession?._id ??
    (await convex.mutation(api.session.start, {
      agentId: cfg.agentId as Id<"agents">,
      zoneId: cfg.zoneId,
    }))
  ) as Id<"sessions">;
  if (!isNewSession) console.log(`[director] adopted live session ${sessionId}`);

  // Spawn: agent at origin, two starter viruses ahead.
  const world: WorldState = { fighters: [], events: [] };
  world.fighters.push({
    id: `agent-${agent._id}`,
    kind: "agent",
    name: `${agent.name}.${agent.ext}`,
    pos: { x: 0, y: 0, z: 0 },
    pose: "idle",
    hp: 120,
    maxHp: 120,
    element: agent.element as Fighter["element"],
    cooldown: 0,
  });
  const virusDefs = [
    { name: "Scrapbit", element: "aqua", x: 6, z: 2 },
    { name: "Glitchwasp", element: "elec", x: -5, z: 5 },
  ];
  virusDefs.forEach((v, i) =>
    world.fighters.push({
      id: `virus-${i}`,
      kind: "virus",
      name: v.name,
      pos: { x: v.x, y: 0, z: v.z },
      pose: "idle",
      hp: 40,
      maxHp: 40,
      element: v.element as Fighter["element"],
      cooldown: 0,
      aggression: 0.6,
    }),
  );

  let tick = 0;
  let energy = agent.energy;
  let synchro = 50;
  let syncTier = synchroTier(synchro).tier; // announce tier crossings once
  let directive: "engage" | "disengage" | "hold" | "focus_weakest" | "protect" = "engage";
  let directiveUntil: number | null = null; // tick when a temporary maneuver expires
  let directiveSource: "operator" | "mind" | null = null; // whose judgment currently steers
  let styleByOperator = false; // the operator's word on style is law — the mind won't touch it
  let decideInFlight = false; // one decide() at a time — a slow vendor must not pile up
  // The operator's recent utterances, for the mind's context — a standing
  // order ("pivot around them") steers the mind for ~30s, then lapses.
  const recentOperatorLines: { text: string; tick: number }[] = [];
  const noteOperatorLine = (text: string) => {
    const t = text.trim().slice(0, 80);
    if (!t) return;
    recentOperatorLines.push({ text: t, tick });
    while (recentOperatorLines.length > 5) recentOperatorLines.shift();
  };
  let moveQueue: QueuedMove[] = []; // conversational movement sequences, in order

  // Per-wave stats for the debrief — reset at every wave spawn.
  let waveStartHp = 120;
  let waveStartTick = 0;
  let waveMinHp = 120;
  let waveCommands = 0;
  const waveMindActions = new Set<string>();
  const resetWaveStats = (hp: number, tick: number) => {
    waveStartHp = hp;
    waveStartTick = tick;
    waveMinHp = hp;
    waveCommands = 0;
    waveMindActions.clear();
  };

  /** Enqueue a parsed movement sequence — steps chain back-to-back. */
  const queueMoves = (seq: MovePrimitive[], tick: number): void => {
    let t = tick;
    moveQueue = seq.map((s) => {
      const dur = Math.max(1, Math.round(s.secs * 4));
      const step: QueuedMove = { ...s, startedAt: t, until: t + dur };
      t += dur;
      return step;
    });
  };
  let targetElement: Element | null = null;
  let lastOperatorTick = -1000; // banter stays quiet right after a conversation
  let wave = 1; // the opening pair is wave 1; clears escalate from here
  let resting = false; // true between waves — the operator's breather to chat and coach
  const downAt = new Map<string, number>(); // fighterId -> tick it died (corpses linger 1s, then vanish)
  let running = true;

  /** Map operator words to a battle directive. */
  const parseDirective = (text: string) => {
    const t = text.toLowerCase();
    if (/retreat|fall back|disengage/.test(t)) return "disengage" as const;
    if (/hold|wait|steady/.test(t)) return "hold" as const;
    if (/focus|weakest|thin/.test(t)) return "focus_weakest" as const;
    if (/protect|guard|cover/.test(t)) return "protect" as const;
    return "engage" as const;
  };
  /** "hit the acqua" should mean the aqua virus. Colors work too. */
  const parseElement = (text: string): Element | null => {
    const t = text.toLowerCase();
    if (/acqua|aqua|water|blue/.test(t)) return "aqua";
    if (/fire|flame|burn|cinder|red/.test(t)) return "fire";
    if (/elec|electric|thunder|volt|arc|yellow/.test(t)) return "elec";
    if (/wood|leaf|vine|green/.test(t)) return "wood";
    return null;
  };
  /** Fire-and-forget agent line — a slow mind must never stall the 4Hz loop. */
  const sayAsync = (situation: string, prompt: string) => {
    cfg.mind
      .speak(
        {
          agentName: agent.name,
          agentExt: agent.ext,
          bondTier: agent.bondTier,
          recentMemories: memoryLines,
          situation,
        },
        prompt,
      )
      .then((line) =>
        convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: { type: "dialogue", speaker: `${agent.name}.${agent.ext}`, text: line },
        }),
      )
      .catch(() => {});
  };

  const trace = async (
    level: "L0" | "L1" | "L2",
    action: string,
    rationale: string,
    latencyMs: number,
    tokens = 0,
  ) => {
    await convex.mutation(api.session.logTrace, {
      sessionId,
      tick,
      level,
      provider: cfg.mind.name,
      latencyMs,
      tokens,
      costUsd: estimateCostUsd(cfg.mind.name, tokens),
      action,
      rationale,
    });
  };

  await trace("L2", "dive_start", `${agent.name}.${agent.ext} dove into ${cfg.zoneId}`, 0);
  if (isNewSession) {
    await convex.mutation(api.session.pushEvent, {
      sessionId,
      tick,
      event: {
        type: "dialogue",
        speaker: `${agent.name}.${agent.ext}`,
        text: await cfg.mind.speak(
          {
            agentName: agent.name,
            agentExt: agent.ext,
            bondTier: agent.bondTier,
            recentMemories: memoryLines,
            situation: "dive start",
          },
          "dive start",
        ),
      },
    });
  } else {
    await convex.mutation(api.session.pushEvent, {
      sessionId,
      tick,
      event: {
        type: "dialogue",
        speaker: `${agent.name}.${agent.ext}`,
        text: `Director reconnected — I'm still here, operator.`,
      },
    });
  }

  const timer = setInterval(async () => {
    if (!running) return;
    const t0 = Date.now();
    tick++;

    // 1. Consume operator intents.
    const intents = (await convex.mutation(api.session.consumeIntents, { sessionId })) as {
      type: string;
      payload: unknown;
    }[];
    for (const intent of intents) {
      const p = intent.payload as Record<string, string>;
      if (intent.type === "command") {
        const text = p.text ?? "";
        // "Next wave" starts the fight again — only meaningful while resting.
        if (resting && isReadyCommand(text)) {
          resting = false;
          wave++;
          spawnWave(world, wave, rand);
          const count = Math.min(1 + wave, 6);
          lastOperatorTick = tick;
          resetWaveStats(world.fighters.find((f) => f.kind === "agent")?.hp ?? 120, tick);
          if (text.trim()) {
            await convex.mutation(api.session.pushEvent, {
              sessionId,
              tick,
              event: { type: "dialogue", speaker: "OPERATOR", text },
            });
          }
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: {
              type: "dialogue",
              speaker: `${agent.name}.${agent.ext}`,
              text: `Wave ${wave} incoming — ${count} viruses on the scope. Stay sharp!`,
            },
          });
          await trace("L1", `wave_start:${wave}`, `${count} viruses spawned`, Date.now() - t0);
          continue;
        }
        // Conversational movement wins when the words are movement, not tactics.
        const seq = parseMoveSequence(text);
        const moved = seq.length > 0 && !isTacticalCommand(text);
        if (!resting) waveCommands++; // coaching that shaped this wave — the debrief counts it
        if (moved) {
          queueMoves(seq, tick);
          synchro = Math.min(100, synchro + 2);
        } else {
          directive = parseDirective(text);
          directiveUntil = maneuverExpiry(directive, tick);
          directiveSource = "operator";
          targetElement = parseElement(text);
          synchro = Math.min(100, synchro + 2); // good coaching nudges synchro up
        }
        // Standing fight-style requests ("incorporate some jumps") are
        // independent of one-shot orders — the agent adopts the style
        // until told otherwise.
        const fs = parseFightStyle(text);
        if (fs) {
          world.style = fs;
          styleByOperator = true; // the operator's word on style is law
        }
        lastOperatorTick = tick;
        noteOperatorLine(text);
        // The operator's words appear in the feed — a dialogue needs both sides.
        if (text.trim()) {
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: "OPERATOR", text },
          });
        }
        // The ack must not block the tick: the world keeps fighting mid-sentence.
        // Tell the mind what the words did, so the ack sets the right expectation.
        const notes: string[] = [];
        if (moved)
          notes.push(
            `movement sequence: ${seq.map(describePrimitive).join(", ")} — the agent performs it, then resumes its own judgment`,
          );
        else if (directiveUntil !== null)
          notes.push(
            `brief maneuver: the agent does this for a few seconds, then resumes its own judgment`,
          );
        if (fs)
          notes.push(
            fs === "evasive"
              ? `fight style: evasive — the agent leaps and dashes around swings on its own until you say "fight normal"`
              : `fight style: balanced — back to straightforward fighting`,
          );
        const maneuverNote = notes.length > 0 ? ` (${notes.join("; ")})` : "";
        sayAsync(`operator command: ${text}`, `operator command: ${text}${maneuverNote}`);
        await trace("L1", `command:${directive}`, `operator said "${text}"`, Date.now() - t0);
      } else if (intent.type === "slot_script") {
        synchro = Math.min(100, synchro + 4);
        const flavor = applyScript(world, p.scriptId, targetElement);
        await convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: { type: "script_fired", scriptId: p.scriptId, byId: `agent-${agent._id}` },
        });
        if (flavor) {
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: `${agent.name}.${agent.ext}`, text: flavor },
          });
        }
        await trace("L1", `slot_script:${p.scriptId}`, flavor ?? "operator slotted a script mid-battle", 1);
      } else if (intent.type === "chat") {
        const text = p.text ?? "";
        // Chat that reads like a command also steers the agent ("hit the acqua").
        let styled = false; // a fight-style change already got its own ack
        if (
          /retreat|fall back|disengage|hold|wait|steady|focus|weakest|thin|protect|guard|cover|attack|hit|flank/.test(
            text.toLowerCase(),
          )
        ) {
          directive = parseDirective(text);
          directiveUntil = maneuverExpiry(directive, tick);
          directiveSource = "operator";
          targetElement = parseElement(text);
          synchro = Math.min(100, synchro + 2);
        } else {
          // Pure movement chat ("do 3 circles and jump") — no tactics attached.
          const seq = parseMoveSequence(text);
          if (seq.length > 0) {
            queueMoves(seq, tick);
            synchro = Math.min(100, synchro + 2);
          }
          const fs = parseFightStyle(text);
          styled = !!fs;
          if (fs) {
            world.style = fs;
            styleByOperator = true; // the operator's word on style is law
            sayAsync(
              "mid-dive chat",
              `${text} (fight style: ${fs}${fs === "evasive" ? " — the agent leaps and dashes around swings on its own until told otherwise" : " — back to straightforward fighting"})`,
            );
          }
        }
        lastOperatorTick = tick;
        noteOperatorLine(text);
        if (text.trim()) {
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: "OPERATOR", text },
          });
        }
        if (!styled) sayAsync("mid-dive chat", text);
        await trace("L2", "chat_reply", `responded to operator`, Date.now() - t0);
      }
    }

    // 2. L0 sim tick (free, every tick).
    const agentF = world.fighters.find((f) => f.kind === "agent");
    const situation = agentF
      ? `${world.fighters.filter((f) => f.kind === "virus" && f.hp > 0).length} viruses, agent hp ${agentF.hp}%${agentF.hp < 30 ? ", hp low" : ""}`
      : "agent down";
    // 2a2. Movement queue: conversational sequences drive the sim one tick at a time.
    while (moveQueue.length > 0 && tick >= moveQueue[0].until) moveQueue.shift();
    const nudge = nudgeForStep(moveQueue[0] ?? null, tick);

    tickWorld(world, TICK_MS / 1000, directive, rand, targetElement, nudge.move || nudge.jump ? nudge : null, synchro);

    // Drain world events into the Convex feed.
    for (const e of world.events.splice(0)) {
      if (e.type === "hit") {
        synchro = Math.max(0, synchro - (e.targetId.startsWith("agent") ? 3 : 0));
        await convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: {
            type: "hit",
            attackerId: e.attackerId,
            targetId: e.targetId,
            damage: e.damage,
            element: e.element,
          },
        });
      } else if (e.type === "down") {
        downAt.set(e.fighterId, tick);
        await convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: { type: "down", fighterId: e.fighterId },
        });
      }
    }

    // Synchro tiers: coaching quality is mechanical now. Crossing into or out
    // of a tier is announced once — the operator should feel the shift.
    // (Steady crossings stay quiet; the feed is for moments, not noise.)
    const tierNow = synchroTier(synchro).tier;
    if (tierNow !== syncTier) {
      syncTier = tierNow;
      if (tierNow === "in sync" || tierNow === "desync") {
        await convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: {
            type: "dialogue",
            speaker: `${agent.name}.${agent.ext}`,
            text:
              tierNow === "in sync"
                ? "We're in sync, operator — feel that rhythm. My strikes hit harder and my arm cycles faster."
                : "I'm losing our rhythm — coach me back, operator. Call the fight with me.",
          },
        });
      }
    }

    // 2a. Maneuver expiry: temporary orders lapse, the agent resumes its own judgment.
    if (directiveUntil !== null && tick >= directiveUntil) {
      directive = "engage";
      directiveUntil = null;
      directiveSource = null;
      await trace("L1", "maneuver_expired", "directive reverted to engage", 0);
    }

    // 2b. Wave control: clears escalate, death ends the dive.
    const agentAlive = (world.fighters.find((f) => f.kind === "agent")?.hp ?? 0) > 0;
    const agentHpNow = world.fighters.find((f) => f.kind === "agent")?.hp ?? 0;
    if (!resting && agentAlive) waveMinHp = Math.min(waveMinHp, agentHpNow);
    const virusesAlive = world.fighters.filter((f) => f.kind === "virus" && f.hp > 0).length;
    if (!agentAlive) {
      // Even in defeat, the agent remembers — how it died shapes the next dive.
      const killed = world.fighters.filter((f) => f.kind === "virus" && f.hp <= 0).length;
      await convex.mutation(api.agents.appendMemory, {
        agentId: cfg.agentId as Id<"agents">,
        kind: "battle",
        text:
          `Wave ${wave} (${Math.round((tick - waveStartTick) / 4)}s): deleted in action. ` +
          `${killed} virus${killed === 1 ? "" : "es"} downed first. ` +
          `Style ${world.style ?? "balanced"}. Operator gave ${waveCommands} commands.`,
      });
      await convex.mutation(api.session.pushEvent, {
        sessionId,
        tick,
        event: {
          type: "dialogue",
          speaker: `${agent.name}.${agent.ext}`,
          text: `I'm down... jack me out, operator. We'll get them next time.`,
        },
      });
      await convex.mutation(api.session.rest, { sessionId });
      clearInterval(timer);
      running = false;
      console.log("[director] agent down — dive over. Surfacing.");
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (virusesAlive === 0 && !resting) {
      // The arena is clear: rest. The next wave waits for the operator —
      // no timer pressure, and the energy clock pauses while they chat.
      resting = true;
      const a = world.fighters.find((f) => f.kind === "agent")!;
      // The debrief: distill the wave into a memory BEFORE the breather heal,
      // so the damage number is honest. Remembering is what makes the next
      // dive smarter — the mind gets these in its prompt.
      const debrief = buildWaveDebrief({
        wave,
        ticksTaken: tick - waveStartTick,
        hpStart: waveStartHp,
        hpEnd: a.hp,
        maxHp: a.maxHp,
        minHp: waveMinHp,
        virusesKilled: world.fighters.filter((f) => f.kind === "virus").length,
        operatorCommands: waveCommands,
        mindActions: [...waveMindActions],
        style: world.style ?? "balanced",
      });
      await convex.mutation(api.agents.appendMemory, {
        agentId: cfg.agentId as Id<"agents">,
        kind: "battle",
        text: debrief.memory,
      });
      memoryLines.push(debrief.memory); // recall stays fresh — the next wave's mind sees this one
      const bond = await convex.mutation(api.agents.addBondXp, {
        agentId: cfg.agentId as Id<"agents">,
        delta: debrief.bondDelta,
        reason: debrief.bondReason,
      });
      a.hp = Math.min(a.maxHp, a.hp + 25); // catch your breath between waves
      synchro = Math.min(100, synchro + 10);
      await convex.mutation(api.session.pushEvent, {
        sessionId,
        tick,
        event: {
          type: "dialogue",
          speaker: `${agent.name}.${agent.ext}`,
          text: `Wave ${wave} cleared — nice coaching, operator. Catch your breath. Say "next wave" when you're ready.`,
        },
      });
      // The agent reflects on the wave out loud — the memory system, visible.
      await convex.mutation(api.session.pushEvent, {
        sessionId,
        tick,
        event: {
          type: "dialogue",
          speaker: `${agent.name}.${agent.ext}`,
          text: debrief.reflection,
        },
      });
      if (bond.leveledUp) {
        await convex.mutation(api.session.pushEvent, {
          sessionId,
          tick,
          event: {
            type: "dialogue",
            speaker: `${agent.name}.${agent.ext}`,
            text: `I can feel it, operator — we're ${bond.tier} now. The bond is real.`,
          },
        });
      }
      await trace("L1", `wave_cleared:${wave}`, `${wave} down, resting until operator is ready`, 1);
    }

    // 2c. L1 autonomy: the mind reads the fight and moves on its own.
    // Every 4s, fire-and-forget — a slow vendor must never stall the 4Hz loop.
    // The operator's word is law: their fresh commands and maneuvers hold the
    // floor, and a decision that arrives after they spoke is dropped, not applied.
    if (
      !decideInFlight &&
      !resting &&
      agentAlive &&
      virusesAlive > 0 &&
      tick % 16 === 0 &&
      tick - lastOperatorTick > 8 &&
      (directiveUntil === null || directiveSource !== "operator")
    ) {
      decideInFlight = true;
      const seenOperatorTick = lastOperatorTick;
      const t0d = Date.now();
      const tactics = tacticalSituation(world, wave);
      cfg.mind
        .decide({
          agentName: agent.name,
          agentExt: agent.ext,
          bondTier: agent.bondTier,
          recentMemories: memoryLines,
          situation,
          tactics,
          operatorLines: recentOperatorLines
            .filter((l) => tick - l.tick < 120)
            .map((l) => l.text)
            .slice(-3),
        })
        .then(async (d) => {
          if (lastOperatorTick !== seenOperatorTick) return; // operator spoke mid-thought — their word stands
          if (!resting) waveMindActions.add(d.action); // the debrief remembers what the mind did
          const before = world.style ?? "balanced";
          const summary = applyMindDecision(
            world,
            d,
            tick,
            {
              queue: (seq, t) => queueMoves(seq, t),
              maneuver: (m, until) => {
                directive = m;
                directiveUntil = until;
                directiveSource = "mind";
              },
              setStyle: (s) => {
                world.style = s;
              },
            },
            { styleLocked: styleByOperator, queueBusy: moveQueue.length > 0 },
          );
          await trace(
            "L1",
            "mind_decide",
            `${d.rationale} → ${summary}`,
            Date.now() - t0d,
            cfg.mind.lastTokens,
          );
          // A style change the mind chose itself is worth announcing —
          // it's the visible proof the agent thinks for itself.
          if (before !== (world.style ?? "balanced")) {
            await convex.mutation(api.session.pushEvent, {
              sessionId,
              tick,
              event: {
                type: "dialogue",
                speaker: `${agent.name}.${agent.ext}`,
                text:
                  world.style === "evasive"
                    ? `Going evasive — ${d.rationale}.`
                    : `Back to balanced — ${d.rationale}.`,
              },
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          decideInFlight = false;
        });
    }

    // 3. Energy — the fiction-coherent session clock.
    // The energy clock pauses while resting — the breather is the operator's time.
    if (!resting) energy = Math.max(0, energy - ENERGY_DRAIN_PER_TICK);
    if (energy <= 0) {
      await convex.mutation(api.session.pushEvent, {
        sessionId,
        tick,
        event: {
          type: "dialogue",
          speaker: `${agent.name}.${agent.ext}`,
          text: `I'm beat — let's recharge. Same time tomorrow?`,
        },
      });
      await convex.mutation(api.session.rest, { sessionId });
      clearInterval(timer);
      running = false;
      // The dive is over — let the last writes flush, then exit. Nothing
      // runs forever: the agent's energy is the session clock.
      console.log("[director] agent exhausted — dive over. Surfacing.");
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // 4. Write the snapshot clients subscribe to.
    await convex.mutation(api.session.writeTick, {
      sessionId,
      tick,
      synchro,
      // Corpses get 1 second of "down" pose so the death reads, then vanish.
      entities: visibleFighters(world.fighters, downAt, tick).map((f) => ({
          entityId: f.id,
          kind: f.kind,
          name: f.name,
          x: f.pos.x,
          y: f.pos.y,
          z: f.pos.z,
          pose: f.pose,
          hp: f.hp,
          maxHp: f.maxHp,
          element: f.element,
        })),
    });

    // 5. L2 heartbeat, slow cadence: the agent comments on the fight.
    // Fire-and-forget: a slow vendor must never stall the 4Hz tick loop.
    // Stays quiet for a bit after the operator speaks — no pile-on.
    if (tick % 120 === 0 && tick - lastOperatorTick > 60 && situation !== "agent down") {
      cfg.mind
        .speak(
          {
            agentName: agent.name,
            agentExt: agent.ext,
            bondTier: agent.bondTier,
            recentMemories: memoryLines,
            situation,
          },
          "battle banter",
        )
        .then((line) =>
          convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: `${agent.name}.${agent.ext}`, text: line },
          }),
        )
        .catch(() => {});
    }

  }, TICK_MS);

  return () => {
    running = false;
    clearInterval(timer);
  };
}

export { MockMind };
