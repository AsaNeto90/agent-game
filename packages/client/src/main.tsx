import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

const ELEMENT_COLORS: Record<string, number> = {
  fire: 0xff5533,
  aqua: 0x3399ff,
  elec: 0xffdd33,
  wood: 0x44cc66,
  null: 0x8899aa,
};

/**
 * DiveView — the 3D UX layer. It renders; it never thinks.
 * Subscribes to the Convex snapshot (4Hz semantic state) and interpolates
 * to 60fps. Poses drive simple procedural animation.
 */
function DiveView({ sessionId }: { sessionId: Id<"sessions"> }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const snapshot = useQuery(api.session.snapshot, { sessionId });
  const meshes = useRef(new Map<string, THREE.Mesh>());

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
    const animate = () => {
      raf = requestAnimationFrame(animate);
      // Interpolate every mesh toward its latest snapshot position.
      for (const [, mesh] of meshes.current) {
        const target = (mesh.userData.target as THREE.Vector3 | undefined);
        if (target) mesh.position.lerp(target, 0.18);
        // Pose flavor: bob while running, flash on hit.
        if (mesh.userData.pose === "hit") {
          (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0xff2222);
        } else {
          (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
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
            color: ELEMENT_COLORS[e.element] ?? 0x8899aa,
            roughness: 0.35,
            metalness: 0.6,
          }),
        );
        mesh.position.set(e.position.x, 1, e.position.z);
        scene.add(mesh);
        meshes.current.set(e.id, mesh);
      }
      mesh.userData.target = new THREE.Vector3(e.position.x, 1, e.position.z);
      mesh.userData.pose = e.pose;
      const s = e.hp / e.maxHp;
      mesh.scale.setScalar(0.6 + 0.4 * Math.max(0.05, s));
    }
    for (const [id, mesh] of meshes.current) {
      if (!seen.has(id)) {
        scene.remove(mesh);
        meshes.current.delete(id);
      }
    }
  }, [snapshot]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}

/** HUD — the operator's verb set: command, slot scripts, chat, vitals. */
function Hud({ sessionId }: { sessionId: Id<"sessions"> }) {
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

  const dialogues = (snapshot?.events ?? []).filter((e) => (e as { type: string }).type === "dialogue");

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
        {dialogues.map((d, i) => {
          const e = d as { speaker: string; text: string };
          return (
            <div key={i}>
              <b>{e.speaker}:</b> {e.text}
            </div>
          );
        })}
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

function App() {
  const [agentId, setAgentId] = useState("");
  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(null);
  const startDive = useMutation(api.session.start);

  if (!sessionId) {
    return (
      <div style={{ padding: 32, fontFamily: "monospace" }}>
        <h2>DIVE CONSOLE</h2>
        <p>Paste an agent id (compile one first: <code>npx convex run agents:compile</code>), then dive.</p>
        <input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="agent id"
          style={{ width: 320 }}
        />
        <button
          onClick={async () => {
            const id = await startDive({ agentId: agentId as Id<"agents">, zoneId: "tide-district" });
            setSessionId(id);
          }}
        >
          Dive into cyberspace
        </button>
      </div>
    );
  }

  return (
    <ConvexProvider client={convex}>
      <div style={{ display: "flex", height: "100vh", background: "#05070f", color: "#cfe3ff", fontFamily: "monospace" }}>
        <div style={{ flex: 3 }}>
          <DiveView sessionId={sessionId} />
        </div>
        <div style={{ flex: 1, borderLeft: "1px solid #1a3a5c", minWidth: 300 }}>
          <Hud sessionId={sessionId} />
        </div>
      </div>
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
