import { useRef } from "react";
import { MathText } from "./artifacts/BoardArtifact.tsx";
import { autoMathLine } from "../../shared/mathText.ts";

/** One toolbar key: the text it inserts and where the caret lands inside it (offset from the start of the insert). */
type Key = { label: string; text: string; caret?: number; title: [string, string] };
const K = {
  frac: { label: "a/b", text: "()/()", caret: 1, title: ["fraction", "fraction"] },
  pow: { label: "xⁿ", text: "^()", caret: 2, title: ["mettre à la puissance", "to the power of"] },
  sub: { label: "xₙ", text: "_()", caret: 2, title: ["indice", "subscript"] },
  sqrt: { label: "√", text: "sqrt()", caret: 5, title: ["racine carrée", "square root"] },
  brackets: { label: "( )", text: "()", caret: 1, title: ["parenthèses", "brackets"] },
  times: { label: "×", text: "×", title: ["multiplier", "multiply"] },
  minus: { label: "−", text: "−", title: ["moins", "minus"] },
  pi: { label: "π", text: "π", title: ["pi", "pi"] },
  theta: { label: "θ", text: "θ", title: ["thêta", "theta"] },
  log: { label: "log", text: "log_()", caret: 4, title: ["logarithme (écris la base après _)", "logarithm (type the base after _)"] },
  ln: { label: "ln", text: "ln()", caret: 3, title: ["logarithme népérien", "natural log"] },
  exp: { label: "eˣ", text: "e^()", caret: 3, title: ["exponentielle", "exponential"] },
  sin: { label: "sin", text: "sin()", caret: 4, title: ["sinus", "sine"] },
  cos: { label: "cos", text: "cos()", caret: 4, title: ["cosinus", "cosine"] },
  tan: { label: "tan", text: "tan()", caret: 4, title: ["tangente", "tangent"] },
  integral: { label: "∫", text: "∫", title: ["intégrale", "integral"] },
  le: { label: "≤", text: "≤", title: ["inférieur ou égal", "at most"] },
  ge: { label: "≥", text: "≥", title: ["supérieur ou égal", "at least"] },
  deg: { label: "°", text: "°", title: ["degrés", "degrees"] },
} satisfies Record<string, Key>;

/** Which keys THIS answer needs — read from the expected answer itself (ASCII or LaTeX), so "√2/2" offers √ and a/b,
 *  "log_2(5)" offers log, and "x + 3" offers nothing extra. No default keys: a box only gets the ones its answer uses.
 *  Without a stored answer, the question's wording decides. Exported for tests. */
export function keysFor(answer: string, question = ""): Key[] {
  const a = String(answer || "").trim();
  const c = a || String(question || "");
  const out: Key[] = [];
  if (/\/|\\frac|\bfraction\b/i.test(c)) out.push(K.frac);
  if (/\^|[²³]|\bsquared\b|\bpower\b/i.test(c) && !/e\s*\^/.test(c)) out.push(K.pow);
  if (/sqrt|√|\\sqrt|\broot\b/i.test(c)) out.push(K.sqrt);
  if (/\b(?:log|ln)\b|log_/i.test(c)) out.push(K.log, K.ln);
  if (/\be\s*\^|\bexp\b|\\exp/i.test(c)) out.push(K.exp);
  if (/\b(?:sin|cos|tan|cot|sec|csc)\b|°/i.test(c)) out.push(K.sin, K.cos, K.tan, K.deg, K.theta);
  if (/[a-z]_\{?[a-z0-9]/i.test(c) && !/log_/i.test(c)) out.push(K.sub);
  if (/π|\bpi\b|\\pi/i.test(c)) out.push(K.pi);
  if (/∫|\\int\b/i.test(c)) out.push(K.integral);
  if (/[<>≤≥]|\\le|\\ge/.test(c)) out.push(K.le, K.ge);
  if (a && /[()]/.test(a)) out.push(K.brackets);
  if (a && /×|\\times|\\cdot/.test(a)) out.push(K.times);
  if (a && /[-−]/.test(a)) out.push(K.minus);
  return [...new Map(out.map((k) => [k.label, k])).values()];
}

/** The free-response answer box with math keys that insert at the caret — only the ones the expected answer uses — and a live
 *  typeset preview of what's typed. Keys show only for non-numeric answers. */
export function MathAnswerInput(props: {
  value: string; onChange: (v: string) => void; onEnter: () => void; placeholder: string; ariaLabel?: string;
  en: boolean; showKeys: boolean; answer?: string; context?: string; autoFocus?: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (k: Key) => {
    const el = ref.current;
    const start = el?.selectionStart ?? props.value.length;
    const end = el?.selectionEnd ?? props.value.length;
    props.onChange(props.value.slice(0, start) + k.text + props.value.slice(end));
    const pos = start + (k.caret ?? k.text.length);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };
  const keys = props.showKeys ? keysFor(props.answer || "", props.context || "") : [];
  const previewable = props.showKeys && props.value.trim() && autoMathLine(props.value) !== props.value;
  return (
    <div className="sm-math-input">
      <input
        ref={ref}
        type="text"
        className="sm-inline-problem-input"
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") props.onEnter(); }}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
      />
      {keys.length > 0 && (
        <div className="sm-math-keys" role="toolbar" aria-label={props.en ? "Math symbols" : "Symboles mathématiques"}>
          {keys.map((k) => (
            <button key={k.label} type="button" className="sm-math-key" title={k.title[props.en ? 1 : 0]} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)}>{k.label}</button>
          ))}
        </div>
      )}
      {previewable ? <div className="sm-math-preview" aria-live="polite"><MathText text={props.value} /></div> : null}
    </div>
  );
}
