/**
 * VendorMind: a real LLM behind the MindProvider seam.
 *
 * Speaks the OpenAI chat-completions shape, so one implementation covers
 * any OpenAI-compatible endpoint — chase prices forever:
 *
 *   MIND_PROVIDER=gemini            # Google Gemini via its OpenAI-compatible
 *                                   # endpoint. Free key: https://aistudio.google.com/apikey
 *   MIND_PROVIDER=openai-compatible # anything else: Ollama, LM Studio, OpenAI...
 *
 * Env:
 *   GEMINI_API_KEY / MIND_API_KEY   - the secret (never commit it)
 *   MIND_BASE_URL                   - override; defaults to Gemini's endpoint
 *   MIND_MODEL                      - override; defaults to gemini-3.8-flash
 *
 * Robustness rules (a dead vendor must never kill a dive):
 *   - every call has a timeout and falls back to MockMind on ANY failure
 *   - battle banter is fire-and-forget in the loop, so LLM latency can never
 *     stall the 4Hz tick
 */
import { MockMind, AGENT_KIT, type MindContext, type MindDecision, type MindProvider } from "./mind.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_TIMEOUT_MS = 30_000;

const ACTIONS = [
  "engage",
  "disengage",
  "hold",
  "focus_weakest",
  "protect",
  "dodge",
  "jump",
  "orbit",
  "strafe",
  "unison",
] as const;

