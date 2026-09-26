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
}

export interface MindDecision {
  /** Semantic action for the world sim — never raw coordinates. */
  action: "engage" | "disengage" | "hold" | "focus_weakest" | "protect";
  rationale: string;
}

export interface MindProvider {
  readonly name: string;
  decide(ctx: MindContext): Promise<MindDecision>;
  speak(ctx: MindContext, prompt: string): Promise<string>;
}

/**
 * MockMind: a scripted sparring partner. Deterministic given the same inputs,
 * zero tokens, zero dollars. Every test and every offline dev loop runs on this.
 */
export class MockMind implements MindProvider {
  readonly name = "mock";
  private n = 0;

  async decide(ctx: MindContext): Promise<MindDecision> {
    this.n++;
    // Simple, legible policy: hurt -> disengage, outnumbered -> focus weakest.
    if (ctx.situation.includes("hp low")) {
      return { action: "disengage", rationale: "hp low — kiting to recover" };
    }
    if (ctx.situation.includes("2+") || ctx.situation.includes("3")) {
      return { action: "focus_weakest", rationale: "outnumbered — thinning the pack" };
    }
    return { action: "engage", rationale: "single target — closing to melee" };
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

/** Rough cost model so traces carry costUsd even for mock (always 0). */
export function estimateCostUsd(provider: string, tokens: number): number {
  if (provider === "mock") return 0;
  // Placeholder blended rate — replaced by per-vendor accounting later.
  return (tokens / 1_000_000) * 3;
}

export type { Element };
