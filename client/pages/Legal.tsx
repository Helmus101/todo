
import { useLang } from "../ui.tsx";
import { LEGAL_EMAIL, LEGAL_ENTITY, Logo } from "../appShared.tsx";

const LEGAL_JURISDICTION = "France";

export function PrivacyBody() {
  const L = useLang();
  return (
    <>
      <h1>{L("Politique de confidentialité", "Privacy Policy")}</h1>
      <p>{L(`Otto (« nous ») est un assistant de tâches qui lit les applications que tu connectes et prépare le travail pour toi. Cette politique explique ce à quoi nous accédons, pourquoi, et tes choix. Otto est géré par ${LEGAL_ENTITY}.`, `Otto ("we", "us") is a to-do assistant that reads the apps you connect and prepares work for you. This policy explains what we access, why, and your choices. Otto is operated by ${LEGAL_ENTITY}.`)}</p>

      <h2>{L("Ce à quoi nous accédons", "What we access")}</h2>
      <p>{L("Uniquement les applications que tu connectes explicitement, et uniquement pour faire le travail demandé :", "Only the apps you explicitly connect, and only to do the work you asked for:")}</p>
      <ul>
        <li><b>Gmail</b> — {L("pour lire les fils récents et préparer des brouillons de réponse. Otto crée des brouillons ; il n'envoie, ne supprime, ni ne modifie jamais un mail de lui-même.", "to read recent threads and prepare draft replies. Otto creates drafts; it never sends, deletes, or modifies mail on its own.")}</li>
        <li><b>Google Calendar</b> — {L("pour lire les événements et préparer des brouillons de nouveaux événements pour ta relecture.", "to read events and prepare drafts of new events for your review.")}</li>
        <li><b>Google Drive / Docs / Sheets / Slides</b> — {L("pour lire les fichiers pertinents et créer des documents qu'il fait pour toi. Otto ne modifie jamais que les documents qu'il a lui-même créés — jamais un fichier qui est déjà le tien.", "to read relevant files and create documents it makes for you. Otto only ever edits a document it created itself — it never modifies a file that's already yours.")}</li>
        <li><b>Pronote</b> ({L("optionnel, non officiel — aucune API Pronote officielle n'existe", "optional, unofficial — no official Pronote API exists")}) — {L("lecture seule, pour voir les dates de rendu des devoirs. Otto n'écrit jamais rien sur Pronote.", "read-only, to see homework due dates. Otto never writes anything back to Pronote.")}</li>
        <li>{L("Autres intégrations que tu connectes", "Other integrations you connect")} — {L("accédées uniquement pour les tâches auxquelles elles se rapportent.", "accessed only for the tasks they relate to.")}</li>
      </ul>
      <p>{L("Otto effectue de manière autonome le travail ", "Otto performs autonomously the work that is ")}<b>{L("réversible", "reversible")}</b>{L(" (brouillons, documents, recherche). Tout ce qui est irréversible — envoyer un mail, publier, inviter, supprimer, ou payer — n'est ", " (drafts, documents, research). Anything irreversible — sending an email, posting, inviting, deleting, or paying — is ")}<b>{L("jamais", "never")}</b>{L(" fait sans ta confirmation explicite. Il ne modifie jamais non plus un document, une feuille ou une présentation qu'il n'a pas créé — seulement tes propres fichiers, jamais ceux d'Otto.", " done without your explicit confirmation. It also never edits a document, sheet, or slide deck that it didn't create — only your own files, never Otto's.")}</p>

      <h2>{L("Ce que nous stockons", "What we store")}</h2>
      <ul>
        <li>{L("Ton email de compte et un mot de passe haché de manière sécurisée (nous ne stockons jamais ton mot de passe en clair).", "Your account email and a securely hashed password (we never store your password in plain text).")}</li>
        <li>{L("Les tâches qu'Otto génère et un profil de faits qu'il apprend pour mieux travailler (personnes, projets, préférences) — tu peux les consulter et les supprimer à tout moment dans les Réglages.", "The tasks Otto generates and a profile of facts it learns to do better work (people, projects, preferences) — you can view and delete these any time in Settings.")}</li>
        <li>{L("Si tu connectes Pronote : ton identifiant, ton mot de passe et le jeton de session Pronote, chiffrés (AES-256-GCM), pour te reconnecter automatiquement. Effacés quand tu déconnectes Pronote.", "If you connect Pronote: your Pronote username, password and session token, encrypted (AES-256-GCM), to reconnect you automatically. Deleted when you disconnect Pronote.")}</li>
        <li>{L("Un décompte approximatif de l'usage IA pour afficher ton utilisation mensuelle.", "Approximate AI-usage counts for showing your monthly usage.")}</li>
      </ul>
      <p>{L("Nous ne vendons pas tes données, ne les utilisons pas pour de la publicité, et n'utilisons pas ton contenu pour entraîner des modèles de fondation.", "We do not sell your data, use it for advertising, or use your content to train foundation models.")}</p>

      <h2>{L("Prestataires de service", "Service providers")}</h2>
      <p>{L("Otto partage des données avec les prestataires nécessaires au fonctionnement du service, selon leurs conditions :", "Otto shares data with the processors needed to run the service, under their terms:")}</p>
      <ul>
        <li><b>Composio</b> — {L("gère les connexions OAuth vers tes applications et exécute les actions de lecture/écriture en ton nom.", "brokers the OAuth connections to your apps and executes read/write actions on your behalf.")}</li>
        <li><b>DeepSeek</b> — {L("le modèle IA qui lit le contexte et rédige le travail. Le contenu pertinent est envoyé pour générer chaque tâche/brouillon.", "the AI model that reads context and drafts the work. Relevant content is sent to generate each task/draft.")}</li>
        <li><b>Supabase</b> — {L("stocke ton compte, tes tâches et ton profil.", "stores your account, tasks, and profile.")}</li>
        <li>{L("Prestataires d'hébergement/infrastructure qui font tourner l'application.", "Hosting/infrastructure providers that run the app.")}</li>
      </ul>

      <h2>{L("Conservation et suppression", "Retention & deletion")}</h2>
      <p>{L(`Tes données sont conservées tant que ton compte existe — nous ne les supprimons pas automatiquement en cas d'inactivité, c'est à toi de le faire quand tu le souhaites. Tu gardes le contrôle, sans email ni attente nécessaire : efface tout ce qu'Otto a appris via Réglages → « Tout oublier », déconnecte n'importe quelle application à tout moment (révoque immédiatement l'accès d'Otto), télécharge tout ce qui est stocké sur toi via Réglages → « Télécharger mes données », ou supprime définitivement ton compte et tout ce qu'il contient via Réglages → « Tout supprimer » — instantané, en libre-service, et irréversible.`, `Your data is kept for as long as your account exists — we don't automatically delete it after a period of inactivity; deleting it when you're done is up to you. You're in control, with no email-and-wait required: clear everything Otto has learned via Settings → "Forget everything", disconnect any app at any time (revokes Otto's access immediately), download everything stored about you via Settings → "Download my data", or permanently delete your account and everything with it via Settings → "Delete everything" — instant, self-serve, and irreversible.`)}</p>

      <h2>{L("Sécurité", "Security")}</h2>
      <p>{L("Google et les autres connexions via OAuth signifient que nous ne voyons jamais tes mots de passe d'application. Pronote est la seule exception — il n'a pas d'OAuth, donc nous conservons ton identifiant et ton mot de passe Pronote chiffrés (AES-256-GCM) avec le jeton de session que Pronote émet, pour te reconnecter automatiquement quand ce jeton expire. Le mot de passe n'est jamais journalisé ni affiché, et il est effacé quand tu déconnectes Pronote ou supprimes ton compte. Les données sont transmises via HTTPS et l'accès est limité à ton compte. Aucun système n'est parfaitement sûr, mais nous prenons des mesures raisonnables pour protéger tes informations.", "Google and other OAuth-based connections mean we never see your app passwords. Pronote is the one exception — it has no OAuth, so we keep your Pronote username and password encrypted (AES-256-GCM) alongside the session token Pronote issues, to reconnect you automatically when that token expires. The password is never logged or shown, and it is deleted when you disconnect Pronote or delete your account. Data is transmitted over HTTPS and access is scoped to your account. No system is perfectly secure, but we take reasonable measures to protect your information.")}</p>

      <h2>{L("Déclaration API Google", "Google API disclosure")}</h2>
      <p>{L("L'utilisation par Otto des informations reçues des API Google respecte la ", "Otto's use of information received from Google APIs adheres to the ")}<a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">{L("politique d'utilisation des données utilisateur des services API Google", "Google API Services User Data Policy")}</a>{L(", y compris les exigences de Limited Use.", ", including the Limited Use requirements.")}</p>

      <h2>{L("Tes droits (RGPD)", "Your rights (GDPR)")}</h2>
      <p>{L(`Si tu es dans l'UE/EEE, le RGPD te donne le droit d'accéder à, de corriger, d'exporter (portabilité), ou de supprimer (effacement) tes données, et de t'opposer à ou de restreindre leur traitement. Les trois premiers sont en libre-service dans les Réglages, dès maintenant, sans demande nécessaire ; pour tout le reste, ou si tu es ailleurs et souhaites la même chose, contacte ${LEGAL_EMAIL} et nous nous en occuperons directement. Notre base légale de traitement est l'exécution du service que tu as demandé (contrat) plus notre intérêt légitime à faire bien fonctionner Otto pour toi.`, `If you're in the EU/EEA, GDPR gives you the right to access, correct, export (portability), or delete (erasure) your data, and to object to or restrict how it's processed. The first three are self-serve in Settings, right now, with no request needed; for anything else, or if you're elsewhere and want the same, contact ${LEGAL_EMAIL} and we'll handle it directly. Our legal basis for processing is performing the service you asked for (contract) plus our legitimate interest in making Otto work well for you.`)}</p>

      <h2>{L("Transferts internationaux", "International transfers")}</h2>
      <p>{L(`Tes données sont traitées par des prestataires situés hors de ${LEGAL_JURISDICTION} (y compris aux États-Unis et ailleurs) — Composio, DeepSeek, Supabase, et notre hébergeur. Nous n'utilisons que des prestataires qui s'engagent contractuellement à protéger tes données (par ex. des clauses contractuelles types le cas échéant) au niveau exigé par le RGPD.`, `Your data is processed by providers based outside ${LEGAL_JURISDICTION} (including the US and elsewhere) — Composio, DeepSeek, Supabase, and our hosting provider. We only use providers that commit contractually to protecting your data (e.g. standard contractual clauses where applicable) to the standard GDPR requires.`)}</p>

      <h2>{L("Âge", "Age")}</h2>
      <p>{L(`Otto est pensé pour les élèves, mais ouvrir un compte nécessite d'avoir l'âge légal pour consentir soi-même au traitement de ses données (15 ans en ${LEGAL_JURISDICTION}) ; en dessous, un parent ou tuteur doit le créer et rester impliqué.`, `Otto is built with students in mind, but opening an account requires being old enough to consent to data processing on your own (15 in ${LEGAL_JURISDICTION}); younger than that, a parent or guardian should set it up and stay involved.`)}</p>

      <h2>{L("Modifications et contact", "Changes & contact")}</h2>
      <p>{L(`Nous mettrons à jour cette politique au fil de l'évolution du service et noterons la date ci-dessus. Questions ou tout ce qui n'est pas couvert ici : ${LEGAL_EMAIL}.`, `We'll update this policy as the service evolves and note the date above. Questions or anything not covered here: ${LEGAL_EMAIL}.`)}</p>
    </>
  );
}

