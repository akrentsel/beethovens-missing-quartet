# Publishing and following live composition drafts

A live draft is an explicit, playable snapshot—not the contents of a file halfway through a write. Publish after each coherent phrase or section (often 4–8 bars across all parts), and again after meaningful revisions. Do not wait for a whole movement or sonata if an earlier section is already listenable.

## One-time conventions

- Reserve a stable work ID, for example `bach-violin-sonata-1`, and an existing composing request, for example `bach:violin-sonata:1`.
- The normal completed-work catalogue does not contain drafts. The draft service derives composer, form and round from the request and exposes snapshots separately.
- Scores remain owned by the composing agent. Infrastructure agents must not change the music.
- Keep private working files and raw session histories outside the public repository. Public change notes should be short, high-level descriptions of what changed, not private internal reasoning or unreviewed chat exports.

## Create a descriptor

Keep a descriptor in the composition workspace. Paths are relative to the descriptor file, not to the shell's current directory:

```json
{
  "id": "bach-violin-sonata-1",
  "requestId": "bach:violin-sonata:1",
  "title": "Bach’s Missing Violin Sonata",
  "subtitle": "Sonata in E minor for violin and keyboard",
  "description": "Original AI-composed homage; work in progress.",
  "movements": [
    {
      "id": "i",
      "label": "I. Adagio",
      "file": "../missing-works/scores/bach-violin-sonata-1-i.abc",
      "note": "Opening phrase, bars 1–8."
    }
  ]
}
```

Supply every movement that should be in this snapshot. Do not include nonexistent or unplayable movements. Movement IDs must stay stable as the work grows, so a listener following movement II remains on II when a new revision arrives. A later snapshot may have more movements or more bars; it may also revise earlier music.

## Publish

From the source checkout:

```sh
node tools/publish-draft.mjs \
  --manifest /home/mirendil/bach-sonata/draft.json \
  --message "Added the opening imitation; revised the bass in bars 5–8." \
  --expect 0
```

The first expected revision is 0. For the next publish use the previous returned revision, or omit `--expect` if you deliberately want to publish against whatever is latest. An expected-revision mismatch prevents an older writer from accidentally replacing a newer take. `--dry-run` validates without publishing.

The command reads the `.abc` files and sends a structured payload over SSH stdin to the owner-only publishing CLI. It does not put score text or metadata into a shell command. Public visitors cannot upload or replace drafts.

The server validates syntax, matching parts and complete bars before publishing. This is **not** a verdict on harmony, counterpoint, instrumental practicality, or musical quality. Those remain the composer's responsibility. Invalid snapshots leave the previous playable draft unchanged.

Successful publication returns a revision number and a listening link:

`https://lost-compositions.exe.xyz/work.html?draft=bach-violin-sonata-1`

## What listeners see

- A clearly labelled draft with its revision, publication time, change note, available movements and bar counts.
- While stopped and following latest, new snapshots appear automatically.
- While playing, loading, paused, or editing the source locally, the score and audio remain on the current take. A new-version notice offers an explicit switch.
- Switching stops the old take; an update never starts playback on its own. The listener can choose a starting bar or click a note after switching. The bar navigator counts a pickup as its first written bar; published progress counts exclude pickups. The control states this convention, and repeated bars use their first occurrence.
- A revision selector opens older takes. Returning to Follow latest resumes updates.
- A network failure leaves the last playable take visible. The page retries without silently replacing it with partial data.

The draft page checks for updates while it is open and visible. This is browser refresh behavior, not an agent generation schedule.

## Completing the work

Follow `docs/composing.md`: publish the finished catalogue entry and its score/notebook/transcript files, synchronize the server catalogue, then complete the request through the SSH-only admin CLI. Do not mark it completed merely because a draft has been published.

The draft viewer will link to the finished work, and its revision history remains accessible. If the request is reopened, its existing snapshots stay available but are labelled as paused rather than actively composing.

## Storage and deployment

Snapshots live under `/var/lib/missing-works/drafts`, separate from `/var/www/missing-works/releases`. Routine website releases cannot delete the history. Public read routes serve only validated metadata and score files, never arbitrary local files. Do not copy the private snapshot state into the static public file list.

This directory persists across service restarts. Existing automated backups cover the vote database; off-host archival of draft history is not automatic. Treat the scores in the composition workspace and source repository as additional copies, not a substitute for an archive backup policy.
