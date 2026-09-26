/**
 * The tick loop. 4Hz: consume intents -> L0 sim -> write snapshot -> traces.
 * Stateless: all durable state lives in Convex. Kill it anytime.
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { MockMind, estimateCostUsd, type MindProvider } from "./mind.js";
import { applyScript, rng, tickWorld, type Fighter, type WorldState } from "./world.js";
import type { Element } from "@agent-game/shared";

const TICK_MS = 250;
const ENERGY_DRAIN_PER_TICK = 0.08; // ~100 energy ≈ 5 min of diving

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
    hp: 100,
    maxHp: 100,
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
  let directive: "engage" | "disengage" | "hold" | "focus_weakest" | "protect" = "engage";
  let targetElement: Element | null = null;
  let lastOperatorTick = -1000; // banter stays quiet right after a conversation
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
  /** "hit the acqua" should mean the aqua virus. */
  const parseElement = (text: string): Element | null => {
    const t = text.toLowerCase();
    if (/acqua|aqua|water/.test(t)) return "aqua";
    if (/fire|flame|burn|cinder/.test(t)) return "fire";
    if (/elec|electric|thunder|volt|arc/.test(t)) return "elec";
    if (/wood|leaf|vine/.test(t)) return "wood";
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
          recentMemories: [],
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
            recentMemories: [],
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
        directive = parseDirective(text);
        targetElement = parseElement(text);
        synchro = Math.min(100, synchro + 2); // good coaching nudges synchro up
        lastOperatorTick = tick;
        // The operator's words appear in the feed — a dialogue needs both sides.
        if (text.trim()) {
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: "OPERATOR", text },
          });
        }
        // The ack must not block the tick: the world keeps fighting mid-sentence.
        sayAsync(`operator command: ${text}`, `operator command: ${text}`);
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
        if (
          /retreat|fall back|disengage|hold|wait|steady|focus|weakest|thin|protect|guard|cover|attack|hit|flank/.test(
            text.toLowerCase(),
          )
        ) {
          directive = parseDirective(text);
          targetElement = parseElement(text);
          synchro = Math.min(100, synchro + 2);
        }
        lastOperatorTick = tick;
        if (text.trim()) {
          await convex.mutation(api.session.pushEvent, {
            sessionId,
            tick,
            event: { type: "dialogue", speaker: "OPERATOR", text },
          });
        }
        sayAsync("mid-dive chat", text);
        await trace("L2", "chat_reply", `responded to operator`, Date.now() - t0);
      }
    }

    // 2. L0 sim tick (free, every tick).
    const agentF = world.fighters.find((f) => f.kind === "agent");
    const situation = agentF
      ? `${world.fighters.filter((f) => f.kind === "virus" && f.hp > 0).length} viruses, agent hp ${agentF.hp}%${agentF.hp < 30 ? ", hp low" : ""}`
      : "agent down";
    tickWorld(world, TICK_MS / 1000, directive, rand, targetElement);

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
      }
    }

    // 3. Energy — the fiction-coherent session clock.
    energy = Math.max(0, energy - ENERGY_DRAIN_PER_TICK);
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
      entities: world.fighters.map((f) => ({
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
            recentMemories: [],
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
