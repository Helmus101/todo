import { useMemo, useState } from "react";
import type { WidgetSpec } from "../../../shared/widgets.ts";
import { shuffledNotSolved, seededShuffle, projectileStats } from "../../../shared/widgets.ts";
import { useLang } from "../../ui.tsx";

export interface WidgetResult { type: WidgetSpec["type"]; caption: string; mistakes: number; total: number }

/** Pre-built tutor activities (WIDGET_ON_BOARD). Tap-based on purpose (works on phones, no drag library): the
 *  checkable ones (match / order / sort) report back once finished so the tutor can react to how it went. */
// Typesetting is injected (BoardArtifact's MathText) rather than imported, so this file never imports the board
// back — no import cycle.
type TextC = (p: { text: string }) => JSX.Element;
let MathText: TextC = ({ text }) => <>{text}</>;

export function WidgetBlock({ id, caption, spec, onResult, Text }: { id: string; caption: string; spec: WidgetSpec; onResult?: (r: WidgetResult) => void; Text?: TextC }) {
  if (Text) MathText = Text;
  if (spec.type === "match") return <MatchWidget id={id} caption={caption} spec={spec} onResult={onResult} />;
  if (spec.type === "order") return <OrderWidget id={id} caption={caption} spec={spec} onResult={onResult} />;
  if (spec.type === "sort") return <SortWidget id={id} caption={caption} spec={spec} onResult={onResult} />;
  if (spec.type === "unit_circle") return <UnitCircle spec={spec} />;
  return <Projectile spec={spec} />;
}

function DoneBanner({ mistakes, total }: { mistakes: number; total: number }) {
  const L = useLang();
  return (
    <div className="sm-widget-done" role="status">
      {mistakes === 0 ? L("Tout juste du premier coup.", "All correct on the first go.") : L(`Terminé — ${mistakes} erreur${mistakes > 1 ? "s" : ""} en chemin.`, `Done — ${mistakes} slip${mistakes > 1 ? "s" : ""} along the way.`)}
      <span className="sm-widget-done-count"> {total}/{total}</span>
    </div>
  );
}

function MatchWidget({ id, caption, spec, onResult }: { id: string; caption: string; spec: Extract<WidgetSpec, { type: "match" }>; onResult?: (r: WidgetResult) => void }) {
  const L = useLang();
  const rights = useMemo(() => shuffledNotSolved(spec.pairs.map((_, i) => i), id), [spec, id]);
  const [pickedLeft, setPickedLeft] = useState<number | null>(null);
  const [matched, setMatched] = useState<number[]>([]);
  const [wrongFlash, setWrongFlash] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const done = matched.length === spec.pairs.length;
  const pickRight = (ri: number) => {
    if (pickedLeft == null || matched.includes(ri)) return;
    if (ri === pickedLeft) {
      const next = [...matched, ri];
      setMatched(next); setPickedLeft(null);
      if (next.length === spec.pairs.length) onResult?.({ type: "match", caption, mistakes, total: spec.pairs.length });
    } else { setMistakes((m) => m + 1); setWrongFlash(ri); setTimeout(() => setWrongFlash(null), 600); }
  };
  return (
    <div className="sm-widget sm-widget-match">
      <div className="sm-widget-cols">
        <div className="sm-widget-col">
          {spec.pairs.map((p, i) => (
            <button key={i} type="button" disabled={matched.includes(i)} className={`sm-widget-chip${pickedLeft === i ? " is-picked" : ""}${matched.includes(i) ? " is-done" : ""}`} onClick={() => setPickedLeft(i)}><MathText text={p.left} /></button>
          ))}
        </div>
        <div className="sm-widget-col">
          {rights.map((ri) => (
            <button key={ri} type="button" disabled={matched.includes(ri) || pickedLeft == null} className={`sm-widget-chip${matched.includes(ri) ? " is-done" : ""}${wrongFlash === ri ? " is-wrong" : ""}`} onClick={() => pickRight(ri)}><MathText text={spec.pairs[ri].right} /></button>
          ))}
        </div>
      </div>
      {!done && <p className="sm-widget-hint">{pickedLeft == null ? L("Choisis un élément à gauche, puis sa paire à droite.", "Pick one on the left, then its partner on the right.") : L("Maintenant sa paire à droite.", "Now its partner on the right.")}</p>}
      {done && <DoneBanner mistakes={mistakes} total={spec.pairs.length} />}
    </div>
  );
}

