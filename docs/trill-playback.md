# Key-aware trill playback

## Bug and fix

Upstream abcjs 6.5.2 expands `!trill!` by alternating the principal MIDI pitch with `pitch + 2`. That makes every ordinary trill a whole tone, even when the score's next diatonic note is a semitone away.

The browser now loads `assets/vendor/abcjs-basic-min.js`, a narrowly patched, locally served copy of the same pinned version. In `src/synth/abc_midi_flattener.js`, the ornament expander receives the written note and resolves `note.pitch + 1` (one **diatonic** step) through the library's existing `adjustPitch` function. This uses the active key signature, same-voice/same-octave bar accidentals, and transposition. The lookup has no explicit accidental and therefore does not modify accidental state. Microtonal auxiliary pitches pass through the existing cents conversion instead of becoming invalid fractional sample IDs.

Examples:

| Principal and context | Before | After |
|---|---|---|
| E in C major | E–F♯ | E–F |
| F♯ in E minor | F♯–G♯ | F♯–G |
| A in F major | A–B | A–B♭ |
| B in C major | B–C♯ | B–C |
| D in C major | D–E | D–E (unchanged) |

The key-aware pitches are selected **before** instrument samples are loaded, and the same library handles MIDI export, so notation, audio sample selection and downloaded MIDI agree. Both `work.html` (completed works and live drafts) and the legacy `beethoven.html` player use the patched dependency.

## Deliberately unchanged

- Trill rhythm, duration, attack order (upper note first), dynamics and instrument choices.
- Explicit `!trillh!`, the library's forced-semitone override.
- Mordents, turns and other ornaments; this patch only changes ordinary trills.
- Harmonic interpretation: the player does not infer an unwritten raised leading tone or an unwritten accidental on an auxiliary. Those must be specified in the music.
- Drum-map or rhythm-head notes without an ordinary written pitch keep the upstream fallback.

The unmodified server-side parser in `server/vendor/abcjs.cjs` is still used for structural validation and duration calculation; neither depends on the corrected auxiliary pitch.

## Rebuild and verify

```sh
node tools/build-abcjs.mjs
node tools/build-abcjs.mjs --check
node --test tests/trills.test.mjs
```

The build script verifies the original bundle's SHA-256, then applies exactly three uniquely matched changes. It refuses to patch a different upstream version. The change is readable in the script; no undocumented manual edit of the minified file is required. The generated file includes a `missingWorksTrillPatch` version marker, and upstream MIT licensing and bundled notices are retained in `assets/vendor/abcjs_basic.LICENSE`.

Tests reproduce the original bug and cover semitone/whole-tone neighbours in major, minor and modal keys, octave boundaries, principal and auxiliary accidentals, natural cancellation, bar resets, voice isolation, key changes, transposition, repeats, the forced-half-step override, microtonal sample IDs, MIDI export, reproducibility and unchanged ordinary notes/other ornaments.
