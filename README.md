# COM1 Study Break & Bubble Tea

A small event registration and organiser check-in app for an NUS Computing Club recruitment submission. Cream, sage and pink styling, a mobile layout, and inline SVG bubble-tea illustrations. No build step for the website.

**Event:** COM1 Foyer, Thursday, 7–9 PM. **No calendar date is confirmed.** There are 150 reservations. Each saved registration reserves one cup. One registration and one cup per student; no walk-ins.

## Start here

The code is complete, but `index.html` intentionally contains public configuration placeholders. Until you connect Supabase, it shows a clear connection message and disables registration. It never pretends to save attendees locally.

From this repository in PowerShell, with Node.js 22 or later installed:

```powershell
npm.cmd ci
npm.cmd run preview
```

Open **http://localhost:4173**. Stop the preview with Ctrl+C. The preview serves only `index.html`, so private configuration files cannot be downloaded from it. You can preview the appearance without Supabase. Browser tests run a real copy of the handler against a temporary test database.

## How the pieces work together

```text
Student / volunteer browser (index.html)
    │ HTTPS JSON requests
    ▼
Supabase Edge Function (event-api)
    │ validate inputs / verify PIN / hash session tokens
    │ privileged, narrowly named database RPC calls
    ▼
Supabase Postgres
    public functions → private tables with RLS
    enforce uniqueness, capacity, session expiry and attendance rules
```

- **Frontend:** a single HTML file holds markup, styles and JavaScript. Tailwind loads from its CDN as requested; custom CSS supplies the event design and remains readable if that CDN is unavailable. It uses native `fetch`, so no frontend Supabase SDK is needed.
- **Edge Function:** the only API used by the browser. It validates all registration inputs, checks the server-configured PIN with bcrypt, rate limits logins and returns safe error codes. It does not log attendee details or PINs.
- **Database:** shared, persistent source of truth for all devices. No attendee database or session token is kept in `localStorage` or `sessionStorage`. The organiser token stays in page memory; refreshing requires another login.
- **Why Supabase:** PostgreSQL gives real transactions and unique constraints, while Edge Functions let a static GitHub Pages site use server-side secrets. It avoids maintaining a separate application server for a 150-person event. The tradeoff is reliance on an internet connection and an external service.

### Files to understand first

| File | Purpose |
| --- | --- |
| `index.html` | Student form, confirmation, PIN screen and organiser dashboard |
| `supabase/migrations/` | Original schema and the follow-up migration making check-in mean cup handover |
| `supabase/functions/event-api/handler.js` | Request validation and authentication; also exercised by Node tests |
| `supabase/functions/event-api/index.ts` | Thin Deno entry point; calls the Supabase Data API |
| `supabase/.env.example` | Private configuration names, with placeholders only |
| `tests/` | Disposable SQL, API, browser and optional local Supabase checks |
| `.github/workflows/pages.yml` | Publishes only `index.html` |

## Connect the hosted Supabase project

Use the **com1-study-break** project belonging to this repository, not a different Computing Club project. Do not run test seed scripts against the real event project.

### 1. Install the CLI and apply the migration

Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) using its supported Windows installation method. The commands below assume `supabase` is on your PATH. The CLI will ask you to sign in and enter your database password; neither belongs in this repository.

