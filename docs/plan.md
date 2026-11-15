# Plan: Missing Works — a listening library and voting queue

## Goal
Visitors browse 36 composers grouped into five eras/traditions, listen to completed AI homages, and vote anonymously for a composer plus form. The owner can inspect a ranked queue, mark a request in progress, and publish its result. The existing Beethoven quartet, notebook, transcript, and score URLs remain available.

## Non-goals
No scheduled generation yet, paid commissions, accounts, human-identity verification, or new compositions in this build. Symphony playback is a notation/sampled-audio capability, not a claim of orchestral realism. No raw private conversation history is deployed.

## Current state
The live repository is https://github.com/akrentsel/beethovens-missing-quartet, deployed from main/root. It contains a single `index.html` player, `scores/*.abc`, `notebook.html`, and `transcript.html` + public `transcript.json`. Source and test tools are in `/home/mirendil/quartet`; private-history stays there and is never copied. The player is hard-coded to four string parts. Node and SQLite are available locally; no public voting backend exists. The user offered a VM and has been asked for SSH access and an HTTPS API hostname.

## Design
A new working checkout at `/home/mirendil/missing-works` contains:
- `index.html`, `assets/library.css`, `assets/library.js`: composer catalogue, composer detail, completed works, form chooser and ranked requests. Hash routes avoid server rewrite rules; old GitHub Pages links redirect to the matching VM page and hash.
- `data/catalog.json`: eras, 36 composers, four forms and work manifests. Each work has composer/form IDs, description, duration, ordered ABC movement paths, notebook and transcript paths.
- `config.json`: public API base URL only; blank means voting is unavailable, never simulated.
- `work.html`, `assets/player.js`, `assets/player.css`: reusable player that loads `?id=…`, discovers part names/instruments from the score and supports variable part counts. Retain the current quartet page as `beethoven.html`.
- `server/`: dependency-free Node 24+ HTTP API and persistent SQLite storage; admin CLI is available only over SSH, not publicly.
- `tests/`: API, catalogue and browser tests. `deploy/`: systemd/Caddy examples and deployment/backup instructions.

API contract:
- `GET /api/health` → `{ok:true}`.
- `GET /api/requests`, optional `X-Voter-Token` UUID → `{requests:[{id,composerId,formId,round,status,votes,voted,createdAt,workId}],updatedAt}`.
- `POST /api/votes`, same header, JSON `{requestId,voted:boolean}` → updated request. Idempotent insert/remove, 400 invalid input, 409 closed request, 429 rate limit.
- IDs are `composer:form:round`; forms are `string-quartet`, `violin-sonata`, `piano-sonata`, `symphony`. Status is `open`, `composing`, or `completed`.
- Seed one open request for each of 144 combinations. The existing Beethoven quartet is completed round 1, with round 2 open for another quartet. No invented votes.

