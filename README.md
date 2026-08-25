# Otto Lycée — Ton Pronote devient 3 choses à faire aujourd'hui.

**Otto lit Pronote, Gmail, Calendar et Drive, et te laisse seulement ce qui a besoin de toi. Il prépare le travail, jamais à ta place. Il n'envoie rien sans ton OK. Il ne fait jamais tes devoirs.**

> Pensé pour le lycée français (Seconde / Première / Terminale). Open source (MIT). Self-hostable. Coût plafonné.

## Le problème

Dimanche 19h. Pronote affiche 11 devoirs, 2 contrôles, 3 mails de profs dans Gmail, 2 PDF dans Drive. Tu paniques, tu ouvres TikTok.

Les to-do lists classiques te demandent de tout retaper toi-même. Les IA qui "font tout à ta place" te font tricher — et flippent tes parents.

## Ce que fait Otto

Otto tourne même quand ton ordi est fermé — un job queue durable (Supabase) le fait travailler en arrière-plan. Par défaut il vérifie Pronote une fois par jour ; réglable jusqu'à 4x/jour (soit toutes les 6h) dans Réglages, et un rafraîchissement manuel marche à tout moment.

**4 intégrations, 4 seulement :**

1. **Pronote** — Devoirs, contrôles (flag "test" de l'emploi du temps), dates. Connexion non-officielle (Index Éducation n'a pas d'API publique) ; ton mot de passe sert une seule fois puis n'est jamais conservé — un jeton chiffré (AES-256-GCM) le remplace ensuite.
2. **Gmail** — Mails de profs, convocations, liens Classroom. Otto ne fait qu'y répondre en brouillon, jamais d'envoi automatique.
3. **Google Calendar** — Contrôles, créneaux libres pour réviser.
4. **Google Drive** — Cours, fiches, corrections partagés par tes profs — pour enrichir tes fiches de révision.

Notion est supporté côté serveur mais volontairement caché de l'interface pour l'instant — chaque connexion en plus est un frein pour un lycéen qui n'a pas de Gmail pro. Aucune autre intégration (GitHub, Slack, Linear, etc.) n'est supportée : la surface reste volontairement limitée à Google Workspace, Notion et Pronote.

**Et il te rend : Aujourd'hui — 3 cartes, pas 20.** Le reste attend son tour dans "Plus tard" et "Peut attendre".

## Ce qu'Otto fait / ne fait PAS

C'est la question qu'on nous pose partout : "creepy", "ça va faire mes devoirs à ma place ?"

**✅ Otto FAIT (travail réversible) :**
- Fiche de révision (plan, définitions, formules) à partir de Pronote + Drive
- Checklist découpée en petites étapes de 10-15 min
- Liste de sources / vidéos ciblées
- Brouillon de mail au prof (JAMAIS envoyé sans ton tap)

**🔒 Otto ne fait JAMAIS sans toi :**
- Envoyer un mail, inviter à un événement Calendar, supprimer un fichier → un tap d'approbation obligatoire, à chaque fois.

**🎓 Otto REFUSE de faire :**
- Dissertation rédigée, exercice corrigé, réponse de contrôle. Le document créé est un guide ; l'exercice reste une étape que TU fais. C'est une règle appliquée dans le code (pas juste une promesse dans ce README) — voir `DOES_STUDENT_WORK` dans `server/claude.ts`.

## Stack

- **Backend :** Node + Express (TypeScript), job queue durable Supabase (Postgres)
- **Frontend :** Vite + React (TypeScript)
- **IA :** [DeepSeek](https://deepseek.com) via l'API compatible OpenAI
- **Intégrations :** [Composio](https://composio.dev) pour Gmail/Calendar/Drive ; module Pronote maison (`pawnote`, non-officiel) avec token chiffré AES-256-GCM
- **Storage :** [Supabase](https://supabase.com) (Postgres, idéalement hébergé en EU) — recommandé, RGPD-friendly

## Démarrage rapide

```bash
git clone <ton-fork> otto && cd otto
cp .env.example .env
#   → renseigne DEEPSEEK_API_KEY, COMPOSIO_API_KEY (https://composio.dev), et SESSION_SECRET
npm install
npm run dev          # ouvre http://localhost:5273
```

Ça suffit pour tourner en local. Ajoute Supabase (voir plus bas) pour que ça survive à un redémarrage.

**Tester sans compte Pronote réel :** mets `PRONOTE_MOCK=1` dans `.env`, puis dans le formulaire "Connecter mon Pronote" tape `demo` comme URL (identifiant/mot de passe : n'importe quoi de non-vide). Ça fait tourner tout le pipeline (connexion → lecture → classement → cartes) avec des devoirs/contrôles factices, sans jamais contacter un vrai Pronote. Jamais actif sans cette variable — à ne pas mettre en production.

## Variables d'environnement

**Requises**

| Variable | Rôle |
|-----|---------|
| `DEEPSEEK_API_KEY` | L'agent IA (génération + exécution des tâches) |
| `COMPOSIO_API_KEY` | Gmail/Calendar/Drive — à récupérer sur https://composio.dev |
| `SESSION_SECRET` | Signe le cookie de session (`openssl rand -hex 32`) |
| `PUBLIC_URL` | Ton origine (`http://localhost:5273` en dev, ton URL HTTPS en prod) |

**Recommandées / spécifiques à Pronote**

| Variable | Rôle |
|-----|---------|
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Persistance cloud (recommandé ; **requis en production**) |
| `CREDENTIAL_ENCRYPTION_KEY` | Chiffre le jeton Pronote (AES-256-GCM) avant stockage. **Sans elle, la connexion Pronote refuse de démarrer** (`openssl rand -hex 32`) — les autres fonctionnalités continuent de marcher sans. |
| `MONTHLY_AI_BUDGET_USD` | Plafond de dépense IA mensuel par compte (défaut `3`) |
| `PRONOTE_MOCK` | `1` = active le compte Pronote factice (`demo`) pour tester sans vrai compte — dev uniquement |
| `CRON_SECRET` | Protège `/api/cron/drain` (requis sur Vercel) |
| `DEEPSEEK_MODEL` | Défaut `deepseek-v4-flash` (ou `deepseek-v4-pro` pour plus de raisonnement) |
| `PORT` | Défaut `8788` |

Voir [`.env.example`](.env.example) pour la liste annotée complète.

## Persistance cloud (recommandé)

Ton profil, tes tâches et tes connexions sont indexés par email de compte, pour survivre aux redémarrages et te suivre partout.

1. Exécute [`supabase.sql`](supabase.sql) dans l'éditeur SQL Supabase (crée les tables ; **RLS verrouillée par défaut**).
2. Renseigne `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. **Le serveur refuse de démarrer en production sans la clé de service** — elle contourne RLS et doit rester côté serveur uniquement.
3. Pour un projet Supabase jetable en local, tu peux utiliser la clé anon + décommenter les policies DEV-ONLY clairement indiquées dans `supabase.sql`.

## Déployer

```bash
npm run build        # → dist/
npm start            # production : Express sert dist/ + l'API sur $PORT
```

Marche sur n'importe quel hébergeur Node (Render, Railway, Fly, une VM, ou Docker — un `Dockerfile` est fourni) et sur Vercel (`vercel.json` branche la fonction API, l'hébergement statique, le cron et les headers de sécurité). Renseigne les variables requises, pointe `PUBLIC_URL` vers ton domaine HTTPS, et vois la **checklist prod** ci-dessous.

### Checklist production

- Variables requises renseignées (le démarrage échoue sans) : `SESSION_SECRET`, `DEEPSEEK_API_KEY`, `COMPOSIO_API_KEY`, `PUBLIC_URL`.
- `CREDENTIAL_ENCRYPTION_KEY` renseignée si tu veux que Pronote fonctionne — sinon la connexion Pronote refuse poliment plutôt que de stocker en clair.
- `supabase.sql` exécuté ; `SUPABASE_SERVICE_KEY` renseignée ; clés anon/service jamais envoyées au client.
- `CRON_SECRET` renseignée (Vercel Cron vide la file d'attente — une fois par jour sur le plan Hobby, plus souvent sur Pro).
- Sécurité en place : CSP + headers de sécurité, rate-limiting sur l'auth, mots de passe bcrypt, cookies `httpOnly`/`secure`, aucun secret dans le bundle client, RLS verrouillée par défaut, AES-256-GCM sur le seul identifiant qu'on stocke nous-mêmes (jeton Pronote), plus le chiffrement au repos par défaut de Postgres/Supabase sur chaque table.
- `/privacy` et `/terms` publiées dans l'app — **requis pour la vérification OAuth Google.**
- **Google OAuth :** Gmail/Calendar/Drive sont des scopes sensibles. Soumets l'écran de consentement OAuth avec ton URL de politique de confidentialité + ta page d'accueil ; tant que ce n'est pas vérifié, Google plafonne l'app à 100 utilisateurs et affiche un écran "app non vérifiée".

## Ce qu'il fait / ne fait pas

- ✅ Prépare automatiquement le travail réversible : brouillons (jamais envoyés), fiches de révision, checklists, recherche/synthèse.
- 🔒 Jamais irréversible sans toi : envoyer un mail, inviter à un événement, supprimer → toujours un tap d'approbation.
- 🎓 Ne fait jamais le travail noté à ta place : pas de dissertation rédigée, pas d'exercice corrigé, pas de réponse de contrôle — les documents créés sont des guides, et l'exercice reste toujours une étape pour toi.
- 🧠 Passe au crible Pronote/Gmail/Calendar/Drive pour les faits ; seul ce qui a *vraiment besoin de toi* remonte.
- 🗂️ Données stockées par compte, chiffrées au repos (Postgres/Supabase par défaut, plus AES-256-GCM applicatif sur le seul identifiant qu'on stocke nous-mêmes) ; rien n'est partagé, revendu, ou utilisé pour entraîner des modèles.
- 📤 RGPD intégré : consentement explicite à l'inscription, export complet de tes données en un clic (`/api/account/export` — tâches, jobs, connexions, jamais les jetons/mots de passe), et suppression de compte instantanée et définitive depuis Réglages.

## Extension Chrome Otto Tabs (optionnelle)

Les étapes du type "ouvrir une page" peuvent ouvrir des onglets automatiquement, groupés dans un groupe "Otto". L'extension non empaquetée est dans [`extension/`](extension/) : `chrome://extensions` → Mode développeur → Charger l'extension non empaquetée → sélectionne le dossier.

## Structure du projet

```
client/     App React (Vite)
server/     API Express, job queue, agent IA, intégrations
shared/     Types + fonctions pures partagées client & serveur
extension/  Extension Chrome Otto Tabs (MV3)
tests/      Suite de tests de fonctions pures (npm test)
supabase.sql  Schéma Postgres + RLS
```

## Développement

```bash
npm run dev         # serveur + client avec hot reload
npm test            # tests de fonctions pures (pas de réseau/IA)
npm run typecheck   # tsc --noEmit
npm run build       # build de production du client
```

## Contribuer

Issues et PRs bienvenues. Lance `npm run typecheck && npm test && npm run build` avant d'ouvrir une PR, et garde un style cohérent avec l'existant.

## Licence

[MIT](LICENSE) © Willem Tjong. Projet indépendant, non affilié à ni approuvé par Pronote/Index Éducation, Google, Composio, DeepSeek, ou Supabase.