export function TermsBody() {
  const L = useLang();
  return (
    <>
      <h1>{L("Conditions d'utilisation", "Terms of Service")}</h1>
      <p>{L(`En utilisant Otto, géré par ${LEGAL_ENTITY}, tu acceptes ces conditions.`, `By using Otto, operated by ${LEGAL_ENTITY}, you agree to these terms.`)}</p>

      <h2>{L("Le service", "The service")}</h2>
      <p>{L("Otto lit les applications que tu connectes et prépare le travail — brouillons, documents, et tâches organisées. Il effectue les actions réversibles de manière autonome et demande ta confirmation avant tout ce qui est irréversible (envoyer, publier, inviter, supprimer, payer). Tu es responsable de la relecture de tout ce qu'Otto prépare avant d'agir dessus.", "Otto reads the apps you connect and prepares work — drafts, documents, and organized tasks. It performs reversible actions autonomously and asks for your confirmation before anything irreversible (sending, posting, inviting, deleting, paying). You are responsible for reviewing anything Otto prepares before you act on it.")}</p>

      <h2>{L("Tes responsabilités", "Your responsibilities")}</h2>
      <ul>
        <li>{L("Garde tes identifiants de compte en sécurité et fournis des informations exactes.", "Keep your account credentials secure and provide accurate information.")}</li>
        <li>{L("Ne connecte que des comptes que tu es autorisé à utiliser.", "Only connect accounts you are authorized to use.")}</li>
        <li>{L("Utilise Otto de manière licite et non pour envoyer du spam, harceler, ou violer les droits d'autrui ou les conditions des applications connectées.", "Use Otto lawfully and not to send spam, harass, or violate others' rights or the connected apps' terms.")}</li>
      </ul>

      <h2>{L("Contenu généré par IA — tout relire", "AI-generated content — review everything")}</h2>
      <p>{L("Otto utilise l'IA, qui peut être inexacte, incomplète, ou erronée. Chaque brouillon, document, et suggestion est un point de départ que ", "Otto uses AI, which can be inaccurate, incomplete, or wrong. Every draft, document, and suggestion is a starting point that ")}<b>{L("tu dois relire et vérifier", "you must review and verify")}</b>{L(" avant de l'envoyer, l'enregistrer, ou t'y fier. Tu es seul responsable de tout ce que tu choisis d'envoyer, publier, ou sur quoi tu agis. Otto ne prépare que du travail réversible et demande ta confirmation avant tout ce qui est irréversible ; la décision — et ses conséquences — t'appartiennent.", " before sending, saving, or relying on it. You are solely responsible for anything you choose to send, publish, or act upon. Otto only prepares reversible work and asks for your confirmation before anything irreversible; the decision — and its consequences — are yours.")}</p>

      <h2>{L("Aucune garantie", "No warranty")}</h2>
      <p>{L("Le service est fourni « tel quel » et « selon disponibilité », sans garantie d'aucune sorte, expresse, implicite, ou légale — y compris toute garantie implicite de qualité marchande, d'adéquation à un usage particulier, d'exactitude, ou de non-contrefaçon. Nous ne garantissons pas qu'Otto sera ininterrompu, sans erreur, sécurisé, ou que ses résultats seront corrects ou adaptés à un usage quelconque. Tu l'utilises à tes propres risques.", "The service is provided \"as is\" and \"as available\", without warranties of any kind, whether express, implied, or statutory — including any implied warranties of merchantability, fitness for a particular purpose, accuracy, or non-infringement. We do not warrant that Otto will be uninterrupted, error-free, secure, or that its output will be correct or suitable for any purpose. You use it at your own risk.")}</p>

      <h2>{L("Limitation de responsabilité", "Limitation of liability")}</h2>
      <p>{L(`Dans toute la mesure permise par la loi applicable, ${LEGAL_ENTITY} et toute personne impliquée dans la fourniture d'Otto ne sauraient être tenus responsables de dommages indirects, accessoires, spéciaux, consécutifs, exemplaires, ou punitifs, ni d'aucune perte de données, de profits, de revenus, de clientèle, de communications manquées, d'envois erronés, ou d'interruption d'activité, découlant de ou liés à ton utilisation (ou incapacité d'utiliser) Otto ou de tout ce qu'il prépare ou fait — même si informé de cette possibilité. Dans toute la mesure permise par la loi, notre responsabilité totale cumulée pour toutes les réclamations liées au service n'excédera pas le plus élevé entre le montant que tu nous as payé au cours des 12 mois précédant la réclamation, ou 50 €. Rien dans ces conditions n'exclut une responsabilité qui ne peut être exclue en vertu de la loi applicable.`, `To the fullest extent permitted by applicable law, ${LEGAL_ENTITY} and anyone involved in providing Otto shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, nor for any loss of data, profits, revenue, goodwill, missed communications, mistaken sends, or business interruption, arising out of or relating to your use of (or inability to use) Otto or anything it prepares or does — even if advised of the possibility. To the fullest extent permitted by law, our total aggregate liability for all claims relating to the service will not exceed the greater of the amount you paid us in the 12 months before the claim, or €50. Nothing in these terms excludes liability that cannot be excluded under applicable law.`)}</p>

      <h2>{L("Tes données et ta responsabilité", "Your data & your responsibility")}</h2>
      <p>{L(`Tu es responsable des comptes et du contenu que tu connectes et de t'assurer que tu as le droit de le faire. Tu agis en tant que responsable de traitement des données personnelles dans tes comptes connectés ; Otto ne les traite que pour fournir le service, comme décrit dans la Politique de confidentialité. Tu acceptes d'indemniser et de dégager ${LEGAL_ENTITY} de toute réclamation, perte, ou dépense découlant de ton utilisation d'Otto, de ton contenu, ou de ta violation de ces conditions ou des droits ou conditions d'un tiers.`, `You are responsible for the accounts and content you connect and for ensuring you have the right to do so. You act as the controller of the personal data in your connected accounts; Otto processes it only to provide the service, as described in the Privacy Policy. You agree to indemnify and hold ${LEGAL_ENTITY} harmless from any claims, losses, or expenses arising from your use of Otto, your content, or your breach of these terms or of any third party's rights or terms.`)}</p>

      <h2>{L("Disponibilité et modifications", "Availability & changes")}</h2>
      <p>{L("Otto est un outil indépendant et n'est ni approuvé par ni affilié à Google, ou tout autre prestataire intégré. Nous pouvons modifier, suspendre, limiter (y compris via un budget IA mensuel), ou interrompre toute partie du service à tout moment sans responsabilité.", "Otto is an independent tool and is not endorsed by or affiliated with Google, or any other integrated provider. We may change, suspend, limit (including via a monthly AI budget), or discontinue any part of the service at any time without liability.")}</p>

      <h2>{L("Résiliation", "Termination")}</h2>
      <p>{L("Tu peux arrêter d'utiliser Otto et supprimer ton compte à tout moment. Nous pouvons suspendre ou résilier les comptes qui violent ces conditions ou qui créent un risque ou une exposition légale.", "You may stop using Otto and delete your account at any time. We may suspend or terminate accounts that violate these terms or that create risk or legal exposure.")}</p>

      <h2>{L("Droit applicable et contact", "Governing law & contact")}</h2>
      <p>{L(`Ces conditions sont régies par les lois de ${LEGAL_JURISDICTION}, sans égard aux règles de conflit de lois, et les tribunaux de ${LEGAL_JURISDICTION} sont compétents, sauf disposition contraire d'une loi locale impérative sur la consommation. Si une disposition est jugée inapplicable, le reste demeure en vigueur. Questions : ${LEGAL_EMAIL}.`, `These terms are governed by the laws of ${LEGAL_JURISDICTION}, without regard to conflict-of-laws rules, and the courts of ${LEGAL_JURISDICTION} have jurisdiction, except where mandatory local consumer law provides otherwise. If any provision is held unenforceable, the rest remains in effect. Questions: ${LEGAL_EMAIL}.`)}</p>
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
          <a className="btn ghost-framer" href="/">{L("Accueil", "Home")}</a>
        </nav>
      </header>
      <main className="research-main">
        {/* The mission statement leads the page, set in the same serif display face as the landing hero —
            this page is the philosophy, typeset like a manifesto, not a plain article. */}
        <p className="micro-label accent">{L("Recherche", "Research")}</p>
        <h1 className="research-title">{L("Fait pour apprendre, pas pour tricher.", "Made for learning, not shortcuts.")}</h1>
        <p className="research-intro">
          {L(
            "La plupart des tuteurs IA promettent d'enseigner. Sous la pression, ils donnent la réponse. Otto est construit sur quatre méthodes qui rendent plus difficile de donner la réponse que t'aider à apprendre.",
            "Most AI tutors promise to teach. Under pressure, they hand over the answer. Otto is built on four methods that make handing over the answer harder than helping you learn.",
          )}
        </p>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>01</p>
          <h2 className="research-sec-title">{L("Le questionnement socratique", "Socratic questioning")}</h2>
        <p className="research-sec-body">
          {L(
            "Otto ne donne jamais la conclusion — c'est toi qui la trouves. Il repère exactement où tu bloques, donne un seul indice à la fois, puis te demande de reformuler avec tes mots. Et s'il commence à glisser vers la réponse toute faite, un garde-fou intégré l'arrête et le redirige.",
            "Otto never states the conclusion — you do. It finds exactly where you're stuck, gives one hint at a time, then asks you to say it back in your own words. And if it ever drifts toward just handing over the answer, a built-in guardrail stops it and redirects.",
          )}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>02</p>
          <h2 className="research-sec-title">{L("La répétition espacée", "Spaced repetition")}</h2>
        <p className="research-sec-body">
          {L(
            "Chaque carte revient juste avant que tu l'aurais oubliée — ni plus tôt, ni plus tard. Celles que tu rates reviennent vite ; celles que tu connais s'éloignent.",
            "Every card comes back right before you'd forget it — not sooner, not later. The ones you miss return quickly; the ones you know drift further away.",
          )}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>03</p>
          <h2 className="research-sec-title">{L("La hiérarchie de l'engagement", "The engagement hierarchy")}</h2>
        <p className="research-sec-body">
          {L(
            "Lire une réponse n'apprend presque rien. Expliquer son raisonnement à voix haute apprend le plus. Chaque réponse d'Otto est écrite pour te faire monter d'un cran — jamais descendre.",
            "Reading an answer teaches you almost nothing. Explaining your reasoning out loud teaches you the most. Every Otto reply is written to pull you one level deeper — never shallower.",
          )}
        </p>
        </section>

        <section className="research-sec">
          <p className="research-sec-kicker" aria-hidden>04</p>
          <h2 className="research-sec-title">{L("La matrice d'Eisenhower", "The Eisenhower matrix")}</h2>
        <p className="research-sec-body">
          {L(
            "Ta journée n'est pas une pile triée par échéance. Chaque tâche est notée pour l'urgence et l'importance — et re-notée à mesure que les dates approchent — pour que la bonne chose reste en haut.",
            "Your day isn't a pile sorted by deadline. Every task is scored for urgency and importance — and re-scored as deadlines approach — so the right thing stays on top.",
          )}
        </p>
        </section>

        <section className="research-sec research-sec-closing">
          <h2 className="research-sec-title">{L("Ce que ça ne veut pas dire", "What this doesn't mean")}</h2>
          <p className="research-sec-body">
            {L(
              "Otto peut se tromper — un modèle de langage reste un modèle de langage. Alors chaque fois qu'un garde-fou se déclenche, Otto l'affiche sur l'échange, au lieu de prétendre qu'il est infaillible.",
              "Otto can still be wrong — a language model is a language model. So whenever a guardrail fires, Otto says so right on the exchange, instead of claiming to be infallible.",
            )}
          </p>
        </section>

        <a className="legal-back" href="/">{L("← Retour à Otto", "← Back to Otto")}</a>
      </main>
      <footer className="legal-foot">
        <span className="foot-mit">© 2026 Otto</span>
      </footer>
    </div>
  );
}
