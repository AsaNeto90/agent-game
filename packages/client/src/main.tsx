import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type { FunctionReference } from "convex/server";
import type { BrainEvent } from "@agent-game/shared";
import { CompileInput, TEMPERAMENT_QUESTIONS, wakeIntro, WAKE_QUESTION } from "@agent-game/shared";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

/**
 * w-compile: the compile flow (FR-01). agents:list, agents:decommission, and
 * the new compile() args don't exist in the generated api types yet — they
 * land on `npx convex dev`. The runtime references are identical; only the
 * types are widened here. The doc type is widened the same way.
 */
type AgentDoc = {
  _id: Id<"agents">;
  name: string;
  ext: string;
  bondTier: string;
  traits?: string[];
  drives?: { curiosity: number; sociability: number; duty: number; ambition: number };
  chassis?: string;
  retired?: boolean;
  createdAt: number;
};

const agentsCompile = api.agents.compile as unknown as FunctionReference<
  "mutation",
  "public",
  { name: string; ext: string; answers: string[] },
  string
>;
const agentsDecommission = (api.agents as unknown as Record<string, unknown>)
  .decommission as FunctionReference<"mutation", "public", { agentId: Id<"agents"> }, null>;

const AGENT_ID_KEY = "deck.agentId";

const btnPrimary: CSSProperties = {
  padding: "8px 16px",
  margin: "4px 8px 4px 0",
  background: "#00e5ff",
  color: "#04121a",
  border: "none",
  borderRadius: 4,
  fontWeight: "bold",
  cursor: "pointer",
};
const btnGhost: CSSProperties = {
  padding: "8px 16px",
  margin: "4px 8px 4px 0",
  background: "transparent",
  color: "#9fd8e8",
  border: "1px solid #1e4a5a",
  borderRadius: 4,
  cursor: "pointer",
};
const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "#7fb3c8",
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
};
const inputStyle: CSSProperties = {
  width: 320,
  marginRight: 8,
  padding: 8,
  background: "#0a1420",
  color: "#d7f4ff",
  border: "1px solid #1e4a5a",
  borderRadius: 4,
};
const errStyle: CSSProperties = { color: "#ff7a7a" };
const codeStyle: CSSProperties = {
  background: "#122",
  padding: "4px 8px",
  borderRadius: 4,
  fontFamily: "monospace",
};

const ELEMENT_COLORS: Record<string, number> = {
  fire: 0xff5533,
  aqua: 0x3399ff,
  elec: 0xffdd33,
  wood: 0x44cc66,
  null: 0x8899aa,
};

// Virus species read at a glance — keyed off the name the director assigns,
// so no schema changes were needed to tell them apart.
const SPECIES_COLORS: Record<string, number> = {
  Dasher: 0xff4455, // fast — red
  Spitter: 0x33ffcc, // ranged — teal
  Bulwark: 0xdd9933, // tank — bronze
};

/**
 * DiveView — the 3D UX layer. It renders; it never thinks.
 * Subscribes to the Convex snapshot (4Hz semantic state) and interpolates
 * to 60fps. Poses drive simple procedural animation.
 */
