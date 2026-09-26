import { describe, expect, it } from "vitest";
import {
  applyMindDecision,
  isReadyCommand,
  MIND_MANEUVER_TICKS,
  nudgeForStep,
  parseMoveSequence,
  tacticalSituation,
  visibleFighters,
  type MovePrimitive,
} from "./loop.js";
import type { Fighter } from "./world.js";

describe("isReadyCommand", () => {
  it("matches the ways an operator asks for the next wave", () => {
    for (const t of [
      "next wave",
      "Next Wave!",
      "ready",
      "I'm ready",
      "bring it on",
      "bring them on",
      "send them",
    ]) {
      expect(isReadyCommand(t)).toBe(true);
    }
  });

  it("does not steal ordinary coaching words", () => {
    for (const t of ["fall back", "focus weakest", "hit the acqua", "hold", ""]) {
      expect(isReadyCommand(t)).toBe(false);
    }
  });
});

describe("visibleFighters", () => {
  const mk = (id: string, hp: number): Fighter => ({
    id,
    kind: "virus",
    name: id,
    pos: { x: 0, y: 0, z: 0 },
    pose: hp > 0 ? "idle" : "down",
    hp,
    maxHp: 40,
    element: "aqua",
    cooldown: 0,
  });

  it("keeps the living and freshly-dead, drops old corpses", () => {
    const fighters = [mk("alive", 30), mk("fresh", 0), mk("old", 0)];
    const downAt = new Map([
      ["fresh", 100],
      ["old", 90],
    ]);
    const visible = visibleFighters(fighters, downAt, 102).map((f) => f.id);
    expect(visible).toContain("alive");
    expect(visible).toContain("fresh"); // died 2 ticks ago — still reads as "down"
    expect(visible).not.toContain("old"); // died 12 ticks ago — vanished
  });

  it("drops corpses with no death record", () => {
    const visible = visibleFighters([mk("ghost", 0)], new Map(), 50).map((f) => f.id);
    expect(visible).not.toContain("ghost");
  });
});

describe("maneuverExpiry", () => {
  it("expires maneuvers, keeps stances", async () => {
    const { maneuverExpiry } = await import("./loop.js");
    expect(maneuverExpiry("disengage", 100)).toBe(116);
    expect(maneuverExpiry("focus_weakest", 100)).toBe(124);
    expect(maneuverExpiry("engage", 100)).toBeNull();
    expect(maneuverExpiry("hold", 100)).toBeNull();
    expect(maneuverExpiry("protect", 100)).toBeNull();
  });
});

describe("parseMoveSequence", () => {
  it("parses 'do 3 circles and jump'", async () => {
    const { parseMoveSequence } = await import("./loop.js");
    const seq = parseMoveSequence("do 3 circles and jump");
    expect(seq).toHaveLength(2);
    expect(seq[0].kind).toBe("circle");
    expect(seq[0].turns).toBe(3);
    expect(seq[1].kind).toBe("jump");
  });

  it("parses directional steps and dashes", async () => {
    const { parseMoveSequence } = await import("./loop.js");
    const seq = parseMoveSequence("go right then dodge left");
    expect(seq).toHaveLength(2);
    expect(seq[0]).toMatchObject({ kind: "step", dash: false });
    expect(seq[0].dx).toBeGreaterThan(0);
    expect(seq[1]).toMatchObject({ kind: "step", dash: true });
    expect(seq[1].dx).toBeLessThan(0);
  });

  it("returns [] for non-movement text", async () => {
    const { parseMoveSequence } = await import("./loop.js");
    expect(parseMoveSequence("attack the aqua one")).toHaveLength(0);
    expect(parseMoveSequence("you're doing great")).toHaveLength(0);
  });

  it("tactical words win over movement words", async () => {
    const { isTacticalCommand } = await import("./loop.js");
    expect(isTacticalCommand("fall back")).toBe(true);
    expect(isTacticalCommand("do 3 circles and jump")).toBe(false);
  });
});

describe("nudgeForStep", () => {
  it("rotates the direction through a circle", async () => {
    const { nudgeForStep } = await import("./loop.js");
    const step = { kind: "circle" as const, dx: 0, dz: 0, dash: false, turns: 1, secs: 4, startedAt: 0, until: 16 };
    const a = nudgeForStep(step, 0).move!;
    const b = nudgeForStep(step, 4).move!;
    expect(a.dx).toBeCloseTo(1, 5);
    expect(a.dz).toBeCloseTo(0, 5);
    // quarter turn later the direction has rotated 90 degrees
    expect(b.dx).toBeCloseTo(0, 5);
    expect(b.dz).toBeCloseTo(1, 5);
  });

  it("passes jumps through", async () => {
    const { nudgeForStep } = await import("./loop.js");
    const step = { kind: "jump" as const, dx: 0, dz: 0, dash: false, turns: 0, secs: 0.75, startedAt: 0, until: 3 };
    expect(nudgeForStep(step, 0)).toEqual({ move: null, jump: true });
    expect(nudgeForStep(null, 0)).toEqual({ move: null, jump: false });
  });
});

