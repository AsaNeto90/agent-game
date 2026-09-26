/**
 * Compile-flow persistence: the mutation validates input, derives the
 * profile server-side, and round-trips through the real schema — no
 * deployment needed, convex-test runs the actual functions in-process.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
// NOTE: "./schema.ts", not "./schema.js" — the committed schema.js is stale
// build output (see u-structures), and vitest would resolve the .js first.
import schema from "./schema.ts";

// vite/client types aren't in the convex tsconfig; declare the one API we use.
declare global {
  interface ImportMeta {
    glob(pattern: string | string[]): Record<string, () => Promise<unknown>>;
  }
}

// The glob must include _generated — convex-test finds its modules root there.
const t = convexTest(schema, import.meta.glob("./**/*.*"));

describe("agents:compile", () => {
  test("persists the derived profile", async () => {
    const agentId = await t.mutation(api.agents.compile, {
      name: "Nova",
      ext: "py", // lowercased on purpose — compile normalizes it
      answers: ["a", "b", "c"],
    });
    const doc = await t.query(api.agents.get, { agentId });
    expect(doc?.name).toBe("Nova");
    expect(doc?.ext).toBe("PY");
    expect(doc?.element).toBe("null");
    expect(doc?.bondTier).toBe("spark");
    // Temperament derivation: a=bold, b=honest, c=methodical.
    expect(doc?.traits).toEqual(["bold", "honest", "methodical"]);
    expect(doc?.drives?.ambition).toBeGreaterThan(doc?.drives?.sociability ?? 0);
    // Chassis hook: reserved, defaulting to frame.
    expect(doc?.chassis).toBe("frame");
    expect(doc?.voice).toBe("default");
    expect(doc?.retired).toBeUndefined();
  });

  test("rejects bad input with a readable message", async () => {
    await expect(
      t.mutation(api.agents.compile, { name: "   ", ext: "PY", answers: ["a", "b", "c"] }),
    ).rejects.toThrow(/name/i);
    await expect(
      t.mutation(api.agents.compile, { name: "Nova", ext: "EXE", answers: ["a", "b", "c"] }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.agents.compile, { name: "Nova", ext: "PY", answers: ["a", "zzz"] }),
    ).rejects.toThrow(/answer/i);
  });

  test("list hides retired agents; decommission retires", async () => {
    const id = await t.mutation(api.agents.compile, {
      name: "Old",
      ext: "MD",
      answers: ["b", "b", "b"],
    });
    const ids = (list: { _id: unknown }[]) => list.map((a) => String(a._id));
    expect(ids(await t.query(api.agents.list, {}))).toContain(String(id));
    await t.mutation(api.agents.decommission, { agentId: id });
    expect(ids(await t.query(api.agents.list, {}))).not.toContain(String(id));
    // History survives retirement — get still finds it.
    expect(await t.query(api.agents.get, { agentId: id })).not.toBeNull();
  });
});
