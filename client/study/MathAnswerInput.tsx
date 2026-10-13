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

/** Which keys this answer can use — read from the expected answer and the question, so a log question offers log/ln,
 *  a trig one sin/cos/tan, and a plain expression only the basics. Exported for tests. */
export function keysFor(context: string): Key[] {
  const c = String(context || "");
  const out: Key[] = [K.frac, K.pow, K.sqrt, K.brackets];
  if (/\b(?:log|ln)\b|log_/i.test(c)) out.push(K.log, K.ln);
  if (/\be\s*\^|\bexp|exponential|\bln\b/i.test(c)) out.push(K.exp);
  if (/\b(?:sin|cos|tan|cot|sec|csc)\b|trig|°|\bangle/i.test(c)) out.push(K.sin, K.cos, K.tan, K.deg, K.theta);
  if (/_|\bsubscript|[a-z]_\{?[a-z0-9]/i.test(c)) out.push(K.sub);
  if (/π|\bpi\b|circle|radian/i.test(c)) out.push(K.pi);
  if (/∫|\bintegra/i.test(c)) out.push(K.integral);
  if (/[<>≤≥]|\binequalit|at most|at least/i.test(c)) out.push(K.le, K.ge);
  out.push(K.times, K.minus);
  return [...new Map(out.map((k) => [k.label, k])).values()];
}

/** The free-response answer box with math keys that insert at the caret, picked to suit the answer, and a live
 *  typeset preview of what's typed. Keys show only for non-numeric answers. */
export function MathAnswerInput(props: {
  value: string; onChange: (v: string) => void; onEnter: () => void; placeholder: string; ariaLabel?: string;
  en: boolean; showKeys: boolean; context?: string; autoFocus?: boolean; disabled?: boolean;
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
  const keys = props.showKeys ? keysFor(props.context || "") : [];
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
