
import { useLang } from "../ui.tsx";
import { LEGAL_EMAIL, LEGAL_ENTITY, Logo } from "../appShared.tsx";

const LEGAL_JURISDICTION = "France";

export function PrivacyBody() {
  const L = useLang();
  return (
    <>
      <h1>{"Privacy Policy"}</h1>
      <p>{`Otto ("we", "us") is a to-do assistant that reads the apps you connect and prepares work for you. This policy explains what we access, why, and your choices. Otto is operated by ${LEGAL_ENTITY}.`}</p>

      <h2>{"What we access"}</h2>
      <p>{"Only the apps you explicitly connect, and only to do the work you asked for:"}</p>
      <ul>
        <li><b>Gmail</b> — {"to read recent threads and prepare draft replies. Otto creates drafts; it never sends, deletes, or modifies mail on its own."}</li>
        <li><b>Google Calendar</b> — {"to read events and prepare drafts of new events for your review."}</li>
        <li><b>Google Drive / Docs / Sheets / Slides</b> — {"to read relevant files and create documents it makes for you. Otto only ever edits a document it created itself — it never modifies a file that's already yours."}</li>
        <li><b>Pronote</b> ({"optional, unofficial — no official Pronote API exists"}) — {"read-only, to see homework due dates. Otto never writes anything back to Pronote."}</li>
        <li>{"Other integrations you connect"} — {"accessed only for the tasks they relate to."}</li>
      </ul>
      <p>{"Otto performs autonomously the work that is "}<b>{"reversible"}</b>{" (drafts, documents, research). Anything irreversible — sending an email, posting, inviting, deleting, or paying — is "}<b>{"never"}</b>{" done without your explicit confirmation. It also never edits a document, sheet, or slide deck that it didn't create — only your own files, never Otto's."}</p>

      <h2>{"What we store"}</h2>
      <ul>
        <li>{"Your account email and a securely hashed password (we never store your password in plain text)."}</li>
        <li>{"The tasks Otto generates and a profile of facts it learns to do better work (people, projects, preferences) — you can view and delete these any time in Settings."}</li>
        <li>{"If you connect Pronote: your Pronote username, password and session token, encrypted (AES-256-GCM), to reconnect you automatically. Deleted when you disconnect Pronote."}</li>
        <li>{"Approximate AI-usage counts for showing your monthly usage."}</li>
      </ul>
      <p>{"We do not sell your data, use it for advertising, or use your content to train foundation models."}</p>

      <h2>{"Service providers"}</h2>
      <p>{"Otto shares data with the processors needed to run the service, under their terms:"}</p>
      <ul>
        <li><b>Composio</b> — {"brokers the OAuth connections to your apps and executes read/write actions on your behalf."}</li>
        <li><b>DeepSeek</b> — {"the AI model that reads context and drafts the work. Relevant content is sent to generate each task/draft."}</li>
        <li><b>Supabase</b> — {"stores your account, tasks, and profile."}</li>
        <li>{"Hosting/infrastructure providers that run the app."}</li>
      </ul>

      <h2>{"Retention & deletion"}</h2>
      <p>{`Your data is kept for as long as your account exists — we don't automatically delete it after a period of inactivity; deleting it when you're done is up to you. You're in control, with no email-and-wait required: clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time (revokes Otto's access immediately), download everything stored about you via Settings → "Download my data", or permanently delete your account and everything with it via Settings → "Delete everything" — instant, self-serve, and irreversible.`}</p>

      <h2>{"Security"}</h2>
      <p>{"Google and other OAuth-based connections mean we never see your app passwords. Pronote is the one exception — it has no OAuth, so we keep your Pronote username and password encrypted (AES-256-GCM) alongside the session token Pronote issues, to reconnect you automatically when that token expires. The password is never logged or shown, and it is deleted when you disconnect Pronote or delete your account. Data is transmitted over HTTPS and access is scoped to your account. No system is perfectly secure, but we take reasonable measures to protect your information."}</p>

      <h2>{"Google API disclosure"}</h2>
      <p>{"Otto's use of information received from Google APIs adheres to the "}<a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">{"Google API Services User Data Policy"}</a>{", including the Limited Use requirements."}</p>

      <h2>{"Your rights (GDPR)"}</h2>
      <p>{`If you're in the EU/EEA, GDPR gives you the right to access, correct, export (portability), or delete (erasure) your data, and to object to or restrict how it's processed. The first three are self-serve in Settings, right now, with no request needed; for anything else, or if you're elsewhere and want the same, contact ${LEGAL_EMAIL} and we'll handle it directly. Our legal basis for processing is performing the service you asked for (contract) plus our legitimate interest in making Otto work well for you.`}</p>

      <h2>{"International transfers"}</h2>
      <p>{`Your data is processed by providers based outside ${LEGAL_JURISDICTION} (including the US and elsewhere) — Composio, DeepSeek, Supabase, and our hosting provider. We only use providers that commit contractually to protecting your data (e.g. standard contractual clauses where applicable) to the standard GDPR requires.`}</p>

      <h2>{"Age"}</h2>
      <p>{`Otto is built with students in mind, but opening an account requires being old enough to consent to data processing on your own (15 in ${LEGAL_JURISDICTION}); younger than that, a parent or guardian should set it up and stay involved.`}</p>

      <h2>{"Changes & contact"}</h2>
      <p>{`We'll update this policy as the service evolves and note the date above. Questions or anything not covered here: ${LEGAL_EMAIL}.`}</p>
    </>
  );
}

