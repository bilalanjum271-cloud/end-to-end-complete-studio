'use client';
import Link from 'next/link';
import { ArrowLeft, Download, Glasses, Smartphone, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Button, Input, Select, StatusBadge, useToast } from '@xen-studio/ui';
import { useI18n } from '@/components/i18n-provider';
import type { XrAsset, XrNode, XrScene, XrSceneDoc } from './types';

const ENV: Record<XrSceneDoc['environment'], { bg: number; ground: number; light: number }> = {
  studio: { bg: 0x16191e, ground: 0x23272e, light: 1.2 }, outdoor: { bg: 0x9ec9e8, ground: 0x6b8f5a, light: 1.6 },
  night: { bg: 0x05070d, ground: 0x111522, light: 0.5 }, passthrough: { bg: 0x000000, ground: 0x1e2228, light: 1.2 },
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const deg = (r: number) => Math.round((r * 180) / Math.PI);

export function SceneEditor({ scene, assets }: { scene: XrScene; assets: XrAsset[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const mount = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<XrSceneDoc>(scene.scene);
  const [selected, setSelected] = useState<string | null>(null);
  const [save, setSave] = useState<'saved' | 'saving' | 'conflict'>('saved');
  const [sound, setSound] = useState(false);
  const [xr, setXr] = useState<{ vr: boolean; ar: boolean }>({ vr: false, ar: false });
  const version = useRef(scene.version);
  const docRef = useRef(doc);
  docRef.current = doc;
  const three = useRef<{ scene: THREE.Scene; renderer: THREE.WebGLRenderer; camera: THREE.PerspectiveCamera; transform: TransformControls;
    objects: Map<string, THREE.Object3D>; listener: THREE.AudioListener; ground: THREE.Mesh } | null>(null);
  const assetName = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.prompt])), [assets]);

  // ── three.js setup (once) ──
  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.xr.enabled = true;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', scene.name);
    renderer.domElement.setAttribute('role', 'img');
    const s = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, el.clientWidth / el.clientHeight, 0.05, 200);
    camera.position.set(2.5, 2, 3.5);
    const listener = new THREE.AudioListener();
    camera.add(listener);
    s.add(camera, new THREE.HemisphereLight(0xffffff, 0x334455, 1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(3, 6, 4);
    s.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.name = '__ground';
    s.add(ground, new THREE.GridHelper(16, 32, 0x343a44, 0x23272e));
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 0.5, 0);
    orbit.enableDamping = true;
    const transform = new TransformControls(camera, renderer.domElement);
    transform.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; if (!e.value) commitTransform(); });
    s.add(transform.getHelper());
    three.current = { scene: s, renderer, camera, transform, objects: new Map(), listener, ground };

    const raycaster = new THREE.Raycaster();
    const pick = (ev: PointerEvent) => {
      if (transform.dragging) return;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      const hits = raycaster.intersectObjects([...three.current!.objects.values()], true);
      let o: THREE.Object3D | null = hits[0]?.object ?? null;
      while (o && !o.userData.nodeId) o = o.parent;
      setSelected(o?.userData.nodeId ?? null);
    };
    let down = { x: 0, y: 0 };
    renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    renderer.domElement.addEventListener('pointerup', (e) => { if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) pick(e); });
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, [role=dialog]')) return;
      const mode = ({ w: 'translate', e: 'rotate', r: 'scale' } as const)[e.key.toLowerCase() as 'w' | 'e' | 'r'];
      if (mode) transform.setMode(mode);
    };
    window.addEventListener('keydown', onKey);
    const resize = new ResizeObserver(() => { camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth, el.clientHeight); });
    resize.observe(el);
    renderer.setAnimationLoop(() => { orbit.update(); renderer.render(s, camera); });
    if ('xr' in navigator) {
      const x = (navigator as Navigator & { xr: { isSessionSupported(m: string): Promise<boolean> } }).xr;
      Promise.all([x.isSessionSupported('immersive-vr').catch(() => false), x.isSessionSupported('immersive-ar').catch(() => false)]).then(([vr, ar]) => setXr({ vr, ar }));
    }
    return () => { window.removeEventListener('keydown', onKey); resize.disconnect(); renderer.setAnimationLoop(null); transform.dispose(); orbit.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── environment ──
  useEffect(() => {
    const th = three.current;
    if (!th) return;
    const env = ENV[doc.environment];
    th.scene.background = doc.environment === 'passthrough' ? null : new THREE.Color(env.bg);
    (th.ground.material as THREE.MeshStandardMaterial).color.setHex(env.ground);
    th.scene.traverse((o) => { if (o instanceof THREE.DirectionalLight) o.intensity = env.light; });
  }, [doc.environment]);

  // ── sync nodes -> three objects (load GLBs once per node) ──
  const loader = useMemo(() => new GLTFLoader(), []);
  useEffect(() => {
    const th = three.current;
    if (!th) return;
    const want = new Set(doc.nodes.map((n) => n.id));
    for (const [id, obj] of th.objects) if (!want.has(id)) { th.scene.remove(obj); th.objects.delete(id); }
    for (const n of doc.nodes) {
      let obj = th.objects.get(n.id);
      if (!obj) {
        obj = new THREE.Group();
        obj.userData.nodeId = n.id;
        th.objects.set(n.id, obj);
        th.scene.add(obj);
        const group = obj;
        loader.load(`/api/xr/assets/${n.asset_id}/model.glb`, (g) => group.add(g.scene), undefined, () => toast({ title: t('project.action.error'), tone: 'error' }));
      }
      obj.position.set(...n.position);
      obj.rotation.set(...n.rotation);
      obj.scale.setScalar(n.scale);
    }
  }, [doc.nodes, loader, t, toast]);

  // ── selection gizmo ──
  useEffect(() => {
    const th = three.current;
    if (!th) return;
    const obj = selected ? th.objects.get(selected) : undefined;
    if (obj) th.transform.attach(obj); else th.transform.detach();
  }, [selected, doc.nodes]);

  // ── spatial sound preview: a soft generated tone per node with audio, attenuated by distance ──
  useEffect(() => {
    const th = three.current;
    if (!th) return;
    const sources: THREE.PositionalAudio[] = [];
    if (sound) {
      const ctx = th.listener.context;
      void ctx.resume();
      doc.nodes.filter((n) => n.audio).forEach((n, i) => {
        const pa = new THREE.PositionalAudio(th.listener);
        const osc = ctx.createOscillator();
        osc.frequency.value = [220, 277.18, 329.63, 392][i % 4];
        osc.type = n.audio!.kind === 'voice' ? 'triangle' : 'sine';
        osc.start();
        pa.setNodeSource(osc as unknown as AudioBufferSourceNode);
        pa.setRefDistance(n.audio!.ref_distance);
        pa.setVolume(n.audio!.volume * 0.3);
        th.objects.get(n.id)?.add(pa);
        sources.push(pa);
      });
    }
    return () => sources.forEach((pa) => { try { (pa.source as unknown as OscillatorNode)?.stop(); } catch { /* already stopped */ } pa.parent?.remove(pa); pa.disconnect(); });
  }, [sound, doc.nodes]);

  // ── autosave (debounced, optimistic concurrency) ──
  const persist = useCallback(async (next: XrSceneDoc) => {
    setSave('saving');
    const res = await fetch(`/api/xr/scenes/${scene.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene: next, version: version.current }) });
    if (res.status === 409) { setSave('conflict'); return; }
    if (!res.ok) { setSave('saved'); toast({ title: t('project.action.error'), tone: 'error' }); return; }
    version.current = (await res.json()).version;
    setSave('saved');
  }, [scene.id, t, toast]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (save === 'conflict') return;
    const timer = setTimeout(() => void persist(doc), 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const update = (id: string, patch: Partial<XrNode>) => setDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  function commitTransform() {
    const th = three.current;
    const id = selected ?? [...(th?.objects.entries() ?? [])].find(([, o]) => o === th?.transform.object)?.[0];
    const o = id ? th?.objects.get(id) : undefined;
    if (!id || !o) return;
    update(id, { position: [r3(o.position.x), r3(o.position.y), r3(o.position.z)], rotation: [r3(o.rotation.x), r3(o.rotation.y), r3(o.rotation.z)], scale: r3(Math.max(0.01, o.scale.x)) });
  }
  const add = (a: XrAsset) => {
    const id = `n${Date.now().toString(36)}`;
    const k = docRef.current.nodes.length;
    setDoc((d) => ({ ...d, nodes: [...d.nodes, { id, asset_id: a.id, position: [r3((k % 4) * 1.2 - 1.8), 0, r3(-Math.floor(k / 4) * 1.2)], rotation: [0, 0, 0], scale: 1 }] }));
    setSelected(id);
  };
  const enterXR = async (mode: 'immersive-vr' | 'immersive-ar') => {
    const th = three.current!;
    const x = (navigator as Navigator & { xr: { requestSession(m: string, o: object): Promise<XRSession> } }).xr;
    const session = await x.requestSession(mode, { optionalFeatures: ['local-floor', 'hit-test', 'hand-tracking'] }).catch(() => null);
    if (session) await th.renderer.xr.setSession(session);
  };
  const sel = doc.nodes.find((n) => n.id === selected);
  const status = save === 'conflict' ? t('xr.editor.conflict') : t(save === 'saving' ? 'xr.editor.saving' : 'xr.editor.saved');

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2">
        <Link href={`/app/${scene.kind}`} className="inline-flex items-center gap-2 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />{t(`studio.${scene.kind}`)}</Link>
        <h1 className="min-w-0 flex-1 truncate ps-2 text-lg font-semibold text-fg" dir="auto">{scene.name}</h1>
        <span role="status" className={`text-sm ${save === 'conflict' ? 'text-danger' : 'text-fg-subtle'}`}>{status}</span>
        <Button size="sm" variant="ghost" icon={sound ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />} onClick={() => setSound((v) => !v)}>{t(sound ? 'xr.editor.mute' : 'xr.editor.sound')}</Button>
        {xr.vr ? <Button size="sm" icon={<Glasses className="size-4" aria-hidden />} onClick={() => enterXR('immersive-vr')}>{t('xr.editor.enter.vr')}</Button> : null}
        {xr.ar ? <Button size="sm" icon={<Smartphone className="size-4" aria-hidden />} onClick={() => enterXR('immersive-ar')}>{t('xr.editor.enter.ar')}</Button> : null}
        <Button asChild size="sm"><a href={`/api/xr/scenes/${scene.id}/export.glb`} download><Download className="size-4" aria-hidden />{t('xr.editor.export')}</a></Button>
      </header>
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr_16rem]">
        <aside className="flex flex-col gap-2 rounded-lg bg-surface-1 p-3 lg:max-h-[70dvh] lg:overflow-y-auto" aria-label={t('xr.editor.library')}>
          <h2 className="px-1 text-sm font-medium text-fg-muted">{t('xr.editor.library')}</h2>
          {assets.map((a) => (
            <button key={a.id} type="button" onClick={() => add(a)} aria-label={t('xr.editor.add', { name: a.prompt })}
              className="truncate rounded-md px-2 py-2 text-start text-sm text-fg hover:bg-surface-2" dir="auto">{a.prompt}</button>
          ))}
          <h2 className="mt-4 px-1 text-sm font-medium text-fg-muted">{t('xr.editor.objects')}</h2>
          {doc.nodes.length === 0 ? <p className="px-1 text-sm text-fg-subtle">{t('xr.editor.none')}</p> : doc.nodes.map((n) => (
            <button key={n.id} type="button" aria-pressed={selected === n.id} onClick={() => setSelected(n.id)}
              className={`truncate rounded-md px-2 py-2 text-start text-sm ${selected === n.id ? 'bg-accent-soft text-accent-text' : 'text-fg hover:bg-surface-2'}`} dir="auto">
              {assetName[n.asset_id] ?? n.asset_id}
            </button>
          ))}
        </aside>
        <div className="flex flex-col gap-2">
          <div ref={mount} className="h-[60dvh] min-h-80 overflow-hidden rounded-xl bg-surface-2 lg:h-[70dvh]" />
          <p className="text-xs text-fg-subtle">{t('xr.editor.hint')}{!xr.vr && !xr.ar ? ` · ${t('xr.editor.noxr')}` : ''}</p>
        </div>
        <aside className="flex flex-col gap-4 rounded-lg bg-surface-1 p-3" aria-label={t('xr.editor.inspector')}>
          <Select label={t('xr.editor.environment')} value={doc.environment} onValueChange={(v) => setDoc((d) => ({ ...d, environment: v as XrSceneDoc['environment'] }))}
            options={(['studio', 'outdoor', 'night', 'passthrough'] as const).map((e) => ({ value: e, label: t(`xr.env.${e}`) }))} />
          {sel ? (
            <>
              <h2 className="text-sm font-medium text-fg" dir="auto">{assetName[sel.asset_id]}</h2>
              <Triple label={t('xr.editor.position')} value={sel.position} onChange={(v) => update(sel.id, { position: v })} />
              <Triple label={t('xr.editor.rotation')} value={sel.rotation.map(deg) as [number, number, number]} onChange={(v) => update(sel.id, { rotation: v.map((d) => r3((d * Math.PI) / 180)) as [number, number, number] })} />
              <Input label={t('xr.editor.scale')} type="number" min={0.01} max={100} step={0.1} value={sel.scale} onChange={(e) => { const v = Number(e.target.value); if (v > 0 && v <= 100) update(sel.id, { scale: v }); }} />
              <label className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" className="size-4 accent-[var(--xs-accent)]" checked={!!sel.audio} onChange={(e) => update(sel.id, { audio: e.target.checked ? { kind: 'ambient', volume: 0.6, ref_distance: 2 } : null })} />
                {t('xr.editor.audio')}
              </label>
              {sel.audio ? (
                <div className="flex flex-col gap-2 ps-6">
                  <Input label={t('xr.editor.audio.volume')} type="range" min={0} max={1} step={0.05} value={sel.audio.volume} onChange={(e) => update(sel.id, { audio: { ...sel.audio!, volume: Number(e.target.value) } })} />
                  <Input label={t('xr.editor.audio.distance')} type="number" min={0.1} max={100} step={0.5} value={sel.audio.ref_distance} onChange={(e) => { const v = Number(e.target.value); if (v > 0) update(sel.id, { audio: { ...sel.audio!, ref_distance: v } }); }} />
                </div>
              ) : null}
              <Button variant="danger" size="sm" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => { setDoc((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== sel.id) })); setSelected(null); }}>{t('xr.editor.delete')}</Button>
            </>
          ) : <StatusBadge status="draft" label={t('xr.editor.none')} />}
        </aside>
      </div>
    </div>
  );
}

function Triple({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (v: [number, number, number]) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium text-fg">{label}</legend>
      <div className="grid grid-cols-3 gap-1">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label key={axis} className="flex flex-col gap-1">
            <span className="text-xs text-fg-subtle">{axis}</span>
            <input type="number" step={0.1} value={value[i]} aria-label={`${label} ${axis}`}
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(value.map((x, j) => (j === i ? v : x)) as [number, number, number]); }}
              className="h-8 w-full rounded-sm border border-line bg-surface-2 px-2 font-mono text-sm text-fg tabular-nums focus:border-focus focus:outline-none" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
