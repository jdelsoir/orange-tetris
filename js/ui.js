/**
 * js/ui.js - Orange Tetris shell: screen router, game loop, input, HUD,
 * leaderboard rendering and the line-clear animation clock.
 *
 * This is the only module that knows about both the DOM and the game modules.
 * It owns no game rules (engine.js), no pixels (render.js) and no persistence
 * (leaderboard.js): it wires them together and drives the clock.
 *
 * Everything it needs is injectable through the constructor so the whole
 * controller can be exercised without a browser.
 */

import * as defaultScores from './leaderboard.js';
import { levelColor, levelGlow } from './render.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Line-clear animation length, and its prefers-reduced-motion counterpart. */
export const CLEAR_MS = 450;
export const CLEAR_MS_REDUCED = 120;

/** Level-up ignite length. Skipped outright under prefers-reduced-motion. */
export const LEVEL_MS = 700;

/** Autorepeat: delayed auto shift, then auto repeat rate. */
export const DAS_MS = 170;
export const ARR_MS = 50;

/** Frame delta clamp: a backgrounded tab must not teleport the piece. */
const MAX_FRAME_MS = 100;

/** Safety valve on the ARR catch-up loop. */
const MAX_REPEATS_PER_FRAME = 8;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/* ------------------------------------------------------------------ *
 * DOM binding
 * ------------------------------------------------------------------ */

/** name -> element id, for the four screens. */
export const SCREEN_IDS = Object.freeze({
  start: 'screen-start',
  game: 'screen-game',
  leaderboard: 'screen-leaderboard',
  gameover: 'screen-gameover'
});

/** name -> element id, for everything else ui.js touches. */
export const ELEMENT_IDS = Object.freeze({
  board: 'board',
  next: 'next',
  hudScore: 'hud-score',
  hudLines: 'hud-lines',
  hudLevel: 'hud-level',
  hudLevelSlot: 'hud-level-slot',
  hudLevelGhost: 'hud-level-ghost',
  pauseOverlay: 'pause-overlay',
  btnPause: 'btn-pause',
  btnQuit: 'btn-quit',
  btnNewGame: 'btn-new-game',
  btnLeaderboard: 'btn-leaderboard',
  btnLbBack: 'btn-lb-back',
  btnLbClear: 'btn-lb-clear',
  leaderboardList: 'leaderboard-list',
  leaderboardEmpty: 'leaderboard-empty',
  goScore: 'go-score',
  goLines: 'go-lines',
  goLevel: 'go-level',
  goNewHigh: 'go-newhigh',
  btnPlayAgain: 'btn-play-again',
  btnGoLeaderboard: 'btn-go-leaderboard',
  btnLeft: 'btn-left',
  btnRight: 'btn-right',
  btnRotate: 'btn-rotate',
  btnDown: 'btn-down',
  btnDrop: 'btn-drop'
});

/** The touch buttons, and whether holding them autorepeats. */
const TOUCH_BUTTONS = Object.freeze([
  { key: 'btnLeft', action: 'left', hold: true },
  { key: 'btnRight', action: 'right', hold: true },
  { key: 'btnDown', action: 'softDrop', hold: true },
  { key: 'btnRotate', action: 'rotateCW', hold: false },
  { key: 'btnDrop', action: 'hardDrop', hold: false }
]);

/**
 * Look every contracted id up once.
 * @param {Document|HTMLElement} [root=document]
 * @returns {object} { screens: {...}, ...elements, missing: string[] }
 */
export function collectDom(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  const find = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);

  const dom = { screens: {}, missing: [] };
  for (const name of Object.keys(SCREEN_IDS)) {
    const el = find(SCREEN_IDS[name]);
    dom.screens[name] = el;
    if (!el) dom.missing.push(SCREEN_IDS[name]);
  }
  for (const name of Object.keys(ELEMENT_IDS)) {
    const el = find(ELEMENT_IDS[name]);
    dom[name] = el;
    // #leaderboard-empty is the one nice-to-have: CSS can hide it on its own.
    if (!el && name !== 'leaderboardEmpty') dom.missing.push(ELEMENT_IDS[name]);
  }
  return dom;
}

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

