import { describe, expect, it, vi } from "vitest";
import { VendorMind } from "./vendor.js";
import type { MindContext } from "./mind.js";

const ctx: MindContext = {
  agentName: "AstroMan",
  agentExt: "PY",
  bondTier: "spark",
  recentMemories: [],
  situation: "2 viruses, agent hp 70%",
};

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function chatBody(content: string, promptTokens = 50, completionTokens = 20) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

const opts = (fetchFn: ReturnType<typeof fakeFetch>, baseUrl = "https://example.test/v1") => ({
  name: "test-vendor",
  apiKey: "sk-test",
  baseUrl,
  model: "test-model",
  timeoutMs: 1000,
  fetchFn: fetchFn as unknown as typeof fetch,
});

describe("VendorMind", () => {
  it("decide parses the vendor's JSON action", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "disengage", "rationale": "hp low, kiting"}'));
    const mind = new VendorMind(opts(fetchFn));
    const d = await mind.decide(ctx);
    expect(d.action).toBe("disengage");
    expect(d.rationale).toMatch(/kiting/);
    expect(mind.lastTokens).toBe(70);
    // Request shape: OpenAI-compatible endpoint, bearer auth, model set.
    const [url, init] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string).model).toBe("test-model");
  });

  it("decide unwraps markdown-fenced JSON", async () => {
    const fetchFn = fakeFetch(chatBody('```json\n{"action": "focus_weakest", "rationale": "thin the pack"}\n```'));
    const mind = new VendorMind(opts(fetchFn));
    expect((await mind.decide(ctx)).action).toBe("focus_weakest");
  });

  it("decide rejects unknown actions and garbage", async () => {
    const bad = new VendorMind(opts(fakeFetch(chatBody('{"action": "teleport"}'))));
    expect((await bad.decide(ctx)).action).toBe("engage");
    const garbage = new VendorMind(opts(fakeFetch(chatBody("lol no json here"))));
    // Falls back to MockMind's deterministic policy for this situation.
    expect((await garbage.decide(ctx)).action).toBe("engage");
  });

  it("falls back to MockMind on HTTP errors and network failures", async () => {
    const http500 = new VendorMind(opts(fakeFetch({ error: "boom" }, 500)));
    expect(await http500.speak(ctx, "operator command: hold")).toMatch(/Holding position/);
    const throwing = new VendorMind({
      ...opts(fakeFetch(chatBody("x"))),
      fetchFn: (async () => {
        throw new Error("socket hung up");
      }) as unknown as typeof fetch,
    });
    expect(await throwing.speak(ctx, "hello")).toMatch(/AstroMan\.PY/);
    expect(throwing.lastTokens).toBe(0);
  });

  it("speak returns vendor text trimmed, capped for the feed", async () => {
    const long =
      "First sentence that carries the scene with plenty of detail about the tide-district grid and the two viruses circling with their octahedral hulls glinting in the dark. " +
      "Second sentence lands the thought cleanly. " +
      "Third sentence rambles on and on about the operator's voice crackling over the link and the synchro meter climbing with every single clean hit we land together out here in the grid, and it just keeps going past any reasonable length.";
    expect(long.length).toBeGreaterThan(280);
    const mind = new VendorMind(opts(fakeFetch(chatBody(`  ${long}  `))));
    const line = await mind.speak(ctx, "battle banter");
    expect(line.length).toBeLessThanOrEqual(280);
    expect(line).toMatch(/\.$/); // cut on a sentence boundary, not mid-word
    expect(line).not.toMatch(/Third sentence/);
  });

  it("omits the Authorization header when constructed without a key (local Ollama)", async () => {
    const fetchFn = fakeFetch(chatBody("local brain online"));
    const mind = new VendorMind({ ...opts(fetchFn, "http://localhost:11434/v1"), apiKey: "" });
    const line = await mind.speak(ctx, "hello");
    expect(line).toBe("local brain online");
    const [, init] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("tolerates a base URL with /chat/completions already appended", async () => {
    const fetchFn = fakeFetch(chatBody("hi"));
    const mind = new VendorMind(
      opts(fetchFn, "https://example.test/v1/chat/completions"),
    );
    await mind.speak(ctx, "hello");
    const [url] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const fetchFn = fakeFetch(chatBody("hi"));
    const mind = new VendorMind(opts(fetchFn, "https://example.test/v1/"));
    await mind.speak(ctx, "hello");
    const [url] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
  });
});

describe("MIND_THINK", () => {
  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.MIND_THINK;
    if (value === undefined) delete process.env.MIND_THINK;
    else process.env.MIND_THINK = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.MIND_THINK;
      else process.env.MIND_THINK = prev;
    }
  };

  const bodyOf = (fetchFn: ReturnType<typeof fakeFetch>) => {
    const [, init] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    return JSON.parse(init.body as string);
  };

  it("sends think:false when MIND_THINK=false (Qwen3 on Ollama)", async () => {
    await withEnv("false", async () => {
      const fetchFn = fakeFetch(chatBody("quick answer"));
      const mind = new VendorMind(opts(fetchFn));
      await mind.speak(ctx, "hello");
      expect(bodyOf(fetchFn)).toMatchObject({ think: false });
    });
  });

  it("omits think when MIND_THINK is unset", async () => {
    await withEnv(undefined, async () => {
      const fetchFn = fakeFetch(chatBody("quick answer"));
      const mind = new VendorMind(opts(fetchFn));
      await mind.speak(ctx, "hello");
      expect(bodyOf(fetchFn)).not.toHaveProperty("think");
    });
  });
});

