import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type { BrainEvent } from "@agent-game/shared";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

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
        const geo =
          e.kind === "agent"
            ? new THREE.CapsuleGeometry(0.5, 1.1, 6, 14)
            : new THREE.OctahedronGeometry(0.7);
        mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color:
              e.kind === "virus"
                ? (SPECIES_COLORS[e.name] ?? ELEMENT_COLORS[e.element] ?? 0x8899aa)
                : (ELEMENT_COLORS[e.element] ?? 0x8899aa),
            roughness: 0.35,
            metalness: 0.6,
          }),
        );
        mesh.position.set(e.position.x, 1 + e.position.y, e.position.z);
        // Floating HP bar — a sprite that always faces the camera. Redrawn
        // only when the hp fraction actually changes, so it costs nothing
        // at rest.
        const barCanvas = document.createElement("canvas");
        barCanvas.width = 64;
        barCanvas.height = 8;
        const barTex = new THREE.CanvasTexture(barCanvas);
        const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false });
        const bar = new THREE.Sprite(barMat);
        bar.scale.set(1.7, 0.21, 1);
        bar.position.y = 1.7;
        mesh.add(bar);
        mesh.userData.bar = { canvas: barCanvas, tex: barTex, mat: barMat, last: -1 };
        scene.add(mesh);
        meshes.current.set(e.id, mesh);
      }
      mesh.userData.target = new THREE.Vector3(e.position.x, 1 + e.position.y, e.position.z);
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
    id.startsWith("agent-") ? "Agent" : id.startsWith("virus-") ? `Virus ${id.slice(6)}` : id;

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
function DiveConsole({ diveId, onReset }: { diveId: string; onReset: () => void }) {
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
    return (
      <div style={panelStyle}>
        <h2>NO ACTIVE DIVE</h2>
        <p>This agent isn't diving right now. The director — the brain's heartbeat — needs to be running:</p>
        <p>
          <code style={{ background: "#122", padding: "4px 8px" }}>
            pnpm --filter @agent-game/director dev
          </code>
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

function DiveScreen({ sessionId }: { sessionId: Id<"sessions"> }) {
  const snapshot = useQuery(api.session.snapshot, { sessionId });
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
  const [input, setInput] = useState("");
  const [diveId, setDiveId] = useState<string | null>(null);

  if (!diveId) {
    return (
      <div style={panelStyle}>
        <h2>DIVE CONSOLE</h2>
        <p>
          Paste an agent id (compile one first:{" "}
          <code>{`npx convex run agents:compile '{"name":"AstroMan","ext":"PY"}'`}</code>
          ) or the session id the director prints, then dive.
        </p>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="agent id or session id"
          style={{ width: 320, marginRight: 8 }}
        />
        <button onClick={() => input.trim() && setDiveId(input.trim())}>
          Find dive
        </button>
      </div>
    );
  }

  return <DiveConsole diveId={diveId} onReset={() => setDiveId(null)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
