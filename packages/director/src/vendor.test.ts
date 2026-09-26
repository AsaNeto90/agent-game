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

  it("constructor refuses to run without a key", () => {
    expect(() => new VendorMind({ apiKey: "" })).toThrow(/apiKey/);
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
