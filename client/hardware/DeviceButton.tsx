import { Usb } from "lucide-react";
import type { DeviceStatus } from "./useArduino.ts";

/** A quiet pill: connect the Arduino companion, or see that it is connected. Hidden where Web Serial doesn't exist. */
export function DeviceButton({ status, onConnect, onDisconnect, en, labelled }: { status: DeviceStatus; onConnect: () => void; onDisconnect: () => void; en: boolean; labelled?: boolean }) {
  if (status === "unsupported") return null;
  const on = status === "connected";
  const label = on ? ("Device connected — click to disconnect") : status === "connecting" ? ("Connecting…") : ("Connect the Otto device (USB)");
  return (
    <button type="button" className={`tutor-device-pill${on ? " is-on" : ""}${labelled ? " labelled" : ""}`} onClick={on ? onDisconnect : onConnect} disabled={status === "connecting"} title={label} aria-label={label} aria-pressed={on}>
      <Usb size={labelled ? 16 : 14} aria-hidden="true" />
      {labelled ? <span>{on ? "Otto device connected" : status === "connecting" ? "Connecting…" : "Connect the Otto device"}</span> : null}
    </button>
  );
}