```powershell
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

Replace `<YOUR_PROJECT_REF>` rather than copying the angle brackets. `db push` applies the versioned migration; do not paste random copies into the SQL editor and then also apply it with the CLI. See [Supabase database migrations](https://supabase.com/docs/guides/deployment/database-migrations).

Keep **Data API enabled**, **automatically expose new tables disabled**, and **automatic RLS enabled**. The architecture does not depend on automatic table exposure:

- Keep `public` in the Data API's exposed schemas so the named RPC functions are reachable by the server.
- **Never add `private` to exposed schemas.** All attendee, session and rate-limit tables are there.
- The migration explicitly enables RLS on every table. It adds no public access policies and revokes direct table permissions from `anon`, `authenticated` and `service_role`.
- Every callable app function explicitly revokes execution from `PUBLIC`, `anon` and `authenticated`, then grants it only to `service_role`.
- The functions run as their trusted database owner (`security definer`), with an empty search path and qualified table names. This lets them access the private tables without giving the browser access.

These deliberate permission grants follow the [Supabase database function guidance](https://supabase.com/docs/guides/database/functions).

### 2. Set private server configuration

```powershell
Copy-Item supabase/.env.example supabase/.env.local
npm.cmd run pin:hash
```

Choose a random **6–12 digit PIN**, input hidden. The helper prints a bcrypt hash, not the PIN. Put that hash into `ORGANISER_PIN_HASH` in `supabase/.env.local`. The test suite's fake PIN is unrelated and must not be reused for the real event.

Generate the rate-limit hashing secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `supabase/.env.local` in your editor:

```dotenv
ORGANISER_PIN_HASH='<YOUR_GENERATED_BCRYPT_HASH>'
RATE_LIMIT_SECRET=<YOUR_RANDOM_SECRET>
ALLOWED_ORIGINS=http://localhost:4173,https://topinmys.github.io
STUDENT_EMAIL_DOMAIN=u.nus.edu
```

These examples contain placeholders only. Allowed origins have a scheme and host, **no trailing slash or repository path**. The GitHub Pages origin is `https://topinmys.github.io`, even though the site's path is `/com1-study-break/`. Add your custom-domain origin if you use one. `http://127.0.0.1:4173` is a different origin from `http://localhost:4173`.

Upload secrets and deploy:

```powershell
supabase secrets set --env-file supabase/.env.local
supabase functions deploy event-api --no-verify-jwt
```

