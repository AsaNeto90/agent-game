import { describe, expect, it } from "vitest";
import { elementMultiplier, rangeBandOf } from "@agent-game/shared";
import { applyScript, rng, tickWorld, type WorldState } from "./world.js";

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
