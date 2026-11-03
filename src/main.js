// Entry: the fork game by default; ?classic runs the original worm-horror prototype.
const params = new URLSearchParams(location.search);
if (params.has('classic')) import('./classic.js');
else import('./game.js');
