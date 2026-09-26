/**
 * w-compile tests: the compile-flow contract (validation, deterministic
 * temperament mapping, chassis hook, wake beat) and the mind's use of the
 * compiled profile. The Convex mutation itself is covered by
 * convex/compile.test.ts (convex-test, real schema).
 */
import { describe, expect, it } from "vitest";
import {
  CHASSIS_STEP_DEFERRED,
  COMPILE_FLOW_STEPS,
  compileProfile,
  TEMPERAMENT_QUESTIONS,
  wakeIntro,
  WAKE_QUESTION,
} from "@agent-game/shared";
import { MockMind, type MindContext } from "./mind.js";

describe("compile input validation", () => {
  const good: { name: string; ext: string; answers: string[] } = {
    name: "Nova",
    ext: "PY",
    answers: ["a", "b", "c"],
  };
  it("rejects an empty name", () => {
    expect(() => compileProfile({ ...good, name: "   " })).toThrow(/name/i);
  });
  it("rejects a 25-char name but accepts 24", () => {
    expect(() => compileProfile({ ...good, name: "x".repeat(25) })).toThrow(/24/);
    expect(compileProfile({ ...good, name: "x".repeat(24) }).name).toHaveLength(24);
  });
  it("trims the name", () => {
    expect(compileProfile({ ...good, name: "  Nova  " }).name).toBe("Nova");
  });
  it("rejects unknown extensions", () => {
    expect(() => compileProfile({ ...good, ext: "EXE" })).toThrow();
  });
  it("accepts all three soul extensions, normalizing case", () => {
    for (const ext of ["PY", "SH", "MD"] as const)
      expect(compileProfile({ ...good, ext }).ext).toBe(ext);
    expect(compileProfile({ ...good, ext: "py" }).ext).toBe("PY");
  });
  it("requires exactly three answers", () => {
    expect(() => compileProfile({ ...good, answers: ["a", "b"] })).toThrow(/three/);
    expect(() => compileProfile({ ...good, answers: ["a", "b", "c", "a"] })).toThrow(/three/);
  });
  it("rejects an unknown answer id", () => {
    expect(() => compileProfile({ ...good, answers: ["a", "zzz", "c"] })).toThrow(/isn't a valid answer/);
  });
});

describe("temperament mapping", () => {
  it("is deterministic", () => {
    const input = { name: "Nova", ext: "PY", answers: ["a", "b", "c"] };
    expect(compileProfile(input)).toEqual(compileProfile(input));
  });
  it("maps answers onto drives and traits", () => {
    const p = compileProfile({ name: "Nova", ext: "PY", answers: ["a", "a", "a"] });
    // a/a/a = bold + ambitious across all three questions.
    expect(p.traits).toContain("bold");
    expect(p.drives.ambition).toBeGreaterThan(p.drives.duty);
    expect(p.drives.curiosity).toBeGreaterThan(5);
  });
  it("keeps drives in bounds", () => {
    const p = compileProfile({ name: "Nova", ext: "SH", answers: ["b", "b", "b"] });
    for (const v of Object.values(p.drives)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
    expect(p.traits).toContain("cautious");
  });
  it("defaults chassis to frame, element to null, voice stub", () => {
    const p = compileProfile({ name: "Nova", ext: "MD", answers: ["c", "c", "c"] });
    expect(p.chassis).toBe("frame");
    expect(p.element).toBe("null");
    expect(p.voice).toBe("default");
  });
  it("reserves the chassis step in the flow without building it", () => {
    expect(COMPILE_FLOW_STEPS).toEqual(["identity", "temperament", "chassis", "wake"]);
    expect(CHASSIS_STEP_DEFERRED).toBe(true);
    expect(TEMPERAMENT_QUESTIONS).toHaveLength(3);
  });
});

describe("wake beat", () => {
  it("introduces the agent by name and teaches the operator", () => {
    const lines = wakeIntro({ name: "Nova", ext: "PY", traits: ["bold", "loyal"] });
    const text = lines.join("\n");
    expect(text).toContain("Nova.PY");
    expect(text).toContain("you talk, I fight");
    expect(text).toContain("bold");
    expect(lines[lines.length - 1]).toBe(WAKE_QUESTION);
  });
});

describe("temperament in the mind", () => {
  const ctxFor = (traits: string[], hp: number): MindContext => ({
    agentName: "Nova",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: `agent ${hp}%`,
    tactics: `w1 | 1v: aqua40 mid | agent ${hp}% melee | style balanced`,
    traits,
  });
  it("cautious agents disengage earlier (40hp)", async () => {
    const d = await new MockMind().decide(ctxFor(["cautious"], 40));
    expect(d.action).toBe("disengage");
    expect(d.style).toBe("evasive");
  });
  it("bold agents hold their nerve at 30hp", async () => {
    const d = await new MockMind().decide(ctxFor(["bold"], 30));
    expect(d.action).not.toBe("disengage");
  });
  it("unprofiled agents keep the old 35 threshold", async () => {
    const d = await new MockMind().decide(ctxFor([], 30));
    expect(d.action).toBe("disengage");
  });
  it("introduces itself with its traits", async () => {
    const line = await new MockMind().speak(ctxFor(["bold", "loyal"], 100), "who are you?");
    expect(line).toContain("Nova.PY");
    expect(line).toContain("bold/loyal");
  });
});