## Decisions
- Working platform name: **Missing Works**; Beethoven’s Missing Quartet keeps its title.
- User-approved composer list and anonymous voting. One vote per browser token per request; users may support multiple requests and undo their votes. This is not one-person-one-vote enforcement.
- Updated at the user's request: host the entire site and API on https://lost-compositions.exe.xyz. GitHub remains the source repository; its old Pages web links redirect to the VM. nginx serves a curated public release, proxies `/api/` to Node, and never exposes server code or SQLite files. Frontend stores a random UUID, server stores its SHA-256 hash. No names, emails or persistent application IP logs.
- Rate-limit writes by connection IP; honor forwarded IP only from an explicitly trusted loopback reverse proxy. Bound request size, validate catalog IDs, allowlist browser origins, use parameterized SQL, and keep the database outside the public directory.
- Queue ordering: vote count descending, creation time ascending, then ID. Generation is initiated manually; status changes preserve votes and completed history. Completing a round opens the next round for that combination.
- Visual identity: a contemporary music publisher’s catalogue. White paper (#f8f9f6), dark ink (#162c33), petrol blue (#1f5962), cool pale blue (#e4edef), and brass (#9b701f). Newsreader for editorial headings, Source Sans 3 for controls. Oversized composer names in ruled catalogue rows; one featured playable work rather than a grid of identical cards.

## Risks
- Live votes depend on VM access, DNS and TLS. Build and prove local persistence first; do not claim live voting until tested across independent clients on the deployed API.
- Anonymous tokens can be reset or forged. Basic duplicate and rate controls are deliberately best-effort; stronger identity/CAPTCHA is out of scope.
- Long symphonies can require large browser audio buffers. Preserve simple sample playback and clearly surface errors; test multi-part scores, not a fictional completed symphony.
- Updating the root replaces the current player with the catalogue. Preserve `beethoven.html`, all score/notebook/transcript URLs, and feature the quartet prominently.

## Milestone 1 — Catalogue and reusable listening pages
**Changes:** create catalogue and library files, preserve legacy player, add generic manifest-driven player. Empty composers get an honest empty state, not invented works.
**Verification:** `node --test tests/catalog.test.mjs`; browser checks on 375px and desktop: all five groups, 36 composers, filtering, four request forms, links to existing work, four movements, audible buffer, pause/resume. Test one-, two-, three-, and multi-part score fixtures with programs preserved.
**Done when:** library and player work locally without a backend, and voting is explicitly unavailable until connected.
**Depends on:** none.

## Milestone 2 — Persistent anonymous voting
**Changes:** `server/` and `tests/backend.test.mjs`; CLI queue/start/complete/backup; config-driven frontend API client with loading, failure and stale-request states. Database excluded from git and static serving.
**Verification:** `node --test tests/backend.test.mjs`; duplicate/idempotent voting, undo, independent tokens, invalid payloads, closed rounds, concurrent requests, process restart persistence, CORS and rate limits. Browser test two independent local clients seeing the same totals; no network must never report a successful vote.
**Done when:** shared totals survive a server restart and administration can consume the queue without exposing a public admin endpoint.
**Depends on:** catalogue schema (can run alongside milestone 1 once written).

## Milestone 3 — Publish and verify
**Changes:** deploy the entire site and API to the provided VM behind exe.dev HTTPS; nginx serves only the curated public file list and proxies `/api/` to Node. Configure systemd and backups, set the API URL, preserve old GitHub Pages links using host-conditional redirects, and commit reviewed source files to the repository. Never deploy private histories, tokens, databases, server source or tests as website files.
**Verification:** deployed HTTP 200s; production CORS; independent-browser add/undo test on a temporary test round or cleanup under admin control; restart persistence; live score playback and transcript search; fresh mobile screenshot.
**Done when:** a visitor can vote and another browser sees the same count, the owner can read the queue, and the old quartet remains playable. If the VM is not ready, publish only a clearly labeled non-voting library after reporting the blocker, not pretend completion.
**Depends on:** milestones 1 and 2; VM access.

## Execution rules
Keep file ownership separate between subagents. Re-read the plan before each milestone. Run tests before public deployment; use an explicit deploy file list. Do not create a recurring generation automation until the user selects a schedule. Ask again only for missing access, new spending, destructive changes, or a material scope change.

## Progress log
- [x] Milestone 1 — library and reusable player (November 15, 2026): 36 composers, era/search filters, completed shelves, four request forms and manifest-driven playback. Full player browser regression: 60 passed, including 1/2/3/6-part fixtures, MIDI header, pause/resume, seeks, tempo, mute, switching during loading and mobile layout.
- [x] Milestone 2 — durable anonymous voting (November 15, 2026): 31 backend tests pass on Node 24/26; browser integration proves shared counts, undo, restart persistence and honest offline failure. HTTPS API deployed on the provided VM and tested with two identities; all temporary test votes removed.
- [x] Milestone 3 — deployed and verified (November 15, 2026): full site and API served from lost-compositions.exe.xyz; all 18 public files byte-verified. Live browser voting, shared totals, undo, playback and transcript search pass. Old GitHub Pages composer/player URLs redirect to matching VM URLs. Source committed and pushed; application services and daily local backups are enabled.

### Surprises
- exe.dev already supplies HTTPS and hostname routing; no Caddy/certificate provisioning was needed. nginx on the public web port forwards only `/api/` to loopback Node.
- The first backup attempt failed because the service user could not traverse `/etc/missing-works`; changing the directory group to the service group fixed it. The backup unit now explicitly preserves state-directory mode 0700.
- The first browser integration test reused a same-document hash navigation instead of loading the new anonymous identity; forcing a new document fixed the test setup. API idempotency itself passed.
- An intermittent abcjs load-cancellation race survived one clean browser run: destroying a controller while its `setTune` promise was pending cleared a buffer still needed by `prime()`. The final player pauses immediately but defers destruction until pending builds settle. Two deterministic regression tests and the complete 60-check browser suite pass after the fix.

### Decision log
2026-11-15: User approved the composer set and anonymous voting, then offered a VM. Use that rather than requiring a third-party database account.

2026-11-15: User explicitly requested hosting the complete website on lost-compositions.exe.xyz, not GitHub Pages. Switched to curated atomic static releases on nginx alongside the API; keep GitHub only as source plus redirects for old shared URLs.

### Outcome
The complete site, player, notebook, public transcript and shared voting API are live at https://lost-compositions.exe.xyz. All 18 deployed public files match the tested local versions. Unit/integration suites: 59 passed; full player browser suite: 60 passed; independent library and real-voting browser checks also pass. A real live vote appeared in the queue and to a second client, then was undone. API votes survived a service restart. Daily local backups are enabled; off-host backup is documented but not automated. Source is published, and old GitHub Pages composer and player links were verified to redirect to the VM. All 59 unit/integration checks also pass on the production Node 24 runtime. No scheduled generation was installed.