function DiveView({ sessionId, followCam }: { sessionId: Id<"sessions">; followCam: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const snapshot = useQuery(api.session.snapshot, { sessionId });
  const meshes = useRef(new Map<string, THREE.Mesh>());
  // The animate loop runs outside React render — mirror the prop through a ref.
  const followRef = useRef(followCam);
  followRef.current = followCam;

  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);
    scene.fog = new THREE.Fog(0x05070f, 20, 60);

    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.1, 200);
    camera.position.set(0, 9, 13);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    // Grid floor — the cyberspace deck.
    const grid = new THREE.GridHelper(60, 60, 0x1a3a5c, 0x0d1f33);
    scene.add(grid);
    scene.add(new THREE.AmbientLight(0x8899bb, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(6, 12, 4);
    scene.add(key);

    let raf = 0;
    const desired = new THREE.Vector3(); // scratch — no per-frame allocation
    const animate = () => {
      raf = requestAnimationFrame(animate);
      // Interpolate every mesh toward its latest snapshot position.
      for (const [, mesh] of meshes.current) {
        const target = (mesh.userData.target as THREE.Vector3 | undefined);
        if (target) mesh.position.lerp(target, 0.18);
        // Pose flavor: bob while running, flash on hit — and the wind-up
        // telegraph: a winding-up virus pulses hot orange. That's the
        // operator's cue to kite, jump, or strafe before the swing lands.
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const pose = mesh.userData.pose as string | undefined;
        if (pose === "hit") {
          mat.emissive.setHex(0xff2222);
          mat.emissiveIntensity = 1;
        } else if (pose === "windup") {
          mat.emissive.setHex(0xff6a00);
          mat.emissiveIntensity = 0.55 + 0.45 * Math.sin(performance.now() / 90);
        } else {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 1;
        }
      }
      // Follow cam: hover over the agent, looking down at it.
      if (followRef.current) {
        for (const [, mesh] of meshes.current) {
          if (mesh.userData.kind === "agent") {
            desired.set(mesh.position.x, mesh.position.y + 9, mesh.position.z + 13);
            camera.position.lerp(desired, 0.07);
            camera.lookAt(mesh.position.x, mesh.position.y + 1, mesh.position.z);
            break;
          }
        }
      }
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    // Expose scene handles for the snapshot effect below.
    (mount as unknown as { __scene: THREE.Scene }).__scene = scene;

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // Sync snapshot entities -> meshes.
  useEffect(() => {
    const mount = mountRef.current;
    const scene = mount && (mount as unknown as { __scene?: THREE.Scene }).__scene;
    if (!scene || !snapshot) return;
    const seen = new Set<string>();
    for (const e of snapshot.entities) {
      seen.add(e.id);
      let mesh = meshes.current.get(e.id);
      if (!mesh) {
        const isStructure = e.kind === "structure";
        const geo =
          e.kind === "agent"
            ? new THREE.CapsuleGeometry(0.5, 1.1, 6, 14)
            : isStructure
              ? new THREE.CylinderGeometry(0.9, 1.15, 3.2, 8)
              : new THREE.OctahedronGeometry(0.7);
        mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: isStructure
              ? 0x22d3ee
              : e.kind === "virus"
                ? (SPECIES_COLORS[e.name] ?? ELEMENT_COLORS[e.element] ?? 0x8899aa)
                : (ELEMENT_COLORS[e.element] ?? 0x8899aa),
            roughness: 0.35,
            metalness: 0.6,
          }),
        );
        // Site nodes are 3.2-tall pillars standing on the ground.
        mesh.position.set(e.position.x, (isStructure ? 1.6 : 1) + e.position.y, e.position.z);
        // Floating HP bar — a sprite that always faces the camera. Redrawn
        // only when the hp fraction actually changes, so it costs nothing
        // at rest.
        const barCanvas = document.createElement("canvas");
        barCanvas.width = 64;
        barCanvas.height = 8;
        const barTex = new THREE.CanvasTexture(barCanvas);
        const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false });
        const bar = new THREE.Sprite(barMat);
        bar.scale.set(isStructure ? 2.4 : 1.7, 0.21, 1);
        bar.position.y = isStructure ? 2.3 : 1.7;
        mesh.add(bar);
        mesh.userData.bar = { canvas: barCanvas, tex: barTex, mat: barMat, last: -1 };
        scene.add(mesh);
        meshes.current.set(e.id, mesh);
      }
      mesh.userData.target = new THREE.Vector3(
        e.position.x,
        (e.kind === "structure" ? 1.6 : 1) + e.position.y,
        e.position.z,
      );
      mesh.userData.pose = e.pose;
      mesh.userData.kind = e.kind;
      const s = e.hp / e.maxHp;
      mesh.scale.setScalar(0.6 + 0.4 * Math.max(0.05, s));
      const barState = mesh.userData.bar as
        | { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; last: number }
        | undefined;
      if (barState && Math.abs(s - barState.last) > 0.001) {
        barState.last = s;
        const ctx = barState.canvas.getContext("2d")!;
        ctx.clearRect(0, 0, 64, 8);
        ctx.fillStyle = "rgba(2,6,16,0.6)";
        ctx.fillRect(0, 0, 64, 8);
        ctx.fillStyle = s > 0.5 ? "#3dff7a" : s > 0.25 ? "#ffd23d" : "#ff4444";
        ctx.fillRect(1, 1, 62 * Math.max(0, s), 6);
        barState.tex.needsUpdate = true;
      }
    }
    for (const [id, mesh] of meshes.current) {
      if (!seen.has(id)) {
        const barState = mesh.userData.bar as
          | { tex: THREE.CanvasTexture; mat: THREE.SpriteMaterial }
          | undefined;
        barState?.tex.dispose();
        barState?.mat.dispose();
        scene.remove(mesh);
        meshes.current.delete(id);
      }
    }
  }, [snapshot]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}