export class UI {
  /**
   * @param {object} options
   * @param {object} options.engine    Engine instance.
   * @param {object} options.renderer  Renderer instance.
   * @param {object} options.dom       Result of collectDom().
   * @param {object} [options.leaderboard] leaderboard.js module (injectable).
   * @param {Window} [options.window]
   * @param {Document} [options.document]
   */
  constructor(options) {
    const opts = options || {};
    this.engine = opts.engine;
    this.renderer = opts.renderer;
    this.dom = opts.dom || {};
    this.scores = opts.leaderboard || defaultScores;
    this.win = opts.window || (typeof window !== 'undefined' ? window : null);
    this.doc =
      opts.document ||
      (this.win && this.win.document) ||
      (typeof document !== 'undefined' ? document : null);

    /** Handed to renderer.draw() every frame. */
    this.anim = { clearProgress: 0, levelProgress: 0, levelColor: null, reducedMotion: false };

    /** @type {'start'|'game'|'leaderboard'|'gameover'} */
    this.screen = 'start';
    /** Where #btn-lb-back should return to. */
    this._lbReturn = 'start';

    // Loop state.
    this._raf = 0;
    this._last = 0;
    this._running = false;

    // Line-clear animation state.
    this._clearing = false;
    this._clearElapsed = 0;
    this._clearDuration = CLEAR_MS;

    // Autorepeat state: action -> { t, armed }.
    this._holds = new Map();

    // Canvas box signature, so we only re-measure when the layout moves.
    this._box = '';

    // HUD mirror, so we only touch the DOM when a number actually changes.
    this._hud = { score: null, lines: null, level: null };
    this._pauseShown = null;
    this._gameOverShown = false;

    this._bound = [];
    this._frame = this._frame.bind(this);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /** Attach global listeners and paint the initial screen. Idempotent. */
  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this._bindKeyboard();
    this._bindTouch();
    this._bindVisibility();
    this.showScreen('start');
    return this;
  }

  /** Detach everything (used by tests and hot reloads). */
  destroy() {
    this._stopLoop();
    for (const off of this._bound) {
      try {
        off();
      } catch {
        /* listener already gone */
      }
    }
    this._bound.length = 0;
    this._holds.clear();
    this._mounted = false;
  }

  _on(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    this._bound.push(() => target.removeEventListener(type, handler, options));
  }

  /* ---------------------------------------------------------------- *
   * Screen router
   * ---------------------------------------------------------------- */

  /**
   * Exactly one screen carries `screen--active`.
   * @param {'start'|'game'|'leaderboard'|'gameover'} name
   */
  showScreen(name) {
    const screens = this.dom.screens || {};
    for (const key of Object.keys(screens)) {
      const el = screens[key];
      if (el && el.classList) el.classList.toggle('screen--active', key === name);
    }
    this.screen = name;
    if (name !== 'game') {
      this._releaseHolds();
      this._stopLoop();
    }
    return this;
  }

  /* ---------------------------------------------------------------- *
   * Game flow
   * ---------------------------------------------------------------- */

  /** Start (or restart) a run and show the game screen. */
  newGame() {
    const e = this.engine;
    this._releaseHolds();
    this._clearing = false;
    this._clearElapsed = 0;
    this.anim.clearProgress = 0;
    this._endLevelUp();
    this._gameOverShown = false;
    this._hud = { score: null, lines: null, level: null };
    this._pauseShown = null;

    if (this.dom.goNewHigh) this.dom.goNewHigh.hidden = true;
    if (e && typeof e.start === 'function') e.start();

    this.showScreen('game');
    this._syncHud();
    this._syncPause();
    this.resize();
    this._startLoop();
    // The start screen just went display:none, which would drop focus on <body>
    // and send the next Tab back to the top of the document. Focus lands on the
    // playfield, not on Pause: a focused <button> owns Space and the arrows, so
    // parking focus there would leave the game unplayable from the keyboard.
    // The board is tabindex="-1", so Tab from here still reaches Pause.
    this._focus(this.dom.board);
    return this;
  }

