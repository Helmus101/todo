import { useEffect, useState } from "react";
import { api } from "../api.ts";

type T = { name: string; level: string; text: string };

/** Real, consented, reviewed student quotes (Settings → Feedback). Renders NOTHING until at least one exists, so the
 *  landing page never carries a placeholder or an invented review — and no review structured data is emitted. */
export function Testimonials() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => { let off = false; void api.testimonials().then((r) => { if (!off) setItems(r.testimonials); }); return () => { off = true; }; }, []);
  if (!items.length) return null;
  return (
    <section className="landing-quotes" aria-label="What students say">
      <h2>{"What students say"}</h2>
      <div className="landing-quotes-list">
        {items.map((q, i) => (
          <figure key={i}>
            <blockquote>{`“${q.text}”`}</blockquote>
            <figcaption>{q.name}{q.level ? `, ${q.level}` : ""}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