/** HUD — the operator's verb set: command, slot scripts, chat, vitals. */
function Hud({
  sessionId,
  followCam,
  onToggleFollow,
}: {
  sessionId: Id<"sessions">;
  followCam: boolean;
  onToggleFollow: () => void;
}) {
  const sendIntent = useMutation(api.session.sendIntent);
  const snapshot = useQuery(api.session.snapshot, { sessionId });
  const [command, setCommand] = useState("");
  const [chat, setChat] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [snapshot?.events.length]);

  const send = (type: "command" | "slot_script" | "suggest_destination" | "chat", payload: object) =>
    sendIntent({ sessionId, type, payload });

  const events = (snapshot?.events ?? []) as BrainEvent[];

  const prettyId = (id: string) =>
    id.startsWith("agent-")
      ? "Agent"
      : id.startsWith("virus-")
        ? `Virus ${id.slice(6)}`
        : id.startsWith("site-")
          ? id.slice(5).charAt(0).toUpperCase() + id.slice(6)
          : id;

  const renderEvent = (e: BrainEvent, i: number) => {
    switch (e.type) {
      case "dialogue":
        if (e.speaker === "OPERATOR") {
          return (
            <div key={i} style={{ color: "#8ad8ff" }}>
              <b>You:</b> {e.text}
            </div>
          );
        }
        return (
          <div key={i}>
            <b>{e.speaker}:</b> {e.text}
          </div>
        );
      case "script_fired":
        return (
          <div key={i} style={{ color: "#ffd76a" }}>
            ⚡ <b>{prettyId(e.byId)}</b> fired <b>{e.scriptId}</b>
          </div>
        );
      case "hit":
        return (
          <div key={i} style={{ color: "#ff8a8a" }}>
            💥 {prettyId(e.attackerId)} → {prettyId(e.targetId)} · {e.damage}
          </div>
        );
      case "down":
        return (
          <div key={i} style={{ color: "#b0b0b0" }}>
            ☠ {prettyId(e.fighterId)} deleted
          </div>
        );
      case "bond_changed":
        return (
          <div key={i} style={{ color: "#8ad8ff" }}>
            💠 Bond rising — {e.tier} ({e.xp} xp)
          </div>
        );
      case "digest":
        return (
          <div key={i} style={{ fontStyle: "italic", opacity: 0.8 }}>
            {e.text}
          </div>
        );
      default:
        return null; // synchro/energy already have their own bars
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 12, gap: 8 }}>
      <div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>SYNCHRO</div>
        <div style={{ background: "#122", height: 8, borderRadius: 4 }}>
          <div
            style={{
              width: `${snapshot?.synchro ?? 50}%`,
              height: "100%",
              background: "#4df",
              borderRadius: 4,
              transition: "width .3s",
            }}
          />
        </div>
      </div>

      <div ref={feedRef} style={{ flex: 1, overflowY: "auto", fontSize: 13, lineHeight: 1.5 }}>
        {events.map(renderEvent)}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {["Flank left", "Focus weakest", "Fall back", "Hold"].map((c) => (
          <button key={c} onClick={() => send("command", { text: c })}>
            {c}
          </button>
        ))}
        {["cinder-slash", "aegis-wall", "overclock"].map((s) => (
          <button key={s} onClick={() => send("slot_script", { scriptId: s })}>
            ⚡ {s}
          </button>
        ))}
        <button
          onClick={() => send("command", { text: "next wave" })}
          style={{ borderColor: "#7dff9a", color: "#7dff9a" }}
        >
          ▸ Next wave
        </button>
        <button
          onClick={onToggleFollow}
          style={
            followCam
              ? { borderColor: "#8ad8ff", color: "#8ad8ff" }
              : { opacity: 0.5 }
          }
          title="Lock the camera over your agent"
        >
          🎥 {followCam ? "Following" : "Free cam"}
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim()) send("command", { text: command });
          setCommand("");
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Command your agent…"
          style={{ flex: 1 }}
        />
        <button type="submit">Send</button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (chat.trim()) send("chat", { text: chat });
          setChat("");
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          placeholder="Chat…"
          style={{ flex: 1 }}
        />
        <button type="submit">Chat</button>
      </form>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 32,
  fontFamily: "monospace",
  color: "#cfe3ff",
  background: "#05070f",
  minHeight: "100vh",
  boxSizing: "border-box",
};

