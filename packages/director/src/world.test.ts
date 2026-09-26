import { describe, expect, it } from "vitest";
import { elementMultiplier, rangeBandOf } from "@agent-game/shared";
import { applyScript, fireUnison, rng, spawnStructures, spawnWave, synchroTier, tickWorld, unisonDamage, waveComposition, STRUCTURE_MAX_HP, UNISON_MIN_SYNCHRO, UNISON_SYCHRO_AFTER, type Fighter, type WorldState } from "./world.js";

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

describe("synchro tiers", () => {
  const mkDuel = (): WorldState => ({
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
        pos: { x: 1, y: 0, z: 0 }, // melee band
        pose: "idle",
        hp: 100,
        maxHp: 100,
        element: "null",
        cooldown: 99, // virus sits out — we only measure the agent's swing
        aggression: 0,
      },
    ],
    events: [],
  });

  it("tier boundaries", () => {
    expect(synchroTier(100).tier).toBe("in sync");
    expect(synchroTier(80).tier).toBe("in sync");
    expect(synchroTier(79).tier).toBe("steady");
    expect(synchroTier(50).tier).toBe("steady");
    expect(synchroTier(30).tier).toBe("steady");
    expect(synchroTier(29).tier).toBe("desync");
    expect(synchroTier(0).tier).toBe("desync");
  });

  it("in sync hits harder than steady, desync hits softer", () => {
    const hi = mkDuel();
    const mid = mkDuel();
    const lo = mkDuel();
    tickWorld(hi, 0.25, "engage", rng(7), null, null, 100);
    tickWorld(mid, 0.25, "engage", rng(7), null, null, 50);
    tickWorld(lo, 0.25, "engage", rng(7), null, null, 0);
    const dmg = (w: WorldState) => 100 - w.fighters.find((f) => f.id === "v")!.hp;
    expect(dmg(hi)).toBeGreaterThan(dmg(mid));
    expect(dmg(lo)).toBeLessThan(dmg(mid));
    expect(dmg(hi)).toBe(Math.round(10 * 1.25)); // exact: 10 x 1.25
  });

  it("in sync cycles the Pulse Arm faster", () => {
    const hi = mkDuel();
    const mid = mkDuel();
    tickWorld(hi, 0.25, "engage", rng(7), null, null, 100);
    tickWorld(mid, 0.25, "engage", rng(7), null, null, 50);
    expect(hi.fighters[0].cooldown).toBeCloseTo(1.2 * 0.8, 5);
    expect(mid.fighters[0].cooldown).toBeCloseTo(1.2, 5);
  });

  it("viruses get no synchro bonus — the bond is the operator's edge", () => {
    const mkAmbush = (): WorldState => {
      const w = mkDuel();
      const v = w.fighters.find((f) => f.id === "v")!;
      v.windup = 0.1; // about to land
      v.cooldown = 0;
      return w;
    };
    const hi = mkAmbush();
    const mid = mkAmbush();
    tickWorld(hi, 0.25, "hold", rng(7), null, null, 100);
    tickWorld(mid, 0.25, "hold", rng(7), null, null, 50);
    const dmg = (w: WorldState) => 100 - w.fighters.find((f) => f.id === "a")!.hp;
    expect(dmg(hi)).toBe(dmg(mid));
  });

  it("defaults to steady when synchro is omitted", () => {
    const w = mkDuel();
    tickWorld(w, 0.25, "engage", rng(7));
    const virus = w.fighters.find((f) => f.id === "v")!;
    expect(100 - virus.hp).toBe(10);
  });
});

