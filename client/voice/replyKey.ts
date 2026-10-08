/** Identity of the newest chat message, for "speak each new assistant reply exactly once".
 *  Deliberately NOT based on chat length: the server caps chat history (CHAT_CAP in server/index.ts),
 *  so once a session hits the cap every new turn adds 2 messages and drops 2 — the length stays constant
 *  and a length-based trigger silently never fires again. Reported live as "TTS stops working at random
 *  times / never works again", with nothing in the console because speak() was never even called. */
export function lastMessageKey(chat: { role: string; at?: string; text: string }[] | undefined): string {
  const m = chat?.length ? chat[chat.length - 1] : undefined;
  return m ? `${m.role}|${m.at ?? ""}|${m.text}` : "";
}