/**
 * Session discovery. The director owns the dive; the client just finds it.
 * - director running  -> subscribe to its live session
 * - nothing diving    -> say so, instead of rendering an empty void
 */
/**
 * The compile flow: identity -> temperament -> (chassis: deferred) -> wake.
 * One agent per profile (V1): when `existing` is set, the flow opens on a
 * confirmation step — recompiling retires the old agent, it never deletes.
 */
function CompileScreen({
  existing,
  onDone,
  onCancel,
  onAdoptId,
}: {
  existing: AgentDoc | null;
  onDone: (agentId: string) => void;
  onCancel?: () => void;
  onAdoptId: (agentId: string) => void;
}) {
  const [step, setStep] = useState<"confirm" | "identity" | "temperament" | "wake" | "done">(
    existing ? "confirm" : "identity",
  );
  const [name, setName] = useState("");
  const [ext, setExt] = useState<"PY" | "SH" | "MD">("PY");
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [wakeAnswer, setWakeAnswer] = useState("");
  const [pasteId, setPasteId] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [copied, setCopied] = useState(false);

  const compileAgent = useMutation(agentsCompile);
  const decommission = useMutation(agentsDecommission);
  const appendMemory = useMutation(api.agents.appendMemory);
  const profile = useQuery(
    api.agents.get,
    agentId ? { agentId: agentId as Id<"agents"> } : "skip",
  ) as unknown as AgentDoc | null | undefined;
  const wakeLines = profile
    ? wakeIntro({ name: profile.name, ext: profile.ext, traits: profile.traits ?? [] })
    : null;

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg.replace(/^.*Error:\s*/, "").slice(0, 280));
  };

  const nextFromIdentity = () => {
    const check = CompileInput.shape.name.safeParse(name);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "That name won't compile.");
      return;
    }
    setError(null);
    setStep("temperament");
  };

  const submitTemperament = async () => {
    setError(null);
    setBusy(true);
    try {
      const id = await compileAgent({ name: name.trim(), ext, answers });
      if (existing) await decommission({ agentId: existing._id });
      setAgentId(id);
      setStep("wake");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const finishWake = async (withAnswer: boolean) => {
    if (agentId && withAnswer && wakeAnswer.trim()) {
      try {
        await appendMemory({
          agentId: agentId as Id<"agents">,
          kind: "preference",
          text: `Wake question — "${WAKE_QUESTION}" The operator answered: "${wakeAnswer.trim().slice(0, 280)}"`,
        });
      } catch {
        // Memory is a nicety; the agent exists regardless.
      }
    }
    if (agentId) setStep("done");
  };

  const copyAgentId = async () => {
    if (!agentId) return;
    try {
      await navigator.clipboard.writeText(agentId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (non-secure context) — the id stays visible to copy by hand.
    }
  };

  if (step === "confirm" && existing) {
    return (
      <div style={panelStyle}>
        <h2>COMPILE A NEW AGENT?</h2>
        <p>
          You already have{" "}
          <b>
            {existing.name}.{existing.ext}
          </b>{" "}
          (bond: {existing.bondTier}). Compiling a new agent <b>retires</b> them — their
          memories stay on record, but they won't dive again.
        </p>
        <p>No permanent build choice is made without confirmation — this is yours.</p>
        <button onClick={() => setStep("identity")} style={btnPrimary}>
          Compile a new agent
        </button>
        {onCancel && (
          <button onClick={onCancel} style={btnGhost}>
            Keep {existing.name}
          </button>
        )}
        {error && <p style={errStyle}>{error}</p>}
      </div>
    );
  }

  if (step === "temperament") {
    return (
      <div style={panelStyle}>
        <h2>TEMPERAMENT</h2>
        <p>Three questions. Answer honestly — this shapes who they are.</p>
        {TEMPERAMENT_QUESTIONS.map((q, qi) => (
          <div key={q.id} style={{ margin: "16px 0" }}>
            <p>
              <b>
                {qi + 1}. {q.prompt}
              </b>
            </p>
            <div>
              {q.choices.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setAnswers((a) => a.map((v, i) => (i === qi ? c.id : v)))}
                  style={answers[qi] === c.id ? btnPrimary : btnGhost}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {error && <p style={errStyle}>{error}</p>}
        <button
          onClick={submitTemperament}
          disabled={busy || answers.some((a) => !a)}
          style={btnPrimary}
        >
          {busy ? "Compiling…" : "Compile"}
        </button>
        {/* CHASSIS STEP (deferred): when the Chassis system ships, its picker
            renders here — between temperament and wake — per
            COMPILE_FLOW_STEPS in @agent-game/shared. Not built in V1. */}
      </div>
    );
  }

  if (step === "wake" && agentId) {
    return (
      <div style={panelStyle}>
        <h2>{profile ? `${profile.name}.${profile.ext} IS AWAKE` : "WAKING UP…"}</h2>
        {!wakeLines && <p>Contacting cyberspace…</p>}
        {wakeLines && profile && (
          <>
            {wakeLines.slice(0, 3).map((line, i) => (
              <p key={i}>
                <b>{profile.name}:</b> {line}
              </p>
            ))}
            <p style={{ fontStyle: "italic", marginTop: 16 }}>
              <b>{profile.name}:</b> {wakeLines[3]}
            </p>
            <input
              value={wakeAnswer}
              onChange={(e) => setWakeAnswer(e.target.value)}
              placeholder="One thing to remember…"
              maxLength={280}
              style={inputStyle}
            />
            <div style={{ marginTop: 8 }}>
              <button onClick={() => finishWake(true)} style={btnPrimary}>
                Answer & continue
              </button>
              <button onClick={() => finishWake(false)} style={btnGhost}>
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // done — the "dive your agent" panel. The compile flow used to drop the
  // operator straight back at the deck with no hint that the director only
  // dives the agent in its AGENT_ID, which stranded people in a
  // Find dive -> NO ACTIVE DIVE loop. This panel closes that gap.
  if (step === "done" && agentId) {
    return (
      <div style={panelStyle}>
        <h2>{profile ? `${profile.name}.${profile.ext} IS READY` : "AGENT COMPILED"}</h2>
        <p>
          One last step, operator: the director only dives the agent whose id is in its{" "}
          <code style={codeStyle}>AGENT_ID</code>. Point it at your new agent:
        </p>
        <ol>
          <li>
            In <code style={codeStyle}>packages/director/.env</code>, set{" "}
            <code style={codeStyle}>AGENT_ID={agentId}</code>
          </li>
          <li>
            Run <code style={codeStyle}>pnpm --filter @agent-game/director dev</code>
          </li>
          <li>Come back here and hit Find dive.</li>
        </ol>
        <p style={{ marginTop: 16 }}>Agent id — click to copy:</p>
        <p>
          <code
            onClick={copyAgentId}
            title="Click to copy"
            style={{ ...codeStyle, cursor: "pointer", wordBreak: "break-all" }}
          >
            {agentId}
          </code>{" "}
          <button onClick={copyAgentId} style={btnGhost}>
            {copied ? "Copied!" : "Copy id"}
          </button>
        </p>
        <div style={{ marginTop: 16 }}>
          <button onClick={() => onDone(agentId)} style={btnPrimary}>
            Continue to deck
          </button>
        </div>
      </div>
    );
  }

  // identity (the default step)
  return (
    <div style={panelStyle}>
      <h2>COMPILE YOUR AGENT</h2>
      <p>Name them. In Navi culture, being named is what makes you real.</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Nova"
        maxLength={24}
        style={inputStyle}
      />
      <p style={{ marginTop: 16 }}>Soul extension — flavor only, for now:</p>
      <div>
        {(["PY", "SH", "MD"] as const).map((e) => (
          <button key={e} onClick={() => setExt(e)} style={ext === e ? btnPrimary : btnGhost}>
            .{e}
          </button>
        ))}
      </div>
      {error && <p style={errStyle}>{error}</p>}
      <div style={{ marginTop: 8 }}>
        <button onClick={nextFromIdentity} style={btnPrimary}>
          Next
        </button>
      </div>
      {!showPaste ? (
        <p style={{ marginTop: 24, opacity: 0.7 }}>
          <button onClick={() => setShowPaste(true)} style={linkBtn}>
            Already compiled? Paste your agent id
          </button>
        </p>
      ) : (
        <p style={{ marginTop: 24 }}>
          <input
            value={pasteId}
            onChange={(e) => setPasteId(e.target.value)}
            placeholder="agent id"
            style={inputStyle}
          />
          <button onClick={() => pasteId.trim() && onAdoptId(pasteId.trim())} style={btnGhost}>
            Use this agent
          </button>
        </p>
      )}
    </div>
  );
}

function DiveConsole({
  diveId,
  agent,
  onReset,
}: {
  diveId: string;
  agent: AgentDoc | null | undefined;
  onReset: () => void;
}) {
  const result = useQuery(api.session.findDive, { id: diveId });

  if (result === undefined) {
    return (
      <div style={panelStyle}>
        <h2>DIVE CONSOLE</h2>
        <p>Contacting cyberspace…</p>
      </div>
    );
  }

  if (result.error) {
    return (
      <div style={panelStyle}>
        <h2>CAN'T FIND THAT DIVE</h2>
        <p>{result.error}</p>
        <button onClick={onReset}>Try another id</button>
      </div>
    );
  }

  if (result.sessionId === null) {
    // Name the agent we're waiting for — the pre-x-divehint screen never said
    // WHOSE dive it was waiting on, which made the AGENT_ID mismatch invisible.
    const who = agent ? `${agent.name}.${agent.ext}` : "this agent";
    return (
      <div style={panelStyle}>
        <h2>NO ACTIVE DIVE</h2>
        <p>
          Waiting for a dive for <b>{who}</b> (<code style={codeStyle}>…{diveId.slice(-4)}</code>).
        </p>
        <p>
          The director — the brain's heartbeat — needs{" "}
          <code style={codeStyle}>AGENT_ID={diveId}</code> in{" "}
          <code style={codeStyle}>packages/director/.env</code> and to be running:
        </p>
        <p>
          <code style={codeStyle}>pnpm --filter @agent-game/director dev</code>
        </p>
        <p>Start it and this screen will connect on its own. Either boot order works.</p>
        <button onClick={onReset}>Try another id</button>
      </div>
    );
  }

  return <DiveScreen key={result.sessionId} sessionId={result.sessionId} />;
}

/** Wave banner — a big cinematic title card when a wave starts or clears.
 * Keys off the wave dialogue events, so no backend changes were needed. */
function WaveBanner({ events }: { events: BrainEvent[] }) {
  const [banner, setBanner] = useState<string | null>(null);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "dialogue" || typeof e.text !== "string") continue;
      const start = /wave (\d+) incoming/i.exec(e.text);
      const clear = /wave (\d+) cleared/i.exec(e.text);
      const m = start ?? clear;
      if (m) {
        const key = `${m[1]}:${start ? "start" : "clear"}:${i}`;
        if (lastKey.current !== key) {
          lastKey.current = key;
          setBanner(start ? `WAVE ${m[1]}` : `WAVE ${m[1]} CLEARED`);
          const t = setTimeout(() => setBanner(null), 2600);
          return () => clearTimeout(t);
        }
        break;
      }
    }
  }, [events]);
  if (!banner) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize: 64,
          fontWeight: "bold",
          letterSpacing: 12,
          color: "#cfe3ff",
          textShadow: "0 0 24px #3399ff, 0 0 60px #3399ff88",
          animation: "wavebanner 2.6s ease-out forwards",
        }}
      >
        {banner}
      </div>
      <style>{`@keyframes wavebanner { 0% { opacity: 0; transform: scale(1.25); } 12% { opacity: 1; transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: scale(0.98); } }`}</style>
    </div>
  );
}

/** Unison banner — full-screen flash + title card when the finisher fires.
 * Keys off the UNISON! dialogue event, the same trick as the wave banners. */
function UnisonBanner({ events }: { events: BrainEvent[] }) {
  const [show, setShow] = useState(false);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== "dialogue" || typeof e.text !== "string") continue;
      if (/UNISON!/.test(e.text)) {
        const key = `unison:${i}`;
        if (lastKey.current !== key) {
          lastKey.current = key;
          setShow(true);
          const t = setTimeout(() => setShow(false), 1800);
          return () => clearTimeout(t);
        }
        break;
      }
    }
  }, [events]);
  if (!show) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        animation: "unisonflashbg 1.8s ease-out forwards",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: "bold",
            letterSpacing: 16,
            color: "#fff7d6",
            textShadow: "0 0 30px #ffcc33, 0 0 80px #ff9900",
            animation: "unisonzoom 1.8s ease-out forwards",
          }}
        >
          UNISON!
        </div>
      </div>
      <style>{`@keyframes unisonflashbg { 0% { opacity: 0; background: radial-gradient(ellipse at center, #ffcc3344 0%, transparent 70%); } 12% { opacity: 1; } 100% { opacity: 0; } } @keyframes unisonzoom { 0% { opacity: 0; transform: scale(1.4); } 12% { opacity: 1; transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: scale(0.97); } }`}</style>
    </div>
  );
}

