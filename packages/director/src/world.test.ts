import { describe, expect, it } from "vitest";
import { elementMultiplier, rangeBandOf } from "@agent-game/shared";
import { applyScript, rng, spawnWave, tickWorld, type Fighter, type WorldState } from "./world.js";

describe("element matchups", () => {
  it("fire beats wood, wood resists fire", () => {
    expect(elementMultiplier("fire", "wood")).toBe(2);
    expect(elementMultiplier("wood", "fire")).toBe(0.5);
  });
  it("null is neutral both ways", () => {
    expect(elementMultiplier("null", "fire")).toBe(1);
    expect(elementMultiplier("fire", "null")).toBe(1);
  });
});

describe("range bands", () => {
  it("classifies distance correctly", () => {
    expect(rangeBandOf(1)).toBe("melee");
    expect(rangeBandOf(5)).toBe("mid");
    expect(rangeBandOf(20)).toBe("long");
  });
});

describe("L0 sim invariants", () => {
  const mkWorld = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "Test.PY",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 100,
        maxHp: 100,
        element: "null",
        cooldown: 0,
      },
      {
        id: "v",
        kind: "virus",
        name: "Scrapbit",
        pos: { x: 10, y: 0, z: 0 },
        pose: "idle",
        hp: 40,
        maxHp: 40,
        element: "aqua",
        cooldown: 0,
        aggression: 1,
      },
    ],
    events: [],
  });

  it("agent closes distance and damages the virus", () => {
    const w = mkWorld();
    const rand = rng(42);
    for (let i = 0; i < 40; i++) tickWorld(w, 0.25, "engage", rand);
    const virus = w.fighters.find((f) => f.id === "v")!;
    expect(virus.hp).toBeLessThan(40);
  });

  it("hp never goes negative, events fire on hits", () => {
    const w = mkWorld();
    const rand = rng(7);
    for (let i = 0; i < 400; i++) tickWorld(w, 0.25, "engage", rand);
    for (const f of w.fighters) expect(f.hp).toBeGreaterThanOrEqual(0);
    expect(w.events.length).toBeGreaterThan(0);
  });

  it("disengage keeps the agent alive longer than engage", () => {
    const run = (directive: "engage" | "disengage") => {
      const w = mkWorld();
      // buff the virus so the difference is measurable
      w.fighters.find((f) => f.id === "v")!.hp = 400;
      const rand = rng(99);
      for (let i = 0; i < 120; i++) tickWorld(w, 0.25, directive, rand);
      return w.fighters.find((f) => f.id === "a")!.hp;
    };
    expect(run("disengage")).toBeGreaterThanOrEqual(run("engage"));
  });

  it("same seed replays identically", () => {
    const run = () => {
      const w = mkWorld();
      const rand = rng(1234);
      for (let i = 0; i < 60; i++) tickWorld(w, 0.25, "engage", rand);
      return w.fighters.map((f) => [f.id, f.hp, f.pos.x.toFixed(3)]);
    };
    expect(run()).toEqual(run());
  });
});

