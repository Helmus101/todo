import { isHandled, type Profile, type WebTask } from "../shared/types.ts";

export const AUTO_PAUSE_DAYS = 7;
const DAY = 86_400_000;

/** True when AI should be paused for inactivity: the student has open tasks but has not checked anything off for over a week.
 *  The clock starts from the latest of: the last task completed, the last time they resumed AI, or (if nothing was ever completed) when the oldest open task appeared.
 *  Accounts with no open tasks (the tutor-only ones) are never paused by this. Pure. */
export function shouldAutoPause(tasks: WebTask[] | undefined, profile: Profile | undefined, now = Date.now()): boolean {
  if (!profile || profile.paused) return false;
  const list = (tasks || []).filter((t) => t.source !== "studylog");
  const open = list.filter((t) => !isHandled(t.status));
  if (!open.length) return false;
  const stamp = (s?: string) => Date.parse(s || "") || 0;
  const lastDone = Math.max(0, ...list.filter((t) => t.status === "done").map((t) => stamp(t.updatedAt) || stamp(t.createdAt)));
  const firstOpen = Math.min(...open.map((t) => stamp(t.createdAt) || now));
  const since = Math.max(lastDone || firstOpen, stamp(profile.autoResumedAt));
  return now - since > AUTO_PAUSE_DAYS * DAY;
}
