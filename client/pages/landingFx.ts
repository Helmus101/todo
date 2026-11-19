// Motion layer for the logged-out landing page. Loaded lazily from Landing.tsx (client only, never prerendered),
// so three/gsap/lenis stay out of the main bundle and out of the static HTML.
// Style follows the product's minimal rule: white canvas, thin ink lines, no glow, no colour.
import * as THREE from "three";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

const INK = "#26221f";
const TEXTS: [string, "m" | "q"][] = [
  ["(fg)′ = f′g + fg′", "m"], ["What would change if…?", "q"], ["MR = MC", "m"], ["Why does that work?", "q"],
  ["∫ 1/x dx = ln|x|", "m"], ["Say it back to me.", "q"], ["F = ma", "m"], ["What did you assume?", "q"],
  ["ΔS ≥ 0", "m"], ["Try a smaller case.", "q"], ["P(A | B)", "m"], ["Where does it break?", "q"],
  ["lim x→2 1/(x − 2)", "m"], ["What happens as x gets closer?", "q"], ["Σ 1/n² = π²/6", "m"], ["Prove it.", "q"],
  ["dy/dx", "m"], ["What do you notice?", "q"], ["e^{iπ} + 1 = 0", "m"], ["Check the units.", "q"],
  ["x² sin x", "m"], ["Now do one alone.", "q"],
];

function cardTexture([text, kind]: [string, "m" | "q"]): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 640; c.height = 400;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff"; g.strokeStyle = INK; g.lineWidth = 3;
  g.beginPath(); g.rect(6, 6, 628, 388); g.fill(); g.stroke();
  g.fillStyle = INK; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = kind === "q" ? 'italic 400 56px "Instrument Serif", Georgia, serif' : '400 56px "Instrument Serif", Georgia, serif';
  const words = text.split(" "), lines: string[] = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 16 && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  lines.push(cur);
  lines.forEach((l, i) => g.fillText(l, 320, 200 + (i - (lines.length - 1) / 2) * 66));
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
}

