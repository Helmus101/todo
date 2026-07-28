import type { WebTask, Profile } from "../shared/types.ts";
import { sortWithinQuadrant, tzOf } from "../shared/types.ts";

export interface BriefingContent {
  date: string;
  userName?: string;
  topPriorities: Array<{
    number: number;
    title: string;
    estimated?: string;
    brief?: string;
  }>;
  upcomingRisks: string[];
  taskCount: number;
}

/** Format tasks into a daily briefing — top 3 priorities + upcoming risks. */
export function formatBriefing(tasks: WebTask[], profile: Profile, now: Date = new Date()): BriefingContent {
  const tz = tzOf(profile);
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Sort by score to find top priorities
  const sorted = sortWithinQuadrant(tasks, profile.highPriorityPeople || [], now);
  const readyTasks = sorted.filter((t) => t.status === "ready");
  const top3 = readyTasks.slice(0, 3);

  // Extract upcoming risks: tasks due tomorrow, calendar events later today
  const upcomingRisks: string[] = [];
  const todayMs = now.getTime();
  const tomorrowStart = new Date(now);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowMs = tomorrowStart.getTime();

  for (const t of readyTasks) {
    if (!t.when) continue;
    const deadline = Date.parse(t.when);
    if (isNaN(deadline)) continue;

    // Tasks due tomorrow
    if (deadline >= tomorrowMs && deadline < tomorrowMs + 86_400_000) {
      upcomingRisks.push(`📅 ${t.title} — due tomorrow`);
    }
  }

  // Cap risks at a reasonable number
  const risks = upcomingRisks.slice(0, 5);

  return {
    date: dayFormatter.format(now),
    userName: profile.name,
    topPriorities: top3.map((t, i) => ({
      number: i + 1,
      title: t.title,
      estimated: t.context ? undefined : undefined,
      brief: t.context || t.why,
    })),
    upcomingRisks: risks.length ? risks : ["None identified"],
    taskCount: readyTasks.length,
  };
}

/** Render briefing as HTML email. */
export function briefingHtml(content: BriefingContent): string {
  const prioritiesHtml = content.topPriorities
    .map(
      (p) => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
        <div style="display: flex; gap: 12px; align-items: flex-start;">
          <div style="font-weight: 600; color: #3b82f6; font-size: 18px; min-width: 32px;">${p.number}</div>
          <div style="flex: 1;">
            <div style="font-weight: 500; color: #1f2937; margin-bottom: 4px;">${escapeHtml(p.title)}</div>
            ${p.brief ? `<div style="color: #6b7280; font-size: 13px; line-height: 1.4;">${escapeHtml(p.brief).substring(0, 200)}</div>` : ""}
          </div>
        </div>
      </td>
    </tr>
  `,
    )
    .join("");

  const risksHtml = content.upcomingRisks
    .map(
      (r) => `
    <li style="margin: 8px 0; color: #6b7280; font-size: 14px;">
      ${escapeHtml(r)}
    </li>
  `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; background-color: #f9fafb;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px;">
      <!-- Header -->
      <div style="margin-bottom: 24px;">
        <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #1f2937;">Good morning${content.userName ? ", " + escapeHtml(content.userName) : ""}</h1>
        <p style="margin: 0; color: #6b7280; font-size: 14px;">${escapeHtml(content.date)}</p>
      </div>

      <!-- Priorities -->
      <div style="margin-bottom: 24px;">
        <h2 style="margin: 0 0 16px 0; font-size: 14px; font-weight: 600; color: #374151; text-transform: uppercase; letter-spacing: 0.5px;">Today's ${content.topPriorities.length} Priorities</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tbody>
            ${prioritiesHtml}
          </tbody>
        </table>
      </div>

      <!-- Risks -->
      <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px;">
        <h3 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #92400e; text-transform: uppercase;">⚠️ Upcoming Risks</h3>
        <ul style="margin: 0; padding-left: 20px;">
          ${risksHtml}
        </ul>
      </div>

      <!-- Footer -->
      <div style="text-align: center; padding-top: 16px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">
          <a href="https://otto.local" style="color: #3b82f6; text-decoration: none;">Open Otto</a> to manage your tasks
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
