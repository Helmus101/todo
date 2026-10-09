// "Look at my whiteboard" — there is no Show-Otto button: the student just tells Otto to look (or draws and asks
// "is this right?"), and Otto reads the ink. This recognises the explicit request so a drawing Otto has already
// seen is re-read on demand ("look again at what I drew", "check my diagram now").
const LOOK = /\b(?:look|check|see|read|view|watch|take a look|have a look|glance|review|tell me|is (?:this|that|it)|comment on|what do you think of|regarde[rz]?|vois|vérifie[rz]?|lis|jette un œil|jette un oeil|dis-moi|c['’]est (?:bon|juste|correct))\b/i;
const BOARD = /\b(?:white ?board|my (?:drawing|diagram|sketch|figure|picture|work|page|board|canvas|graph|triangle)|what i (?:drew|wrote|did)|this (?:drawing|diagram|sketch|figure|page)|tableau|dessin|schéma|croquis|ce que j['’]ai (?:dessiné|écrit|fait))\b/i;
export function asksToLook(message: string): boolean {
  const m = String(message || "");
  return m.length < 400 && LOOK.test(m) && BOARD.test(m);
}