/** Mounts the motion layer; returns a cleanup that removes everything it added. */
export function mountLandingFx(root: HTMLElement): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cleanups: Array<() => void> = [];
  let dead = false;

  /* ---- Three.js: scroll flies the camera through a corridor of thin-lined equation and question cards ---- */
  const canvas = document.createElement("canvas");
  canvas.className = "lx-gl"; canvas.setAttribute("aria-hidden", "true");
  root.prepend(canvas);
  cleanups.push(() => canvas.remove());
  let renderer: THREE.WebGLRenderer | null = null;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch { renderer = null; }
  if (renderer) {
    const r = renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, 1.75)); r.setClearColor(0xffffff, 1);
    const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0xffffff, 5, 40);
    const cam = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    const L = 110, geo = new THREE.PlaneGeometry(3.4, 2.125), cards: THREE.Mesh[] = [], disposables: Array<{ dispose(): void }> = [geo];
    const build = () => {
      for (let i = 0; i < 30; i++) {
        const map = cardTexture(TEXTS[i % TEXTS.length]); disposables.push(map);
        const mat = new THREE.MeshBasicMaterial({ map, transparent: true, opacity: 0.8, side: THREE.DoubleSide }); disposables.push(mat);
        const m = new THREE.Mesh(geo, mat);
        const a = i * 2.399 + Math.random() * 0.4, rad = 4 + Math.random() * 3.4;
        m.position.set(Math.cos(a) * rad * 1.3, Math.sin(a) * rad * 0.7, -8 - i * (L - 14) / 30 - Math.random() * 2);
        m.rotation.set((Math.random() - 0.5) * 0.25, -m.position.x * 0.05, (Math.random() - 0.5) * 0.3);
        m.userData = { y0: m.position.y, ph: Math.random() * 6.28 };
        scene.add(m); cards.push(m);
      }
    };
    const N = 1600, pa = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pa[i * 3] = (Math.random() - 0.5) * 26; pa[i * 3 + 1] = (Math.random() - 0.5) * 16; pa[i * 3 + 2] = 8 - Math.random() * (L + 20); }
    const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(pa, 3));
    const pm = new THREE.PointsMaterial({ color: 0x26221f, size: 0.035, transparent: true, opacity: 0.55 });
    scene.add(new THREE.Points(pg, pm)); disposables.push(pg, pm);

    const resize = () => { r.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); };
    resize(); addEventListener("resize", resize); cleanups.push(() => removeEventListener("resize", resize));
    let prog = 0, camZ = 6, mx = 0, my = 0, sx = 0, sy = 0, raf = 0;
    const readProg = () => { const h = document.documentElement.scrollHeight - innerHeight; prog = h > 0 ? Math.min(1, Math.max(0, scrollY / h)) : 0; };
    const onMove = (e: PointerEvent) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; };
    addEventListener("scroll", readProg, { passive: true }); addEventListener("pointermove", onMove); readProg();
    cleanups.push(() => { removeEventListener("scroll", readProg); removeEventListener("pointermove", onMove); });

    const draw = (t: number) => {
      const target = 6 - prog * (L + 4), vel = target - camZ;
      camZ += vel * 0.07;
      cam.fov += ((55 + Math.min(22, Math.abs(vel) * 1.1)) - cam.fov) * 0.1; cam.updateProjectionMatrix();
      sx += (mx - sx) * 0.05; sy += (my - sy) * 0.05;
      cam.position.set(sx * 2, -sy * 1.3, camZ); cam.lookAt(sx * 1.1, -sy * 0.7, camZ - 10);
      cards.forEach((c) => { c.position.y = c.userData.y0 + Math.sin(t * 0.6 + c.userData.ph) * 0.16; });
      r.render(scene, cam);
    };
    const start = async () => {
      try { await document.fonts.load('italic 400 40px "Instrument Serif"'); } catch { /* fall back to Georgia */ }
      if (dead) return;
      build();
      if (reduce) { draw(2); const onS = () => draw(2); addEventListener("scroll", onS, { passive: true }); cleanups.push(() => removeEventListener("scroll", onS)); return; }
      const loop = (ms: number) => { draw(ms * 0.001); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    };
    void start();
    cleanups.push(() => { cancelAnimationFrame(raf); disposables.forEach((d) => d.dispose()); r.dispose(); });
  }

  if (reduce) return () => { dead = true; cleanups.forEach((f) => f()); };

  /* ---- Lenis smooth scroll, GSAP reveals ---- */
  gsap.registerPlugin(ScrollTrigger);
  const lenis = new Lenis({ lerp: 0.09 });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (t: number) => lenis.raf(t * 1000);
  gsap.ticker.add(tick); gsap.ticker.lagSmoothing(0);
  cleanups.push(() => { gsap.ticker.remove(tick); lenis.destroy(); });

  const ctx = gsap.context(() => {
    // headline: letters rise from a mask, then the rest settles in
    const h1 = root.querySelector<HTMLElement>(".landing-min-main h1");
    if (h1) {
      const original = h1.textContent || "";
      const words = original.split(/(\s+)/);
      h1.textContent = "";
      const chars: HTMLElement[] = [];
      words.forEach((w) => {
        if (!w.trim()) { h1.append(w); return; }
        const wrap = document.createElement("span"); wrap.style.cssText = "display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.12em;margin-bottom:-.12em";
        for (const ch of w) { const s = document.createElement("span"); s.textContent = ch; s.style.display = "inline-block"; wrap.append(s); chars.push(s); }
        h1.append(wrap);
      });
      h1.setAttribute("aria-label", original);
      cleanups.push(() => { h1.textContent = original; h1.removeAttribute("aria-label"); });
      gsap.from(chars, { yPercent: 110, duration: 1.1, ease: "expo.out", stagger: 0.025, delay: 0.1 });
    }
    gsap.from(".landing-min-main > p", { y: 18, opacity: 0, duration: 1, ease: "expo.out", stagger: 0.12, delay: 0.5 });
    // the example session writes itself in as you reach it
    gsap.from(".landing-demo .ts-line", { y: 24, opacity: 0, duration: 0.8, ease: "expo.out", stagger: 0.28, scrollTrigger: { trigger: ".landing-demo", start: "top 80%" } });
    gsap.from(".landing-ask, .landing-detail, .landing-quotes", { y: 30, opacity: 0, duration: 0.9, ease: "expo.out", stagger: 0.1, scrollTrigger: { trigger: ".landing-ask", start: "top 88%" } });
  }, root);
  cleanups.push(() => ctx.revert());

  document.fonts && document.fonts.ready.then(() => { if (!dead) ScrollTrigger.refresh(); });
  return () => { dead = true; cleanups.reverse().forEach((f) => f()); };
}