describe("parseFightStyle", () => {
  it("detects evasive requests", async () => {
    const { parseFightStyle } = await import("./loop.js");
    expect(parseFightStyle("let's incorporate some jumps and dodge on the next wave")).toBe("evasive");
    expect(parseFightStyle("dodge more")).toBe("evasive");
    expect(parseFightStyle("fight evasive")).toBe("evasive");
    expect(parseFightStyle("play it safe")).toBe("evasive");
  });

  it("detects balanced requests", async () => {
    const { parseFightStyle } = await import("./loop.js");
    expect(parseFightStyle("fight normal")).toBe("balanced");
    expect(parseFightStyle("go aggressive")).toBe("balanced");
    expect(parseFightStyle("stop dodging")).toBe("balanced");
  });

  it("returns null for one-shot movement and chatter", async () => {
    const { parseFightStyle } = await import("./loop.js");
    expect(parseFightStyle("jump")).toBeNull();
    expect(parseFightStyle("do 3 circles and jump")).toBeNull();
    expect(parseFightStyle("you're doing great")).toBeNull();
  });
});

describe("flee parsing", () => {
  it("'dodge!' with no direction becomes a flee dash", async () => {
    const { parseMoveSequence } = await import("./loop.js");
    const seq = parseMoveSequence("dodge!");
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ kind: "step", dash: true, flee: true });
  });

  it("'dodge left' stays a directional dash", async () => {
    const { parseMoveSequence } = await import("./loop.js");
    const seq = parseMoveSequence("dodge left");
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ kind: "step", dash: true });
    expect(seq[0].flee).toBeFalsy();
    expect(seq[0].dx).toBeLessThan(0);
  });
});

describe("tacticalSituation", () => {
  const mkAgent = (hp: number, x: number, z: number): Fighter => ({
    id: "agent-1",
    kind: "agent",
    name: "agent",
    pos: { x, y: 0, z },
    pose: "idle",
    hp,
    maxHp: 120,
    element: "null",
    cooldown: 0,
  });
  const mkVirus = (id: string, element: "aqua" | "fire", hp: number, x: number, z: number, windup = 0): Fighter => ({
    id,
    kind: "virus",
    name: id,
    pos: { x, y: 0, z },
    pose: windup > 0 ? "windup" : "idle",
    hp,
    maxHp: 40,
    element,
    cooldown: 0,
    windup,
  });

  it("marks imminent swings SWING! and early telegraphs WINDUP", () => {
    const world = {
      fighters: [
        mkAgent(96, 0, 0),
        mkVirus("v1", "aqua", 40, 2, 0, 0.2), // in melee, about to land
        mkVirus("v2", "fire", 25, 6, 0, 0.7), // mid range, telegraphing
      ],
      events: [],
      style: "balanced" as const,
    };
    const s = tacticalSituation(world, 2);
    expect(s).toBe("w2 | 2v: aqua40 melee SWING!, fire25 mid WINDUP | agent 80% melee | style balanced");
  });

  it("handles a cleared arena", () => {
    const world = { fighters: [mkAgent(120, 0, 0)], events: [], style: "evasive" as const };
    expect(tacticalSituation(world, 3)).toBe("w3 | 0v:  | agent 100% far | style evasive");
  });
});