function OrderWidget({ id, caption, spec, onResult }: { id: string; caption: string; spec: Extract<WidgetSpec, { type: "order" }>; onResult?: (r: WidgetResult) => void }) {
  const L = useLang();
  const [list, setList] = useState<number[]>(() => shuffledNotSolved(spec.items.map((_, i) => i), id));
  const [checks, setChecks] = useState(0);
  const [done, setDone] = useState(false);
  const [wrongIdx, setWrongIdx] = useState<number[]>([]);
  const move = (pos: number, d: -1 | 1) => {
    const to = pos + d;
    if (done || to < 0 || to >= list.length) return;
    const next = list.slice(); [next[pos], next[to]] = [next[to], next[pos]];
    setList(next); setWrongIdx([]);
  };
  const check = () => {
    const wrong = list.map((v, pos) => (v === pos ? -1 : pos)).filter((x) => x >= 0);
    if (!wrong.length) { setDone(true); onResult?.({ type: "order", caption, mistakes: checks, total: spec.items.length }); }
    else { setChecks((c) => c + 1); setWrongIdx(wrong); }
  };
  return (
    <div className="sm-widget sm-widget-order">
      <ol className="sm-widget-list">
        {list.map((v, pos) => (
          <li key={v} className={`sm-widget-row${wrongIdx.includes(pos) ? " is-wrong" : ""}${done ? " is-done" : ""}`}>
            <span className="sm-widget-num">{pos + 1}</span>
            <span className="sm-widget-row-text"><MathText text={spec.items[v]} /></span>
            {!done && <span className="sm-widget-move">
              <button type="button" aria-label={L("Monter", "Move up")} disabled={pos === 0} onClick={() => move(pos, -1)}>↑</button>
              <button type="button" aria-label={L("Descendre", "Move down")} disabled={pos === list.length - 1} onClick={() => move(pos, 1)}>↓</button>
            </span>}
          </li>
        ))}
      </ol>
      {!done && <button type="button" className="btn primary sm-widget-check" onClick={check}>{L("Vérifier l'ordre", "Check the order")}</button>}
      {!done && wrongIdx.length > 0 && <p className="sm-widget-hint">{L("Pas encore — les lignes en rouge ne sont pas à la bonne place.", "Not yet — the red rows aren't in the right place.")}</p>}
      {done && <DoneBanner mistakes={checks} total={spec.items.length} />}
    </div>
  );
}

function SortWidget({ id, caption, spec, onResult }: { id: string; caption: string; spec: Extract<WidgetSpec, { type: "sort" }>; onResult?: (r: WidgetResult) => void }) {
  const L = useLang();
  const order = useMemo(() => seededShuffle(spec.items.map((_, i) => i), id), [spec, id]);
  const [placed, setPlaced] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [wrongFlash, setWrongFlash] = useState<number | null>(null);
  const remaining = order.filter((i) => placed[i] === undefined);
  const done = remaining.length === 0;
  const drop = (cat: number) => {
    if (selected == null) return;
    if (spec.items[selected].category === cat) {
      const next = { ...placed, [selected]: cat };
      setPlaced(next); setSelected(null);
      if (Object.keys(next).length === spec.items.length) onResult?.({ type: "sort", caption, mistakes, total: spec.items.length });
    } else { setMistakes((m) => m + 1); setWrongFlash(cat); setTimeout(() => setWrongFlash(null), 600); }
  };
  return (
    <div className="sm-widget sm-widget-sort">
      {!done && (
        <div className="sm-widget-pool">
          {remaining.map((i) => (
            <button key={i} type="button" className={`sm-widget-chip${selected === i ? " is-picked" : ""}`} onClick={() => setSelected(i)}><MathText text={spec.items[i].text} /></button>
          ))}
        </div>
      )}
      <div className="sm-widget-bins">
        {spec.categories.map((c, ci) => (
          <button key={ci} type="button" className={`sm-widget-bin${wrongFlash === ci ? " is-wrong" : ""}`} disabled={selected == null} onClick={() => drop(ci)}>
            <span className="sm-widget-bin-title">{c}</span>
            <span className="sm-widget-bin-items">{order.filter((i) => placed[i] === ci).map((i) => <span key={i} className="sm-widget-chip is-done"><MathText text={spec.items[i].text} /></span>)}</span>
          </button>
        ))}
      </div>
      {!done && <p className="sm-widget-hint">{selected == null ? L("Choisis un élément, puis la catégorie où il va.", "Pick an item, then the category it belongs in.") : L("Où va-t-il ?", "Where does it go?")}</p>}
      {done && <DoneBanner mistakes={mistakes} total={spec.items.length} />}
    </div>
  );
}