describe("shields and script effects", () => {
  const mkWorld = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "Test.PY",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 100,
        maxHp: 100,
        element: "null",
        cooldown: 0,
      },
      {
        id: "v",
        kind: "virus",
        name: "Scrapbit",
        pos: { x: 10, y: 0, z: 0 },
        pose: "idle",
        hp: 40,
        maxHp: 40,
        element: "aqua",
        cooldown: 0,
        aggression: 1,
      },
    ],
    events: [],
  });

  it("shield absorbs damage before hp", () => {
    const w = mkWorld();
    w.fighters.find((f) => f.id === "a")!.shield = 500;
    const rand = rng(7);
    for (let i = 0; i < 120; i++) tickWorld(w, 0.25, "hold", rand);
    const agent = w.fighters.find((f) => f.id === "a")!;
    expect(agent.hp).toBe(100);
    expect(agent.shield!).toBeLessThan(500);
  });

  it("targetElement steers the agent to that element", () => {
    const w = mkWorld();
    w.fighters.push({
      id: "v2",
      kind: "virus",
      name: "Glitchwasp",
      pos: { x: 3, y: 0, z: 0 },
      pose: "idle",
      hp: 40,
      maxHp: 40,
      element: "elec",
      cooldown: 0,
      aggression: 0, // keep it passive so the test isolates targeting
    });
    const rand = rng(42);
    for (let i = 0; i < 20; i++) tickWorld(w, 0.25, "engage", rand, "aqua");
    // aqua virus is farther but was preferred; elec virus untouched
    expect(w.fighters.find((f) => f.id === "v")!.hp).toBeLessThan(40);
    expect(w.fighters.find((f) => f.id === "v2")!.hp).toBe(40);
  });

  it("applyScript damage hits for power x element multiplier", () => {
    const w = mkWorld();
    const flavor = applyScript(w, "cinder-slash"); // fire 22 vs aqua = x0.5 -> 11
    const virus = w.fighters.find((f) => f.id === "v")!;
    expect(virus.hp).toBe(29);
    expect(w.events.some((e) => e.type === "hit" && e.damage === 11)).toBe(true);
    expect(flavor).toContain("Cinder Slash");
  });

  it("applyScript heal restores agent hp up to max", () => {
    const w = mkWorld();
    w.fighters.find((f) => f.id === "a")!.hp = 50;
    applyScript(w, "mend-protocol");
    expect(w.fighters.find((f) => f.id === "a")!.hp).toBe(75);
  });

  it("applyScript barrier grants a shield", () => {
    const w = mkWorld();
    applyScript(w, "aegis-wall");
    expect(w.fighters.find((f) => f.id === "a")!.shield).toBe(30);
  });

  it("applyScript stun locks the target's cooldown", () => {
    const w = mkWorld();
    applyScript(w, "static-snare");
    expect(w.fighters.find((f) => f.id === "v")!.cooldown).toBeGreaterThanOrEqual(3);
  });

  it("applyScript returns null for unknown scripts and unwired kinds", () => {
    const w = mkWorld();
    expect(applyScript(w, "nope")).toBeNull();
    expect(applyScript(w, "overclock")).toBeNull(); // buff: flavor-only in v1
    expect(w.events).toHaveLength(0);
  });
});

describe("waves", () => {
  const mkWorld = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "Test.PY",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 100,
        maxHp: 100,
        element: "null",
        cooldown: 0,
      },
    ],
    events: [],
  });

  it("spawnWave adds escalating virus counts with scaled hp", () => {
    const w2 = mkWorld();
    spawnWave(w2, 2, rng(1));
    expect(w2.fighters.filter((f) => f.kind === "virus")).toHaveLength(3);
    expect(w2.fighters.find((f) => f.kind === "virus")!.hp).toBe(60);

    const w5 = mkWorld();
    spawnWave(w5, 5, rng(1));
    const viruses = w5.fighters.filter((f) => f.kind === "virus");
    expect(viruses).toHaveLength(6); // capped
    expect(viruses[0].hp).toBe(90);
  });

  it("spawnWave clears corpses from earlier waves", () => {
    const w = mkWorld();
    w.fighters.push({
      id: "virus-old",
      kind: "virus",
      name: "Dead",
      pos: { x: 5, y: 0, z: 0 },
      pose: "down",
      hp: 0,
      maxHp: 40,
      element: "aqua",
      cooldown: 0,
    });
    spawnWave(w, 2, rng(1));
    expect(w.fighters.some((f) => f.id === "virus-old")).toBe(false);
    expect(w.fighters.filter((f) => f.kind === "virus" && f.hp > 0)).toHaveLength(3);
  });
});

