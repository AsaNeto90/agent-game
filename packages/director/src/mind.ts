/**
 * The MindProvider abstraction — the most important interface in the codebase.
 *
 * The director NEVER calls a vendor SDK directly. It calls a MindProvider.
 * Swap implementations with an env var and chase prices forever:
 *   - MockMind: deterministic, scripted, $0. Tests + offline dev.
 *   - VendorMind (later): Anthropic / OpenAI / local model behind one shape.
 */
import type { Element } from "@agent-game/shared";

export interface MindContext {
  agentName: string;
  agentExt: string;
  bondTier: string;
  recentMemories: string[];
  situation: string; // compact world summary, e.g. "2 aqua viruses at mid range, hp 70%"
  /** Rich tactical snapshot for decide(): per-virus hp/band/windup, agent hp/band, style. */
  tactics?: string;
  /** The operator's recent words — lets the mind honor casual requests
   *  ("be careful", "go aggressive") with no keyword parsing needed. */
  operatorLines?: string[];
}

export interface MindDecision {
  /** Semantic action for the world sim — never raw coordinates. */
  action:
    | "engage"
    | "disengage"
    | "hold"
    | "focus_weakest"
    | "protect"
    | "dodge"
    | "jump"
    | "orbit"
    | "strafe";
  /** Persistent stance the mind adopts for itself — the loop ignores it
   *  while the operator holds the style lock. */
  style?: "evasive" | "balanced";
  rationale: string;
}

export interface MindProvider {
  readonly name: string;
  decide(ctx: MindContext): Promise<MindDecision>;
  speak(ctx: MindContext, prompt: string): Promise<string>;
  /** Tokens burned by the most recent call — the flight recorder reads this. */
  readonly lastTokens: number;
}

/**
 * MockMind: a scripted sparring partner. Deterministic given the same inputs,
 * zero tokens, zero dollars. Every test and every offline dev loop runs on this.
 */
export class MockMind implements MindProvider {
  readonly name = "mock";
  readonly lastTokens = 0;
  private n = 0;

  // NOTE: the mock does not read ctx.recentMemories. Genuine recall needs a
  // mind that reasons over language — that's the vendor mind's job. The mock
  // proves the memory plumbing (write → store → inject); the vendor proves
  // the remembering.
  async decide(ctx: MindContext): Promise<MindDecision> {
    this.n++;
    // Reads the tactical snapshot like a vendor would: survival first,
    // then imminent swings, then repositioning, then pack tactics.
    // Tactics format: "w2 | 3v: aqua40 melee SWING!, null25 mid WINDUP | agent 70% melee | style balanced"
    const t = ctx.tactics ?? ctx.situation;
    const hp = /agent (\d+)%/.exec(t);
    const agentHp = hp ? parseInt(hp[1], 10) : 100;
    const swings = (t.match(/SWING!/g) ?? []).length; // landing within ~0.5s
    const windups = (t.match(/WINDUP/g) ?? []).length; // telegraphing, >0.5s out
    const viruses = parseInt(/(\d+)v:/.exec(t)?.[1] ?? "1", 10);
    const style = /style (evasive|balanced)/.exec(t)?.[1];
    const lines = (ctx.operatorLines ?? []).join(" ").toLowerCase();

    // The operator asked to circle them — keep pivoting, don't retreat.
    // An explicit movement request beats the tactical read, every time.
    if (/pivot|orbit|around them|around him|around it|circles? around/.test(lines)) {
      return { action: "orbit", rationale: "pivoting around them, operator" };
    }
    // Hurt -> disengage and go evasive on your own. No keyword required.
    if (agentHp < 35) {
      return { action: "disengage", style: "evasive", rationale: "hurt — going evasive" };
    }
    // A swing about to land in melee -> leap it.
    if (swings > 0 && /agent \d+% melee/.test(t)) {
      return { action: "jump", rationale: "leaping the swing" };
    }
    // One swing telegraphing in melee — sidestep it without giving ground.
    if (swings === 0 && windups === 1 && /agent \d+% melee/.test(t)) {
      return { action: "strafe", rationale: "sidestepping the swing" };
    }
    // Multiple telegraphs -> reposition before they converge.
    if (windups >= 2) {
      return { action: "dodge", rationale: "too many swings — repositioning" };
    }
    // Recovered -> drop the evasive stance you adopted yourself.
    if (style === "evasive" && agentHp > 60) {
      return { action: "engage", style: "balanced", rationale: "patched up — pressing again" };
    }
    if (viruses >= 3) {
      return { action: "focus_weakest", rationale: "outnumbered — thinning the pack" };
    }
    return { action: "engage", rationale: "on the nearest threat" };
  }

