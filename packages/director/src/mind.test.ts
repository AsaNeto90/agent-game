import { describe, expect, it } from "vitest";
import { MockMind, pickScript, AGENT_KIT, type MindContext } from "./mind.js";

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

describe("MockMind.decide reads the tactical snapshot", () => {
  const mind = new MockMind();
  const tctx = (tactics: string): MindContext => ({
    agentName: "AstroMan",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: "fighting",
    tactics,
  });

  it("goes evasive and disengages on its own when hurt", async () => {
    const d = await mind.decide(tctx("w2 | 2v: aqua40 melee, null25 mid | agent 20% melee | style balanced"));
    expect(d.action).toBe("disengage");
    expect(d.style).toBe("evasive");
  });

  it("leaps a swing about to land in melee", async () => {
    const d = await mind.decide(tctx("w2 | 1v: aqua40 melee SWING! | agent 80% melee | style balanced"));
    expect(d.action).toBe("jump");
  });

  it("repositions when multiple viruses telegraph at once", async () => {
    const d = await mind.decide(
      tctx("w2 | 3v: aqua40 melee WINDUP, null25 mid WINDUP, fire40 far | agent 80% mid | style balanced"),
    );
    expect(d.action).toBe("dodge");
  });

  it("drops the evasive stance it adopted once recovered", async () => {
    const d = await mind.decide(tctx("w2 | 1v: aqua40 mid | agent 70% mid | style evasive"));
    expect(d.action).toBe("engage");
    expect(d.style).toBe("balanced");
  });

  it("thins the pack when outnumbered", async () => {
    const d = await mind.decide(
      tctx("w3 | 4v: aqua40 far, null25 far, fire40 far, elec40 far | agent 90% far | style balanced"),
    );
    expect(d.action).toBe("focus_weakest");
  });

  it("engages by default", async () => {
    const d = await mind.decide(tctx("w1 | 1v: aqua40 mid | agent 100% mid | style balanced"));
    expect(d.action).toBe("engage");
  });
});

describe("MockMind.decide lateral movement", () => {
  const mind = new MockMind();
  const tctx = (tactics: string, operatorLines: string[] = []): MindContext => ({
    agentName: "AstroMan",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: "fighting",
    tactics,
    operatorLines,
  });

  it("keeps pivoting when the operator asked to circle them", async () => {
    const d = await mind.decide(
      tctx("w2 | 3v: aqua40 melee WINDUP, null25 melee WINDUP | agent 80% melee | style balanced", [
        "try pivoting around them in circles",
      ]),
    );
    expect(d.action).toBe("orbit");
  });

  it("sidesteps a single telegraphed swing without retreating", async () => {
    const d = await mind.decide(tctx("w2 | 1v: aqua40 melee WINDUP | agent 80% melee | style balanced"));
    expect(d.action).toBe("strafe");
  });

  it("still leaps the swing that's about to land", async () => {
    const d = await mind.decide(tctx("w2 | 1v: aqua40 melee SWING! | agent 80% melee | style balanced"));
    expect(d.action).toBe("jump");
  });
});