describe("virus species", () => {
  const mkAgent = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "Test.PY",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 120,
        maxHp: 120,
        element: "null",
        cooldown: 0,
      },
    ],
    events: [],
  });
  const mkVirus = (species: string, x: number): Fighter => ({
    id: `v-${species}`,
    kind: "virus",
    species,
    name: species,
    pos: { x, y: 0, z: 0 },
    pose: "idle",
    hp: 60,
    maxHp: 60,
    element: "null",
    cooldown: 0,
    aggression: 1,
  });

  it("waveComposition escalates deterministically", () => {
    expect(waveComposition(1)).toEqual(["scrapbit", "scrapbit"]);
    expect(waveComposition(2)).toEqual(["scrapbit", "scrapbit", "dasher"]);
    expect(waveComposition(3)).toContain("spitter");
    expect(waveComposition(4)).toContain("bulwark");
    expect(waveComposition(9)).toHaveLength(6); // capped
  });

  it("spawnWave assigns species kits with scaled hp", () => {
    const w = mkAgent();
    spawnWave(w, 4, rng(1));
    const by = new Map(
      w.fighters.filter((f) => f.kind === "virus").map((f) => [f.species!, f]),
    );
    expect(by.get("bulwark")!.maxHp).toBe(Math.round(80 * 2.2));
    expect(by.get("dasher")!.maxHp).toBe(Math.round(80 * 0.8));
    expect(by.get("scrapbit")!.maxHp).toBe(80);
    expect(by.get("bulwark")!.name).toBe("Bulwark");
  });

  it("dasher closes distance faster than a scrapbit", () => {
    const mk = (species: string) => {
      const w = mkAgent();
      w.fighters.push(mkVirus(species, 20));
      return w;
    };
    const d = mk("dasher");
    const s = mk("scrapbit");
    for (let i = 0; i < 20; i++) {
      tickWorld(d, 0.25, "hold", rng(3));
      tickWorld(s, 0.25, "hold", rng(3));
    }
    const distD = Math.hypot(d.fighters[1].pos.x, d.fighters[1].pos.z);
    const distS = Math.hypot(s.fighters[1].pos.x, s.fighters[1].pos.z);
    expect(distD).toBeLessThan(distS);
  });

  it("spitter holds mid range and backs off when crowded", () => {
    const w = mkAgent();
    w.fighters.push(mkVirus("spitter", 1)); // starts in melee
    for (let i = 0; i < 12; i++) tickWorld(w, 0.25, "hold", rng(3));
    const d = Math.hypot(w.fighters[1].pos.x, w.fighters[1].pos.z);
    expect(d).toBeGreaterThan(2.5); // backed out of melee
    expect(d).toBeLessThan(8); // ...but holds mid, doesn't flee
  });

  it("spit can't be jumped — only leaving mid range dodges it", () => {
    const w = mkAgent();
    const v = mkVirus("spitter", 5); // mid range
    v.windup = 0.1;
    w.fighters.push(v);
    w.fighters[0].airborne = 0.6; // mid-air — a melee swing would whiff
    tickWorld(w, 0.25, "hold", rng(3));
    expect(w.fighters[0].hp).toBeLessThan(120); // spit landed through the jump

    const w2 = mkAgent();
    const v2 = mkVirus("spitter", 5);
    v2.windup = 0.1;
    w2.fighters.push(v2);
    w2.fighters[0].pos.x = 30; // fled to long range
    tickWorld(w2, 0.25, "hold", rng(3));
    expect(w2.fighters[0].hp).toBe(120); // whiffed
  });

  it("bulwark hits like a truck and telegraphs like a billboard", () => {
    const w = mkAgent();
    const v = mkVirus("bulwark", 1);
    v.windup = 0.1;
    w.fighters.push(v);
    tickWorld(w, 0.25, "hold", rng(3));
    expect(120 - w.fighters[0].hp).toBe(Math.round(6 * 1.7));

    const wb = mkAgent();
    const vb = mkVirus("bulwark", 1);
    wb.fighters.push(vb);
    const ws = mkAgent();
    const vs = mkVirus("scrapbit", 1);
    ws.fighters.push(vs);
    tickWorld(wb, 0.25, "hold", rng(9));
    tickWorld(ws, 0.25, "hold", rng(9));
    expect(vb.windup!).toBeGreaterThan(vs.windup!); // longer telegraph
  });

  it("species-less viruses default to scrapbit behavior", () => {
    const w = mkAgent();
    const v = mkVirus("scrapbit", 1);
    delete v.species;
    v.windup = 0.1;
    w.fighters.push(v);
    tickWorld(w, 0.25, "hold", rng(3));
    expect(120 - w.fighters[0].hp).toBe(6); // base VIRUS_POWER, no kit
  });
});

