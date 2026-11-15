# Vendored code

`abcjs.cjs` is the unmodified `dist/abcjs-basic-min.js` from the npm package
`abcjs@6.5.2` (MIT, Copyright (c) 2009-2024 Paul Rosen and Gregory Dyke),
renamed to `.cjs` so Node loads it as CommonJS inside this ES-module package.
The server uses only `parseOnly` (no DOM) to validate draft ABC.

- tarball: https://registry.npmjs.org/abcjs/-/abcjs-6.5.2.tgz
- tarball integrity: sha512-XLDZPy/4TZbOqPsLwuu0Umsl79NTAcObEkboPxdYZXI8/fU6PNh59SAnkZOnEPVbyT8EXfBUjgNoe/uKd3T0xQ==
- abcjs.cjs sha256: 9a6ac915174d0cb06c5278247072cc2ab8f1f90e193a1988b3b0e6c9fcfb47b9

Licences: `abcjs.LICENSE.md` (package LICENSE.md) and
`abcjs-basic-min.js.LICENSE` (third-party notices shipped with the bundle).