  /** Abandon the current run and go back to the start screen. */
  quit() {
    const e = this.engine;
    if (e && e.paused && typeof e.togglePause === 'function') e.togglePause();
    this._releaseHolds();
    this._clearing = false;
    this.anim.clearProgress = 0;
    this._endLevelUp();
    this.showScreen('start');
    this._focus(this.dom.btnNewGame);
    return this;
  }

  /** Pause / resume. Gravity stops, rendering continues. */
  togglePause() {
    const e = this.engine;
    if (this.screen !== 'game' || !e) return this;
    if (e.gameOver || e.phase === 'over' || e.phase === 'ready') return this;
    if (typeof e.togglePause === 'function') e.togglePause();
    this._releaseHolds();
    this._syncPause();
    return this;
  }

  /** Pause on tab blur, never resume automatically. */
  autoPause() {
    const e = this.engine;
    if (this.screen !== 'game' || !e || e.paused || e.gameOver) return this;
    if (e.phase !== 'playing' && e.phase !== 'clearing') return this;
    return this.togglePause();
  }

  /* ---------------------------------------------------------------- *
   * Loop
   * ---------------------------------------------------------------- */

  _startLoop() {
    if (this._running) return;
    const raf = this.win && this.win.requestAnimationFrame;
    this._running = true;
    this._last = 0;
    if (typeof raf === 'function') {
      this._raf = raf.call(this.win, this._frame);
    } else {
      // No rAF (tests, exotic hosts): draw one frame and stop.
      this._running = false;
      this._draw();
    }
  }

  _stopLoop() {
    if (!this._running) return;
    this._running = false;
    const cancel = this.win && this.win.cancelAnimationFrame;
    if (typeof cancel === 'function' && this._raf) cancel.call(this.win, this._raf);
    this._raf = 0;
  }

  _frame(timestamp) {
    if (!this._running) return;
    const raf = this.win && this.win.requestAnimationFrame;
    if (typeof raf === 'function') this._raf = raf.call(this.win, this._frame);

    const ts = typeof timestamp === 'number' && isFinite(timestamp) ? timestamp : 0;
    let dt = this._last ? ts - this._last : 0;
    this._last = ts;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;

    this.step(dt);
  }

  /**
   * One logical frame. Public so tests can drive the clock by hand.
   * @param {number} dt milliseconds since the previous frame.
   */
  step(dt) {
    const e = this.engine;
    if (!e) return;

    // The ignite is an overlay, not a beat in the game: it keeps running while
    // the next piece falls and only freezes on pause.
    if (this._levelUp && !e.paused) this._advanceLevelUp(dt);

    if (e.phase === 'clearing') {
      // Gravity never advances here: engine.tick() is not called at all.
      if (!this._clearing) this._beginClear();
      else if (!e.paused) this._advanceClear(dt);
    } else {
      this._clearing = false;
      this.anim.clearProgress = 0;
      if (e.phase === 'playing' && !e.paused && !e.gameOver) {
        this._pumpHolds(dt);
        e.tick(dt);
        if (e.phase === 'clearing') this._beginClear();
      }
    }

    this._syncHud();
    this._draw();
    if (e.gameOver) this._handleGameOver();
  }

  _draw() {
    this._syncCanvasBox();
    const r = this.renderer;
    if (r && typeof r.draw === 'function') r.draw(this.engine, this.anim);
  }

