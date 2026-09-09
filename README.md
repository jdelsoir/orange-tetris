# Orange Tetris

Tetris with Orange colours, 10 levels and a local leaderboard. A plain static web
app: vanilla JavaScript ES modules, one stylesheet, two canvases. No frameworks,
no build step, no dependencies, no network calls.

**Play: https://jdelsoir.github.io/orange-tetris/**

Installable as a PWA (Add to Home Screen / the install button in the address bar)
and fully playable offline once it has been opened once.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move left / right | Arrow left / right | on-screen arrows |
| Rotate clockwise | Arrow up, or X | rotate button |
| Rotate counter-clockwise | Z | (rotate button cycles clockwise) |
| Soft drop | Arrow down | down button |
| Hard drop | Space | drop button |
| Pause / resume | P or Esc | Pause |

Touch controls appear on coarse-pointer devices and are hidden on desktop.
The row is built for two thumbs: left, right on the left for movement, then a
wider gap, then hard drop, soft drop, rotate on the right for piece actions.
Hard drop keeps a neutral grey treatment rather than the orange accent, since
it is used once per piece and a mis-tap cannot be undone.

## Rules

- Standard 10x20 playfield, 7-bag randomiser, SRS rotation with wall kicks.
- Levels 1 to 10, one level per 10 cleared lines, gravity from 1000 ms down to 150 ms.
- Line scores: 100 / 300 / 500 / 800 times the current level, plus 1 point per soft
  dropped cell and 2 per hard dropped cell.
- The top ten scores live in this browser's `localStorage` only. Nothing is sent
  anywhere, and clearing site data clears the leaderboard.

## Run it locally

The app uses ES modules, so it needs to be served over HTTP (opening `index.html`
with `file://` will not work).

```bash
cd Tetris
python3 -m http.server 8000
# then open http://localhost:8000/
```

To exercise the service worker locally, use a normal (not private) window;
`localhost` counts as a secure origin, so registration works without HTTPS.

Tests (Node's built-in runner, no dependencies):

```bash
node --test tests/
```

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`, which publishes the repository
root to GitHub Pages. Set **Settings -> Pages -> Source = GitHub Actions** once.

The workflow stamps `__CACHE_VERSION__` in `sw.js` with a content hash of the site,
so every deploy gets a fresh cache name, the old caches are deleted on activation,
and open tabs get a "New version available" prompt instead of stale assets. The new
worker waits until the player presses **Reload** on that prompt; it never swaps
itself in under a running game. If the site is ever published without the workflow
(branch deploy, manual upload), `sw.js` notices the unstamped placeholder and serves
css/js stale-while-revalidate instead of cache-first, so nobody gets pinned to an
old build.

`manifest.webmanifest` uses relative `start_url`/`scope` (`./`), so the app is
installable both at `/orange-tetris/` and from a local server root.

Because the site is served from `/orange-tetris/`, every path in the HTML, CSS and JS
is relative. Do not introduce root-absolute paths (`/css/style.css`) or they will 404.

## Layout

```
index.html              shell, screens, PWA head block (CSP, manifest, SW registration)
css/style.css           Orange brand styling
js/engine.js            game rules, pure logic, no DOM
js/render.js            canvas drawing
js/leaderboard.js       localStorage top ten
js/ui.js  js/main.js    screen flow, input, loop
sw.js                   service worker: network-first HTML, cache-first assets
manifest.webmanifest    installability, icons, "New Game" shortcut
offline.html            fallback page when a navigation fails offline
icons/                  192, 512, maskable 512, apple-touch 180 (+ favicon-32.png)
```
