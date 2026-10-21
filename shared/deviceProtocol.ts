// The line protocol between the Otto web app and the Arduino companion (Mega 2560 over USB serial, 115200 baud).
// One JSON object per line, in both directions. The device only ever sends button presses; the app only ever sends a short
// status word and a few ASCII characters for the display — never answers, never what the student said.

export const DEVICE_BAUD = 115200;
export type DeviceButton = "help" | "next" | "mic";
export type DeviceState = "idle" | "ready" | "listening" | "thinking" | "speaking" | "offline";
export type DeviceIn = { btn: DeviceButton } | { hello: string };
export type DeviceOut = { state: DeviceState } | { lcd: string } | { beep: "ok" | "no" };

const BUTTONS: DeviceButton[] = ["help", "next", "mic"];
const STATES: DeviceState[] = ["idle", "ready", "listening", "thinking", "speaking", "offline"];

/** One line from the device → a message, or null for anything that isn't ours (boot noise, partial lines). */
export function parseDeviceLine(line: string): DeviceIn | null {
  const t = String(line || "").trim();
  if (!t.startsWith("{") || t.length > 200) return null;
  try {
    const j = JSON.parse(t);
    if (j && typeof j.btn === "string" && (BUTTONS as string[]).includes(j.btn)) return { btn: j.btn as DeviceButton };
    if (j && typeof j.hello === "string") return { hello: j.hello.slice(0, 40) };
  } catch { /* not JSON */ }
  return null;
}

/** The text the display can show: plain ASCII, ≤16 characters per row (accents folded, anything else dropped). */
export function lcdText(s: string, max = 16): string {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "'").trim().slice(0, max);
}

/** A message → the exact bytes to write (one line). */
export function encodeDeviceMsg(m: DeviceOut): string {
  if ("state" in m) return JSON.stringify({ state: STATES.includes(m.state) ? m.state : "idle" }) + "\n";
  if ("lcd" in m) return JSON.stringify({ lcd: lcdText(m.lcd) }) + "\n";
  return JSON.stringify({ beep: m.beep === "no" ? "no" : "ok" }) + "\n";
}

/** Serial data arrives in arbitrary chunks: this joins them and hands back whole lines. */
export class LineBuffer {
  private rest = "";
  push(chunk: string): string[] {
    this.rest += chunk;
    const parts = this.rest.split(/\r?\n/);
    this.rest = parts.pop() || "";
    if (this.rest.length > 400) this.rest = ""; // runaway noise: never grow without bound
    return parts.filter(Boolean);
  }
}

/** What the lights should say, from what the tutor page knows. Thinking wins over speaking wins over listening. */
export function deviceStateOf(s: { sending: boolean; speaking: boolean; listening: boolean; active?: boolean }): DeviceState {
  // "ready" = the tutor is on (a call is open) and nothing is happening this instant: the light stays lit.
  return s.sending ? "thinking" : s.speaking ? "speaking" : s.listening ? "listening" : s.active ? "ready" : "idle";
}

/** What a button asks Otto, in the session language. "mic" is not a message: it starts and stops the tutor (see TutorSession). */
export function buttonMessage(b: DeviceButton, en: boolean): string | null {
  if (b === "help") return "I'm stuck — can you give me a hint?";
  if (b === "next") return "Okay, what should we do next?";
  return null;
}