The hosted runtime supplies `SUPABASE_URL` and private keys. The transport prefers the current `SUPABASE_SECRET_KEYS.default` entry and falls back to `SUPABASE_SECRET_KEY` or the legacy `SUPABASE_SERVICE_ROLE_KEY` for local/older setups. These privileged keys appear only in server-side calls; **never paste them into the frontend or a committed file**. `.env.local` is ignored by Git. See the [Supabase environment variable guidance](https://supabase.com/docs/guides/functions/secrets).

`verify_jwt = false` is intentional: students have no Supabase Auth account, and new publishable keys are not user JWTs. The function has public capacity, registration and PIN-login operations; organiser operations require the custom short-lived session. A publishable key or allowed origin is not organiser authentication. See [Supabase function auth headers](https://supabase.com/docs/guides/functions/auth-headers).

### 3. Set public frontend configuration

Find `CONFIG` near the start of the inline JavaScript in `index.html`:

```js
const CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  publishableKey: 'YOUR_SUPABASE_PUBLISHABLE_KEY',
  emailDomain: 'u.nus.edu',
};
```

Copy the project URL and **publishable key** from your Supabase project settings. Both are public by design. Do not use a secret key or the legacy `service_role` key. The publishable key goes in the `apikey` request header; organiser authentication uses `x-organiser-session` separately.

To change the permitted email domain, update **both** `CONFIG.emailDomain` and the server's `STUDENT_EMAIL_DOMAIN`, upload secrets again, and redeploy the frontend. The server is the authority; editing the browser cannot bypass it. Checking the domain and format **does not prove email ownership or student status**.

Start the preview again. Capacity should now load from Supabase. Confirm configuration through capacity and organiser login; do not create fake reservations in the real event database. Test registrations belong in the disposable local setup below.

## Publish to GitHub Pages

1. Configure and test the backend first, then replace the public placeholders in `index.html`.
2. Commit and push this repository to `topinmys/com1-study-break`. Review `git status` first; private `.env` files must remain ignored.
3. In the repository, open **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Run **Actions → Publish event page → Run workflow**. Later pushes to `main` that change the frontend publish automatically.
5. When the action finishes, visit **https://topinmys.github.io/com1-study-break/**. That is the expected URL after deployment, not a claim that the site is already live.
6. Check capacity and organiser login from the deployed origin. In a separate local test environment, use two devices or two browser sessions to practise check-in and undo before the event.

The workflow uploads **only `index.html`**. No server environment files, tests, attendee records or Node packages are included in the Pages artifact. This uses [GitHub's supported custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). No code has been pushed or published by this implementation session.

## The important rules, explained for an interview

### Reserving the final cup safely

The server calls `event_register`. Inside one transaction it locks the single settings row, checks duplicates and counts saved registrations, then inserts only if fewer than 150 exist. A second transaction waits for the same row lock. Once the first commits, the second counts again and sees the new reservation. Only one can take the final place.

The lock is released automatically on commit or error. If the insert fails, nothing is reserved. Database unique constraints on lowercase trimmed email and uppercase trimmed student ID provide a second layer of duplicate protection. Only this reservation function is granted to the server for inserting attendees; direct table inserts are not granted.

### Organiser login and its limits

- bcrypt compares the submitted PIN with a server-configured hash. There is no frontend PIN comparison or embedded deployed PIN.
- All login attempts, including successes, count toward **5 attempts per client-IP bucket per 10-minute fixed window**, plus **100 globally per 10 minutes**. Rate limits live in Postgres, so restarting an Edge Function does not reset them.
- IP buckets use HMAC-SHA-256 with a private secret; raw IPs are not stored. Proxy IP headers are not a perfect identity. The global cap remains even if headers or IPs change. Volunteers sharing campus Wi-Fi may share a bucket. The global cap can also temporarily block legitimate logins during an attack; this is a simple first-version tradeoff.
- A successful login creates a random 256-bit token using Web Crypto. Only its SHA-256 hash is saved. The browser keeps the usable token in memory, not persistent browser storage.
- Every organiser read, update and logout checks the hashed session against its **two-hour expiry in the database**. Logout removes that session. Expired rows are also cleaned during future logins.
- The PIN is shared, so it cannot identify which volunteer made a change. Anyone with the PIN can view attendee details. Share it only with volunteers, use HTTPS, log out on shared devices, and choose a fresh PIN for a future event.
- Rotating the PIN prevents new logins with the old PIN but does not revoke existing sessions. To revoke all sessions, the project owner can run `delete from private.organiser_sessions;` in the Supabase SQL editor. This removes sessions, not registrations.
- Origin restrictions reduce accidental browser access but do not prevent scripts from calling public endpoints. There is no email ownership check, CAPTCHA, or identity assurance: someone could reserve under another student's details. These are acknowledged scope limits.

### Attendance and handing out cups

Check-in means the attendee has received their one reserved cup. One `checked_in_at` timestamp records this combined action; null means it has not been recorded. The dashboard has one check-in button and one checked-in/cups-given total. Undo corrects a recording mistake.

Updates explicitly say **set check-in to `true` or `false`**, rather than toggle whatever value happens to be in the database. Repeating the same request leaves the existing timestamp unchanged. The attendee row is locked during changes, preventing two volunteers from producing contradictory saved states. Counters are calculated from saved timestamps, not incremented in the browser.

The screen disables controls during a save, waits for the server, and refreshes the snapshot. It polls every five seconds, retaining the search query, card focus and expanded contact details. A successful save is never guessed from a tap. After an ambiguous network failure, refresh and check the saved state before issuing a cup. The app records collection; volunteers still need to coordinate the physical handover.

### If the internet or Supabase is unavailable

No offline registration or attendance mode is claimed. Capacity failures disable registration. Failed submissions show an error, not a success ticket. An organiser sync failure leaves the last confirmed data visible with a stale-data message; failed updates do not optimistically tick boxes.

A lost response can occur after a transaction actually committed. Students can retry **the same details**; the unique constraints prevent a second reservation. A duplicate message tells them those details are already registered, without exposing an attendee list. Volunteers should refresh before handing out a cup if a save was not confirmed. If service is down at the door, pause digital confirmations and let the event lead decide the operational fallback; this app cannot safely reconcile an offline list.

### Data handling

Public capacity returns numbers only. Public registration returns just a reservation flag and opaque reference. Attendee lists, contact details and timestamps require organiser access. Public users cannot query the private tables or execute database functions directly.

Name/student ID support check-in; email/student ID prevent duplicates; Telegram permits manual event-related contact. Telegram handles are accepted with or without `@`. Names and other submitted details are rendered with `textContent`, so an HTML-looking name is displayed as text. The reference is a private reminder, not an authentication credential.

No retention period is invented in the page. The event lead should agree when to delete real attendee records after the event and handle corrections through the project owner. Automated retention, self-service editing and cancellation are outside this version.

## Tests and what they prove

Install development dependencies and the test browser:

```powershell
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd test
npm.cmd run test:ui
```

`npm test` runs all migrations and actual SQL functions in **PGlite, an embedded PostgreSQL engine**, and routes API requests through the same handler that the Edge Function serves. It checks input normalisation, domain configuration, duplicate constraints, RLS/permission denial, 150-place boundary, sessions and expiry, bcrypt PINs, persistent rate limits, idempotent combined check-in, undo, rejection of obsolete separate-collection actions, and database failures.

`test:ui` drives Chromium at desktop and narrow phone sizes. It uses the actual HTML, handler and temporary SQL database over local HTTP. It checks registration and persistence after page refresh, duplicates, safe rendering of HTML-like names, network failures without false confirmations, capacity loss, organiser actions/undo, search, a second session seeing polling updates, logout and no horizontal overflow. It also verifies the unconfigured state. Screenshots are written under ignored `test-results/`. The tests block Tailwind's CDN to verify the CSS fallback.

**Verification during implementation:** 14 SQL/API tests and 5 browser tests passed. The Edge Function entry point passed `deno check --node-modules-dir=manual supabase/functions/event-api/index.ts`. Desktop and mobile screenshots were visually reviewed. The preview returned the frontend successfully and refused a request for a server configuration file. The project owner subsequently linked the hosted Supabase project with the CLI; the backend has not yet been deployed. The optional local Supabase test was skipped because no local instance was configured.

**Limits of this evidence:** PGlite has one database connection, so its queued final-place requests check the boundary but do not prove multi-connection locking. The browser test's two sessions share a temporary PGlite-backed server; that is not evidence of deployed Edge Function behaviour, a real phone browser, or real Supabase networking. Use the next test for the real local stack. No fake attendees have been sent to a real event database.

### Optional: real local Supabase integration test

Use a disposable local instance and Docker Desktop supported by the CLI. Do not point these tests at your hosted event. In this repository:

```powershell
supabase start
supabase db reset --local
```

`db reset --local` erases **only the local development database** and reapplies migrations. The hosted project linked earlier is separate. Create `supabase/.env.local` as above using a separate test PIN/hash, then in another terminal leave this running:

```powershell
supabase functions serve event-api --env-file supabase/.env.local --no-verify-jwt
```

Get the local API URL and public/anon key from `supabase status` (do not copy the service-role key). In the test terminal:

```powershell
$env:TEST_SUPABASE_URL = 'http://127.0.0.1:54321'
$env:TEST_PUBLISHABLE_KEY = '<LOCAL_PUBLIC_OR_ANON_KEY>'
$env:TEST_ORGANISER_PIN = '<YOUR_LOCAL_TEST_PIN>'
npm.cmd run test:live
```

This script refuses any host except loopback and requires an empty database. It creates 149 fake attendees, submits two simultaneous HTTP requests for the final place, expects exactly one success, then checks cross-session attendance, repeated combined check-in, undo, logout and public Data API denial. Its 150 fake records remain in the disposable local database for inspection. Reset locally afterward if needed; never reset the hosted event to clean test data.

For a manual phone check against your local stack, the preview currently binds to loopback. Use the hosted staging setup or deliberately adapt the preview binding and allowed origins for your own LAN; do not assume another device can reach `localhost` on your computer.

### Fake data versus real data

Automated tests use names beginning `Fake Student`, invented student IDs, and synthetic email addresses. They do not represent actual students and no messages are sent. The browser security test deliberately uses an HTML-looking fake name. Fake test data is generated at runtime, never shipped as a registration list. Do not import fixtures into production or take screenshots containing real attendees for the recruitment submission.

## Deliberately outside this version

No Telegram bot, automated messages, QR scanning, waitlist, student accounts, multi-event management, cancellation flow, email verification, exports, volunteer audit log, separate collection step, or offline queue. A single event, 150 guaranteed cups, and check-in at handover keep the project focused.

## Draft: How I used AI — review before submitting

> I used Codex to generate an initial implementation of the frontend, database migrations, Edge Function, automated checks and setup documentation from my recruitment brief. Codex ran the automated SQL/API and Chromium checks in a disposable test environment and reviewed rendered screenshots. I requested a simpler event flow where check-in also means handing over the cup; Codex implemented the corresponding frontend, server, migration and test changes. The original generated baseline and this change were saved in separate commits.
>
> I reviewed the generated form code with Codex's explanations, requested removal of the data-collection and email helper text, and manually checked empty required fields, valid example inputs, and rejection of a short Telegram handle. I also linked the existing Supabase project using the CLI. Codex ran the automated checks; those checks are separate from my own manual testing. Backend deployment and verification on the hosted stack are still outstanding at this point in the review.
