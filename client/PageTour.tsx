import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLang } from "./ui.tsx";

/** One stop of a page guide. `target` is a CSS selector for the REAL control being explained (a step whose target
 *  isn't on the page — e.g. a task card when there are no tasks — is skipped, never shown pointing at nothing).
 *  `interactive` steps ask the student to actually do the thing: they advance when the target is clicked. */
export interface TourStep {
  target?: string;
  title: [string, string];
  body: [string, string];
  /** "Try it: …" line shown on interactive steps. */
  action?: [string, string];
  interactive?: boolean;
}

interface TourCtx { seen: Set<string>; markSeen: (id: string) => void; suppressed: boolean }
const Ctx = createContext<TourCtx | null>(null);

export function TourProvider({ seen, markSeen, suppressed, children }: { seen: Set<string>; markSeen: (id: string) => void; suppressed: boolean; children: ReactNode }) {
  return <Ctx.Provider value={{ seen, markSeen, suppressed }}>{children}</Ctx.Provider>;
}

const PAD = 8;
type Rect = { x: number; y: number; w: number; h: number };

/** The first-visit guide for ONE page. Renders nothing once `id` has been seen (or while the basic onboarding is
 *  on screen, or before `ready`). A dimmed overlay with a hole around the target — the hole stays clickable, so
 *  interactive steps work on the real control — plus a small card with Back / Next / Skip. Leaving the page
 *  mid-guide doesn't mark it seen; finishing or skipping does (and that sticks to the account). */
export function PageTour({ id, steps, ready = true }: { id: string; steps: TourStep[]; ready?: boolean }) {
  const L = useLang();
  const ctx = useContext(Ctx);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [armed, setArmed] = useState(false);
  const missingSince = useRef<number | null>(null);
  const shown = useRef(false);
  const [dead, setDead] = useState(false); // every target was missing: stop quietly WITHOUT marking the page seen
  const active = !!ctx && !dead && !ctx.seen.has(id) && !ctx.suppressed && ready && steps.length > 0;

  // Give the page a moment to paint its controls before the first step appears.
  useEffect(() => {
    if (!active) { setArmed(false); return; }
    const t = setTimeout(() => setArmed(true), 700);
    return () => clearTimeout(t);
  }, [active]);

  const finish = useCallback(() => { ctx?.markSeen(id); }, [ctx, id]);
  const step = steps[Math.min(i, steps.length - 1)];
  const go = useCallback((n: number) => { missingSince.current = null; if (n >= steps.length) { if (shown.current) finish(); else setDead(true); } else setI(Math.max(0, n)); }, [steps.length, finish]);

  // Track the target's box (it can move: scrolling, resize, content loading). A missing target is waited for
  // briefly, then the step is skipped.
  useLayoutEffect(() => {
    if (!active || !armed) return;
    let raf = 0, cancelled = false;
    let scrolled = false;
    const tick = () => {
      if (cancelled) return;
      if (!step.target) { shown.current = true; setRect(null); raf = requestAnimationFrame(tick); return; }
      const el = document.querySelector<HTMLElement>(step.target);
      const r = el?.getBoundingClientRect();
      if (el && r && r.width > 0 && r.height > 0) {
        missingSince.current = null;
        shown.current = true;
        if (!scrolled) { scrolled = true; if (r.top < 70 || r.bottom > window.innerHeight - 60) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
        setRect((o) => (o && Math.abs(o.x - r.left) < 0.5 && Math.abs(o.y - r.top) < 0.5 && Math.abs(o.w - r.width) < 0.5 && Math.abs(o.h - r.height) < 0.5 ? o : { x: r.left, y: r.top, w: r.width, h: r.height }));
      } else {
        setRect(null);
        if (missingSince.current == null) missingSince.current = performance.now();
        else if (performance.now() - missingSince.current > 1800) { go(i + 1); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [active, armed, step, i, go]);

  // Interactive step: advance when the student actually uses the highlighted control.
  useEffect(() => {
    if (!active || !armed || !step.interactive || !step.target) return;
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return;
    const onClick = () => { setTimeout(() => go(i + 1), 350); };
    el.addEventListener("click", onClick, { capture: true, once: true });
    return () => el.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
  }, [active, armed, step, i, go, rect === null]);

  useEffect(() => {
    if (!active || !armed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish(); else if (e.key === "ArrowRight" || e.key === "Enter") go(i + 1); else if (e.key === "ArrowLeft") go(i - 1); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, armed, i, go, finish]);

  if (!active || !armed) return null;
  const hole = rect && step.target ? { x: Math.max(0, rect.x - PAD), y: Math.max(0, rect.y - PAD), w: rect.w + PAD * 2, h: rect.h + PAD * 2 } : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const CARD_W = Math.min(340, vw - 24);
  let cardStyle: React.CSSProperties;
  const CARD_H = 210; // generous estimate (title + 3 lines + action + buttons)
  if (hole) {
    const left = Math.min(Math.max(12, hole.x + hole.w / 2 - CARD_W / 2), vw - CARD_W - 12);
    const roomBelow = vh - (hole.y + hole.h), roomAbove = hole.y;
    if (roomBelow >= CARD_H + 26) cardStyle = { left, top: hole.y + hole.h + 14, width: CARD_W };
    else if (roomAbove >= CARD_H + 26) cardStyle = { left, bottom: vh - hole.y + 14, width: CARD_W };
    // A target that fills the screen (the whole board): float the card over its middle instead of off-screen.
    else cardStyle = { left: (vw - CARD_W) / 2, top: Math.max(84, vh / 2 - CARD_H / 2), width: CARD_W };
  } else {
    cardStyle = { left: (vw - CARD_W) / 2, top: Math.max(80, vh / 2 - 110), width: CARD_W };
  }
  const last = i >= steps.length - 1;
  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="false" aria-label={L(...step.title)}>
      {hole ? (
        <>
          <div className="tour-dim" style={{ left: 0, top: 0, width: "100%", height: hole.y }} />
          <div className="tour-dim" style={{ left: 0, top: hole.y + hole.h, width: "100%", height: Math.max(0, vh - hole.y - hole.h) }} />
          <div className="tour-dim" style={{ left: 0, top: hole.y, width: hole.x, height: hole.h }} />
          <div className="tour-dim" style={{ left: hole.x + hole.w, top: hole.y, width: Math.max(0, vw - hole.x - hole.w), height: hole.h }} />
          <div className={`tour-ring${step.interactive ? " live" : ""}`} style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }} />
        </>
      ) : <div className="tour-dim" style={{ inset: 0 }} />}
      <div className="tour-card" style={cardStyle}>
        <div className="tour-meta"><span>{i + 1} / {steps.length}</span><button type="button" className="tour-skip" onClick={finish}>{L("Passer", "Skip")}</button></div>
        <h3 className="tour-title">{L(...step.title)}</h3>
        <p className="tour-body">{L(...step.body)}</p>
        {step.interactive && step.action ? <p className="tour-action">{L(...step.action)}</p> : null}
        <div className="tour-actions">
          <button type="button" className="btn ghost xs" onClick={() => go(i - 1)} disabled={i === 0}>{L("Retour", "Back")}</button>
          <button type="button" className="btn primary xs" onClick={() => go(i + 1)} autoFocus>{last ? L("C'est compris", "Got it") : step.interactive ? L("Suivant", "Next") : L("Suivant", "Next")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
