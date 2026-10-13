// The AI layer's public surface. Implementation lives in server/ai/:
//   client      providers (DeepSeek / Gemini / NVIDIA), retries, JSON + tool-call parsing
//   context     prompt context blocks (profile, academics, assignment, track, exam style, …)
//   generate    finding tasks in connected sources, refining manual tasks
//   run         executing a task (agent loop) and finalising its steps/links/artifacts
//   steps       step/link cleanup and contamination guards
//   tools       tool schemas offered to the model
//   board       building and validating board entries, notes, decks, quizzes, problems
//   chat        task chat and the tutor (chatAboutTask, studyHelp, tutorOpener)
//   studyContent journal cards, practice problems, weekly/monthly decks, student model, themes
//   voice       text-to-speech and image description
//   coursework, scheduling
export * from "./ai/client.ts";
export * from "./ai/context.ts";
export * from "./ai/generate.ts";
export * from "./ai/run.ts";
export * from "./ai/steps.ts";
export * from "./ai/tools.ts";
export * from "./ai/board.ts";
export * from "./ai/chat.ts";
export * from "./ai/studyContent.ts";
export * from "./ai/voice.ts";
export * from "./ai/coursework.ts";
export * from "./ai/scheduling.ts";
