# Test-only catalogues and scores

Nothing in this directory belongs in `deploy/public-files.txt`.

- `backend-catalog.json` is a **fixed initial-state catalogue**: 36 composers, four forms, one completed Beethoven quartet, and Bach's first violin-sonata round still open. Backend, publishing and local voting tests use it so completing real works does not silently change their preconditions. Do not refresh this fixture whenever a composition is published. Tests that exercise completion derive their own updated copies.
- `catalog.json` and the small `.abc` files are synthetic player fixtures for different instrument counts, missing scores and invalid paths.
- `tests/catalog.test.mjs` separately validates the real `data/catalog.json` and its score links. The application continues to use the real catalogue; no production seeding behavior was changed to accommodate tests.

Browser mocks testing a not-yet-completed work must also serve the fixed fixture rather than the current production catalogue. Actual live-site smoke tests should read the target site's catalogue and derive expectations from it.
