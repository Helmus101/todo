import { newSession, playTurn } from "./lib.mjs";
const S = newSession({ subject: undefined, lang: "en", profile: { name: "Alex", yearLevel: "Year 12", track: "ib", courses: ["Economics HL"] } });
S.task.sourceSubject = undefined;
const msgs = ["hi can you do like let's do like average cost total cost and then you see the profit maximizing point yeah", "yeah so basically marginal cost equals marginal revenue", "it's TC over Q wait can you draw a graph of like all these curves I can really visualize it"];
for (const m of msgs) { const o = await playTurn(S, m, {}); console.log("S:", m.slice(0,80), "\nT:", o.reply?.slice(0, 400), "\n"); }
for (const e of S.board) if (e.graph) console.log(JSON.stringify(e.graph).slice(0, 900));