  /**
   * Cheap per-frame guard against a stale backing store.
   *
   * Resize events are not reliable: a devicePixelRatio change, a CSS-driven
   * relayout, or a viewport override can move the canvas box without ever
   * firing `resize`. Comparing the box signature costs one layout read and
   * re-measures only when something actually moved.
   * @returns {boolean} true when the renderer was re-measured.
   */
  _syncCanvasBox() {
    const board = this.dom.board;
    if (!board) return false;
    const dpr = (this.win && this.win.devicePixelRatio) || 1;
    const w = board.clientWidth || 0;
    const h = board.clientHeight || 0;
    const nextEl = this.dom.next;
    const nw = nextEl ? nextEl.clientWidth || 0 : 0;
    const nh = nextEl ? nextEl.clientHeight || 0 : 0;
    const signature = w + 'x' + h + '/' + nw + 'x' + nh + '@' + dpr;
    if (signature === this._box) return false;
    this._box = signature;
    // A hidden screen reports a zero box; leave the backing store alone.
    if (w <= 0 || h <= 0) return false;
    const r = this.renderer;
    if (r && typeof r.resize === 'function') {
      r.resize();
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Line-clear animation
   * ---------------------------------------------------------------- */

  /** @returns {number} animation length in ms, honouring prefers-reduced-motion. */
  clearDurationMs() {
    return this.prefersReducedMotion() ? CLEAR_MS_REDUCED : CLEAR_MS;
  }

  prefersReducedMotion() {
    const w = this.win;
    if (!w || typeof w.matchMedia !== 'function') return false;
    try {
      const mq = w.matchMedia(REDUCED_MOTION_QUERY);
      return !!(mq && mq.matches);
    } catch {
      return false;
    }
  }

  _beginClear() {
    this._clearing = true;
    this._clearElapsed = 0;
    const reduced = this.prefersReducedMotion();
    this._clearDuration = reduced ? CLEAR_MS_REDUCED : CLEAR_MS;
    this.anim.clearProgress = 0;
    // Shortening a full-strength white flash would only make it strobe, so the
    // renderer is told to drop the flash and the glow outright.
    this.anim.reducedMotion = reduced;
    // Keep physically held keys and buttons held: only their DAS/ARR clocks are
    // rewound, so autorepeat picks up again by itself once the next piece spawns.
    this._rewindHolds();
  }

  _advanceClear(dt) {
    const step = isFinite(dt) && dt > 0 ? dt : 0;
    this._clearElapsed += step;
    const dur = this._clearDuration > 0 ? this._clearDuration : 1;
    const p = this._clearElapsed / dur;
    this.anim.clearProgress = p >= 1 ? 1 : p;

    if (this._clearElapsed >= dur) {
      this._clearing = false;
      this.anim.clearProgress = 0;
      if (typeof this.engine.commitClear === 'function') this.engine.commitClear();
    }
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  /**
   * Run one game action by name.
   * @param {'left'|'right'|'rotateCW'|'rotateCCW'|'softDrop'|'hardDrop'|'pause'} action
   */
  action(action) {
    const e = this.engine;
    if (!e || this.screen !== 'game') return false;

    if (action === 'pause') {
      this.togglePause();
      return true;
    }
    if (e.paused || e.gameOver || e.phase !== 'playing') return false;

    switch (action) {
      case 'left':
        return !!e.moveLeft();
      case 'right':
        return !!e.moveRight();
      case 'rotateCW':
        return !!e.rotateCW();
      case 'rotateCCW':
        return !!e.rotateCCW();
      case 'softDrop':
        e.softDrop();
        return true;
      case 'hardDrop':
        // A drop that completes rows flips the engine to 'clearing'; the loop
        // is the single owner of the animation clock and picks it up there.
        e.hardDrop();
        return true;
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Autorepeat (DAS / ARR)
   * ---------------------------------------------------------------- */

  /** Left and right are mutually exclusive so a stuck key cannot cancel itself out. */
  _holdStart(action) {
    if (this._holds.has(action)) return;
    if (action === 'left') this._holds.delete('right');
    if (action === 'right') this._holds.delete('left');
    this.action(action);
    this._holds.set(action, { t: 0, armed: false });
  }

  _holdStop(action) {
    this._holds.delete(action);
  }

  _releaseHolds() {
    this._holds.clear();
  }

  /**
   * Restart every hold's DAS/ARR clock without forgetting that the key or
   * button is still down. Used by the line-clear pause: dropping the holds
   * there left the eventual keyup with nothing to release, so the player had
   * to lift and press again after every clear.
   */
  _rewindHolds() {
    for (const state of this._holds.values()) {
      state.t = 0;
      state.armed = false;
    }
  }

  _pumpHolds(dt) {
    if (this._holds.size === 0) return;
    const step = isFinite(dt) && dt > 0 ? dt : 0;
    for (const [action, state] of this._holds) {
      state.t += step;
      if (!state.armed) {
        if (state.t >= DAS_MS) {
          state.t -= DAS_MS;
          state.armed = true;
          this.action(action);
        } else {
          continue;
        }
      }
      let guard = 0;
      while (state.t >= ARR_MS && guard++ < MAX_REPEATS_PER_FRAME) {
        state.t -= ARR_MS;
        this.action(action);
      }
      if (state.t > ARR_MS) state.t = ARR_MS;
    }
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  _bindKeyboard() {
    const target = this.win || this.doc;
    this._on(target, 'keydown', (ev) => this.handleKeyDown(ev));
    this._on(target, 'keyup', (ev) => this.handleKeyUp(ev));
  }

  /**
   * True for a focused control that owns its own keyboard behaviour. Space and
   * the arrows must reach it untouched: preventDefault() on keydown would stop
   * a <button> from activating, so tabbing to Pause and pressing Space used to
   * hard drop instead.
   */
  static isInteractiveTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (target.isContentEditable) return true;
    const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  /** Arrows and space must never scroll the page while playing. */
  static scrollKey(key) {
    return (
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      key === 'ArrowUp' ||
      key === 'ArrowDown' ||
      key === ' ' ||
      key === 'Spacebar'
    );
  }

  handleKeyDown(ev) {
    if (!ev || this.screen !== 'game') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // The listener sits on window, so the event has already bubbled up from
    // whatever has focus. Leave that control alone.
    if (UI.isInteractiveTarget(ev.target)) return;

    const key = ev.key;
    if (UI.scrollKey(key) && typeof ev.preventDefault === 'function') ev.preventDefault();
    // The browser's own key repeat is ignored: DAS/ARR is driven by the loop.
    if (ev.repeat) return;

    switch (key) {
      case 'ArrowLeft':
        this._holdStart('left');
        break;
      case 'ArrowRight':
        this._holdStart('right');
        break;
      case 'ArrowDown':
        this._holdStart('softDrop');
        break;
      case 'ArrowUp':
      case 'x':
      case 'X':
        this.action('rotateCW');
        break;
      case 'z':
      case 'Z':
        this.action('rotateCCW');
        break;
      case ' ':
      case 'Spacebar':
        this.action('hardDrop');
        break;
      case 'p':
      case 'P':
      case 'Escape':
        this.action('pause');
        break;
      default:
        break;
    }
  }

  handleKeyUp(ev) {
    if (!ev) return;
    if (UI.isInteractiveTarget(ev.target)) return;
    const key = ev.key;
    if (UI.scrollKey(key) && this.screen === 'game' && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }
    if (key === 'ArrowLeft') this._holdStop('left');
    else if (key === 'ArrowRight') this._holdStop('right');
    else if (key === 'ArrowDown') this._holdStop('softDrop');
  }

  /* ---------------------------------------------------------------- *
   * Touch controls
   * ---------------------------------------------------------------- */

  _bindTouch() {
    for (const spec of TOUCH_BUTTONS) {
      const el = this.dom[spec.key];
      if (!el) continue;
      // Pointer events only: no 300ms tap delay, no synthetic mouse echo.
      if (el.style) el.style.touchAction = 'none';

      this._on(el, 'pointerdown', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (ev && typeof el.setPointerCapture === 'function' && ev.pointerId != null) {
          try {
            el.setPointerCapture(ev.pointerId);
          } catch {
            /* capture is a nicety, not a requirement */
          }
        }
        if (spec.hold) this._holdStart(spec.action);
        else this.action(spec.action);
      });

      if (spec.hold) {
        const release = () => this._holdStop(spec.action);
        this._on(el, 'pointerup', release);
        this._on(el, 'pointercancel', release);
        this._on(el, 'pointerleave', release);
      }

      // The controls stay visible and tabbable on a coarse/hybrid pointer, so
      // Enter and Space on a focused button must do something. A keyboard
      // activation reports detail === 0; a pointer-driven click reports 1 and
      // is ignored here because pointerdown already handled it.
      this._on(el, 'click', (ev) => {
        if (ev && typeof ev.detail === 'number' && ev.detail > 0) return;
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        this.action(spec.action);
      });

      // Long-press on a control should not open the context menu.
      this._on(el, 'contextmenu', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Visibility
   * ---------------------------------------------------------------- */

  _bindVisibility() {
    this._on(this.win, 'blur', () => this.autoPause());
    this._on(this.doc, 'visibilitychange', () => {
      if (this.doc && this.doc.hidden) this.autoPause();
    });
  }

  /* ---------------------------------------------------------------- *
   * HUD / overlay
   * ---------------------------------------------------------------- */

  /** Write score/lines/level only when the value actually moved. */
  _syncHud() {
    const e = this.engine;
    if (!e) return;
    this._setNumber('hudScore', 'score', e.score);
    this._setNumber('hudLines', 'lines', e.lines);

    const before = this._hud.level;
    this._setNumber('hudLevel', 'level', e.level);
    const after = this._hud.level;
    if (after === before) return;

    // A rise is a level-up and gets the animation; anything else (a new game
    // resetting to 1) just repaints in the new colour.
    if (typeof before === 'number' && after > before) this._beginLevelUp(before, after);
    else this._paintLevel(after, null);
  }

  /* ---------------------------------------------------------------- *
   * Level-up
   * ---------------------------------------------------------------- */

  /**
   * @param {number} from level just left behind
   * @param {number} to   level just reached
   */
  _beginLevelUp(from, to) {
    this._paintLevel(to, from);
    // Reduced motion keeps the recolour, which carries the information, and
    // drops the ignite and the cut, which only carry the drama.
    if (this.prefersReducedMotion()) {
      this._levelUp = false;
      this.anim.levelProgress = 0;
      this.anim.levelColor = null;
      return;
    }
    this._levelUp = true;
    this._levelElapsed = 0;
    this.anim.levelProgress = 0;
    this.anim.levelColor = levelColor(to);
    this._restartLevelCut();
  }

  _advanceLevelUp(dt) {
    const step = isFinite(dt) && dt > 0 ? dt : 0;
    this._levelElapsed += step;
    const p = this._levelElapsed / LEVEL_MS;
    this.anim.levelProgress = p >= 1 ? 1 : p;
    if (this._levelElapsed >= LEVEL_MS) this._endLevelUp();
  }

  _endLevelUp() {
    this._levelUp = false;
    this._levelElapsed = 0;
    this.anim.levelProgress = 0;
    this.anim.levelColor = null;
  }

  /**
   * Paint the level colour onto the HUD.
   * @param {number} level
   * @param {number|null} from previous level, or null for a plain repaint.
   */
  _paintLevel(level, from) {
    const slot = this.dom.hudLevelSlot;
    if (slot && slot.style && typeof slot.style.setProperty === 'function') {
      slot.style.setProperty('--c-level', levelColor(level));
      // Levels 9 and 10 share brand orange with 8, so they escalate with a glow.
      slot.style.setProperty('--c-level-glow', levelGlow(level) || 'none');
      if (from != null) slot.style.setProperty('--c-level-prev', levelColor(from));
    }
    const ghost = this.dom.hudLevelGhost;
    if (ghost) ghost.textContent = from != null ? String(from) : '';
  }

  /** Re-run the CSS cut by taking the class off, reflowing, and putting it back. */
  _restartLevelCut() {
    const slot = this.dom.hudLevelSlot;
    if (!slot || !slot.classList) return;
    slot.classList.remove('is-levelup');
    // Reading a layout property between the two flushes the removal, without
    // which the browser coalesces them and the animation never restarts.
    void slot.offsetWidth;
    slot.classList.add('is-levelup');
  }

  _setNumber(domKey, hudKey, value) {
    const v = typeof value === 'number' && isFinite(value) ? Math.trunc(value) : 0;
    if (this._hud[hudKey] === v) return;
    this._hud[hudKey] = v;
    const el = this.dom[domKey];
    if (el) el.textContent = String(v);
  }

  _syncPause() {
    const paused = !!(this.engine && this.engine.paused);
    if (this._pauseShown === paused) return;
    this._pauseShown = paused;
    if (this.dom.pauseOverlay) this.dom.pauseOverlay.hidden = !paused;
    const btn = this.dom.btnPause;
    if (btn) {
      btn.textContent = paused ? 'Resume' : 'Pause';
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    }
  }

  /* ---------------------------------------------------------------- *
   * Game over
   * ---------------------------------------------------------------- */

  _handleGameOver() {
    if (this._gameOverShown) return;
    this._gameOverShown = true;
    this._releaseHolds();
    this._stopLoop();

    const e = this.engine;
    const score = Math.trunc(e && isFinite(e.score) ? e.score : 0);
    const lines = Math.trunc(e && isFinite(e.lines) ? e.lines : 0);
    const level = Math.trunc(e && isFinite(e.level) ? e.level : 1);

    if (this.dom.goScore) this.dom.goScore.textContent = String(score);
    if (this.dom.goLines) this.dom.goLines.textContent = String(lines);
    if (this.dom.goLevel) this.dom.goLevel.textContent = String(level);

    let newHigh = false;
    try {
      newHigh = !!this.scores.isHighScore(score);
      if (newHigh) this.scores.saveScore({ score, lines, level });
    } catch {
      newHigh = false;
    }
    if (this.dom.goNewHigh) this.dom.goNewHigh.hidden = !newHigh;

    if (this.dom.pauseOverlay) this.dom.pauseOverlay.hidden = true;
    this._pauseShown = false;

    this.showScreen('gameover');
    this._focus(this.dom.btnPlayAgain);
  }

  /* ---------------------------------------------------------------- *
   * Leaderboard screen
   * ---------------------------------------------------------------- */

  /**
   * @param {'start'|'gameover'} [from] where #btn-lb-back returns to.
   */
  showLeaderboard(from) {
    if (from === 'start' || from === 'gameover') this._lbReturn = from;
    this.renderLeaderboard();
    this.showScreen('leaderboard');
    this._focus(this.dom.btnLbBack);
    return this;
  }

  /** Leave the leaderboard for wherever we came from. */
  leaveLeaderboard() {
    const back = this._lbReturn === 'gameover' ? 'gameover' : 'start';
    this.showScreen(back);
    this._focus(back === 'gameover' ? this.dom.btnPlayAgain : this.dom.btnNewGame);
    return this;
  }

  /** Rebuild #leaderboard-list from storage and toggle the empty state. */
  renderLeaderboard() {
    const host = this.dom.leaderboardList;
    let list = [];
    try {
      list = this.scores.loadScores() || [];
    } catch {
      list = [];
    }

    if (host) {
      host.textContent = '';
      const doc = host.ownerDocument || this.doc;
      if (doc && typeof doc.createElement === 'function') {
        for (let i = 0; i < list.length; i++) {
          host.appendChild(this._scoreRow(doc, i + 1, list[i]));
        }
      }
    }

    const empty = this.dom.leaderboardEmpty;
    if (empty) empty.hidden = list.length > 0;
    return list;
  }

  _scoreRow(doc, rank, entry) {
    const tr = doc.createElement('tr');
    const cell = (text) => {
      const td = doc.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    };
    const num = (v, fallback) =>
      typeof v === 'number' && isFinite(v) ? String(Math.trunc(v)) : fallback;

    cell(String(rank));
    cell(num(entry && entry.score, '0'));
    cell(num(entry && entry.lines, '0'));
    cell(num(entry && entry.level, '1'));
    let when = '-';
    try {
      when = this.scores.formatDate(entry && entry.date) || '-';
    } catch {
      when = '-';
    }
    cell(when);
    return tr;
  }

  /** Confirm, then wipe the leaderboard and repaint the screen. */
  clearLeaderboard() {
    const ask = this.win && typeof this.win.confirm === 'function' ? this.win.confirm : null;
    const ok = ask ? ask.call(this.win, 'Delete all saved scores on this device?') : true;
    if (!ok) return false;
    try {
      this.scores.clearScores();
    } catch {
      /* leaderboard.js never throws, but never say never */
    }
    this.renderLeaderboard();
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Misc
   * ---------------------------------------------------------------- */

  /** Force a re-measure of both canvases and repaint. Safe to call at any time. */
  resize() {
    this._box = '';
    if (this.screen === 'game') this._draw();
    else this._syncCanvasBox();
    return this;
  }

  _focus(el) {
    if (!el || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* focus is best effort */
    }
  }
}

export default UI;