  async speak(ctx: MindContext, prompt: string): Promise<string> {
    this.n++;
    const tag = `${ctx.agentName}.${ctx.agentExt}`;

    // Operator commands get specific acknowledgments — a command answered
    // with a non-sequitur feels like not being heard at all.
    const cmd = /^operator command:\s*(.*)/i.exec(prompt);
    if (cmd) {
      const text = cmd[1].toLowerCase();
      if (/retreat|fall back|disengage|pull back/.test(text))
        return `Falling back — regrouping, operator.`;
      if (/hold|wait|steady|stop|stay/.test(text)) return `Holding position. Waiting for your call.`;
      if (/focus|weakest|thin|target/.test(text)) return `On the weakest one — thinning the pack.`;
      if (/flank|left|right|around/.test(text)) return `Flanking. Keep their eyes on me.`;
      if (/attack|engage|fight|hit|strike|kill|delete|get them/.test(text)) return `Engaging!`;
      if (/script|chip|slot|fire|blast/.test(text)) return `Script acknowledged — say the word and it's lit.`;
      return `On it — ${tag} moving.`;
    }

    // Periodic battle banter — reads the actual situation, so the agent
    // comments on the fight instead of looping three random lines.
    if (/battle banter/i.test(prompt)) {
      const count = /^(\d+) viruses?/.exec(ctx.situation);
      const n = count ? parseInt(count[1], 10) : 1;
      if (/hp low/.test(ctx.situation)) {
        const lines = [
          `I'm hurting, operator — armor's flickering.`,
          `Systems dimming... I can still fight. Keep coaching me.`,
        ];
        return lines[this.n % lines.length];
      }
      if (n === 0) return `Grid's clear. ...for now.`;
      if (n === 1) {
        const lines = [`One left. It's mine.`, `Last one dancing. Watch this.`];
        return lines[this.n % lines.length];
      }
      const lines = [
        `Two on me — I like those odds.`,
        `They're circling. Keep the scripts coming, operator.`,
        `My call: we press the advantage.`,
      ];
      return lines[this.n % lines.length];
    }

    if (/dive start/i.test(prompt)) return `Jacked in. ${tag} on the grid — what are we hunting today?`;
    if (/tired|rest|beat|exhausted|recharge/i.test(prompt))
      return `I'm running warm, but I've got one more dive in me.`;
    if (/hello|hi\b|hey|yo\b|morning/i.test(prompt))
      return `Hey. ${tag} here — bond's at ${ctx.bondTier}. What's the plan?`;
    if (/thank|thanks|thx|nice|good job|well done|awesome/i.test(prompt)) return `Heh. All in a day's dive.`;
    if (/who are you|your name|introduce/i.test(prompt))
      return `${tag} — your agent. Compiled, bonded, and itching for a fight.`;
    if (/\?\s*$/.test(prompt)) return `My call: we press the advantage.`;

    const lines = [
      `Reading you loud and clear, operator.`,
      `Heh. Did you see that last one?`,
      `Give me a target and a script, I'll give you a deleted virus.`,
    ];
    return lines[this.n % lines.length];
  }
}

/**
 * Rough cost model for the flight recorder. Mock is always 0; vendor rates
 * are blended $/1M-token estimates (input+output averaged) — honest enough
 * for a prototype, real per-token accounting comes with the economy design.
 */
const BLENDED_USD_PER_MTOKENS: Record<string, number> = {
  mock: 0,
  gemini: 1.4, // ~gemini-3.8-flash paid tier, blended in/out
  "openai-compatible": 3, // placeholder — set MIND_USD_PER_MTOKENS to override
};

export function estimateCostUsd(provider: string, tokens: number): number {
  const override = Number(process.env.MIND_USD_PER_MTOKENS);
  const rate =
    Number.isFinite(override) && override > 0
      ? override
      : (BLENDED_USD_PER_MTOKENS[provider] ?? BLENDED_USD_PER_MTOKENS["openai-compatible"]!);
  return (tokens / 1_000_000) * rate;
}

export type { Element };
