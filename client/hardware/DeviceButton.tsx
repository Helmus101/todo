import { Usb } from "lucide-react";
import type { DeviceStatus } from "./useArduino.ts";

/** A quiet pill: connect the Arduino companion, or see that it is connected. Hidden where Web Serial doesn't exist. */
export function DeviceButton({ status, onConnect, onDisconnect, en }: { status: DeviceStatus; onConnect: () => void; onDisconnect: () => void; en: boolean }) {
  if (status === "unsupported") return null;
  const on = status === "connected";
  const label = on ? (en ? "Device connected — click to disconnect" : "Boîtier connecté — cliquer pour déconnecter") : status === "connecting" ? (en ? "Connecting…" : "Connexion…") : (en ? "Connect the Otto device (USB)" : "Connecter le boîtier Otto (USB)");
  return (
    <button type="button" className={`tutor-device-pill${on ? " is-on" : ""}`} onClick={on ? onDisconnect : onConnect} disabled={status === "connecting"} title={label} aria-label={label} aria-pressed={on}>
      <Usb size={14} aria-hidden="true" />
    </button>
  );
}
