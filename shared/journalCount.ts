/** How many real daily journal entries ("what I learned today") a list of tasks holds — week:/month: roll-ups and cleared entries don't count. */
export function countJournalEntries(tasks: any[]): number {
  let n = 0;
  for (const t of tasks) if (t?.source === "studylog" && typeof t?.logDate === "string" && !t.logDate.startsWith("week:") && !t.logDate.startsWith("month:") && String(t?.logText || "").trim()) n++;
  return n;
}
