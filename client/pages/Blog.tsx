import type { ReactNode } from "react";
import { POSTS, postBySlug, postPath, type Block, type Post } from "../../shared/blog.ts";

/** The blog's page bodies, shared by the browser and the build-time prerender (scripts/prerender-landing.tsx), so the
 *  static HTML a search engine reads is exactly what the app shows. Plain links, no client state. */
const fmt = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.t === "h2" ? <h2 key={i}>{b.text}</h2>
        : b.t === "p" ? <p key={i}>{b.text}</p>
        : <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>)}
    </>
  );
}

const tagOf = (p: Post) => (p.kind === "guide" ? "IB guide" : "Study method");

function Card({ p, featured }: { p: Post; featured?: boolean }) {
  return (
    <li className={`blog-card${featured ? " featured" : ""}`}>
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

export function BlogIndexBody(): ReactNode {
  // The newest IB guide leads; everything else follows in the order it was written.
  const lead = POSTS.find((p) => p.kind === "guide") || POSTS[0];
  return (
    <article className="blog">
      <p className="blog-eyebrow">{"The Otto blog"}</p>
      <h1>{"Study methods that work"}</h1>
      <p className="blog-lede">{"Study methods based on published research, with the studies named so you can check them, and guides to the IB Diploma: command terms, past papers, the Extended Essay and the points."}</p>
      <ul className="blog-list">
        <Card p={lead} featured />
        {POSTS.filter((p) => p !== lead).map((p) => <Card key={p.slug} p={p} />)}
      </ul>
    </article>
  );
}

export function BlogPostBody({ post }: { post: Post }): ReactNode {
  const more = POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);
  return (
    <article className="blog blog-post">
      <p className="blog-crumbs"><a href="/">{"Otto"}</a>{" / "}<a href="/blog">{"Blog"}</a></p>
      <div className="blog-post-head">
        <span className={`blog-tag${post.kind === "guide" ? " guide" : ""}`}>{tagOf(post)}</span>
        <span className="blog-meta">{`${fmt(post.date)} · ${post.minutes} min read`}</span>
      </div>
      <h1>{post.title}</h1>
      <div className="blog-body"><Blocks blocks={post.blocks} /></div>
      <aside className="blog-cta">
        <p><b>{"Try it out loud."}</b>{" Otto is a voice tutor with a shared whiteboard: it asks instead of telling, and explains when you are stuck."}</p>
        <a className="btn primary" href="/signup">{"Start talking"}</a>
      </aside>
      <h2 className="blog-more-head">{"More guides"}</h2>
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