describe("applyMindDecision", () => {
  const baseWorld = () => ({ fighters: [], events: [], style: "balanced" as const });
  const mkAct = () => {
    const calls: { queue: MovePrimitive[][]; maneuver: [string, number][]; style: string[] } = {
      queue: [],
      maneuver: [],
      style: [],
    };
    return {
      calls,
      act: {
        queue: (seq: MovePrimitive[], t: number) => calls.queue.push(seq),
        maneuver: (d: "engage" | "disengage" | "hold" | "focus_weakest" | "protect", until: number) =>
          calls.maneuver.push([d, until]),
        setStyle: (s: "balanced" | "evasive") => calls.style.push(s),
      },
    };
  };

  it("queues a fleeing dash for dodge", () => {
    const { calls, act } = mkAct();
    const summary = applyMindDecision(
      baseWorld(),
      { action: "dodge", rationale: "repositioning" },
      100,
      act,
      { styleLocked: false, queueBusy: false },
    );
    expect(calls.queue).toHaveLength(1);
    expect(calls.queue[0][0]).toMatchObject({ kind: "step", dash: true, flee: true });
    expect(summary).toContain("dodge");
  });

  it("queues a jump", () => {
    const { calls, act } = mkAct();
    applyMindDecision(baseWorld(), { action: "jump", rationale: "leaping" }, 100, act, {
      styleLocked: false,
      queueBusy: false,
    });
    expect(calls.queue[0][0]).toMatchObject({ kind: "jump" });
  });

  it("turns stances into temporary maneuvers", () => {
    const { calls, act } = mkAct();
    const summary = applyMindDecision(
      baseWorld(),
      { action: "disengage", rationale: "kiting" },
      100,
      act,
      { styleLocked: false, queueBusy: false },
    );
    expect(calls.maneuver).toEqual([["disengage", 100 + MIND_MANEUVER_TICKS]]);
    expect(summary).toContain("maneuver:disengage");
  });

  it("flips style when unlocked, keeps it when the operator locked it", () => {
    const { calls, act } = mkAct();
    const world = baseWorld();
    applyMindDecision(world, { action: "engage", style: "evasive", rationale: "hurt" }, 100, act, {
      styleLocked: false,
      queueBusy: false,
    });
    expect(calls.style).toEqual(["evasive"]);

    const locked = mkAct();
    const world2 = baseWorld();
    applyMindDecision(
      world2,
      { action: "engage", style: "evasive", rationale: "hurt" },
      100,
      locked.act,
      { styleLocked: true, queueBusy: false },
    );
    expect(locked.calls.style).toEqual([]);
  });

  it("skips impulses while the operator has moves queued", () => {
    const { calls, act } = mkAct();
    const summary = applyMindDecision(
      baseWorld(),
      { action: "jump", rationale: "leaping" },
      100,
      act,
      { styleLocked: false, queueBusy: true },
    );
    expect(calls.queue).toEqual([]);
    expect(summary).toContain("skipped");
  });
});

describe("parseMoveSequence orbit", () => {
  it("'pivot around them in circles' orbits the enemy, not itself", () => {
    const seq = parseMoveSequence("try pivoting around them in circles");
    expect(seq).toHaveLength(1);
    expect(seq[0].kind).toBe("orbit");
    expect(seq[0].secs).toBe(3);
  });

  it("'orbit the virus twice' gives a longer orbit", () => {
    const seq = parseMoveSequence("orbit the virus twice");
    expect(seq[0].kind).toBe("orbit");
    expect(seq[0].secs).toBe(6);
  });

  it("plain 'do 3 circles' stays a circle in place", () => {
    const seq = parseMoveSequence("do 3 circles");
    expect(seq[0].kind).toBe("circle");
    expect(seq[0].turns).toBe(3);
  });
});

describe("nudgeForStep orbit", () => {
  it("translates an orbit step into an orbit nudge", () => {
    const n = nudgeForStep(
      { kind: "orbit", dx: 0, dz: 0, dash: false, turns: 0, secs: 3, startedAt: 0, until: 12 },
      5,
    );
    expect(n.move).toMatchObject({ orbit: true, dash: false });
    expect(n.jump).toBe(false);
  });
});

describe("applyMindDecision lateral moves", () => {
  const baseWorld = () => ({ fighters: [], events: [], style: "balanced" as const });
  const mkAct = () => {
    const queued: MovePrimitive[][] = [];
    return {
      queued,
      act: {
        queue: (seq: MovePrimitive[]) => queued.push(seq),
        maneuver: () => {},
        setStyle: () => {},
      },
    };
  };

  it("orbit queues a sustained pivot around the threat", () => {
    const { queued, act } = mkAct();
    const summary = applyMindDecision(
      baseWorld(),
      { action: "orbit", rationale: "pivoting" },
      100,
      act,
      { styleLocked: false, queueBusy: false },
    );
    expect(queued[0][0]).toMatchObject({ kind: "orbit", dash: false, secs: 3 });
    expect(summary).toContain("orbit");
  });

  it("strafe queues a quick lateral dash", () => {
    const { queued, act } = mkAct();
    applyMindDecision(baseWorld(), { action: "strafe", rationale: "sidestep" }, 100, act, {
      styleLocked: false,
      queueBusy: false,
    });
    expect(queued[0][0]).toMatchObject({ kind: "orbit", dash: true, secs: 0.75 });
  });

  it("skips lateral moves while the operator has moves queued", () => {
    const { queued, act } = mkAct();
    const summary = applyMindDecision(
      baseWorld(),
      { action: "orbit", rationale: "pivoting" },
      100,
      act,
      { styleLocked: false, queueBusy: true },
    );
    expect(queued).toEqual([]);
    expect(summary).toContain("skipped");
  });
});
