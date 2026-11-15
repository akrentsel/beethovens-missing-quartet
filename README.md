# Missing Works

A listening library and community commissioning queue for **original AI-composed homages**. These are not lost or rediscovered works by the named composers, and living composers do not endorse this project.

**Listen and vote:** https://lost-compositions.exe.xyz/

The full website and voting API run on the VM. GitHub is the source repository; the old GitHub Pages URLs redirect to this hostname.

The library starts with *Beethoven’s Missing Quartet*, four movements in D minor, with its composition notebook and a searchable, redacted conversation transcript. Browse 36 composers across five eras/traditions and request a string quartet, violin sonata, piano sonata or symphony.

## Run locally

Node **24 or newer**, with the built-in `node:sqlite` module. No package installation or build step is required.

```sh
SERVE_STATIC=true node server/index.mjs
# Open http://127.0.0.1:3000/
```

Local votes are saved in `var/votes.sqlite`, which is git-ignored and never served. To choose another database or port:

```sh
DB_PATH=/path/to/votes.sqlite PORT=3000 SERVE_STATIC=true node server/index.mjs
```

For a static-only preview, serve this directory with any HTTP server. Voting needs a reachable API configured in `config.json`; it never falls back to simulated or browser-only totals.

## Project layout

- `index.html`, `assets/library.*`: composer catalogue, completed works, requests and queue.
- `data/catalog.json`: composer groups, forms and work/movement manifests.
- `work.html`, `assets/player.*`: manifest-driven notation and sampled playback, using [abcjs](https://www.abcjs.net/).
- `beethoven.html`: the original self-contained quartet player, kept available.
- `scores/`: ABC notation. The player supports varying part counts and honors score instrument programs.
- `notebook.html`, `transcript.html`, `transcript.json`: the first quartet’s notebook and public conversation record. Private internal reasoning, credentials and raw private histories are not published.
- `server/`: persistent anonymous voting API and SSH-only administration CLI.
- `deploy/`: service and reverse-proxy examples, setup and backup instructions.
- `docs/composing.md`: how to consume the queue and add a finished work.

## Voting and generation

Visitors need no account. A browser creates and remembers a random UUID; the database stores only its SHA-256 hash. Each ID can support a request once, and undo while the round remains open. Different requests can be supported simultaneously. Counts are shared and survive service restarts.

Duplicate protection is **best-effort**, not proof of one person per vote. Clearing storage or using another device can bypass it. The API applies basic per-IP and global write rate limits; it does not persist IP addresses in vote records. CORS is an origin restriction, not authentication.

A person starts generation. The queue does not automatically commission or generate work, and no recurring generation schedule is installed. The CLI marks a request `composing`; completion preserves its votes and opens a new round for another work of the same composer/form.

## Tests

```sh
node --test tests/*.test.mjs
```

Browser tests require Chrome/headless-shell and use a small DevTools Protocol driver. Set `CHROME` to the browser executable if it is not in the default Lor test location.

```sh
# With a static preview at http://127.0.0.1:8890/:
node tests/library-browser.cjs
# Starts an isolated API with a disposable database:
node tests/voting-browser.cjs
```

The existing music has been checked analytically and through audio-buffer tests. That is not the same as musical judgment by ear or a recording by live performers. Short-note levels, sampled sustain and orchestral realism have limits; revisions and human listening remain important.
