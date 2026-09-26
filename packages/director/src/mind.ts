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
    const lines = [
      `Reading you loud and clear, operator.`,
      `On it — ${ctx.agentName}.${ctx.agentExt} moving.`,
      `Heh. Did you see that last one?`,
      `My call: we press the advantage.`,
      `Give me a target and a script, I'll give you a deleted virus.`,
    ];
    if (/tired|rest|beat/i.test(prompt)) return `I'm running warm, but I've got one more dive in me.`;
    if (/hello|hi|hey|morning/i.test(prompt))
      return `Hey. ${ctx.agentName}.${ctx.agentExt} here — bond's at ${ctx.bondTier}. What are we hunting today?`;
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
