import { IB_SUBJECTS, IB_GROUP_NAMES, type IbSubject, type IbLevel } from "../../shared/ibSubjectList.ts";

/** The student's IB subjects. One tap on a subject adds it at SL, a second tap makes it HL, a third removes it. Used in onboarding
 *  and Settings; the tutor's start screen, the subject knowledge and the question level all follow what is picked here. */
export function IbSubjectPicker({ value, onChange }: { value: IbSubject[]; onChange: (next: IbSubject[]) => void }) {
  const levelOf = (name: string): IbLevel | undefined => value.find((s) => s.name === name)?.level;
  const tap = (name: string) => {
    const cur = levelOf(name);
    if (!cur) { if (value.length >= 7) return; onChange([...value, { name, level: "SL" }]); }
    else if (cur === "SL") onChange(value.map((s) => (s.name === name ? { ...s, level: "HL" } : s)));
    else onChange(value.filter((s) => s.name !== name));
  };
  const hl = value.filter((s) => s.level === "HL").length;
  return (
    <div className="ib-picker" translate="yes">
      <p className="muted small">{`Tap once for SL, twice for HL, three times to remove. ${value.length} chosen, ${hl} at HL.`}</p>
      {([1, 2, 3, 4, 5, 6] as const).map((g) => (
        <div key={g} style={{ marginTop: 10 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>{`Group ${g} · ${IB_GROUP_NAMES[g]}`}</div>
          <div className="onboard-chips">
            {IB_SUBJECTS.filter((s) => s.group === g).map((s) => {
              const lv = levelOf(s.name);
              return (
                <button key={s.name} type="button" className={`btn xs ${lv ? "" : "ghost"}`} aria-pressed={!!lv} onClick={() => tap(s.name)}>
                  {s.name}{lv ? ` · ${lv}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
