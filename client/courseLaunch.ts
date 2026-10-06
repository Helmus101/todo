// Hand-off between the Courses page and the Tutor: "study this unit" stores the target here, then navigates
// to /tutor, which consumes it exactly once on mount and starts a session already pointed at that unit.
const KEY = "otto-tutor-launch";
export interface TutorLaunch { courseId: string; unitId: string }

export function setTutorLaunch(l: TutorLaunch): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(l)); } catch { /* best-effort */ }
}
export function takeTutorLaunch(): TutorLaunch | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const l = JSON.parse(raw);
    return typeof l?.courseId === "string" && typeof l?.unitId === "string" ? l : null;
  } catch { return null; }
}
