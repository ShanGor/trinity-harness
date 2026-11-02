import { subscribeResponseSpeech } from './response-speech-events';
import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from './chat-items';
import './x-du-companion.css';

export type CompanionState =
  'idle' | 'thinking' | 'working' | 'approval' | 'listening' | 'speaking';
type State = CompanionState;
export function companionState(
  items: ChatItem[],
  busy: boolean,
  approval: boolean,
  voice: string,
  muted: boolean,
): State {
  if (approval) return 'approval';
  if (voice === 'speaking') return 'speaking';
  if (voice === 'listening' && !muted) return 'listening';
  if (!busy) return 'idle';
  const last = items[items.length - 1];
  if (
    last?.role === 'assistant' &&
    last.tools.some((tool) => tool.status === 'in_progress' || tool.status === 'pending')
  )
    return 'working';
  return 'thinking';
}
const labels: Record<State, string> = {
  idle: '待命',
  thinking: '思考中',
  working: '工作中',
  approval: '等待你的确认',
  listening: '正在听',
  speaking: '正在说话',
};
type Robot = {
  play(name: string): Promise<unknown>;
  stop(): void;
  setSpeaking(value: boolean): void;
};
export function XDuCompanion({
  state,
  sessionId,
  embedded = false,
}: {
  state: State;
  sessionId: string | null;
  embedded?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(() => localStorage.getItem('trinity-xdu-open') === 'true');
  const [failed, setFailed] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const robot = useRef<Robot | null>(null);
  const generation = useRef(0);
  const responseSpeaking = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const apply = (r: Robot, s: State): void => {
    r.setSpeaking(false);
    r.stop();
    if (s === 'speaking') r.setSpeaking(true);
    else if (s === 'thinking' || s === 'listening') void r.play(s);
    else if (s === 'working') void r.play('magic');
  };
  useEffect(() => {
    localStorage.setItem('trinity-xdu-open', String(open));
  }, [open]);
  useEffect(() => {
    generation.current++;
    if (robot.current)
      apply(robot.current, responseSpeaking.current && state !== 'approval' ? 'speaking' : state);
  }, [state, sessionId]);
  useEffect(() => {
    responseSpeaking.current = false;
    return subscribeResponseSpeech((event) => {
      if (event.sessionId !== sessionId) return;
      responseSpeaking.current = event.phase === 'playing';
      const r = robot.current;
      if (!r) return;
      generation.current++;
      if (event.phase === 'playing' && latest.current !== 'approval') {
        apply(r, 'speaking');
      } else if (event.phase === 'ended' && latest.current === 'idle') {
        r.setSpeaking(false);
        r.stop();
        void r.play('celebrate');
      } else {
        apply(r, latest.current);
      }
    });
  }, [sessionId]);
  useEffect(() => {
    if ((!open && !embedded) || !host.current) return;
    let disposed = false;
    let cleanup = (): void => {};
    setFailed(false);
    void (async () => {
      const [THREE, { GLTFLoader }, { RobotController }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('./x-du/robot-controller.js'),
      ]);
      const model = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/mimo.glb`);
      if (disposed || !host.current) {
        model.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
          }
        });
        return;
      }
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      host.current.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      // A soft studio reflection gives the metal shell and black visor their shape.
      const width = 64,
        height = 32;
      const pixels = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const u = x / width,
            v = y / height,
            i = (y * width + x) * 4;
          const key = Math.exp(-((u - 0.28) ** 2 + (v - 0.3) ** 2) / 0.006) * 3.8;
          const fill = Math.exp(-((u - 0.72) ** 2 + (v - 0.43) ** 2) / 0.015) * 1.4;
          const base = 0.16 + 0.16 * (1 - v);
          pixels[i] = base + key + fill * 0.65;
          pixels[i + 1] = base + key * 0.96 + fill * 0.86;
          pixels[i + 2] = base + key * 0.88 + fill;
          pixels[i + 3] = 1;
        }
      }
      const environment = new THREE.DataTexture(
        pixels,
        width,
        height,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      environment.mapping = THREE.EquirectangularReflectionMapping;
      environment.needsUpdate = true;
      scene.environment = environment;
      const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
      const container = host.current;
      const resize = (): void => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      resize();
      camera.position.set(1.25, 1.15, 3.4);
      camera.lookAt(0, 0.75, 0);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x7b8d89, 0.8));
      const light = new THREE.DirectionalLight(0xf7f8f6, 1.8);
      light.position.set(2.4, 4, 3);
      const fillLight = new THREE.DirectionalLight(0xe6edf0, 0.78);
      fillLight.position.set(-3, 2, -2);
      scene.add(light, fillLight);
      model.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          if (material.name === '小杜 · 青绿发光表情') {
            material.color.set('#35d9b4');
            material.emissive.set('#35f2c3');
            material.emissiveIntensity = 0.85;
            material.toneMapped = false;
          } else if (material.name === '小杜 · 青绿发光细节') {
            material.color.set('#20d9ae');
            material.emissive.set('#28ffc0');
            material.emissiveIntensity = 1.15;
            material.toneMapped = false;
          }
        }
      });
      const r = new RobotController(model.scene);
      robot.current = r;
      scene.add(r.object);
      apply(
        r,
        responseSpeaking.current && latest.current !== 'approval' ? 'speaking' : latest.current,
      );
      const clock = new THREE.Clock();
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      renderer.setAnimationLoop(() => {
        if (document.hidden) {
          clock.getDelta();
          return;
        }
        if (!reduced.matches) r.update(clock.getDelta());
        renderer.render(scene, camera);
      });
      cleanup = () => {
        observer.disconnect();
        renderer.setAnimationLoop(null);
        robot.current = null;
        r.dispose();
        model.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
          }
        });
        environment.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [open, embedded]);
  const play = (action: string): void => {
    const r = robot.current;
    if (!r || state === 'approval' || state === 'speaking' || responseSpeaking.current) return;
    const current = ++generation.current;
    r.stop();
    void r.play(action).then(() => {
      if (robot.current === r && generation.current === current) apply(r, latest.current);
    });
  };
  if (embedded) {
    return (
      <div className="xdu-embedded" aria-label="小杜伙伴">
        <div ref={host} className="xdu-canvas" aria-hidden="true" />
        {failed && <p>角色暂时不可用</p>}
      </div>
    );
  }
  return (
    <aside className="xdu" aria-label="小杜伙伴">
      {open ? (
        <>
          <div className="xdu-head">
            <span aria-live="polite">{labels[state]}</span>
            <button onClick={() => setOpen(false)}>收起</button>
          </div>
          <div ref={host} className="xdu-canvas" aria-hidden="true" />
          {failed && <p>角色暂时不可用</p>}
          <div className="xdu-actions">
            <button onClick={() => play('greet')}>打招呼</button>
            <button onClick={() => play('highFive')}>击掌</button>
            <button onClick={() => play('magic')}>变魔术</button>
          </div>
        </>
      ) : (
        <button onClick={() => setOpen(true)}>打开小杜</button>
      )}
    </aside>
  );
}