describe("site defense — viruses want the website, not the agent", () => {
  const mkAgentW = (): WorldState => ({
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
  const mkVirus = (id: string, x: number, z: number, hp = 40): Fighter => ({
    id,
    kind: "virus",
    name: "Scrapbit",
    pos: { x, y: 0, z },
    pose: "idle",
    hp,
    maxHp: 40,
    element: "aqua",
    cooldown: 0,
    aggression: 1,
  });
  const mkWorld = (): WorldState => {
    const w = mkAgentW();
    spawnStructures(w);
    return w;
  };

  it("spawnStructures builds three 120hp nodes in a triangle", () => {
    const w = mkAgentW();
    spawnStructures(w);
    expect(w.structures).toHaveLength(3);
    expect(w.structures!.map((s) => s.name)).toEqual(["Homepage", "Database", "Gateway"]);
    for (const s of w.structures!) {
      expect(s.hp).toBe(STRUCTURE_MAX_HP);
      expect(s.maxHp).toBe(STRUCTURE_MAX_HP);
    }
  });

  it("a virus far from the agent goes for the nearest node", () => {
    const w = mkWorld();
    const v = mkVirus("v", 30, 0);
    v.retargetIn = 0;
    w.fighters.push(v);
    tickWorld(w, 0.25, "engage", rng(1));
    expect(v.targetId).toBe("site-homepage");
    expect(v.pos.x).toBeLessThan(30); // moving toward it
  });

  it("a healthy virus close to the agent engages it", () => {
    const w = mkWorld();
    const v = mkVirus("v", 3, 0);
    v.retargetIn = 0;
    w.fighters.push(v);
    tickWorld(w, 0.25, "engage", rng(1));
    expect(v.targetId).toBe("a");
    expect(v.fleeing).toBe(false);
  });

  it("a hurt virus runs from the agent toward the site", () => {
    const w = mkWorld();
    const v = mkVirus("v", 3, 0, 12); // 30% hp — below scrapbit bravery 0.35
    v.retargetIn = 0;
    w.fighters.push(v);
    tickWorld(w, 0.25, "engage", rng(1));
    expect(v.fleeing).toBe(true);
    expect(v.targetId).toBe("site-homepage");
    expect(v.pos.x).toBeGreaterThan(3); // running from the agent
  });

  it("a virus wind-up landing on a node damages the structure", () => {
    const w = mkWorld();
    const node = w.structures!.find((s) => s.id === "site-homepage")!;
    const v = mkVirus("v", 12, 0); // 1 unit from the node — melee
    v.targetId = "site-homepage";
    v.retargetIn = 100;
    v.windup = 0.1;
    w.fighters.push(v);
    tickWorld(w, 0.25, "engage", rng(1));
    expect(node.hp).toBeLessThan(120);
    expect(w.events.some((e) => e.type === "hit" && e.targetId === "site-homepage")).toBe(true);
  });

  it("striking a site-eater pulls its aggro onto the agent", () => {
    const w = mkWorld();
    const v = mkVirus("v", 12, 0);
    v.targetId = "site-homepage";
    v.retargetIn = 100;
    w.fighters.push(v);
    const agent = w.fighters[0];
    agent.pos = { x: 12.5, y: 0, z: 0 }; // teleport into melee and swing
    agent.cooldown = 0;
    tickWorld(w, 0.25, "engage", rng(7));
    expect(v.hp).toBeLessThan(40); // the swing connected
    expect(v.targetId).toBe("a");
    expect(v.fleeing).toBe(false);
  });

  it("spawnWave sends fresh viruses at the site", () => {
    const w = mkAgentW();
    spawnStructures(w);
    spawnWave(w, 1, rng(9));
    const viruses = w.fighters.filter((f) => f.kind === "virus");
    expect(viruses.length).toBeGreaterThan(0);
    for (const v of viruses) expect(v.targetId).toMatch(/^site-/);
  });

  it("protect directive intercepts the site-eater, not the nearest virus", () => {
    const w = mkWorld();
    const eater = mkVirus("eater", 9, 0);
    eater.targetId = "site-homepage";
    eater.retargetIn = 100;
    eater.cooldown = 999;
    eater.aggression = 0;
    const lurker = mkVirus("lurker", -3, 0);
    lurker.targetId = "a";
    lurker.retargetIn = 100;
    lurker.cooldown = 999;
    lurker.aggression = 0;
    w.fighters.push(eater, lurker);
    const agent = w.fighters[0];
    tickWorld(w, 0.25, "protect", rng(3));
    expect(agent.pos.x).toBeGreaterThan(0); // moved toward the eater at +x
  });
});

describe("unison finisher", () => {
  const mkDuel = (): WorldState => ({
    fighters: [
      {
        id: "a",
        kind: "agent",
        name: "AstroMan.PY",
        pos: { x: 0, y: 0, z: 0 },
        pose: "idle",
        hp: 120,
        maxHp: 120,
        element: "null",
        cooldown: 0,
      },
      {
        id: "v1",
        kind: "virus",
        name: "Scrapbit",
        pos: { x: 1, y: 0, z: 0 },
        pose: "idle",
        hp: 50,
        maxHp: 50,
        element: "null",
        cooldown: 0,
      },
      {
        id: "v2",
        kind: "virus",
        name: "Bulwark",
        species: "bulwark",
        pos: { x: 10, y: 0, z: 0 },
        pose: "idle",
        hp: 176,
        maxHp: 176,
        element: "null",
        cooldown: 0,
      },
    ],
    structures: [
      { id: "site-homepage", name: "Homepage", pos: { x: 11, y: 0, z: 0 }, hp: 100, maxHp: 120 },
    ],
    events: [],
  });

  it("damage scales with synchro and bond tier", () => {
    expect(unisonDamage(80, "spark")).toBe(60);
    expect(unisonDamage(100, "spark")).toBe(66); // +10% at a full meter
    expect(unisonDamage(80, "inferno")).toBe(90); // bond is the damage
    expect(unisonDamage(95, "blaze")).toBe(81); // 60 * 1.075 * 1.25 = 80.625
    expect(UNISON_MIN_SYNCHRO).toBe(80);
    expect(UNISON_SYCHRO_AFTER).toBe(40);
  });

  it("one-shots a same-wave virus, chunks a bulwark", () => {
    const w = mkDuel();
    const res = fireUnison(w, 80, "spark");
    expect(res).not.toBeNull();
    expect(res!.damage).toBe(60);
    const v1 = w.fighters.find((f) => f.id === "v1")!;
    expect(v1.hp).toBe(0);
    expect(w.events).toContainEqual(expect.objectContaining({ type: "down", fighterId: "v1" }));
    const v2 = w.fighters.find((f) => f.id === "v2")!;
    expect(v2.hp).toBe(176); // untouched — the finisher hits one target
  });

  it("chunks a bulwark instead of deleting it", () => {
    const w = mkDuel();
    w.fighters.find((f) => f.id === "v1")!.hp = 0; // only the bulwark stands
    const res = fireUnison(w, 100, "blaze");
    expect(res!.targetName).toBe("Bulwark");
    const v2 = w.fighters.find((f) => f.id === "v2")!;
    // 60 * 1.1 * 1.25 = 82.5 -> 83 damage on 176hp: a chunk, not a kill
    expect(v2.hp).toBe(176 - 83);
    expect(v2.hp).toBeGreaterThan(0);
  });

  it("never touches the site — viruses only", () => {
    const w = mkDuel();
    const siteHp = w.structures![0].hp;
    fireUnison(w, 80, "spark");
    expect(w.structures![0].hp).toBe(siteHp);
    const hits = w.events.filter((e) => e.type === "hit");
    expect(hits.every((e) => e.type === "hit" && e.targetId.startsWith("v"))).toBe(true);
  });

  it("honors targetElement like the L0 pick", () => {
    const w = mkDuel();
    w.fighters.find((f) => f.id === "v1")!.element = "aqua";
    w.fighters.find((f) => f.id === "v2")!.element = "fire";
    const res = fireUnison(w, 80, "spark", "fire");
    expect(res!.targetName).toBe("Bulwark"); // farther, but the called element
  });

  it("returns null when there's nothing to hit", () => {
    const w = mkDuel();
    w.fighters = w.fighters.filter((f) => f.kind === "agent");
    expect(fireUnison(w, 100, "soulbound")).toBeNull();
    expect(w.events).toHaveLength(0);
  });

  it("puts the agent in the cast pose", () => {
    const w = mkDuel();
    fireUnison(w, 80, "spark");
    expect(w.fighters.find((f) => f.id === "a")!.pose).toBe("cast");
  });

  it("applies the element wheel", () => {
    const w = mkDuel();
    const agent = w.fighters.find((f) => f.id === "a")!;
    agent.element = "fire"; // fire > wood, but v1 is null — neutral
    w.fighters.find((f) => f.id === "v1")!.element = "wood";
    const res = fireUnison(w, 80, "spark");
    expect(res!.damage).toBe(120); // 60 x 2
  });
});