function UnitCircle({ spec }: { spec: Extract<WidgetSpec, { type: "unit_circle" }> }) {
  const L = useLang();
  const [deg, setDeg] = useState(spec.angle);
  const [showValues, setShowValues] = useState(true);
  const r = 90, cx = 120, cy = 110, a = (deg * Math.PI) / 180;
  const px = cx + r * Math.cos(a), py = cy - r * Math.sin(a);
  const fix = (v: number) => (Math.abs(v) < 0.0005 ? "0" : v.toFixed(3));
  return (
    <div className="sm-widget sm-widget-circle">
      <svg viewBox="0 0 240 220" role="img" aria-label={L("Cercle trigonométrique", "Unit circle")}>
        <line x1="10" y1={cy} x2="230" y2={cy} stroke="currentColor" opacity=".3" /><line x1={cx} y1="10" x2={cx} y2="210" stroke="currentColor" opacity=".3" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" opacity=".6" />
        <line x1={cx} y1={cy} x2={px} y2={py} stroke="#2563EB" strokeWidth="2" />
        <line x1={px} y1={py} x2={px} y2={cy} stroke="#DC2626" strokeWidth="2" strokeDasharray="4 3" />
        <line x1={cx} y1={cy} x2={px} y2={cy} stroke="#16A34A" strokeWidth="2" strokeDasharray="4 3" />
        <path d={`M ${cx + 22} ${cy} A 22 22 0 ${deg > 180 ? 1 : 0} 0 ${cx + 22 * Math.cos(a)} ${cy - 22 * Math.sin(a)}`} fill="none" stroke="#2563EB" />
        <circle cx={px} cy={py} r="5" fill="#2563EB" />
      </svg>
      <label className="sm-widget-slider"><span>{L("Angle", "Angle")} {Math.round(deg)}°</span><input type="range" min={0} max={360} step={1} value={deg} onChange={(e) => setDeg(Number(e.target.value))} /></label>
      <div className="sm-widget-readout">
        <button type="button" className="sm-widget-link" onClick={() => setShowValues((v) => !v)}>{showValues ? L("Masquer les valeurs (prédis d'abord)", "Hide the values (predict first)") : L("Afficher les valeurs", "Show the values")}</button>
        {showValues && <span><span style={{ color: "#16A34A" }}>cos</span> = {fix(Math.cos(a))} · <span style={{ color: "#DC2626" }}>sin</span> = {fix(Math.sin(a))}</span>}
      </div>
    </div>
  );
}

function Projectile({ spec }: { spec: Extract<WidgetSpec, { type: "projectile" }> }) {
  const L = useLang();
  const [angle, setAngle] = useState(spec.angle);
  const [speed, setSpeed] = useState(spec.speed);
  const g = spec.g;
  const st = projectileStats(angle, speed, g);
  const W = 320, H = 170, pad = 24;
  // fixed window sized for the extreme settings so dragging a slider visibly changes the arc instead of rescaling it away
  const maxRange = (60 * 60) / Math.min(g, 9.8) * 1.0, maxH = maxRange / 4;
  const sx = (W - 2 * pad) / Math.max(40, Math.min(maxRange, Math.max(st.range * 1.15, 40)));
  const sy = Math.min(sx, (H - 2 * pad) / Math.max(10, st.height * 1.2));
  const sc = Math.min(sx, sy);
  const a = (angle * Math.PI) / 180;
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) { const t = (st.time * i) / 40; pts.push(`${pad + speed * Math.cos(a) * t * sc},${H - pad - (speed * Math.sin(a) * t - 0.5 * g * t * t) * sc}`); }
  void maxH;
  return (
    <div className="sm-widget sm-widget-projectile">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={L("Trajectoire", "Trajectory")}>
        <line x1={pad} y1={H - pad} x2={W - pad / 2} y2={H - pad} stroke="currentColor" opacity=".4" />
        <polyline points={pts.join(" ")} fill="none" stroke="#2563EB" strokeWidth="2" />
        <circle cx={pad} cy={H - pad} r="4" fill="#DC2626" />
      </svg>
      <label className="sm-widget-slider"><span>{L("Angle", "Angle")} {angle}°</span><input type="range" min={5} max={85} step={1} value={angle} onChange={(e) => setAngle(Number(e.target.value))} /></label>
      <label className="sm-widget-slider"><span>{L("Vitesse", "Speed")} {speed} m/s</span><input type="range" min={5} max={60} step={1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} /></label>
      <div className="sm-widget-readout">{L("Portée", "Range")} {st.range.toFixed(1)} m · {L("Hauteur max", "Max height")} {st.height.toFixed(1)} m · {L("Durée", "Time")} {st.time.toFixed(2)} s · g = {g}</div>
    </div>
  );
}
