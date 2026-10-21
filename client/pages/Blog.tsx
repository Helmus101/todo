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

export function BlogIndexBody(): ReactNode {
  return (
    <article className="blog">
      <h1>{"Otto blog: study methods that work"}</h1>
      <p className="blog-lede">{"Short guides to studying, each based on published research on how people learn, with the studies named so you can check them."}</p>
      <ul className="blog-list">
        {POSTS.map((p) => (
          <li key={p.slug}>
            <h2><a href={postPath(p)}>{p.title}</a></h2>
            <p>{p.description}</p>
            <p className="blog-meta">{`${fmt(p.date)} · ${p.minutes} min read`}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

export function BlogPostBody({ post }: { post: Post }): ReactNode {
  const more = POSTS.filter((p) => p.slug !== post.slug).slice(0, 3);
  return (
    <article className="blog">
      <p className="blog-crumbs"><a href="/">{"Otto"}</a>{" / "}<a href="/blog">{"Blog"}</a></p>
      <h1>{post.title}</h1>
      <p className="blog-meta">{`${fmt(post.date)} · ${post.minutes} min read`}</p>
      <Blocks blocks={post.blocks} />
      <aside className="blog-cta">
        <p><b>{"Try it out loud."}</b>{" Otto is a voice tutor with a shared whiteboard: it asks instead of telling, and explains when you are stuck."}</p>
        <a className="btn primary" href="/">{"Start talking"}</a>
      </aside>
      <h2>{"More guides"}</h2>
      <ul className="blog-more">{more.map((p) => <li key={p.slug}><a href={postPath(p)}>{p.title}</a></li>)}</ul>
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
      <main className="legal">{post ? <BlogPostBody post={post} /> : <><h1>{"Page not found"}</h1><p><a href="/blog">{"Back to the blog"}</a></p></>}</main>
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
      <main className="legal"><BlogIndexBody /></main>
    </div>
  );
}
