import { describe, expect, it } from "vitest";
import { MockMind, type MindContext } from "./mind.js";

const ctx: MindContext = {
  agentName: "AstroMan",
  agentExt: "PY",
  bondTier: "spark",
  recentMemories: [],
  situation: "2 viruses at mid range",
};

describe("MockMind.speak answers in context", () => {
  it("acknowledges a retreat command specifically", async () => {
    const mind = new MockMind();
    const line = await mind.speak(ctx, "operator command: fall back and regroup");
    expect(line.toLowerCase()).toMatch(/falling back|regroup/);
  });

  it("acknowledges hold and focus commands specifically", async () => {
    const mind = new MockMind();
    expect((await mind.speak(ctx, "operator command: hold")).toLowerCase()).toMatch(/holding/);
    expect((await mind.speak(ctx, "operator command: focus the weakest")).toLowerCase()).toMatch(
      /weakest/,
    );
  });

  it("never answers a command with a generic non-sequitur", async () => {
    const mind = new MockMind();
    for (const c of ["retreat", "hold your ground", "focus weakest", "attack now", "flank left"]) {
      const line = await mind.speak(ctx, `operator command: ${c}`);
      expect(line).not.toMatch(/Did you see that last one/);
    }
  });

  it("greets and answers identity questions", async () => {
    const mind = new MockMind();
    expect(await mind.speak(ctx, "hey buddy")).toMatch(/AstroMan\.PY/);
    expect(await mind.speak(ctx, "who are you?")).toMatch(/your agent/);
  });

  it("stays deterministic", async () => {
    const a = new MockMind();
    const b = new MockMind();
    for (const p of ["operator command: hold", "hello", "operator command: attack", "thanks"]) {
      expect(await a.speak(ctx, p)).toBe(await b.speak(ctx, p));
    }
  });

  it("battle banter reacts to the situation, never loops generics", async () => {
    const mind = new MockMind();
    const hurt = await mind.speak({ ...ctx, situation: "2 viruses, agent hp 20%, hp low" }, "battle banter");
    expect(hurt.toLowerCase()).toMatch(/hurting|dimming/);
    const solo = await mind.speak({ ...ctx, situation: "1 viruses, agent hp 90%" }, "battle banter");
    expect(solo.toLowerCase()).toMatch(/one left|last one/);
    const pack = await mind.speak({ ...ctx, situation: "3 viruses, agent hp 80%" }, "battle banter");
    expect(pack).not.toMatch(/Did you see that last one|Reading you loud and clear/);
  });
});
