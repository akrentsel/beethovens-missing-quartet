# Operating the composition queue

The library publishes AI-composed homages, never works falsely attributed to the historical composer. No scheduled generation is installed. A person asks the agent to inspect the votes and begin the next work.

## Read the queue

On the vote VM, with access to the database:

```sh
cd /opt/missing-works
sudo -u missingworks DB_PATH=/var/lib/missing-works/votes.sqlite node server/admin.mjs queue --json
```

Or read the public API (`GET /api/requests`) and select open requests with positive votes. Rank by votes descending, creation time ascending, then request ID. If no request has votes, report that and ask which piece to begin rather than inventing a winner.

## Start a work

Use the admin CLI's `start <requestId>` command. It changes the request from open to composing and stops new votes on that round. This CLI is available over SSH only; there is no public administrative endpoint. Read the CLI help and current record before modifying it.

Write a composition brief with the form, instrument list, approximate length, musical references, and the desired degree of resemblance. Reference influences honestly; do not claim the result is an undiscovered original. Actual musical quality requires listening and revision, not just clean notation checks.

## Add the result to the library

1. Add one ABC file per movement under `scores/`. Include `V:` labels/clefs and `%%MIDI program` instructions for the actual instruments. Preserve program changes and valid durations. The sample player has limited sustain and realism; test the entire score, especially an orchestral work.
2. Add a work to `data/catalog.json`: stable `id`, `composerId`, `formId`, matching `round`, `title`, `subtitle`, `description`, `date`, `durationSeconds`, `status:"completed"`, and ordered `movements` with `id`, `label`, `source`, `durationSeconds` and optional `note`. Only link notebook/transcript files that actually exist.
3. Keep provenance per work. Public composition logs contain publishable messages, actions and reports only, with sensitive material and private internal reasoning omitted. Never copy raw session exports or credentials to this repository.
4. Run catalogue/backend/player tests and a browser playback test. Listen where possible; label anything unverified. Commit the source changes, update `deploy/public-files.txt`, deploy an atomic public release to the VM (see `deploy/README.md`), and verify the new work at `https://lost-compositions.exe.xyz/`.
5. Copy the updated catalogue to the vote server, then use `complete <requestId> <workId>`. Completion preserves that round's votes and creates a new open round for another work of the same composer/form. Verify the public queue and work link.

If composition is abandoned before publication, use `reopen <requestId>` to return it to voting. Do not reset or silently transfer votes.

## Adding composers and forms

`data/catalog.json` is the source of truth. Append stable IDs and human-readable labels. Synchronizing the server with a new catalogue must not overwrite votes or status. Historical categories are browsing aids: composers may bridge periods, and some composer/form requests will intentionally be counterfactual (for example, a Baroque composer and a modern symphony).