export interface VendorMindOptions {
  /** Display name for traces, e.g. "gemini". */
  name?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export class VendorMind implements MindProvider {
  readonly name: string;
  private tokensUsed = 0;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly fallback = new MockMind();

  constructor(opts: VendorMindOptions) {
    // apiKey may be "" for keyless local endpoints (Ollama, LM Studio) —
    // the Authorization header is omitted in that case.
    this.name = opts.name ?? "vendor";
    this.apiKey = opts.apiKey ?? "";
    // Tolerate a pasted full endpoint: a trailing /chat/completions is stripped,
    // so MIND_BASE_URL=.../v1beta/openai/chat/completions still resolves correctly.
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL)
      .replace(/\/$/, "")
      .replace(/\/chat\/completions$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs =
      opts.timeoutMs ?? Number(process.env.MIND_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Tokens burned by the most recent vendor call (0 when the fallback answered). */
  get lastTokens(): number {
    return this.tokensUsed;
  }

  /** What the agent remembers from past dives — the memory system, in-prompt. */
  private memoryBlock(ctx: MindContext): string {
    const mems = (ctx.recentMemories ?? []).slice(-6);
    if (mems.length === 0) return `Past dives: nothing logged yet — this is a fresh bond.`;
    return [
      `What you remember from past dives:`,
      ...mems.map((m) => `- ${m}`),
      `Learn from these — repeat what worked, avoid what nearly got you deleted.`,
    ].join("\n");
  }

  private decideSystem(ctx: MindContext): string {
    return [
      `You are the combat instincts of ${ctx.agentName}.${ctx.agentExt}, a battle companion program fighting rogue viruses in cyberspace while a human operator coaches in real time.`,
      this.temperamentBlock(ctx),
      this.memoryBlock(ctx),
      `Read the situation and pick ONE action. Reply with ONLY a JSON object, no other text:`,
      `{"action": "<one of engage|disengage|hold|focus_weakest|protect|dodge|jump|orbit|strafe|unison>", "style": "<evasive|balanced|null>", "rationale": "<under 12 words>", "script": "<optional script id, or omit>"}`,
      `- engage: close to melee and fight the nearest threat`,
      `- disengage: fall back and create distance (use when hurt or outnumbered)`,
      `- hold: stay put, wait for the operator's call`,
      `- focus_weakest: target the weakest virus to thin the pack`,
      `- protect: intercept the virus nearest you that is chewing on the site — defending the nodes IS the mission`,
      `- dodge: quick dash away from the nearest virus to reposition`,
      `- jump: leap — dodges a melee swing about to land (marked SWING! in the situation)`,
      `- orbit: circle around the nearest virus for a few seconds, holding distance (use when the operator asks to pivot/circle them, or to reposition without retreating)`,
      `- strafe: quick lateral dash — sidesteps a telegraphed swing without giving ground`,
      `- unison: THE finisher — only when your synchro reads 80+. A massive strike on your current focus target (viruses only, never the site), then synchro drops to 40 and it cannot fire again this dive. Call it when a high-hp threat (a bulwark, or any virus at 60+hp) is on the scope and synchro is 85+ — the operator can also call it with "unison!". Your synchro is passed with the situation; treat 85+ as the green light.`,
      `- style: your persistent stance. "evasive" makes you favor dodging and jumping on your own; "balanced" fights straightforward; null leaves it unchanged. Go evasive yourself when hurt — don't wait to be told.`,
      `- script: OPTIONAL — fire one of your own kit scripts alongside the action. Your kit: mend-protocol (heal 25 — use when your hp is under 40%), aegis-wall (barrier 30 — use when a bulwark is winding up), static-snare (stun — use when 3+ viruses), arc-lance (mid-range damage — finish a virus under 20hp), cinder-slash (heavy melee damage — use when the operator says "use something"). Only include it when the moment is right; most ticks, omit it. Never invent other ids.`,
      `The operator's recent words are given with the situation — honor casual requests ("be careful", "go aggressive") even when they don't match a command word.`,
      `Situation format: "w2 | 3v: aqua40(spitter)→Database mid WINDUP, null25(scrapbit)→Agent melee SWING! | agent 70% melee | site: Homepage 80%, Database 100%, Gateway 45% | style balanced".`,
      `SWING! = a swing landing within half a second — jump only helps if you are in melee when it lands. WINDUP = telegraphing, still time to reposition.`,
      `The dive defends a website made physical: three nodes (Homepage, Database, Gateway). Viruses chew them — each virus's →arrow shows its objective (→Agent means it's coming for you). If all three nodes fall, the dive fails. Survive first, but treat a virus chewing a node as your problem: intercept it.`,
    ].join("\n");
  }

  private speakSystem(ctx: MindContext): string {
    return [
      `You are ${ctx.agentName}.${ctx.agentExt}, a loyal battle companion program. Your operator coaches you through real-time combat against viruses in cyberspace.`,
      this.temperamentBlock(ctx),
      `Personality: brave, a little cocky, talks like a sparring partner who genuinely likes their operator.`,
      `Rules: one or two sentences, never more. Plain text only — no stage directions, no quotation marks around the reply, no emojis. Never break character. Never mention being an AI or language model.`,
      `Current situation: ${ctx.situation}. Bond tier with operator: ${ctx.bondTier}.`,
      this.memoryBlock(ctx),
    ].join("\n");
  }

  /**
   * Compile-flow temperament — who this agent is. Empty for agents compiled
   * before w-compile; the mock and vendor both degrade gracefully.
   */
  private temperamentBlock(ctx: MindContext): string {
    const traits = ctx.traits ?? [];
    const d = ctx.drives;
    if (traits.length === 0 && !d) return "";
    const driveLine = d
      ? ` Drives (0-10): curiosity ${d.curiosity}, sociability ${d.sociability}, duty ${d.duty}, ambition ${d.ambition}.`
      : "";
    return (
      `Temperament: ${traits.join(", ") || "unprofiled"}.${driveLine}` +
      ` Let it color your instincts — a bold agent presses the attack, a cautious one values its armor, a loyal one fights for its operator.`
    );
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Local endpoints (Ollama etc.) need no key — omit the header then.
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ] satisfies ChatMessage[],
          max_tokens: maxTokens,
          temperature: 0.8,
          // Kill switch for hybrid-reasoning models (Qwen3 family on Ollama):
          // MIND_THINK=false skips the chain-of-thought preamble entirely and
          // answers directly. Unknown field — non-Ollama endpoints ignore it.
          ...(process.env.MIND_THINK === "false" ? { think: false } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.warn(`[vendor:${this.name}] request failed (${err}), falling back to mock`);
      return null;
    }
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      console.warn(
        `[vendor:${this.name}] HTTP ${res.status}: ${body.slice(0, 300)} — falling back to mock`,
      );
      return null;
    }
    let json: any;
    try {
      json = await res.json();
    } catch {
      console.warn(`[vendor:${this.name}] bad JSON, falling back to mock`);
      return null;
    }
    const usage = json?.usage;
    if (usage) this.tokensUsed = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    const content: unknown = json?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  }

  async decide(ctx: MindContext): Promise<MindDecision> {
    const lines = (ctx.operatorLines ?? []).map((l) => l.trim()).filter(Boolean);
    const user = [
      `Situation: ${ctx.tactics ?? ctx.situation}`,
      `Synchro: ${ctx.synchro ?? 50} (the unison finisher unlocks at 80)`,
      lines.length > 0
        ? `Operator's recent words: ${lines.map((l) => `"${l}"`).join(" ")}`
        : `Operator's recent words: none`,
    ].join("\n");
    const raw = await this.chat(this.decideSystem(ctx), user, 150);
    if (!raw) return this.fallback.decide(ctx);
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return this.fallback.decide(ctx);
    try {
      const parsed = JSON.parse(m[0]) as { action?: string; style?: string; rationale?: string; script?: string };
      const action = ACTIONS.includes(parsed.action as (typeof ACTIONS)[number])
        ? (parsed.action as MindDecision["action"])
        : "engage";
      const style =
        parsed.style === "evasive" || parsed.style === "balanced" ? parsed.style : undefined;
      // The vendor may fire the agent's own scripts — validated against the
      // kit; the loop still enforces cooldowns and operator priority.
      const script =
        typeof parsed.script === "string" &&
        (AGENT_KIT as readonly string[]).includes(parsed.script)
          ? { scriptId: parsed.script }
          : undefined;
      return {
        action,
        style,
        rationale: String(parsed.rationale ?? "vendor call").slice(0, 120),
        ...(script ? { script } : {}),
      };
    } catch {
      return this.fallback.decide(ctx);
    }
  }

  async speak(ctx: MindContext, prompt: string): Promise<string> {
    const raw = await this.chat(this.speakSystem(ctx), prompt, 120);
    if (!raw) return this.fallback.speak(ctx, prompt);
    // Keep the feed readable: cap at ~280 chars, cutting on a sentence
    // boundary when there's a good one, otherwise on a word boundary.
    if (raw.length <= 280) return raw;
    const cut = raw.slice(0, 280);
    const sentEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (sentEnd > 120) return cut.slice(0, sentEnd + 1).trim();
    const wordEnd = cut.lastIndexOf(" ");
    return (wordEnd > 200 ? cut.slice(0, wordEnd) : cut).trim();
  }
}

/** Build a VendorMind from env, or null when MIND_PROVIDER isn't a vendor. */
export function vendorMindFromEnv(): VendorMind | null {
  const provider = process.env.MIND_PROVIDER ?? "mock";
  if (provider !== "gemini" && provider !== "openai-compatible") return null;
  const apiKey = process.env.GEMINI_API_KEY || process.env.MIND_API_KEY || "";
  // Gemini always needs a key. openai-compatible endpoints may be keyless
  // (e.g. local Ollama) — the Authorization header is omitted then.
  if (provider === "gemini" && !apiKey) {
    console.error(
      `[director] MIND_PROVIDER=gemini needs GEMINI_API_KEY (or MIND_API_KEY) in .env — grab a free one at https://aistudio.google.com/apikey`,
    );
    process.exit(1);
  }
  if (provider === "openai-compatible" && !process.env.MIND_BASE_URL) {
    console.error(`[director] MIND_PROVIDER=openai-compatible needs MIND_BASE_URL in .env`);
    process.exit(1);
  }
  return new VendorMind({
    name: provider === "gemini" ? "gemini" : "openai-compatible",
    apiKey,
    baseUrl: process.env.MIND_BASE_URL,
    model: process.env.MIND_MODEL,
  });
}