describe("wind-up telegraphs", () => {
  const mkDuel = () => {
    const w: WorldState = {
      fighters: [
        { id: "a", kind: "agent", name: "Test.PY", pos: { x: 0, y: 0, z: 0 }, pose: "idle", hp: 100, maxHp: 100, element: "null", cooldown: 0 },
        { id: "v", kind: "virus", name: "V", pos: { x: 1, y: 0, z: 0 }, pose: "idle", hp: 40, maxHp: 40, element: "null", cooldown: 0, aggression: 1 },
      ],
      events: [],
    };
    return w;
  };
  const hits = (w: WorldState) => w.events.filter((e) => e.type === "hit");

  it("virus telegraphs instead of striking instantly", () => {
    const w = mkDuel();
    tickWorld(w, 0.25, "hold", rng(7));
    const v = w.fighters[1];
    expect(v.pose).toBe("windup");
    expect(v.windup).toBeGreaterThan(0);
    expect(hits(w)).toHaveLength(0); // no damage yet — the operator gets a reaction window
  });

  it("wind-up completes into a strike when the target holds still", () => {
    const w = mkDuel();
    const r = rng(7);
    for (let i = 0; i < 4; i++) tickWorld(w, 0.25, "hold", r);
    expect(hits(w)).toHaveLength(1);
    expect(w.fighters[0].hp).toBe(94); // VIRUS_POWER = 6, null vs null
  });

  it("kiting out of range during wind-up dodges the strike", () => {
    const w = mkDuel();
    const r = rng(7);
    tickWorld(w, 0.25, "hold", r); // wind-up starts
    w.fighters[0].pos.x = 50; // operator shouted "fall back!"
    for (let i = 0; i < 3; i++) tickWorld(w, 0.25, "hold", r);
    expect(hits(w)).toHaveLength(0);
    expect(w.fighters[0].hp).toBe(100);
  });

  it("killing the virus mid-wind-up cancels its attack", () => {
    const w = mkDuel();
    const r = rng(7);
    tickWorld(w, 0.25, "hold", r); // wind-up starts
    w.fighters[1].hp = 0; // interrupted
    for (let i = 0; i < 3; i++) tickWorld(w, 0.25, "hold", r);
    expect(hits(w)).toHaveLength(0);
  });
});

describe("autonomous footwork", () => {
  const mkFighter = (over: Partial<Fighter>): Fighter => ({
    id: "x",
    kind: "virus",
    name: "X",
    pos: { x: 0, y: 0, z: 0 },
    pose: "idle",
    hp: 40,
    maxHp: 40,
    element: "null",
    cooldown: 0,
    ...over,
  });

  it("gives ground when two viruses wind up swings in reach", () => {
    const w: WorldState = {
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 2, y: 0, z: 0 }, windup: 0.5 }),
        mkFighter({ id: "v2", pos: { x: 2, y: 0, z: 1 }, windup: 0.5 }),
      ],
      events: [],
    };
    tickWorld(w, 0.25, "engage", rng(3));
    const a = w.fighters[0];
    expect(a.pose).toBe("run");
    expect(a.pos.x).toBeLessThan(0); // stepped away from the pair's centroid
    expect(w.events.filter((e) => e.type === "hit" && e.attackerId === "a")).toHaveLength(0);
  });

  it("holds its ground against a single wind-up and punishes it", () => {
    const w: WorldState = {
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 1, y: 0, z: 0 }, windup: 0.5 }),
      ],
      events: [],
    };
    tickWorld(w, 0.25, "engage", rng(3));
    expect(w.fighters[0].pose).toBe("melee_attack");
  });
});

describe("operator nudge", () => {
  const mkAgent = (over = {}): Fighter => ({
    id: "a",
    kind: "agent",
    name: "A.PY",
    pos: { x: 0, y: 0, z: 0 },
    pose: "idle",
    hp: 100,
    maxHp: 100,
    element: "null",
    cooldown: 0,
    ...over,
  });
  const mkVirus = (over = {}): Fighter => ({
    id: "v",
    kind: "virus",
    name: "V",
    pos: { x: 10, y: 0, z: 0 },
    pose: "idle",
    hp: 40,
    maxHp: 40,
    element: "null",
    cooldown: 0,
    ...over,
  });

  it("steps right on a move nudge", () => {
    const w: WorldState = { fighters: [mkAgent(), mkVirus()], events: [] };
    tickWorld(w, 0.25, "engage", rng(1), null, { move: { dx: 1, dz: 0, dash: false } });
    expect(w.fighters[0].pos.x).toBeGreaterThan(0);
    expect(w.fighters[0].pose).toBe("run");
  });

  it("a jump dodges a melee swing", () => {
    const w: WorldState = {
      fighters: [mkAgent(), mkVirus({ pos: { x: 1, y: 0, z: 0 }, windup: 0.1, cooldown: 0 })],
      events: [],
    };
    // The virus is mid-swing; the agent jumps the exact tick it lands.
    tickWorld(w, 0.25, "engage", rng(1), null, { jump: true });
    expect(w.fighters[0].hp).toBe(100); // whiffed — leapt clean over it
    expect(w.fighters[0].pos.y).toBeGreaterThan(0);
    expect(w.fighters[0].pose).toBe("jump");
  });

  it("the jump lands back at y=0", () => {
    const w: WorldState = { fighters: [mkAgent({ airborne: 0.6, pos: { x: 0, y: 1, z: 0 } }), mkVirus()], events: [] };
    for (let i = 0; i < 4; i++) tickWorld(w, 0.25, "engage", rng(1));
    expect(w.fighters[0].pos.y).toBe(0);
    expect(w.fighters[0].airborne ?? 0).toBeLessThanOrEqual(0);
  });
});

