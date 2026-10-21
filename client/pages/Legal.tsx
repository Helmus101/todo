
import { useLang } from "../ui.tsx";
import { LEGAL_EMAIL, LEGAL_ENTITY, Logo } from "../appShared.tsx";

const LEGAL_JURISDICTION = "France";

export function PrivacyBody() {
  const L = useLang();
  return (
    <>
      <h1>{"Privacy Policy"}</h1>
      <p>{`Otto ("we", "us") is a voice tutor with a shared whiteboard: you talk through a problem, Otto asks questions, explains when you need it, and writes the working on paper as you go. This policy explains what we access, why, and your choices. Otto is operated by ${LEGAL_ENTITY}.`}</p>

      <h2>{"What happens when you talk to Otto"}</h2>
      <ul>
        <li><b>{"Your voice."}</b> {"The microphone is only used after you tap to start a call. During the call your browser streams your audio directly to the live-voice provider (Google Gemini Live, or OpenAI Realtime as a fallback) with a short-lived credential our server creates for you. Our servers do not receive or store your audio."}</li>
        <li><b>{"Transcripts."}</b> {"The provider returns a transcript of what you and Otto said. We send short pieces of that conversation, and the lines already on your board, to an AI model (DeepSeek or Google) so it can write the board for you and answer anything you type."}</li>
        <li><b>{"Your drawings."}</b> {"If you draw on the board, a picture of it is sent to the voice provider so Otto can see it, and, when you ask Otto to look, to Google's image-reading service."}</li>
        <li><b>{"Memory."}</b> {"To start where you left off, short notes from your earlier sessions, and (for accounts that use the rest of the app) your tasks, journal and coursework, are included in what Otto is told about you. Nothing is added that you did not provide."}</li>
      </ul>

      <h2>{"What stays on your device"}</h2>
      <p>{"Your tutoring sessions — the conversation, the board, your drawings and the session summaries — are saved only in this browser (local storage). They are not copied to our servers and do not follow you to another device. Clearing this site's data, or using private browsing, erases them. You can delete any past session from the sessions list at any time."}</p>

      <h2>{"What we store on our servers"}</h2>
      <ul>
        <li>{"Your account email and a securely hashed password (we never store your password in plain text)."}</li>
        <li>{"A small profile of facts that help Otto teach you (for example your level and how you like to learn) — you can view and delete these any time in Settings."}</li>
        <li>{"Approximate AI-usage counts, used for daily limits and to show your usage."}</li>
        <li>{"If you use the optional integrations (see below): the connection details they need. Pronote credentials are stored encrypted (AES-256-GCM) and deleted when you disconnect."}</li>
      </ul>
      <p>{"We do not sell your data, use it for advertising, or use your content to train foundation models."}</p>

      <h2>{"Optional integrations (full app)"}</h2>
      <p>{"Accounts that open the full app can connect other apps, only to do work you asked for:"}</p>
      <ul>
        <li><b>Gmail</b> — {"to read recent threads and prepare draft replies. Otto creates drafts; it never sends, deletes, or modifies mail on its own."}</li>
        <li><b>Google Calendar</b> — {"to read events and prepare drafts of new events for your review."}</li>
        <li><b>Google Drive / Docs / Sheets / Slides</b> — {"to read relevant files and create documents it makes for you. Otto only ever edits a document it created itself."}</li>
        <li><b>Pronote</b> ({"optional, unofficial — no official Pronote API exists"}) — {"read-only, to see homework due dates. Otto never writes anything back to Pronote."}</li>
      </ul>
      <p>{"Anything irreversible — sending an email, posting, inviting, deleting, or paying — is never done without your explicit confirmation."}</p>

      <h2>{"Service providers"}</h2>
      <p>{"Otto shares data with the processors needed to run the service. What you send them is handled under their own terms:"}</p>
      <ul>
        <li><b>Google</b> — {"Gemini Live (voice), image reading, and, if you connect them, the Google apps above."}</li>
        <li><b>OpenAI</b> — {"Realtime voice, used as a fallback when the first voice service is unavailable."}</li>
        <li><b>DeepSeek</b> — {"the AI model that writes the board and answers typed messages."}</li>
        <li><b>Supabase</b> — {"stores your account and profile."}</li>
        <li><b>Composio</b> — {"brokers the connections to the optional integrations."}</li>
        <li>{"Hosting/infrastructure providers that run the app."}</li>
      </ul>

      <h2>{"Retention & deletion"}</h2>
      <p>{`Your account data is kept for as long as your account exists — we don't automatically delete it after a period of inactivity. Your tutoring sessions live in your browser until you delete them or clear the site's data. You're in control, with no email-and-wait required: delete past sessions from the sessions list, clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time, or delete your account.`}</p>

      <h2>{"Security"}</h2>
      <p>{"Voice credentials are created on our server for a single call and expire within minutes; our API keys never reach your browser. Google and other OAuth-based connections mean we never see your app passwords. Pronote is the one exception — it has no OAuth, so we keep your Pronote username and password encrypted to reconnect you when its token expires."}</p>

      <h2>{"Google API disclosure"}</h2>
      <p>{"Otto's use of information received from Google APIs adheres to the "}<a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">{"Google API Services User Data Policy"}</a>{", including the Limited Use requirements."}</p>

      <h2>{"Your rights (GDPR)"}</h2>
      <p>{`If you're in the EU/EEA, GDPR gives you the right to access, correct, export (portability), or delete (erasure) your data, and to object to or restrict how it's processed. Your tutoring sessions are already in your hands (they are in your browser), and the account data can be viewed and deleted in Settings. For anything else, or if you're elsewhere and want the same, contact ${LEGAL_EMAIL}.`}</p>

      <h2>{"International transfers"}</h2>
      <p>{`Your data is processed by providers based outside ${LEGAL_JURISDICTION} (including the US and elsewhere) — Google, OpenAI, DeepSeek, Supabase, Composio and our hosting provider. We only use providers that commit contractually to protecting your data (e.g. standard contractual clauses where applicable) to the standard GDPR requires.`}</p>

      <h2>{"Age"}</h2>
      <p>{`Otto is built with students in mind, but opening an account requires being old enough to consent to data processing on your own (15 in ${LEGAL_JURISDICTION}); younger than that, a parent or guardian should set it up and stay involved. Because Otto uses your voice, please make sure anyone using it has agreed to the microphone being used.`}</p>

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
      <p>{"Otto is a voice tutor with a shared whiteboard. It asks questions, explains ideas, and writes working and diagrams on the board while you talk. It is a learning aid: it is built to guide you to answers, not to do your graded work for you. Some accounts also have access to a wider set of tools (tasks, journal, coursework, optional app connections); for those, anything irreversible is only done with your confirmation, and you are responsible for reviewing anything Otto prepares before you act on it."}</p>

      <h2>{"Your responsibilities"}</h2>
      <ul>
        <li>{"Keep your account credentials secure and provide accurate information."}</li>
        <li>{"Allow the microphone only when you want to talk; make sure anyone else who can be heard in the room is okay with it."}</li>
        <li>{"Only connect accounts you are authorized to use."}</li>
        <li>{"Use Otto lawfully and honestly: follow your school's rules on academic integrity, and don't use Otto to harass others or to break the terms of the services it works with."}</li>
        <li>{"Your tutoring sessions are saved in your browser, not on our servers. Keep them as long as you need them; clearing the site's data deletes them."}</li>
      </ul>

      <h2>{"AI-generated content — check it"}</h2>
      <p>{"Otto uses AI, which can be inaccurate, incomplete, or wrong — including in maths and science. Explanations, board lines, diagrams and spoken answers are a starting point that "}<b>{"you must check"}</b>{" against your course material, your teacher, or a reliable source before relying on them, especially for exams and graded work. If something doesn't add up, say so and Otto will go back over it with you."}</p>

      <h2>{"No warranty"}</h2>
      <p>{"The service is provided \"as is\" and \"as available\", without warranties of any kind, whether express, implied, or statutory — including any implied warranties of merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not warrant that Otto will be uninterrupted, error-free, secure, or that the voice will always be available."}</p>

      <h2>{"Limitation of liability"}</h2>
      <p>{`To the fullest extent permitted by applicable law, ${LEGAL_ENTITY} and anyone involved in providing Otto shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, nor for any loss of data (including tutoring sessions saved only in your browser), grades, profits, or opportunities arising from your use of, or inability to use, the service. Nothing in these terms limits liability that cannot be limited by law.`}</p>

      <h2>{"Your data"}</h2>
      <p>{"How your data is handled is described in the Privacy Policy. In short: your voice goes to the voice provider during a call and is not stored by us; your sessions stay in your browser; we do not sell your data or use it to train foundation models."}</p>

      <h2>{"Availability & changes"}</h2>
      <p>{"Otto is an independent tool and is not endorsed by or affiliated with Google, OpenAI, DeepSeek or any other provider it uses. We may change, suspend, limit (including through daily usage limits) or discontinue any part of the service at any time without liability."}</p>

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