export function TermsBody() {
  const L = useLang();
  return (
    <>
      <h1>{"Terms of Service"}</h1>
      <p>{`By using Otto, operated by ${LEGAL_ENTITY}, you agree to these terms.`}</p>

      <h2>{"The service"}</h2>
      <p>{"Otto reads the apps you connect and prepares work — drafts, documents, and organized tasks. It performs reversible actions autonomously and asks for your confirmation before anything irreversible (sending, posting, inviting, deleting, paying). You are responsible for reviewing anything Otto prepares before you act on it."}</p>

      <h2>{"Your responsibilities"}</h2>
      <ul>
        <li>{"Keep your account credentials secure and provide accurate information."}</li>
        <li>{"Only connect accounts you are authorized to use."}</li>
        <li>{"Use Otto lawfully and not to send spam, harass, or violate others' rights or the connected apps' terms."}</li>
      </ul>

      <h2>{"AI-generated content — review everything"}</h2>
      <p>{"Otto uses AI, which can be inaccurate, incomplete, or wrong. Every draft, document, and suggestion is a starting point that "}<b>{"you must review and verify"}</b>{" before sending, saving, or relying on it. You are solely responsible for anything you choose to send, publish, or act upon. Otto only prepares reversible work and asks for your confirmation before anything irreversible; the decision — and its consequences — are yours."}</p>

      <h2>{"No warranty"}</h2>
      <p>{"The service is provided \"as is\" and \"as available\", without warranties of any kind, whether express, implied, or statutory — including any implied warranties of merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not warrant that Otto will be uninterrupted, error-free, secure, or that its output will be correct or suitable for any purpose. You use it at your own risk."}</p>

      <h2>{"Limitation of liability"}</h2>
      <p>{`To the fullest extent permitted by applicable law, ${LEGAL_ENTITY} and anyone involved in providing Otto shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, nor for any loss of data, profits, revenue, goodwill, missed communications, mistaken sends, or business interruption, arising out of or relating to your use of (or inability to use) Otto or anything it prepares or does — even if advised of the possibility. To the fullest extent permitted by law, our total aggregate liability for all claims relating to the service will not exceed the greater of the amount you paid us in the 12 months before the claim, or €50. Nothing in these terms excludes liability that cannot be excluded under applicable law.`}</p>

      <h2>{"Your data & your responsibility"}</h2>
      <p>{`You are responsible for the accounts and content you connect and for ensuring you have the right to do so. You act as the controller of the personal data in your connected accounts; Otto processes it only to provide the service, as described in the Privacy Policy. You agree to indemnify and hold ${LEGAL_ENTITY} harmless from any claims, losses, or expenses arising from your use of Otto, your content, or your breach of these terms or of any third party's rights or terms.`}</p>

      <h2>{"Availability & changes"}</h2>
      <p>{"Otto is an independent tool and is not endorsed by or affiliated with Google, or any other integrated provider. We may change, suspend, limit (including via a monthly AI budget), or discontinue any part of the service at any time without liability."}</p>

      <h2>{"Termination"}</h2>
      <p>{"You may stop using Otto and delete your account at any time. We may suspend or terminate accounts that violate these terms or that create risk or legal exposure."}</p>

      <h2>{"Governing law & contact"}</h2>
      <p>{`These terms are governed by the laws of ${LEGAL_JURISDICTION}, without regard to conflict-of-laws rules, and the courts of ${LEGAL_JURISDICTION} have jurisdiction, except where mandatory local consumer law provides otherwise. If any provision is held unenforceable, the rest remains in effect. Questions: ${LEGAL_EMAIL}.`}</p>
    </>
  );
}