function DiveScreen({ sessionId }: { sessionId: Id<"sessions"> }) {  const snapshot = useQuery(api.session.snapshot, { sessionId });
  const [followCam, setFollowCam] = useState(true);

  if (snapshot && snapshot.status !== "active") {
    return (
      <div style={panelStyle}>
        <h2>{snapshot.status === "resting" ? "AGENT RESTING" : "DIVE ENDED"}</h2>
        <p>
          {snapshot.status === "resting"
            ? "Your agent is recharging. Restart the director to dive again."
            : "This dive is over. Restart the director to open a new session."}
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#05070f",
        color: "#cfe3ff",
        fontFamily: "monospace",
      }}
    >
      <div style={{ flex: 3, position: "relative" }}>
        <DiveView sessionId={sessionId} followCam={followCam} />
        <WaveBanner events={(snapshot?.events ?? []) as BrainEvent[]} />
        <UnisonBanner events={(snapshot?.events ?? []) as BrainEvent[]} />
      </div>
      <div style={{ flex: 1, borderLeft: "1px solid #1a3a5c", minWidth: 300 }}>
        <Hud
          sessionId={sessionId}
          followCam={followCam}
          onToggleFollow={() => setFollowCam((f) => !f)}
        />
      </div>
    </div>
  );
}

