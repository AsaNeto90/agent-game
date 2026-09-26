import { it } from "vitest";
import { rng, spawnWave, tickWorld, type WorldState } from "./src/world.js";
it("species balance sim", () => {
  for (const wave of [1, 2, 3, 4]) {
    const w: WorldState = { fighters: [{ id: "a", kind: "agent", name: "A", pos: {x:0,y:0,z:0}, pose: "idle", hp: 120, maxHp: 120, element: "null", cooldown: 0 }], events: [] };
    spawnWave(w, wave, rng(11));
    const comp = w.fighters.filter(f => f.kind === "virus").map(f => f.name).join(",");
    const rand = rng(11);
    let ticks = 0;
    while (w.fighters.some(f => f.kind === "virus" && f.hp > 0) && w.fighters[0].hp > 0 && ticks < 1200) {
      tickWorld(w, 0.25, "engage", rand, null, null, 60);
      ticks++;
    }
    const cleared = !w.fighters.some(f => f.kind === "virus" && f.hp > 0);
    console.log(`wave ${wave} [${comp}]: ${cleared ? `cleared in ${ticks} ticks` : "AGENT DIED"} — agent hp ${Math.max(0, w.fighters[0].hp)}/120`);
  }
});
