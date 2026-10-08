import type { TourStep } from "./PageTour.tsx";

/** First-visit page guides. Each step points at a REAL control (selectors match what the page renders); a step whose
 *  target isn't there is skipped. "interactive" steps wait for the student to actually use the control. */
export const TOURS: Record<string, TourStep[]> = {
  tasks: [
    { target: ".dash-head", title: ["Ton plan du jour", "Your plan for today"], body: ["Otto lit Pronote, Gmail et ton agenda, puis range tout par priorité. Ce qui est urgent ET important passe en premier.", "Otto reads Pronote, Gmail and your calendar, then orders everything by priority. What's urgent AND important comes first."] },
    { target: ".add-task-input", title: ["Ajoute n'importe quoi", "Add anything"], body: ["Écris une tâche à ta façon — « réviser le chap. 5 de physique ». Otto la précise, la date et prépare un plan.", "Type a task your own way — “revise physics chapter 5”. Otto sharpens it, dates it and prepares a plan."], action: ["À toi : clique dans le champ.", "Try it: click into the field."], interactive: true },
    { target: ".list .card .card-main", title: ["Ouvre une tâche", "Open a task"], body: ["Chaque tâche a un plan pas à pas, des fiches ou un quiz quand c'est utile, et un bouton pour demander de l'aide au tuteur.", "Each task has a step-by-step plan, flashcards or a quiz when useful, and a way to ask the tutor for help."] },
    { target: ".list .card .card-check", title: ["Coche quand c'est fait", "Tick it when it's done"], body: ["Ta progression du jour se met à jour, et Otto apprend ton rythme.", "Your day's progress updates, and Otto learns your pace."] },
    { target: ".topnav-links", title: ["Le reste d'Otto", "The rest of Otto"], body: ["Tuteur pour apprendre en réfléchissant, Journal pour retenir, Erreurs pour ne plus les refaire, Cours pour ajouter tes documents, Réglages pour tout ajuster. Chaque page te montrera comment elle marche la première fois.", "Tutor to learn by thinking, Journal to remember, Mistakes so you don't repeat them, Coursework for your documents, Settings to tune it all. Each page shows you how it works the first time you open it."] },
  ],
  "tutor-landing": [
    { target: "#tutor-subject-select", title: ["Choisis une matière", "Pick a subject"], body: ["Otto adapte son niveau, ses exemples et même tes documents de cours à la matière choisie.", "Otto adapts his level, examples and even your uploaded coursework to the subject you pick."], action: ["À toi : ouvre la liste.", "Try it: open the list."], interactive: true },
    { target: ".tutor-start-btn", title: ["Lance une séance", "Start a session"], body: ["Une séance = un tableau blanc partagé et Otto qui te pose des questions plutôt que de donner la réponse.", "A session = a shared whiteboard and Otto asking you questions instead of handing you the answer."] },
  ],
  "tutor-session": [
    { target: ".ts-canvas", title: ["Le tableau, c'est votre feuille", "The board is your shared page"], body: ["Otto y écrit l'objectif, les définitions, les formules, ton raisonnement, des exercices et des graphes. Tu peux écrire et dessiner dessus aussi.", "Otto writes the focus, definitions, formulas, your reasoning, exercises and graphs here. You can write and draw on it too."] },
    { target: ".tc-toolbar", title: ["Tes outils", "Your tools"], body: ["Stylo, surligneur, gomme, texte, annuler. Le crayon « main » fait défiler le tableau. Ces outils restent toujours au même endroit.", "Pen, highlighter, eraser, text, undo. The “hand” scrolls the board. These tools always stay in the same place."] },
    { target: "[data-tour='tc-highlighter']", title: ["Essaie le surligneur", "Try the highlighter"], body: ["Surligne ou entoure un passage pour le montrer à Otto.", "Highlight or circle a passage to point it out to Otto."], action: ["À toi : clique le surligneur.", "Try it: click the highlighter."], interactive: true },
    { target: ".otto-dock", title: ["Parle à Otto", "Talk to Otto"], body: ["Tu ne vois que sa dernière réponse, comme face à une vraie personne. Tape, ou parle. Tout ce qui compte reste sur le tableau.", "You only see his latest answer, like talking to a real person. Type, or speak. Everything that matters stays on the board."] },
    { target: ".voice-mic-btn", title: ["Mode vocal", "Voice mode"], body: ["Touche le micro : Otto t'écoute en continu et te répond à voix haute. Touche à nouveau pour couper. Le micro ne s'ouvre jamais sans que tu le demandes.", "Tap the mic: Otto listens hands-free and answers out loud. Tap again to turn it off. The mic never opens unless you ask."] },
    { target: ".otto-quick", title: ["Réponses rapides", "One-tap replies"], body: ["Un indice, « je suis perdu », ou un autre exercice : un toucher suffit.", "A hint, “I'm lost”, or another exercise — one tap is enough."] },
    { title: ["Montrer ton travail à Otto", "Show Otto your work"], body: ["Dessine ou écris sur le tableau, puis « Montrer à Otto » : tu peux lui dire quoi regarder. Il lit ton écriture et réagit à ce que tu as fait.", "Draw or write on the board, then “Show Otto” — you can tell him what to look at. He reads your handwriting and reacts to what you did."] },
    { target: ".tutor-end-btn", title: ["Terminer la séance", "End the session"], body: ["Elle est sauvegardée dans « Nos séances passées », avec le tableau et la conversation.", "It's saved under “Past sessions”, with the board and the conversation."] },
  ],
  journal: [
    { target: ".seg-btn.on", title: ["Journal et cartes", "Journal and flashcards"], body: ["Deux vues : ton journal du jour, et les cartes de révision qu'Otto en tire.", "Two views: your journal for the day, and the flashcards Otto makes from it."] },
    { target: ".studylog-textarea", title: ["Une ligne par jour", "One line a day"], body: ["Écris ce que tu as appris. Otto en fait des cartes, repère ce que tu maîtrises et ce qui reste fragile.", "Write what you learned. Otto turns it into flashcards and spots what you've mastered and what's still shaky."], action: ["À toi : clique et écris un mot.", "Try it: click in and type a word."], interactive: true },
    { target: ".btn.primary", title: ["Enregistrer et réviser", "Save and review"], body: ["Une fois enregistré, les cartes arrivent avec un rythme de révision espacée.", "Once saved, the cards arrive on a spaced-review schedule."] },
  ],
  mistakes: [
    { target: ".dash-head", title: ["Tes erreurs, utiles", "Your mistakes, made useful"], body: ["Note chaque erreur précise : la question, ta réponse, ce qui s'est passé, ce qu'il faut faire. Otto s'en sert pour t'interroger là où tu bloques.", "Log each precise mistake: the question, your answer, what happened, what to do next time. Otto uses them to quiz you where you slip."] },
    { target: ".btn.primary", title: ["Ajouter une erreur", "Add a mistake"], body: ["Ça prend dix secondes. Les erreurs sont regroupées par matière.", "It takes ten seconds. Mistakes are grouped by subject."] },
  ],
  coursework: [
    { target: ".cw-chips", title: ["1 · La matière", "1 · The subject"], body: ["Chaque document appartient à une matière : le tuteur ne s'en sert que dans la bonne matière.", "Each document belongs to a subject: the tutor only uses it in the right subject."], action: ["À toi : choisis une matière.", "Try it: pick a subject."], interactive: true },
    { target: ".cw-drop", title: ["2 · Le document", "2 · The document"], body: ["PDF, photo ou texte. Otto lit seulement les premières pages (6 max), en fait un résumé, et le fichier reste sur ton appareil. Si c'est une feuille d'exercices, il crée des tâches.", "PDF, photo or text. Otto reads only the first pages (6 max), summarizes them, and the file stays on your device. If it's a worksheet, he creates tasks from it."] },
    { target: ".cw-library", title: ["Ta bibliothèque", "Your library"], body: ["Les résumés servent dans le chat et avec le tuteur : « dans ta fiche sur… ». Supprime un document quand tu veux.", "The summaries are used in chat and with the tutor: “in your worksheet on…”. Remove a document any time."] },
  ],
  settings: [
    { target: ".settings-sec", title: ["Tout se règle ici", "Everything is tuned here"], body: ["Compte, connexions (Pronote, Gmail…), langue, parcours, et ce qu'Otto sait de toi — tu peux tout voir et tout effacer.", "Account, connections (Pronote, Gmail…), language, track, and what Otto knows about you — you can see and erase all of it."] },
    { target: "[data-tour='replay-onboarding']", title: ["Revoir la visite", "Replay the tour"], body: ["« Tester l'onboarding » rejoue l'accueil et tous les guides de page.", "“Test onboarding” replays the welcome and every page guide."] },
  ],
};
