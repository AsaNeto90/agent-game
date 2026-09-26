import { describe, expect, it } from "vitest";
import { elementMultiplier, rangeBandOf } from "@agent-game/shared";
import { rng, tickWorld, type WorldState } from "./world.js";

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