function App() {
  const [agentId, setAgentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(AGENT_ID_KEY);
    } catch {
      return null;
    }
  });
  const [screen, setScreen] = useState<"start" | "compile" | "dive">("start");
  const [diveId, setDiveId] = useState<string | null>(null);

  const stored = useQuery(
    api.agents.get,
    agentId ? { agentId: agentId as Id<"agents"> } : "skip",
  ) as unknown as AgentDoc | null | undefined;

  const adopt = (id: string) => {
    try {
      localStorage.setItem(AGENT_ID_KEY, id);
    } catch {
      // Private mode — the id just won't persist.
    }
    setAgentId(id);
  };
  const forget = () => {
    try {
      localStorage.removeItem(AGENT_ID_KEY);
    } catch {
      // ignore
    }
    setAgentId(null);
  };

  if (screen === "dive" && diveId) {
    return (
      <DiveConsole
        diveId={diveId}
        agent={stored}
        onReset={() => {
          setDiveId(null);
          setScreen("start");
        }}
      />
    );
  }

  if (screen === "compile") {
    if (agentId && stored === undefined) {
      return (
        <div style={panelStyle}>
          <h2>DIVE CONSOLE</h2>
          <p>Contacting cyberspace…</p>
        </div>
      );
    }
    return (
      <CompileScreen
        existing={stored && !stored.retired ? stored : null}
        onDone={(id) => {
          adopt(id);
          setScreen("start");
        }}
        onCancel={() => setScreen("start")}
        onAdoptId={(id) => {
          adopt(id);
          setScreen("start");
        }}
      />
    );
  }

  // start screen
  if (!agentId) {
    return (
      <CompileScreen
        existing={null}
        onDone={(id) => {
          adopt(id);
          setScreen("start");
        }}
        onAdoptId={(id) => {
          adopt(id);
          setScreen("start");
        }}
      />
    );
  }

  if (stored === undefined) {
    return (
      <div style={panelStyle}>
        <h2>DIVE CONSOLE</h2>
        <p>Contacting cyberspace…</p>
      </div>
    );
  }

  if (stored === null || stored.retired) {
    // Stored id points at nothing (or a retired agent) — back to compile.
    return (
      <CompileScreen
        existing={null}
        onDone={(id) => {
          adopt(id);
          setScreen("start");
        }}
        onAdoptId={(id) => {
          adopt(id);
          setScreen("start");
        }}
      />
    );
  }

  return (
    <div style={panelStyle}>
      <h2>DIVE CONSOLE</h2>
      <p>
        Operator of{" "}
        <b>
          {stored.name}.{stored.ext}
        </b>{" "}
        — bond: {stored.bondTier}.
      </p>
      <button
        onClick={() => {
          setDiveId(agentId);
          setScreen("dive");
        }}
        style={btnPrimary}
      >
        Find dive
      </button>
      <button onClick={() => setScreen("compile")} style={btnGhost}>
        Compile a new agent
      </button>
      <p style={{ marginTop: 16, opacity: 0.7 }}>
        <button onClick={forget} style={linkBtn}>
          Forget this agent
        </button>
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