describe("MIND_TIMEOUT_MS", () => {
  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.MIND_TIMEOUT_MS;
    if (value === undefined) delete process.env.MIND_TIMEOUT_MS;
    else process.env.MIND_TIMEOUT_MS = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.MIND_TIMEOUT_MS;
      else process.env.MIND_TIMEOUT_MS = prev;
    }
  };

  it("uses MIND_TIMEOUT_MS for the abort signal when set", async () => {
    await withEnv("60000", async () => {
      const { timeoutMs: _ignored, ...noTimeout } = opts(fakeFetch(chatBody("hi")));
      const mind = new VendorMind(noTimeout);
      expect((mind as unknown as { timeoutMs: number }).timeoutMs).toBe(60000);
    });
  });

  it("defaults to 30s when MIND_TIMEOUT_MS is unset", async () => {
    await withEnv(undefined, async () => {
      const { timeoutMs: _ignored, ...noTimeout } = opts(fakeFetch(chatBody("hi")));
      const mind = new VendorMind(noTimeout);
      expect((mind as unknown as { timeoutMs: number }).timeoutMs).toBe(30_000);
    });
  });
});

describe("VendorMind.decide autonomy", () => {
  it("parses the style field the mind sets for itself", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "disengage", "style": "evasive", "rationale": "hurt, kiting"}'));
    const d = await new VendorMind(opts(fetchFn)).decide(ctx);
    expect(d.action).toBe("disengage");
    expect(d.style).toBe("evasive");
  });

  it("drops invalid style values instead of crashing", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "jump", "style": "reckless", "rationale": "yolo"}'));
    const d = await new VendorMind(opts(fetchFn)).decide(ctx);
    expect(d.action).toBe("jump");
    expect(d.style).toBeUndefined();
  });

  it("accepts the new dodge and jump actions", async () => {
    const d = await new VendorMind(opts(fakeFetch(chatBody('{"action": "dodge", "rationale": "repositioning"}')))).decide(ctx);
    expect(d.action).toBe("dodge");
  });

  it("sends the tactical snapshot and operator lines to the vendor", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "engage", "rationale": "ok"}'));
    const mind = new VendorMind(opts(fetchFn));
    await mind.decide({
      ...ctx,
      tactics: "w2 | 1v: aqua40 melee | agent 80% melee | style balanced",
      operatorLines: ["be careful out there"],
    });
    const [, init] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user").content as string;
    expect(userMsg).toContain("aqua40 melee");
    expect(userMsg).toContain("be careful out there");
  });
});

describe("VendorMind.decide lateral moves", () => {
  it("accepts orbit and strafe actions", async () => {
    const orbit = await new VendorMind(
      opts(fakeFetch(chatBody('{"action": "orbit", "rationale": "pivoting"}'))),
    ).decide(ctx);
    expect(orbit.action).toBe("orbit");
    const strafe = await new VendorMind(
      opts(fakeFetch(chatBody('{"action": "strafe", "rationale": "sidestep"}'))),
    ).decide(ctx);
    expect(strafe.action).toBe("strafe");
  });
});

describe("VendorMind memory injection", () => {
  const systemOf = (fetchFn: ReturnType<typeof fakeFetch>) => {
    const [, init] = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0];
    const body = JSON.parse(init.body as string);
    return body.messages.find((m: { role: string }) => m.role === "system").content as string;
  };

  it("decide prompt carries past-dive memories", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "orbit", "rationale": "worked before"}'));
    const mind = new VendorMind(opts(fetchFn));
    await mind.decide({
      ...ctx,
      recentMemories: ["Wave 2 (42s): cleared. Damage 24 (120->96hp). Pivoting around them worked."],
      tactics: "w3 | 2v: aqua40 melee | agent 100% melee | style balanced",
    });
    const system = systemOf(fetchFn);
    expect(system).toContain("What you remember from past dives:");
    expect(system).toContain("Pivoting around them worked.");
    expect(system).toContain("repeat what worked");
  });

  it("decide prompt admits a fresh bond honestly", async () => {
    const fetchFn = fakeFetch(chatBody('{"action": "engage", "rationale": "fresh"}'));
    const mind = new VendorMind(opts(fetchFn));
    await mind.decide({ ...ctx, recentMemories: [] });
    expect(systemOf(fetchFn)).toContain("nothing logged yet");
  });

  it("speak prompt carries memories too, capped at six", async () => {
    const fetchFn = fakeFetch(chatBody("Nice pivoting out there."));
    const mind = new VendorMind(opts(fetchFn));
    const mems = Array.from({ length: 8 }, (_, i) => `Wave ${i + 1}: cleared.`);
    await mind.speak({ ...ctx, recentMemories: mems }, "battle banter");
    const system = systemOf(fetchFn);
    expect(system).toContain("Wave 8: cleared.");
    expect(system).not.toContain("Wave 1: cleared."); // oldest fall off the prompt
    expect(system).not.toContain("Wave 2: cleared.");
  });
});
