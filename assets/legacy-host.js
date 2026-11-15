// Preserve old GitHub Pages links without hosting a second copy of the application.
(() => {
  const prefix = '/beethovens-missing-quartet/';
  if (location.hostname !== 'akrentsel.github.io' || !location.pathname.startsWith(prefix)) return;
  const path = location.pathname.slice(prefix.length);
  location.replace('https://lost-compositions.exe.xyz/' + path + location.search + location.hash);
})();
