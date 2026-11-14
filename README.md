# Beethoven’s Missing Quartet

An original AI-composed string quartet in D minor, inspired by Beethoven. **Not a lost or rediscovered work by Beethoven.** Composed with Lor in four movements; approximately 18 minutes.

- `index.html`: an interactive score and sampled playback, using [abcjs](https://www.abcjs.net/).
- `notebook.html`: an edited, high-level composition notebook based on recorded decisions, revision reports and test results. Not raw private reasoning or chat logs.
- `transcript.html` and `transcript.json`: a searchable public excerpt of the main conversation and four subagent histories, with omission markers and redaction notes. Private internal reasoning and provider metadata are not included.
- `scores/`: the four movements in ABC notation.

## Publish with GitHub Pages

In **Settings → Pages**, choose **Deploy from a branch**, select **main**, choose **/ (root)**, and save.

The site will be at https://akrentsel.github.io/beethovens-missing-quartet/ once deployment finishes.

The page needs network access for the notation library, fonts and instrument samples. Click Play to enable browser audio. The scores and player have been checked analytically and in headless-browser tests; this is not a recording of live performers or a musicological claim about what Beethoven would have written.
