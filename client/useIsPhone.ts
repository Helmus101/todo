import { useEffect, useState } from "react";

// 767px keeps iPad (smallest portrait width 768px) OUT of "phone" — this is specifically a phone-vs-
// everything-else check, not a general small-screen check. Reactive (matchMedia listener), not a one-time
// innerWidth read at mount, so rotating a phone or resizing a desktop window past the line updates live.
const PHONE_QUERY = "(max-width: 767px)";

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isPhone;
}
