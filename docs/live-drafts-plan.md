# Live composition drafts

## Goal
Listeners can open an in-progress work, hear any published partial movement, and see new validated revisions arrive without reloading. Playing/loading/paused takes remain pinned to their score and audio. When stopped, follow-latest updates automatically; while listening, an explicit switch loads the new take. Older revisions remain selectable.

## Scope and current state
The active request is `bach:violin-sonata:1`, being composed in another user thread. Coordinate with that thread; never edit its scores. The existing player caches ABC per movement and renders a full audio buffer. The VM already has Node24, SQLite, nginx and SSH-only administrative commands. No public upload endpoint will be added.

## Architecture and contract
- Draft snapshots live outside atomic website releases, under `/var/lib/missing-works/drafts`, so deploying the website never deletes drafts.
- A draft descriptor names `id` (work ID), `requestId`, `title`, optional subtitle/description and `movements:[{id,label,file,note}]`. The local publishing helper reads the ABC files and sends a JSON payload over SSH stdin to an owner-only CLI. Metadata and ABC are validated before publication. Syntax, aligned bars and durations are checked; musical quality remains the composing agent's responsibility.
- Revisions are immutable, numbered monotonically. Publish the complete revision directory first, then atomically update the index. Validate request ownership and `composing` state against the vote database. Never overwrite earlier revisions. Guard concurrent publishers with a lock/transaction and optional expectedRevision.
- `GET /api/drafts` -> `{drafts:[{id,requestId,composerId,formId,title,revision,publishedAt,changeNote,status,completedWorkId,movements:[{id,label,bars}]}]}`.
- `GET /api/drafts/:id` -> `{work:manifest,revisions:[{revision,publishedAt,changeNote}],status,completedWorkId}`.
- `GET /api/drafts/:id/revisions/:n` -> `{work:manifest}`.
- `GET /api/drafts/:id/revisions/:n/:movement.abc` -> immutable ABC text, only validated names. All reads reuse existing origin restrictions. No arbitrary file reads or public writes.
- Manifest matches existing work shape: `id,requestId,composerId,formId,round,title,subtitle,description,status:'draft',revision,publishedAt,changeNote,durationSeconds,movements:[{id,label,note,source,bars,durationSeconds,sha256}]`. Sources are same-origin relative paths `api/drafts/ID/revisions/N/MOVEMENT.abc`.
- Wrapper status is the CURRENT request status (`composing`, `completed`, `open` if reopened). A completed request supplies `completedWorkId` linking to the finished catalogue entry. Historical snapshots remain draft-labelled.

## Viewer behavior
`work.html?draft=ID` opens the latest snapshot, with a prominent Draft label, revision/date, change note, bar counts and a revision selector. Poll every 5 seconds while visible, one request at a time; back off on failures and retain the last playable take. Pause polling while hidden and resume on return. `?revision=N` pins an earlier take, with an explicit Follow latest control. Clicking Play never happens automatically due to an arriving update. Existing continuation between movements remains governed by the listener's control.

If a newer revision arrives:
- idle, unedited, follow-latest: apply automatically, preserving movement ID when possible;
- playing/loading/paused or locally edited: keep current score/audio and show a switch button;
- explicit switch: stop the old take, load the new score, optionally seek to a chosen measure (no autoplay), and expose the prior take in the revision selector;
- fetch failure: keep the old take intact, show retry state; never mix old audio with new notation.

The catalogue and queue show a Listen to live draft link for published drafts matching a composing request. Composers with no playable snapshot say the first draft is not available yet. Drafts never masquerade as completed catalogue works.

## Milestones
1. Publisher and storage/API: backend tests for validation, immutable history, failed/partial publication, concurrent/stale updates, safe paths, matching request, completed work discovery and restart persistence.
2. Player and catalogue: browser tests for initial draft, idle update, queued update during playback/paused/loading, old revisions, movement preservation, network failure, edited source protection, completion link and mobile layout. Existing player and vote tests must still pass.
3. Deployment and actual Bach draft: install SSH-only publishing wrapper, persist snapshots separately from site releases, coordinate publishing with the composer, deploy tested files atomically, verify actual live draft playback and revision behavior. Commit only owned infrastructure files; preserve composer work and catalogue edits.

## Execution rules
No private reasoning or raw logs in public draft metadata. Do not modify votes or mark a composition complete. No fake musical content is published as Bach's work. Test fixtures stay out of production. Publishing a draft is explicit, not a filesystem watcher exposing unfinished writes. Public completion waits for a valid snapshot from the composing agent; if none exists yet, ship the working feature and clearly report that state.

## Progress
- [x] Publisher and storage/API — immutable, fsynced revisions and SSH-only publication deployed; 60 backend/publisher tests pass on Node 24.
- [x] Player and catalogue — 70 draft-viewer browser checks, 60 existing player browser checks, and library discovery tests pass. Current takes remain pinned; Stop resumes following; scroll is preserved.
- [x] Deployed and verified — production waiting page and composer state verified; a real local store/API/three-part-score integration test verified publication, audio, pinned playback, revision switching, and immutable history. The actual Bach agent has not published its first snapshot yet; that production musical-content check remains pending.

## Decisions and findings
2026-11-15: User approved phrase/section snapshots, auto-update while stopped, and pinned score/audio with manual switching during playback. The Bach thread owns the composition; this thread owns infrastructure.

2026-11-15: Added a draft-only Stop control so listeners can leave paused/pinned state and resume following. Automatic updates preserve scroll and follow the new bottom only when the listener was already at the bottom.

2026-11-15: Published progress counts omit pickups, while the bar navigator counts the pickup as bar 1. The navigator explicitly states its convention. Source/runtime timing rather than approximate duration is used to seek; repeat navigation uses the first occurrence.

2026-11-15: Final regression suite: 97 tests pass on Node 24 and Node 26. Live draft URL is https://lost-compositions.exe.xyz/work.html?draft=bach-violin-sonata-1. It currently waits for the composing agent's first actual publication and checks automatically. No test music was published to production.
