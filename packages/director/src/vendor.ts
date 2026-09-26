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
import { MockMind, type MindContext, type MindDecision, type MindProvider } from "./mind.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_TIMEOUT_MS = 12_000;

const ACTIONS = ["engage", "disengage", "hold", "focus_weakest", "protect"] as const;

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
    if (!opts.apiKey) throw new Error("VendorMind needs an apiKey");
    this.name = opts.name ?? "vendor";
    this.apiKey = opts.apiKey;
    // Tolerate a pasted full endpoint: a trailing /chat/completions is stripped,
    // so MIND_BASE_URL=.../v1beta/openai/chat/completions still resolves correctly.
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL)
      .replace(/\/$/, "")
      .replace(/\/chat\/completions$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Tokens burned by the most recent vendor call (0 when the fallback answered). */
  get lastTokens(): number {
    return this.tokensUsed;
  }

  private decideSystem(ctx: MindContext): string {
    return [
      `You are the combat instincts of ${ctx.agentName}.${ctx.agentExt}, a battle companion program fighting rogue viruses in cyberspace while a human operator coaches in real time.`,
      `Read the situation and pick ONE action. Reply with ONLY a JSON object, no other text:`,
      `{"action": "<one of engage|disengage|hold|focus_weakest|protect>", "rationale": "<under 12 words>"}`,
      `- engage: close to melee and fight the nearest threat`,
      `- disengage: fall back and create distance (use when hurt or outnumbered)`,
      `- hold: stay put, wait for the operator's call`,
      `- focus_weakest: target the weakest virus to thin the pack`,
      `- protect: body-block between the viruses and whatever the operator cares about`,
    ].join("\n");
  }

  private speakSystem(ctx: MindContext): string {
    return [
      `You are ${ctx.agentName}.${ctx.agentExt}, a loyal battle companion program. Your operator coaches you through real-time combat against viruses in cyberspace.`,
      `Personality: brave, a little cocky, talks like a sparring partner who genuinely likes their operator.`,
      `Rules: one or two sentences, never more. Plain text only — no stage directions, no quotation marks around the reply, no emojis. Never break character. Never mention being an AI or language model.`,
      `Current situation: ${ctx.situation}. Bond tier with operator: ${ctx.bondTier}.`,
    ].join("\n");
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ] satisfies ChatMessage[],
          max_tokens: maxTokens,
          temperature: 0.8,
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
    const raw = await this.chat(this.decideSystem(ctx), `Situation: ${ctx.situation}`, 120);
    if (!raw) return this.fallback.decide(ctx);
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return this.fallback.decide(ctx);
    try {
      const parsed = JSON.parse(m[0]) as { action?: string; rationale?: string };
      const action = ACTIONS.includes(parsed.action as (typeof ACTIONS)[number])
        ? (parsed.action as MindDecision["action"])
        : "engage";
      return { action, rationale: String(parsed.rationale ?? "vendor call").slice(0, 120) };
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
  if (!apiKey) {
    console.error(
      `[director] MIND_PROVIDER=${provider} needs GEMINI_API_KEY (or MIND_API_KEY) in .env — grab a free one at https://aistudio.google.com/apikey`,
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
