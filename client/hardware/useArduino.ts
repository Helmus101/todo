import { useCallback, useEffect, useRef, useState } from "react";
import { DEVICE_BAUD, LineBuffer, encodeDeviceMsg, parseDeviceLine, type DeviceButton, type DeviceOut } from "../../shared/deviceProtocol.ts";

// Web Serial (Chrome / Edge, https or localhost). The device is optional: every failure leaves the app working as before.
export type DeviceStatus = "unsupported" | "disconnected" | "connecting" | "connected";

export function useArduino(onButton: (b: DeviceButton) => void) {
  const serial = typeof navigator !== "undefined" ? (navigator as any).serial : undefined;
  const [status, setStatus] = useState<DeviceStatus>(serial ? "disconnected" : "unsupported");
  const portRef = useRef<any>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const cbRef = useRef(onButton);
  cbRef.current = onButton;
  const lastBtnRef = useRef(0);

  const close = useCallback(async () => {
    try { await readerRef.current?.cancel(); } catch { /* already closed */ }
    try { writerRef.current?.releaseLock(); } catch { /* already released */ }
    try { await portRef.current?.close(); } catch { /* already closed */ }
    readerRef.current = null; writerRef.current = null; portRef.current = null;
    setStatus(serial ? "disconnected" : "unsupported");
  }, [serial]);

  const send = useCallback((m: DeviceOut) => {
    const w = writerRef.current;
    if (!w) return;
    w.write(new TextEncoder().encode(encodeDeviceMsg(m))).catch(() => { void close(); });
  }, [close]);

  /** Must be called from a click (the browser asks which port). */
  const connect = useCallback(async () => {
    if (!serial || status === "connecting" || status === "connected") return;
    setStatus("connecting");
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: DEVICE_BAUD });
      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      setStatus("connected");
      // The Mega resets when the port opens; give the bootloader time before the first state goes out.
      await new Promise((r) => setTimeout(r, 2000));
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const dec = new TextDecoder();
      const buf = new LineBuffer();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const line of buf.push(dec.decode(value))) {
              const m = parseDeviceLine(line);
              if (m && "btn" in m && Date.now() - lastBtnRef.current > 250) { lastBtnRef.current = Date.now(); cbRef.current(m.btn); }
            }
          }
        } catch { /* cable pulled */ }
        void close();
      })();
    } catch {
      await close(); // cancelled the picker, port busy, no permission
    }
  }, [serial, status, close]);

  useEffect(() => () => { void close(); }, [close]);
  return { status, connect, disconnect: close, send };
}
