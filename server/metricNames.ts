/**
 * Full catalog of personalization metrics — the single source of truth for "what does Otto track" so this
 * list is never scattered/undiscoverable across call sites. Every name here is recorded via
 * store.ts's recordMetric(email, name, value, bucket?, context?) — the SAME generic, flexible pipeline
 * (reusing weave_web_session_outcomes), so adding a new one is "call recordMetric with a new name", never a
 * schema change. `wired: true` means a real call site exists today (grep the name to find it); `wired:
 * false` is a documented, designed-but-not-yet-instrumented metric — listed here so a future call site knows
 * exactly what name/unit/bucket to use, rather than each new signal getting invented ad hoc. Collection is
 * deliberately ahead of consumption in several cases (see `usedBy`): a bandit or report doesn't read every
 * wired metric yet, but the data exists from day one so nothing has to be backfilled later.
 */
export interface MetricDef {
  name: string;
  unit: string;    // what `value` means
  bucket: string;  // what `bucket` is used for (a grouping label), or "n/a"
  wired: boolean;  // does a real call site record this today?
  usedBy: string;  // which decision/report reads this today, or "collected, not yet consumed"
}

export const METRIC_CATALOG: MetricDef[] = [
  // ── Tasks ────────────────────────────────────────────────────────────────────────────────────────
  { name: "task_created", unit: "count (1)", bucket: "source (gmail/manual/pronote/...)", wired: true, usedBy: "collected" },
  { name: "task_completed", unit: "count (1)", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_dismissed", unit: "count (1)", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_lateness_hours", unit: "hours late (negative = early)", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_time_to_first_action_seconds", unit: "seconds, shownAt→firstActionAt", bucket: "source", wired: true, usedBy: "collected (also feeds the granularity bandit reward directly)" },
  { name: "task_time_to_completion_seconds", unit: "seconds, shownAt→done", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_steps_count", unit: "count", bucket: "source", wired: false, usedBy: "planned — record at generation (runById)" },
  { name: "task_step_completed", unit: "count (1)", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_step_stuck_seconds", unit: "seconds a step sat un-done since the task's last run", bucket: "source", wired: false, usedBy: "planned — needs a per-step timestamp not currently stored" },
  { name: "task_revision_requested", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "task_auto_run", unit: "count (1)", bucket: "source", wired: true, usedBy: "collected" },
  { name: "task_manual_added", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "task_followups_spawned", unit: "count", bucket: "source", wired: false, usedBy: "planned — record in runById where followUps are folded in" },
  { name: "task_title_tightened", unit: "count (1)", bucket: "source", wired: false, usedBy: "planned — record in runById where out.title replaces a placeholder" },

  // ── Study Mode sessions ──────────────────────────────────────────────────────────────────────────
  { name: "study_session_started", unit: "count (1)", bucket: "template (WRITING/READING/...)", wired: true, usedBy: "collected" },
  { name: "study_session_duration_seconds", unit: "seconds", bucket: "template", wired: true, usedBy: "collected" },
  { name: "study_session_break_seconds", unit: "seconds", bucket: "template", wired: true, usedBy: "collected" },
  { name: "study_pomodoro_cycles_completed", unit: "count", bucket: "armId", wired: true, usedBy: "collected" },
  { name: "study_exit_early", unit: "0=completed planned length, 1=didn't", bucket: "source", wired: true, usedBy: "collected" },
  { name: "study_idle_ratio", unit: "0-1 fraction of session spent idle", bucket: "template", wired: true, usedBy: "pomodoro/audio bandit reward (recorded separately too)" },
  { name: "study_material_added", unit: "count (1)", bucket: "material type", wired: true, usedBy: "collected" },
  { name: "study_artifact_added", unit: "count (1)", bucket: "artifact type", wired: true, usedBy: "collected" },
  { name: "study_background_image_set", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "study_pdf_uploaded", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "study_gdoc_opened", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "study_review_submitted", unit: "count (1) — end-of-session reflection filled in", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "study_session_resumed", unit: "count (1) — resumed vs. fresh start", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "study_retile_triggered", unit: "count (1)", bucket: "n/a", wired: false, usedBy: "planned — record in tileWithinBounds call sites if desk-crowding ever becomes a signal worth its own metric" },
  { name: "study_desk_artifact_count", unit: "count of artifacts open at session end", bucket: "template", wired: true, usedBy: "collected" },

  // ── Flashcards / quizzes / practice problems ─────────────────────────────────────────────────────
  { name: "flashcard_review", unit: "0/1 correct", bucket: "task source", wired: true, usedBy: "flashcard bandit reward (via Leitner box, recorded separately too)" },
  { name: "flashcard_struggle", unit: "correct-rate on a 3+-seen card", bucket: "task source", wired: true, usedBy: "collected" },
  { name: "flashcard_deck_created", unit: "card count", bucket: "deck source (daily/weekly/monthly)", wired: true, usedBy: "collected" },
  { name: "quiz_attempt_score_ratio", unit: "0-1 score/total", bucket: "task source", wired: true, usedBy: "collected" },
  { name: "quiz_created", unit: "question count", bucket: "deck source (weekly/monthly)", wired: true, usedBy: "collected" },
  { name: "practice_problem_attempted", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "practice_problem_correct", unit: "0/1", bucket: "n/a", wired: true, usedBy: "collected" },

  // ── Study Journal ────────────────────────────────────────────────────────────────────────────────
  { name: "journal_entry_saved", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "activity-hour signal (also recorded as its own metric)" },
  { name: "journal_entry_length_chars", unit: "characters", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "journal_week_summary_generated", unit: "card count", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "journal_month_summary_generated", unit: "card count", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "journal_day_skipped", unit: "count (1) — a weekday with no entry, logged at week-summary time", bucket: "n/a", wired: false, usedBy: "planned — record in the week-summary route from the days array" },

  // ── Chat / tutoring ──────────────────────────────────────────────────────────────────────────────
  { name: "chat_message_sent", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "activity-hour signal (also recorded as its own metric)" },
  { name: "chat_message_length_chars", unit: "characters", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "chat_guardrail_tripped", unit: "count (1)", bucket: "task source", wired: true, usedBy: "collected" },
  { name: "chat_artifact_created", unit: "count (1)", bucket: "artifact kind (note/deck/quiz)", wired: true, usedBy: "collected" },
  { name: "chat_error", unit: "count (1) — DeepSeek failure or empty completion", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "chat_tool_call", unit: "count (1)", bucket: "tool name", wired: false, usedBy: "planned — record per tool_call in chatAboutTask's loop" },
  { name: "chat_help_requested_on_step", unit: "count (1) — 'Aide' tapped on a specific step", bucket: "n/a", wired: true, usedBy: "collected" },

  // ── Engagement / account-level ───────────────────────────────────────────────────────────────────
  { name: "settings_opened", unit: "count (1)", bucket: "n/a", wired: false, usedBy: "planned — needs a client-side call at the Settings page mount" },
  { name: "pomodoro_manually_overridden", unit: "count (1) — student changed the bandit's suggestion before starting", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "ai_paused_toggled", unit: "1=paused, 0=resumed", bucket: "n/a", wired: true, usedBy: "collected" },
  { name: "app_session_started", unit: "count (1) — app opened/loaded", bucket: "n/a", wired: false, usedBy: "planned — needs a client-side call on initial app load" },
  { name: "integration_connected", unit: "count (1)", bucket: "app name", wired: true, usedBy: "collected" },
  { name: "integration_disconnected", unit: "count (1)", bucket: "app name", wired: true, usedBy: "collected" },
  { name: "pronote_sync", unit: "count (1)", bucket: "n/a", wired: true, usedBy: "collected" },
];

/** Fast lookup for validating a metric name against the catalog — not currently enforced (recordMetric
 *  deliberately accepts an open string so a new call site never needs this file updated first), but useful
 *  for a future audit/report to flag names that drifted from the documented list. */
export const METRIC_NAMES = new Set(METRIC_CATALOG.map((m) => m.name));
