import { useRef } from "react";

/** One toolbar key: the text it inserts and where the caret lands inside it (offset from the start of the insert). */
const KEYS: { label: string; text: string; caret?: number; title: [string, string] }[] = [
  { label: "log", text: "log_()", caret: 4, title: ["logarithme (écris la base après _)", "logarithm (type the base after _)"] },
  { label: "ln", text: "ln()", caret: 3, title: ["logarithme népérien", "natural log"] },
  { label: "a/b", text: "()/()", caret: 1, title: ["fraction", "fraction"] },
  { label: "xⁿ", text: "^()", caret: 2, title: ["exposant", "exponent"] },
  { label: "√", text: "sqrt()", caret: 5, title: ["racine carrée", "square root"] },
  { label: "π", text: "π", title: ["pi", "pi"] },
  { label: "×", text: "×", title: ["multiplier", "multiply"] },
  { label: "( )", text: "()", caret: 1, title: ["parenthèses", "brackets"] },
  { label: "−", text: "−", title: ["moins", "minus"] },
];

/** The free-response answer box with a row of math keys that insert at the caret — a student shouldn't have to know
 *  how to type "log base a of x" or a fraction on a plain keyboard. Shown only for non-numeric answers. */
export function MathAnswerInput(props: {
  value: string; onChange: (v: string) => void; onEnter: () => void; placeholder: string; ariaLabel?: string;
  en: boolean; showKeys: boolean; autoFocus?: boolean; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (k: (typeof KEYS)[number]) => {
    const el = ref.current;
    const start = el?.selectionStart ?? props.value.length;
    const end = el?.selectionEnd ?? props.value.length;
    props.onChange(props.value.slice(0, start) + k.text + props.value.slice(end));
    const pos = start + (k.caret ?? k.text.length);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };
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
      {props.showKeys && (
        <div className="sm-math-keys" role="toolbar" aria-label={props.en ? "Math symbols" : "Symboles mathématiques"}>
          {KEYS.map((k) => (
            <button key={k.label} type="button" className="sm-math-key" title={k.title[props.en ? 1 : 0]} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)}>{k.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