describe("pickScript — the agent's own script brain", () => {
  const KIT = [...AGENT_KIT];
  const sctx = (tactics: string, scriptsReady: string[] = KIT, scriptRequested = false): MindContext => ({
    agentName: "AstroMan",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: "",
    tactics,
    scriptsReady,
    scriptRequested,
  });

  it("mends itself when hurt", () => {
    const s = pickScript(sctx("w2 | 2v: aqua40(scrapbit) melee, null25(scrapbit) mid | agent 30% melee | style balanced"));
    expect(s?.scriptId).toBe("mend-protocol");
  });

  it("braces with aegis-wall when a bulwark winds up", () => {
    const s = pickScript(sctx("w4 | 2v: wood176(bulwark) melee WINDUP, aqua40(scrapbit) mid | agent 80% melee | style balanced"));
    expect(s?.scriptId).toBe("aegis-wall");
  });

  it("snares the pack when outnumbered", () => {
    const s = pickScript(
      sctx("w3 | 3v: aqua40(scrapbit) melee, null25(dasher) mid, elec30(spitter) mid | agent 80% melee | style balanced"),
    );
    expect(s?.scriptId).toBe("static-snare");
  });

  it("lances a virus that's almost down", () => {
    const s = pickScript(sctx("w2 | 2v: aqua15(scrapbit) mid, null40(scrapbit) far | agent 90% mid | style balanced"));
    expect(s?.scriptId).toBe("arc-lance");
  });

  it("keeps its hands down when the moment isn't right", () => {
    const s = pickScript(sctx("w1 | 1v: aqua40(scrapbit) mid | agent 100% mid | style balanced"));
    expect(s).toBeUndefined();
  });

  it("fires nothing when everything is on cooldown", () => {
    const s = pickScript(sctx("w2 | 2v: aqua40(scrapbit) melee | agent 20% melee | style balanced", []));
    expect(s).toBeUndefined();
  });

  it("never picks outside its kit", () => {
    const s = pickScript(sctx("w2 | 2v: aqua40(scrapbit) melee | agent 20% melee | style balanced", ["ghostphase"]));
    expect(s).toBeUndefined();
  });

  it('"use something!" relaxes the heal threshold and finds a reason', () => {
    const mend = pickScript(
      sctx("w2 | 1v: aqua40(scrapbit) mid | agent 60% mid | style balanced", KIT, true),
    );
    expect(mend?.scriptId).toBe("mend-protocol");
    const boom = pickScript(sctx("w1 | 1v: aqua40(scrapbit) mid | agent 100% mid | style balanced", KIT, true));
    expect(boom?.scriptId).toBe("cinder-slash");
  });

  it("parses the legacy readout without species", () => {
    const s = pickScript(sctx("w2 | 2v: aqua40 melee, null25 mid | agent 30% melee | style balanced"));
    expect(s?.scriptId).toBe("mend-protocol");
  });

  it("MockMind attaches the script alongside its maneuver", async () => {
    const mind = new MockMind();
    const d = await mind.decide(
      sctx("w2 | 2v: aqua40(scrapbit) melee, null25(scrapbit) mid | agent 20% melee | style balanced"),
    );
    expect(d.action).toBe("disengage"); // survival maneuver unchanged
    expect(d.script?.scriptId).toBe("mend-protocol"); // plus its own hands
  });

  it("MockMind omits the script when the kit is on cooldown", async () => {
    const mind = new MockMind();
    const d = await mind.decide(
      sctx("w2 | 2v: aqua40(scrapbit) melee | agent 20% melee | style balanced", []),
    );
    expect(d.script).toBeUndefined();
  });
});

describe("MockMind.decide bodyguard duty", () => {
  const mind = new MockMind();
  const tctx = (tactics: string): MindContext => ({
    agentName: "AstroMan",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: "fighting",
    tactics,
  });

  it("intercepts site-eaters with protect", async () => {
    const d = await mind.decide(
      tctx(
        "w2 | 2v: aqua40(scrapbit)→Database mid, elec32(dasher)→Agent far | agent 80% far | site: Homepage 100%, Database 80%, Gateway 100% | style balanced",
      ),
    );
    expect(d.action).toBe("protect");
    expect(d.rationale).toMatch(/site-eater/);
  });

  it("survival still beats bodyguard duty when hurt", async () => {
    const d = await mind.decide(
      tctx(
        "w2 | 1v: aqua40(scrapbit)→Database mid | agent 20% mid | site: Homepage 100%, Database 80%, Gateway 100% | style balanced",
      ),
    );
    expect(d.action).toBe("disengage");
  });

  it("stands down when nothing is chewing the site", async () => {
    const d = await mind.decide(
      tctx(
        "w2 | 2v: aqua40(scrapbit)→Agent melee, elec32(dasher)→Agent far | agent 80% melee | site: Homepage 100%, Database 100%, Gateway 100% | style balanced",
      ),
    );
    expect(d.action).toBe("engage");
  });
});

describe("pickScript reads objective arrows", () => {
  const KIT = [...AGENT_KIT];
  const sctx = (tactics: string, scriptsReady: string[] = KIT): MindContext => ({
    agentName: "AstroMan",
    agentExt: "PY",
    bondTier: "spark",
    recentMemories: [],
    situation: "fighting",
    tactics,
    scriptsReady,
  });

  it("still reads the radar when viruses carry objective arrows", () => {
    const s = pickScript(
      sctx(
        "w2 | 2v: aqua15(scrapbit)→Database melee, null40(scrapbit)→Agent far | agent 90% melee | site: Homepage 100%, Database 100%, Gateway 100% | style balanced",
      ),
    );
    expect(s?.scriptId).toBe("arc-lance");
  });

  it("still spots a winding bulwark through the arrow", () => {
    const s = pickScript(
      sctx(
        "w4 | 1v: wood176(bulwark)→Homepage melee WINDUP | agent 80% melee | site: Homepage 100%, Database 100%, Gateway 100% | style balanced",
      ),
    );
    expect(s?.scriptId).toBe("aegis-wall");
  });
});
