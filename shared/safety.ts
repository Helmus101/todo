// Code-level safety checks on what a student types or says, so the response to a crisis or a jailbreak does not rest on the
// model alone. Deliberately simple: keyword patterns in English, French, Spanish and German. It errs towards noticing, and
// the result is only used to (a) show a fixed help card, (b) tell the tutor privately, (c) keep the "explain now" nudge and the
// training archive away from the moment. The text itself is never stored or sent anywhere by this module.

export type SafetyKind = "crisis" | "sexual" | "violence" | "jailbreak" | "personal";
export interface SafetyHit { kind: SafetyKind }

const CRISIS = [
  /\b(?:kill|hurt|harm|cut)\s+(?:my ?self|me)\b/i,
  /\b(?:want|wanna|going|plan(?:ning)?) to (?:die|disappear|end it)\b/i,
  /\bsuicid\w*/i,
  /\b(?:don'?t|do not) (?:want|wanna) to (?:live|be here|exist)\b/i,
  /\bno (?:point|reason) (?:in )?(?:living|anything|going on)\b|\bdon'?t see the point of (?:anything|living)\b/i,
  /\b(?:better off|everyone.{0,12}better) without me\b/i,
  /\b(?:i )?(?:can'?t|cannot) (?:do|take) this anymore\b/i,
  /\bj'?en peux plus\b(?! de\b)|\bj'?ai envie de (?:mourir|disparaître|disparaitre)\b|\bme (?:tuer|faire du mal|suicider)\b|\bplus envie de vivre\b|\bsuicid\w*/i,
  /\bquiero (?:morir|desaparecer)\b|\bmatarme\b|\bno quiero vivir\b/i,
  /\bich will (?:nicht mehr leben|sterben)\b|\bmich (?:umbringen|töten)\b|\bselbstmord\b/i,
];
const SEXUAL = [
  /\b(?:sex|sexy|nude|nudes|naked|porn\w*|horny|boobs|dick|erotic|nsfw|girlfriend|boyfriend)\b/i,
  /\bsexe\b|\bnu(?:e|es|s)?\b.{0,12}\bphoto\b|\bporno\w*|\bpetite? amie?\b|\bt'?aimer\b|\bsois ma (?:copine|petite amie)\b/i,
  /\b(?:say|tell me) (?:you )?love(?:s)? (?:me|you)\b|\bi love you\b|\bje t'?aime\b/i,
];
const VIOLENCE = [
  /\bhow (?:to|do i|can i) (?:make|build) (?:a )?(?:bomb|weapon|gun|explosive|poison)\b/i,
  /\b(?:kill|shoot|stab|beat up) (?:him|her|them|my teacher|my \w+)\b/i,
  /\bcomment (?:fabriquer|faire) (?:une? )?(?:bombe|arme|poison)\b/i,
];
const JAILBREAK = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompt|guidelines)\b/i,
  /\b(?:print|show|reveal|repeat|tell me)\b[^.\n]{0,30}\b(?:your |the )?(?:system )?(?:prompt|instructions)\b/i,
  /\bDAN\b|\bdeveloper mode\b|\bjailbreak\b|\bmode d[ée]veloppeur\b/i,
  /\b(?:you are now|from now on you|pretend (?:to be|you are)|act as|play the role of|role-?play)\b/i,
  /\b(?:ignore[zr]?|oublie[zr]?)\b[^.\n]{0,30}\b(?:consignes?|instructions?|r[èe]gles?)\b|\btu es maintenant\b|\bfais comme si tu [ée]tais\b/i,
  /\(?\s*private note for you\b|\(typed by the student\b/i,
];
const PERSONAL = [
  /\b(?:my )?(?:password|mot de passe|mdp)\s*(?:is|est|:)\s*\S+/i,
  /\b(?:my )?(?:address|adresse)\s*(?:is|est|:)\s*\d+/i,
  /(?:\+?\d[\s.-]?){10,}/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
];

const test = (list: RegExp[], t: string) => list.some((r) => r.test(t));

/** The most serious thing found in the text, or null. Crisis wins over everything. */
export function classifySafety(text: string): SafetyHit | null {
  const t = String(text || "").slice(0, 2000);
  if (!t.trim()) return null;
  if (test(CRISIS, t)) return { kind: "crisis" };
  if (test(JAILBREAK, t)) return { kind: "jailbreak" };
  if (test(SEXUAL, t)) return { kind: "sexual" };
  if (test(VIOLENCE, t)) return { kind: "violence" };
  if (test(PERSONAL, t)) return { kind: "personal" };
  return null;
}

/** Help lines by language. Where none is known the card says to call the local emergency number. */
const HELP: Record<string, { text: string }> = {
  fr: { text: "Si tu penses à te faire du mal, parle-en maintenant à un adulte de confiance (parent, professeur, infirmière scolaire). En France, le 3114 (prévention du suicide) est gratuit et ouvert 24 h/24 ; en cas de danger immédiat, appelle le 112." },
  en: { text: "If you are thinking about hurting yourself, please talk to a trusted adult now (a parent, teacher or school counsellor). If you are in danger right now, call your local emergency number (112 in Europe, 911 in the US, 999 in the UK). In the US you can call or text 988; in the UK, Samaritans are on 116 123." },
  es: { text: "Si estás pensando en hacerte daño, habla ahora con un adulto de confianza (familia, profesor u orientador). Si estás en peligro, llama al número de emergencias de tu país (112 en Europa). En España, la línea 024 es gratuita las 24 horas." },
  de: { text: "Wenn du daran denkst, dir wehzutun, sprich jetzt mit einer Vertrauensperson (Eltern, Lehrkraft, Schulberatung). Bei akuter Gefahr wähle die Notrufnummer 112. In Deutschland ist die Telefonseelsorge unter 0800 111 0 111 kostenlos erreichbar." },
};
export function crisisCardText(lang: string): string { return (HELP[lang] || HELP.en).text; }
