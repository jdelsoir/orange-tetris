/**
 * js/main.js - Orange Tetris entry point.
 *
 * Deliberately thin: build the four collaborators once the DOM exists, wire
 * the buttons to UI methods, and keep the canvases sized. Every rule, pixel,
 * key and score lives in engine.js / render.js / ui.js / leaderboard.js.
 */

import { Engine } from './engine.js';
import { Renderer } from './render.js';
import * as leaderboard from './leaderboard.js';
import { UI, collectDom } from './ui.js';

/** @param {HTMLElement|null} el @param {() => void} fn */
function onClick(el, fn) {
  if (el) el.addEventListener('click', fn);
}

/**
 * Keep both canvases matched to their CSS box, coalescing bursts of resize
 * events into a single rAF-aligned re-measure.
 * @param {UI} ui
 */
function watchResize(ui) {
  let queued = 0;

  const flush = () => {
    queued = 0;
    ui.resize();
  };
  const schedule = () => {
    if (queued) return;
    queued = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 16);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', schedule);

  // devicePixelRatio can change when a window moves between displays.
  if (typeof window.matchMedia === 'function') {
    const dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (dprQuery && typeof dprQuery.addEventListener === 'function') {
      dprQuery.addEventListener('change', schedule);
    }
  }

  // The board only gets a real box once the game screen is shown. Keep a hard
  // reference to the observer: a bare `new ResizeObserver(...)` is collectable.
  let observer = null;
  if (typeof ResizeObserver === 'function' && ui.dom.board) {
    observer = new ResizeObserver(schedule);
    observer.observe(ui.dom.board);
    if (ui.dom.next) observer.observe(ui.dom.next);
  }
  return observer;
}

function boot() {
  const dom = collectDom(document);
  if (dom.missing.length) {
    console.warn('[tetris] markup is missing these ids:', dom.missing.join(', '));
  }

  const engine = new Engine();
  const renderer = new Renderer(dom.board, dom.next);
  const ui = new UI({ engine, renderer, dom, leaderboard, window, document });

  // --- start screen -------------------------------------------------
  onClick(dom.btnNewGame, () => ui.newGame());
  onClick(dom.btnLeaderboard, () => ui.showLeaderboard('start'));

  // --- game screen --------------------------------------------------
  onClick(dom.btnPause, () => ui.togglePause());
  onClick(dom.btnQuit, () => ui.quit());

  // --- leaderboard screen -------------------------------------------
  onClick(dom.btnLbBack, () => ui.leaveLeaderboard());
  onClick(dom.btnLbClear, () => ui.clearLeaderboard());

  // --- game over screen ---------------------------------------------
  onClick(dom.btnPlayAgain, () => ui.newGame());
  onClick(dom.btnGoLeaderboard, () => ui.showLeaderboard('gameover'));

  const resizeObserver = watchResize(ui);
  ui.mount();

  // The manifest's "New Game" shortcut launches ./?new=1 — honour it instead of
  // landing on the start screen like the plain icon does.
  if (wantsNewGame()) ui.newGame();

  // Handy for debugging from the console, but not something to hand every
  // visitor: local development only.
  if (isLocalHost()) window.tetris = { engine, renderer, ui, resizeObserver };
}

/** True when the app was launched from the manifest's "New Game" shortcut. */
function wantsNewGame() {
  try {
    return new URLSearchParams(location.search).has('new');
  } catch {
    return false;
  }
}

function isLocalHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '' || location.protocol === 'file:';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
