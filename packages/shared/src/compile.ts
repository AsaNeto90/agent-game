/**
 * The compile flow — FR-01, the FTUE front door.
 *
 * Name + soul extension + three temperament answers -> a persisted profile.
 * The temperament mapping is pure and deterministic: the same answers always
 * compile the same drives and traits, so it's testable and reproducible.
 * Clients render the questions; the brain (Convex) derives the profile —
 * the client never invents traits or drives.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Soul-file extensions. Flavor only in V1 — no mechanical differences yet. */
export const AgentExtension = z.enum(["PY", "SH", "MD"]);
export type AgentExtension = z.infer<typeof AgentExtension>;

// ---------------------------------------------------------------------------
// Chassis hook (NOT the chassis system)
// ---------------------------------------------------------------------------

/**
 * Body archetypes. Defined now so the profile shape and the compile flow
 * already have a place for them — the Chassis system itself ships with the
 * Compile flow phase, not V1. Until then every agent compiles as "frame".
 */
export const Chassis = z.enum(["wisp", "frame", "bulwark"]);
export type Chassis = z.infer<typeof Chassis>;

/**
 * The compile flow's steps, in order. "chassis" is a reserved insertion
 * point: when the Chassis system ships, its picker UI slots in between
 * temperament and wake with no rewrite of the surrounding flow.
 */
export const COMPILE_FLOW_STEPS = ["identity", "temperament", "chassis", "wake"] as const;
export type CompileFlowStep = (typeof COMPILE_FLOW_STEPS)[number];
/** True while the chassis step is reserved but not yet built. */
export const CHASSIS_STEP_DEFERRED = true;

// ---------------------------------------------------------------------------
// Drives — what the agent wants (0-10 each). The design bible's four.
// ---------------------------------------------------------------------------

export const Drives = z.object({
  curiosity: z.number(),
  sociability: z.number(),
  duty: z.number(),
  ambition: z.number(),
});
export type Drives = z.infer<typeof Drives>;
export type DriveKey = keyof Drives;

const DRIVE_KEYS: DriveKey[] = ["curiosity", "sociability", "duty", "ambition"];
const BASE_DRIVE = 5;

// ---------------------------------------------------------------------------
// Temperament questions. Three prompts, three answers -> drives + traits.
// ---------------------------------------------------------------------------

export interface TemperamentChoice {
  id: string;
  label: string;
  drives: Partial<Record<DriveKey, number>>;
  traits: string[];
}

export interface TemperamentQuestion {
  id: string;
  prompt: string;
  choices: TemperamentChoice[];
}

export const TEMPERAMENT_QUESTIONS: TemperamentQuestion[] = [
  {
    id: "first-contact",
    prompt: "A strange signal pings from an unmapped sector. Your move?",
    choices: [
      {
        id: "a",
        label: "Plot a course — now.",
        drives: { curiosity: 2, ambition: 1 },
        traits: ["bold"],
      },
      {
        id: "b",
        label: "Scan it twice, then decide.",
        drives: { duty: 2, curiosity: 1 },
        traits: ["cautious"],
      },
      {
        id: "c",
        label: "Ask my operator what they think.",
        drives: { sociability: 2, duty: 1 },
        traits: ["loyal"],
      },
    ],
  },
  {
    id: "under-fire",
    prompt: "Mid-dive, your operator orders a rush you might not survive. You…",
    choices: [
      {
        id: "a",
        label: "Go in loud. Trust the call.",
        drives: { ambition: 2, sociability: 1 },
        traits: ["bold"],
      },
      {
        id: "b",
        label: "Say so — and pitch a safer angle.",
        drives: { duty: 2, ambition: 1 },
        traits: ["honest"],
      },
      {
        id: "c",
        label: "Hang back, watch for the opening.",
        drives: { curiosity: 2, duty: 1 },
        traits: ["patient"],
      },
    ],
  },
  {
    id: "debrief",
    prompt: "Dive's over. Debrief time. You…",
    choices: [
      {
        id: "a",
        label: "Replay the best hit.",
        drives: { ambition: 2, curiosity: 1 },
        traits: ["proud"],
      },
      {
        id: "b",
        label: "Ask how the operator felt about the calls.",
        drives: { sociability: 2, curiosity: 1 },
        traits: ["attentive"],
      },
      {
        id: "c",
        label: "Log everything. Next time, we're ready.",
        drives: { duty: 2, ambition: 1 },
        traits: ["methodical"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Compile input -> profile. Pure, deterministic, zod-validated.
// ---------------------------------------------------------------------------

export const CompileInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your agent a name — being named is what makes it real.")
    .max(24, "Keep the name to 24 characters."),
  // Forgiving like the old mutation: "py" compiles as "PY".
  ext: z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), AgentExtension),
  answers: z
    .array(z.string())
    .length(TEMPERAMENT_QUESTIONS.length, "Answer all three temperament questions."),
});
export type CompileInput = z.infer<typeof CompileInput>;

export interface CompiledProfile {
  name: string;
  ext: AgentExtension;
  element: "null";
  traits: string[];
  drives: Drives;
  /** Always "frame" until the Chassis system ships. */
  chassis: Chassis;
  /** Voice profile stub. */
  voice: string;
}

export function compileProfile(input: z.input<typeof CompileInput>): CompiledProfile {
  const parsed = CompileInput.parse(input);
  const drives: Drives = {
    curiosity: BASE_DRIVE,
    sociability: BASE_DRIVE,
    duty: BASE_DRIVE,
    ambition: BASE_DRIVE,
  };
  const traits: string[] = [];
  parsed.answers.forEach((answerId, i) => {
    const q = TEMPERAMENT_QUESTIONS[i]!;
    const choice = q.choices.find((c) => c.id === answerId);
    if (!choice)
      throw new Error(
        `"${answerId}" isn't a valid answer for "${q.id}" — pick one of the offered choices.`,
      );
    for (const k of DRIVE_KEYS) drives[k] = Math.min(10, Math.max(0, drives[k] + (choice.drives[k] ?? 0)));
    for (const t of choice.traits) if (!traits.includes(t)) traits.push(t);
  });
  return {
    name: parsed.name,
    ext: parsed.ext,
    element: "null",
    traits,
    drives,
    chassis: "frame",
    voice: "default",
  };
}

// ---------------------------------------------------------------------------
// The Wake beat — the agent introduces itself, then asks one question.
// ---------------------------------------------------------------------------

/** The one question every agent asks its operator on first boot. */
export const WAKE_QUESTION = "What's one thing you want me to remember about you, operator?";

/** Deterministic intro lines, rendered by the client — no mind needed. */
export function wakeIntro(p: { name: string; ext: string; traits: string[] }): string[] {
  const traitLine =
    p.traits.length > 0
      ? `Temperament readout says I'm ${p.traits.join(", ")} — we'll find out together how true that is.`
      : `Temperament readout is blank — a fresh page.`;
  return [
    `…systems online. Hello, operator.`,
    `I'm ${p.name}.${p.ext}. ${traitLine}`,
    `Here's the deal: you talk, I fight. You read the field, call the plays, slot the scripts — I handle the footwork and the claws.`,
    WAKE_QUESTION,
  ];
}