export function ResearchPageBody() {
  const L = useLang();
  return (
    <div className="landing research-page">
      <header className="landing-nav-framer">
        <a className="brand-framer" href="/"><Logo size={20} /> <span className="brand-name-framer">otto</span></a>
        <nav className="landing-navlinks-framer">
          <a className="btn ghost-framer" href="/">{"Home"}</a>
        </nav>
      </header>
      <main className="research-main">
        {/* The mission statement leads the page, set in the same serif display face as the landing hero —
            this page is the philosophy, typeset like a manifesto, not a plain article. */}
        <p className="micro-label accent">{"Research"}</p>
        <h1 className="research-title">{"Made for learning, not shortcuts."}</h1>
        <p className="research-intro">
          {"Most AI tutors promise to teach. Under pressure, they hand over the answer. Otto is a voice tutor built on four methods that make handing over the answer harder than helping you learn."}
        </p>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>01</p>
          <h2 className="research-sec-title">{"Socratic questioning"}</h2>
        <p className="research-sec-body">
          {"Otto never states the conclusion of your problem — you do. It finds exactly where you're stuck, gives one hint at a time, then asks you to say it back in your own words. When you genuinely need an idea explained, it explains it plainly, then hands the thinking straight back to you."}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>02</p>
          <h2 className="research-sec-title">{"Check on a fresh example"}</h2>
        <p className="research-sec-body">
          {"A right answer isn't proof you understand. Before moving on, Otto gives you a new case. A mistake is treated as a clue: it finds the belief behind it, tests it with a small example, and asks you to revise your own idea."}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>03</p>
          <h2 className="research-sec-title">{"Talking it through"}</h2>
        <p className="research-sec-body">
          {"Reading an answer teaches you almost nothing. Explaining your reasoning out loud teaches you the most. That is why Otto is a voice tutor: every reply is one short question that pulls you one level deeper — never shallower."}
        </p>
        <p className="research-sec-body">
          {"Saying it out loud works for three reasons the research keeps finding:"}
        </p>
        <p className="research-sec-body">
          {"You learn more from explaining than from reading. Students who explained worked examples to themselves, aloud, solved later problems better than students who only read them (Chi et al., 1989)."}
        </p>
        <p className="research-sec-body">
          {"What you say is remembered better. Words read aloud are remembered better than the same words read silently — the production effect (MacLeod et al., 2010)."}
        </p>
        <p className="research-sec-body">
          {"Speaking shows you your own gaps. People feel they understand how things work until they have to explain it step by step, and then they find out they don't (Rozenblit & Keil, 2002). Otto uses exactly that moment to ask the next question."}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>04</p>
          <h2 className="research-sec-title">{"A shared board and a memory"}</h2>
        <p className="research-sec-body">
          {"Otto writes the problem, your correct steps and the pictures on a shared whiteboard, so the working stays in front of you while you talk. It remembers your past sessions, tasks and workbooks, so each session starts where you left off."}
        </p>
        </section>

        <section className="research-sec research-sec-closing">
          <h2 className="research-sec-title">{"What this doesn't mean"}</h2>
          <p className="research-sec-body">
            {"Otto can still be wrong — a language model is a language model. If something it says doesn't add up, say so out loud and it will go back over it with you."}
          </p>
        </section>

        <a className="legal-back" href="/">{"← Back to Otto"}</a>
      </main>
      <footer className="legal-foot">
        <span className="foot-mit">© 2026 Otto</span>
      </footer>
    </div>
  );
}
