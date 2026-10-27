import { useEffect, useState, type ReactNode } from "react";
import { POSTS, postBySlug, postPath, type Block, type Post } from "../../shared/blog.ts";

/** The blog's page bodies, shared by the browser and the build-time prerender (scripts/prerender-landing.tsx), so the
 *  static HTML a search engine reads is exactly what the app shows. Plain links, no client state. */
const fmt = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const OTTO_FITS = "Where Otto fits";

function Blocks({ blocks }: { blocks: Block[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.t === "h2" && b.text === OTTO_FITS) {
      // The closing note about Otto is set apart as a callout.
      const next = blocks[i + 1];
      out.push(<aside key={i} className="blog-otto" id={slugOf(b.text)}><p className="blog-otto-label">{b.text}</p>{next?.t === "p" && <p>{next.text}</p>}</aside>);
      if (next?.t === "p") i++;
    } else if (b.t === "h2") out.push(<h2 key={i} id={slugOf(b.text)}>{b.text}</h2>);
    else if (b.t === "p") out.push(<p key={i}>{b.text}</p>);
    else out.push(<ul key={i}>{b.items.map((x, k) => <li key={k}>{x}</li>)}</ul>);
  }
  return <>{out}</>;
}

const tagOf = (p: Post) => (p.kind === "guide" ? "IB guide" : "Study method");

function Card({ p, featured, n }: { p: Post; featured?: boolean; n?: number }) {
  return (
    <li className={`blog-card${featured ? " featured" : ""}`}>
      {n !== undefined && <span className="blog-card-num" aria-hidden>{String(n).padStart(2, "0")}</span>}
      <div className="blog-card-top">
        <span className={`blog-tag${p.kind === "guide" ? " guide" : ""}`}>{tagOf(p)}</span>
        <span className="blog-card-arrow" aria-hidden>{"→"}</span>
      </div>
      <h2><a href={postPath(p)}>{p.title}</a></h2>
      <p>{p.description}</p>
      <p className="blog-meta">{`${fmt(p.date)} · ${p.minutes} min read`}</p>
    </li>
  );
}

type Filter = "all" | "guide" | "method";

export function BlogIndexBody(): ReactNode {
  const [filter, setFilter] = useState<Filter>("all");
  const guides = POSTS.filter((p) => p.kind === "guide").length;
  const shown = POSTS.filter((p) => filter === "all" || (filter === "guide" ? p.kind === "guide" : p.kind !== "guide"));
  // The newest IB guide leads when it is in the list; everything else follows in the order it was written.
  const lead = filter === "method" ? undefined : shown.find((p) => p.kind === "guide") || shown[0];
  const rest = shown.filter((p) => p !== lead);
  const tabs: [Filter, string][] = [["all", `All ${POSTS.length}`], ["guide", `IB guides ${guides}`], ["method", `Study methods ${POSTS.length - guides}`]];
  return (
    <article className="blog">
      <p className="blog-eyebrow">{"The Otto blog"}</p>
      <h1>{"Study smarter, with the evidence."}</h1>
      <p className="blog-lede">{"Study methods based on published research, with the studies named so you can check them, and guides to the IB Diploma: command terms, past papers, the Extended Essay and the points."}</p>
      <div className="blog-tabs" role="tablist" aria-label="Filter posts">
        {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={`blog-tab${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{label}</button>)}
      </div>
      <ul className="blog-list">
        {lead && <Card p={lead} featured />}
        {rest.map((p, i) => <Card key={p.slug} p={p} n={i + 1} />)}
      </ul>
    </article>
  );
}

/** A thin bar under the nav that fills as the post is read. Browser only; the prerendered page shows it empty. */
function ReadingProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const on = () => { const h = document.documentElement; const max = h.scrollHeight - h.clientHeight; setPct(max > 0 ? Math.min(100, (h.scrollTop / max) * 100) : 0); };
    on(); window.addEventListener("scroll", on, { passive: true }); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); };
  }, []);
  return <div className="blog-progress" aria-hidden><div style={{ width: `${pct}%` }} /></div>;
}

export function BlogPostBody({ post }: { post: Post }): ReactNode {
  // Same kind of post first (a guide leads to more guides), then the rest.
  const others = POSTS.filter((p) => p.slug !== post.slug);
  const more = [...others.filter((p) => p.kind === post.kind), ...others.filter((p) => p.kind !== post.kind)].slice(0, 3);
  return (
    <article className="blog blog-post">
      <ReadingProgress />
      <p className="blog-crumbs"><a href="/">{"Otto"}</a>{" / "}<a href="/blog">{"Blog"}</a></p>
      <div className="blog-post-head">
        <span className={`blog-tag${post.kind === "guide" ? " guide" : ""}`}>{tagOf(post)}</span>
        <span className="blog-meta">{`${fmt(post.date)} · ${post.minutes} min read`}</span>
      </div>
      <h1>{post.title}</h1>
      <p className="blog-dek">{post.description}</p>
      <nav className="blog-toc" aria-label="In this guide">
        <span>{"In this guide"}</span>
        {post.blocks.filter((x): x is Extract<Block, { t: "h2" }> => x.t === "h2").map((x) => <a key={x.text} href={`#${slugOf(x.text)}`}>{x.text}</a>)}
      </nav>
      <div className="blog-body"><Blocks blocks={post.blocks} /></div>
      <aside className="blog-cta">
        <p><b>{"Try it out loud."}</b>{" Otto is a voice tutor with a shared whiteboard: it asks instead of telling, and explains when you are stuck."}</p>
        <a className="btn primary" href="/signup">{"Start talking"}</a>
      </aside>
      <h2 className="blog-more-head">{"Keep reading"}</h2>
      <ul className="blog-more">{more.map((p) => <Card key={p.slug} p={p} />)}</ul>
    </article>
  );
}

export function BlogPostPage({ slug }: { slug: string }): ReactNode {
  const post = postBySlug(slug);
  return (
    <div className="landing legal-page">
      <header className="landing-nav glass-nav">
        <a className="brand" href="/">{"Otto"}</a>
        <nav className="landing-navlinks"><a className="btn ghost" href="/research">{"Approach"}</a><a className="btn ghost" href="/blog">{"Blog"}</a></nav>
      </header>
      <main className="legal blog-page">{post ? <BlogPostBody post={post} /> : <><h1>{"Page not found"}</h1><p><a href="/blog">{"Back to the blog"}</a></p></>}</main>
    </div>
  );
}

export function BlogIndexPage(): ReactNode {
  return (
    <div className="landing legal-page">
      <header className="landing-nav glass-nav">
        <a className="brand" href="/">{"Otto"}</a>
        <nav className="landing-navlinks"><a className="btn ghost" href="/research">{"Approach"}</a><a className="btn ghost" href="/blog">{"Blog"}</a></nav>
      </header>
      <main className="legal blog-page"><BlogIndexBody /></main>
    </div>
  );
}