describe("fight styles", () => {
  const mkFighter = (over: Partial<Fighter>): Fighter => ({
    id: "x",
    kind: "virus",
    name: "X",
    pos: { x: 0, y: 0, z: 0 },
    pose: "idle",
    hp: 40,
    maxHp: 40,
    element: "null",
    cooldown: 0,
    ...over,
  });

  it("evasive style leaps a swing that's about to land and takes no damage", () => {
    const w: WorldState = {
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 1.5, y: 0, z: 0 }, windup: 0.4 }),
      ],
      events: [],
      style: "evasive",
    };
    tickWorld(w, 0.25, "engage", rng(3));
    expect(w.fighters[0].pose).toBe("jump");
    expect((w.fighters[0].airborne ?? 0)).toBeGreaterThan(0);
    // The swing completes on the second tick — the agent is still airborne, so it whiffs.
    tickWorld(w, 0.25, "engage", rng(3));
    expect(w.fighters[0].hp).toBe(100);
  });

  it("balanced style eats that same swing", () => {
    const w: WorldState = {
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 1.5, y: 0, z: 0 }, windup: 0.4 }),
      ],
      events: [],
      style: "balanced",
    };
    tickWorld(w, 0.25, "engage", rng(3));
    tickWorld(w, 0.25, "engage", rng(3));
    expect(w.fighters[0].hp).toBeLessThan(100);
  });

  it("evasive style gives ground to a single wind-up; balanced holds", () => {
    const mkWorld = (style: "evasive" | "balanced"): WorldState => ({
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 2, y: 0, z: 0 }, windup: 0.7 }),
      ],
      events: [],
      style,
    });
    const evasiveW = mkWorld("evasive");
    tickWorld(evasiveW, 0.25, "engage", rng(3));
    expect(evasiveW.fighters[0].pose).toBe("dash");
    expect(evasiveW.fighters[0].pos.x).toBeLessThan(0);
    const balancedW = mkWorld("balanced");
    tickWorld(balancedW, 0.25, "engage", rng(3));
    expect(balancedW.fighters[0].pose).toBe("melee_attack");
  });

  it("style defaults to balanced when unset", () => {
    const w: WorldState = {
      fighters: [
        mkFighter({ id: "a", kind: "agent", name: "A.PY", hp: 100, maxHp: 100 }),
        mkFighter({ id: "v1", pos: { x: 2, y: 0, z: 0 }, windup: 0.7 }),
      ],
      events: [],
    };
    tickWorld(w, 0.25, "engage", rng(3));
    expect(w.fighters[0].pose).toBe("melee_attack");
  });
});

describe("orbit nudge", () => {
  const mkWorld = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "Test.PY",
        pos: { x: 6, y: 0, z: 0 },
        pose: "idle",
        hp: 100,
        maxHp: 100,
        element: "null",
        cooldown: 99, // don't swing — isolate the movement
      },
      {
        id: "v",
        kind: "virus",
        name: "v",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 40,
        maxHp: 40,
        element: "aqua",
        cooldown: 99,
      },
    ],
    events: [],
  });

  it("moves tangentially around the threat, holding distance", () => {
    const world = mkWorld();
    const rand = rng(1);
    // Agent at +x of the virus: tangent should push it toward +z, not inward.
    tickWorld(world, 0.25, "hold", rand, null, {
      move: { dx: 0, dz: 0, dash: false, orbit: true },
    });
    const agent = world.fighters[0];
    expect(agent.pos.z).toBeGreaterThan(0.5); // moved laterally
    expect(Math.abs(agent.pos.x - 6)).toBeLessThan(0.5); // distance held
  });

  it("a dash orbit moves faster", () => {
    const slow = mkWorld();
    const fast = mkWorld();
    const rand = rng(1);
    tickWorld(slow, 0.25, "hold", rand, null, { move: { dx: 0, dz: 0, dash: false, orbit: true } });
    tickWorld(fast, 0.25, "hold", rand, null, { move: { dx: 0, dz: 0, dash: true, orbit: true } });
    expect(fast.fighters[0].pos.z).toBeGreaterThan(slow.fighters[0].pos.z);
  });
});
