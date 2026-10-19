import type { TourStep } from "./PageTour.tsx";

/** First-visit page guides. Each step points at a REAL control (selectors match what the page renders); a step whose
 *  target isn't there is skipped. "interactive" steps wait for the student to actually use the control. */
export const TOURS: Record<string, TourStep[]> = {
  tasks: [
    { target: ".dash-head", title: "Your plan for today", body: "Otto reads Pronote, Gmail and your calendar, then orders everything by priority. What's urgent AND important comes first." },
    { target: ".add-task-input", title: "Add anything", body: "Type a task your own way — “revise physics chapter 5”. Otto sharpens it, dates it and prepares a plan.", action: "Try it: click into the field.", interactive: true },
    { target: ".list .card .card-main", title: "Open a task", body: "Each task has a step-by-step plan, flashcards or a quiz when useful, and a way to ask the tutor for help." },
    { target: ".list .card .card-check", title: "Tick it when it's done", body: "Your day's progress updates, and Otto learns your pace." },
    { target: ".topnav-links", title: "The rest of Otto", body: "Tutor to learn by thinking, Journal to remember, Mistakes so you don't repeat them, Coursework for your documents, Settings to tune it all. Each page shows you how it works the first time you open it." },
  ],
  "tutor-landing": [
    { target: "#tutor-opening", title: "Tell Otto what you're working on", body: "Paste a problem, name a topic or say what's blocking you — Otto works out the subject on his own.", action: "Try it: type a sentence.", interactive: true },
    { target: ".tutor-start-btn", title: "Start a session", body: "A session = a shared whiteboard and Otto asking you questions instead of handing you the answer." },
  ],
  "tutor-session": [
    { target: ".ts-canvas", title: "The board is your shared page", body: "Otto writes the focus, definitions, formulas, your reasoning, exercises and graphs here. You can write and draw on it too." },
    { target: ".tc-toolbar", title: "Your tools", body: "Pen, highlighter, eraser, text, undo. The “hand” scrolls the board. These tools always stay in the same place." },
    { target: "[data-tour='tc-highlighter']", title: "Try the highlighter", body: "Highlight or circle a passage to point it out to Otto.", action: "Try it: click the highlighter.", interactive: true },
    { target: ".otto-dock", title: "Talk to Otto", body: "You only see his latest answer, like talking to a real person. Type, or speak. Everything that matters stays on the board." },
    { target: ".voice-mic-btn", title: "Voice mode", body: "Tap the mic: Otto listens hands-free and answers out loud. Tap again to turn it off. The mic never opens unless you ask." },
    { target: ".otto-quick", title: "One-tap replies", body: "A hint, “I'm lost”, or another exercise — one tap is enough." },
    { title: "Show Otto your work", body: "Draw or write on the board, then “Show Otto” — you can tell him what to look at. He reads your handwriting and reacts to what you did." },
    { target: ".tutor-end-btn", title: "End the session", body: "It's saved under “Past sessions”, with the board and the conversation." },
  ],
  journal: [
    { target: ".seg-btn.on", title: "Journal and flashcards", body: "Two views: your journal for the day, and the flashcards Otto makes from it." },
    { target: ".studylog-textarea", title: "One line a day", body: "Write what you learned. Otto turns it into flashcards and spots what you've mastered and what's still shaky.", action: "Try it: click in and type a word.", interactive: true },
    { target: ".btn.primary", title: "Save and review", body: "Once saved, the cards arrive on a spaced-review schedule." },
  ],
  mistakes: [
    { target: ".dash-head", title: "Your mistakes, made useful", body: "Log each precise mistake: the question, your answer, what happened, what to do next time. Otto uses them to quiz you where you slip." },
    { target: ".btn.primary", title: "Add a mistake", body: "It takes ten seconds. Mistakes are grouped by subject." },
  ],
  coursework: [
    { target: ".cw-chips", title: "1 · The subject", body: "Each document belongs to a subject: the tutor only uses it in the right subject.", action: "Try it: pick a subject.", interactive: true },
    { target: ".cw-drop", title: "2 · The document", body: "PDF, photo or text. Otto reads only the first pages (6 max), summarizes them, and the file stays on your device. If it's a worksheet, he creates tasks from it." },
    { target: ".cw-library", title: "Your library", body: "The summaries are used in chat and with the tutor: “in your worksheet on…”. Remove a document any time." },
  ],
  settings: [
    { target: ".settings-sec", title: "Everything is tuned here", body: "Account, connections (Pronote, Gmail…), language, track, and what Otto knows about you — you can see and erase all of it." },
    { target: "[data-tour='replay-onboarding']", title: "Replay the tour", body: "“Test onboarding” replays the welcome and every page guide." },
  ],
};
