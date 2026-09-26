# Agent Game — monorepo scaffold (V1 demo)

API-first agent companion game. The brain lives in **Convex** (soul store +
realtime) plus a tiny **director** process (the 4Hz tick loop). Clients are
dumb renderers: they send intents, subscribe to snapshots.

```
packages/shared    — the API contract (zod schemas). The seam. Never drift it.
convex/            — soul store: agents, sessions, entities, intents, scripts,
                     fragments, bond ledger, memories, decision traces.
packages/director  — tick loop: L0 sim (free) + MindProvider (mock today,
                     vendor/local tomorrow). Stateless — kill it anytime.
packages/client    — Vite + React + Three.js dive view. Renders, never thinks.
```

## Prereqs

- Node 20+, pnpm 9+
- A Convex account (free tier). The project already pays for Convex.

## Run it

```bash
# 1. Install
pnpm install

# 2. Start Convex (generates _generated/ bindings, opens dashboard)
npx convex dev
#    Copy the deployment URL it prints.

# 3. Seed the script library (in another terminal, after convex dev is up)
npx convex run scripts:seedLibrary '{"scripts":[]}'  # placeholder; use the seed script below

# 4. Compile your first agent
npx convex run agents:compile '{"name":"AstroMan","ext":"PY"}'
#    Save the returned agent id.

# 5. Director — the brain's heartbeat
cp packages/director/.env.example packages/director/.env
#    Fill in CONVEX_URL + AGENT_ID
pnpm --filter @agent-game/director dev

# 6. Client — the 3D dive view
cp packages/client/.env.example packages/client/.env
#    Fill in VITE_CONVEX_URL
pnpm --filter @agent-game/client dev
#    Open http://localhost:5173, paste the agent id, dive.
```

### Seeding the script library

The 12-script Starter Kit lives in `packages/shared/src/starter-scripts.ts`.
Seed it once:

```bash
npx tsx -e "
import { STARTER_SCRIPTS } from './packages/shared/src/starter-scripts.ts';
console.log(JSON.stringify({ scripts: STARTER_SCRIPTS.map(({id,name,category,element,tags,rarity,description,effect}) => ({ scriptId: id, name, category, element, tags, rarity, description, effect })) }));
" | xargs -0 -I{} npx convex run scripts:seedLibrary '{}'
```

(Or run it from the Convex dashboard's function runner.)

## What works in this scaffold

- Tick loop at 4Hz: intent inbox → L0 sim (range bands, element matchups,
  melee + ranged) → snapshot write → event feed → decision traces.
- Operator verbs: command, slot script, chat. Synchro + energy modeled.
- MockMind: deterministic, $0. Every test runs on it.
- VendorMind: a real LLM behind `MindProvider` (OpenAI-compatible shape —
  works with Gemini, Ollama, LM Studio, OpenAI...). Set `MIND_PROVIDER=gemini`
  with a free `GEMINI_API_KEY` from https://aistudio.google.com/apikey and the
  agent starts thinking for real. Any vendor failure falls back to MockMind,
  so a dead API never kills a dive.
- Client: Three.js dive view with interpolated 60fps rendering, HUD with
  command buttons / script slots / chat / synchro bar / dialogue feed.
- Tests: `pnpm --filter @agent-game/director test` (vitest — sim invariants,
  determinism, element math).

## What's stubbed (by design)

- Bond XP awards on battle end, virus drops → fragments, compile/shatter UI.
- Style vector updates from play history (schema is ready).
- Auth (single local operator), multiplayer, trading, tournaments.
- The Expo "deck" client — same Convex backend when it's time.

## Deploying the demo (still $0)

- Client → Vercel (already in use): `vercel --prod` from `packages/client`.
- Director → Fly.io free tier: one always-on box running `pnpm start`.
- Convex → already hosted. Set `CONVEX_URL` / `VITE_CONVEX_URL` per env.

## Design docs

- `~/workspace/your_files/game-vision-bible/` — the whole dream.
- `~/workspace/your_files/game-v1-requirements/` — V1 scope + non-goals.
