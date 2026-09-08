/**
 * UI controller tests.
 *
 * ui.js is the only module that touches both the DOM and the game, so it is
 * tested against hand-rolled DOM/window stubs (no jsdom, no npm). The clock is
 * driven by calling ui.step(dt) directly, which is exactly what the rAF loop
 * does, so animation and autorepeat timings are exact instead of flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { UI, collectDom, SCREEN_IDS, ELEMENT_IDS, CLEAR_MS, CLEAR_MS_REDUCED, DAS_MS, ARR_MS } from '../js/ui.js';
import { Engine, COLS, ROWS } from '../js/engine.js';

/* ------------------------------------------------------------------ *
 * DOM / window stubs
 * ------------------------------------------------------------------ */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(c) {
    this.set.add(c);
  }
  remove(c) {
    this.set.delete(c);
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, on) {
    const next = on === undefined ? !this.set.has(c) : !!on;
    if (next) this.set.add(c);
    else this.set.delete(c);
    return next;
  }
}

class El {
  constructor(doc, tag, id) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.classList = new ClassList();
    this.children = [];
    this.hidden = false;
    this.style = {};
    this.attrs = {};
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.writes = 0;
    this.focused = 0;
    this._text = '';
    this._listeners = new Map();
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children.length = 0;
    this.writes++;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  focus() {
    this.focused++;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }
  emit(type, ev = {}) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(ev);
  }
  listenerCount(type) {
    const set = this._listeners.get(type);
    return set ? set.size : 0;
  }
}

class Doc extends El {
  constructor() {
    super(null, 'document', '');
    this.ownerDocument = this;
    this.byId = new Map();
    this.hidden = false;
  }
  getElementById(id) {
    return this.byId.get(id) || null;
  }
  createElement(tag) {
    return new El(this, tag);
  }
  make(id, tag = 'div') {
    const el = new El(this, tag, id);
    this.byId.set(id, el);
    return el;
  }
}

class Win extends El {
  constructor(doc) {
    super(doc, 'window', '');
    this.document = doc;
    this.devicePixelRatio = 1;
    this.reducedMotion = false;
    this.confirmAnswer = true;
    this.confirmCount = 0;
    this.frames = new Map();
    this._nextFrame = 1;
  }
  requestAnimationFrame(cb) {
    const id = this._nextFrame++;
    this.frames.set(id, cb);
    return id;
  }
  cancelAnimationFrame(id) {
    this.frames.delete(id);
  }
  matchMedia(query) {
    const matches = String(query).includes('reduced-motion') ? this.reducedMotion : false;
    return { matches, media: query, addEventListener() {}, removeEventListener() {} };
  }
  confirm() {
    this.confirmCount++;
    return this.confirmAnswer;
  }
  /** Run every pending frame callback once, with the given timestamp. */
  tickFrames(ts) {
    const pending = [...this.frames.entries()];
    this.frames.clear();
    for (const [, cb] of pending) cb(ts);
    return pending.length;
  }
}

/** A recording stand-in for render.js. */
function stubRenderer() {
  return {
    resizes: 0,
    draws: 0,
    frames: [],
    resize() {
      this.resizes++;
    },
    draw(state, anim) {
      this.draws++;
      this.frames.push({ phase: state ? state.phase : null, progress: anim ? anim.clearProgress : null });
    }
  };
}

/** A leaderboard.js stand-in with the same surface. */
function stubScores(initial = []) {
  return {
    list: initial.slice(),
    saved: [],
    cleared: 0,
    loadScores() {
      return this.list.slice();
    },
    isHighScore(score) {
      return score > 0 && (this.list.length < 10 || score > this.list[this.list.length - 1].score);
    },
    saveScore(entry, nowIso = '2026-03-04T05:06:07.000Z') {
      this.saved.push({ ...entry, date: nowIso });
      this.list.push({ ...entry, date: nowIso });
      this.list.sort((a, b) => b.score - a.score);
      this.list = this.list.slice(0, 10);
      return this.list.slice();
    },
    clearScores() {
      this.cleared++;
      this.list = [];
    },
    formatDate(iso) {
      return iso ? 'DD/MM/YYYY HH:mm' : '-';
    }
  };
}

const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Full fixture: every contracted id, a real Engine, stubbed renderer/scores. */
function harness({ scores = stubScores(), seed = 11 } = {}) {
  const doc = new Doc();
  for (const id of Object.values(SCREEN_IDS)) doc.make(id, 'section');
  for (const id of Object.values(ELEMENT_IDS)) doc.make(id, id === 'board' || id === 'next' ? 'canvas' : 'div');

  const board = doc.getElementById('board');
  board.clientWidth = 300;
  board.clientHeight = 600;
  const next = doc.getElementById('next');
  next.clientWidth = 104;
  next.clientHeight = 234;

  const win = new Win(doc);
  const engine = new Engine(seeded(seed));
  const renderer = stubRenderer();
  const dom = collectDom(doc);
  const ui = new UI({ engine, renderer, dom, leaderboard: scores, window: win, document: doc });
  ui.mount();
  return { doc, win, engine, renderer, scores, dom, ui };
}

const activeScreens = (doc) =>
  Object.values(SCREEN_IDS).filter((id) => doc.getElementById(id).classList.contains('screen--active'));

const keyEvent = (key, extra = {}) => {
  const ev = { key, repeat: false, prevented: 0, preventDefault() { ev.prevented++; }, ...extra };
  if (!ev.preventDefault) ev.preventDefault = () => { ev.prevented++; };
  return ev;
};

/** Lock a piece into the bottom row so the engine enters phase 'clearing'. */
function setUpClear(engine) {
  for (let x = 1; x < COLS; x++) engine.board[ROWS - 1][x] = 'T';
  engine.current = { type: 'I', rot: 1, x: -2, y: 0 };
  engine.hardDrop();
}

/* ------------------------------------------------------------------ *
 * DOM binding
 * ------------------------------------------------------------------ */

test('collectDom resolves every contracted id', () => {
  const { dom } = harness();
  assert.deepEqual(dom.missing, []);
  for (const name of Object.keys(SCREEN_IDS)) assert.ok(dom.screens[name], `missing screen ${name}`);
  for (const name of Object.keys(ELEMENT_IDS)) assert.ok(dom[name], `missing element ${name}`);
});

test('collectDom reports absent ids instead of throwing', () => {
  const doc = new Doc();
  doc.make('screen-start', 'section');
  const dom = collectDom(doc);
  assert.ok(dom.missing.includes('screen-game'));
  assert.ok(dom.missing.includes('hud-score'));
  assert.equal(dom.screens.game, null);
});

/* ------------------------------------------------------------------ *
 * Screen router
 * ------------------------------------------------------------------ */

test('exactly one screen carries screen--active at a time', () => {
  const { doc, ui } = harness();
  assert.deepEqual(activeScreens(doc), ['screen-start']);
  for (const [name, id] of Object.entries(SCREEN_IDS)) {
    ui.showScreen(name);
    assert.deepEqual(activeScreens(doc), [id], `showScreen(${name})`);
  }
});

test('newGame shows the game screen and starts a fresh run', () => {
  const { doc, ui, engine } = harness();
  ui.newGame();
  assert.deepEqual(activeScreens(doc), ['screen-game']);
  assert.equal(engine.phase, 'playing');
  assert.equal(engine.score, 0);
  assert.equal(engine.nextQueue.length, 3);
  assert.ok(engine.current);
});

test('newGame focuses the playfield, not a button', () => {
  const { ui, dom } = harness();
  ui.newGame();
  // Focus must move (otherwise it falls back to <body> and Tab restarts at the
  // top of the document) but it must not land on a control that would swallow
  // Space and the arrow keys.
  assert.equal(dom.board.focused, 1, 'the playfield should take focus');
  assert.equal(dom.btnPause.focused, 0, 'a focused button would own Space and the arrows');
});

test('quit returns to the start screen and stops the loop', () => {
  const { doc, ui, win } = harness();
  ui.newGame();
  assert.ok(win.frames.size > 0, 'the loop should have scheduled a frame');
  ui.quit();
  assert.deepEqual(activeScreens(doc), ['screen-start']);
  assert.equal(win.frames.size, 0, 'the pending frame should be cancelled');
});

test('leaving the leaderboard returns to wherever it was opened from', () => {
  const { doc, ui } = harness();
  ui.showLeaderboard('start');
  ui.leaveLeaderboard();
  assert.deepEqual(activeScreens(doc), ['screen-start']);

  ui.showLeaderboard('gameover');
  ui.leaveLeaderboard();
  assert.deepEqual(activeScreens(doc), ['screen-gameover']);
});

/* ------------------------------------------------------------------ *
 * Loop
 * ------------------------------------------------------------------ */

test('the loop runs on requestAnimationFrame and reschedules itself', () => {
  const { ui, win, renderer } = harness();
  ui.newGame();
  const drawsAfterStart = renderer.draws;

  win.tickFrames(16);
  win.tickFrames(32);
  assert.ok(renderer.draws > drawsAfterStart + 1, 'the loop must keep drawing');
  assert.equal(win.frames.size, 1, 'exactly one frame stays queued');
});

test('a huge frame delta is clamped so a backgrounded tab cannot teleport the piece', () => {
  const { ui, win, engine } = harness();
  ui.newGame();
  const y0 = engine.current.y;
  win.tickFrames(0);
  win.tickFrames(60000); // one minute in a single frame
  assert.ok(engine.current.y - y0 <= 1, `piece fell ${engine.current.y - y0} rows on one frame`);
});

test('gravity advances at the level-1 rate', () => {
  const { ui, engine } = harness();
  ui.newGame();
  const y0 = engine.current.y;
  for (let i = 0; i < 10; i++) ui.step(100); // 1000ms
  assert.equal(engine.current.y - y0, 1);
});

/* ------------------------------------------------------------------ *
 * Line-clear animation
 * ------------------------------------------------------------------ */

test('the clear animation drives clearProgress 0 -> 1 over 450ms, then commits', () => {
  const { ui, engine } = harness();
  ui.newGame();
  setUpClear(engine);
  assert.equal(engine.phase, 'clearing');
  assert.deepEqual(engine.pendingClear, [ROWS - 1]);

  ui.step(0); // the frame that notices the clear
  assert.equal(ui.anim.clearProgress, 0);

  ui.step(CLEAR_MS / 2);
  assert.ok(Math.abs(ui.anim.clearProgress - 0.5) < 1e-9, `progress was ${ui.anim.clearProgress}`);
  assert.equal(engine.phase, 'clearing', 'must not commit early');
  assert.equal(engine.lines, 0);

  ui.step(CLEAR_MS / 2);
  assert.equal(engine.phase, 'playing');
  assert.equal(engine.lines, 1);
  assert.equal(ui.anim.clearProgress, 0);
  assert.ok(engine.current, 'the next piece must have spawned');
});

test('prefers-reduced-motion shortens the animation to 120ms', () => {
  const { ui, engine, win } = harness();
  win.reducedMotion = true;
  ui.newGame();
  setUpClear(engine);

  ui.step(0);
  assert.equal(ui.clearDurationMs(), CLEAR_MS_REDUCED);
  ui.step(CLEAR_MS_REDUCED - 1);
  assert.equal(engine.phase, 'clearing');
  ui.step(1);
  assert.equal(engine.phase, 'playing');
  assert.equal(engine.lines, 1);
});

test('prefers-reduced-motion also tells the renderer to drop the flash', () => {
  const { ui, engine, win, renderer } = harness();
  win.reducedMotion = true;
  ui.newGame();
  setUpClear(engine);

  ui.step(0);
  assert.equal(ui.anim.reducedMotion, true, 'a shortened white flash is a harder strobe, not a softer one');
  assert.ok(renderer.frames.length > 0);

  // And the default is off, so an unset preference changes nothing.
  const plain = harness();
  plain.ui.newGame();
  setUpClear(plain.engine);
  plain.ui.step(0);
  assert.equal(plain.ui.anim.reducedMotion, false);
});

test('a held key keeps repeating across a line clear', () => {
  const { ui, win, engine } = harness();
  ui.newGame();
  win.emit('keydown', keyEvent('ArrowLeft'));
  setUpClear(engine);

  ui.step(0);          // the loop picks the clear up
  ui.step(CLEAR_MS);   // ... and commits it
  assert.equal(engine.phase, 'playing');

  const x0 = engine.current.x;
  ui.step(DAS_MS + ARR_MS * 2);
  assert.ok(engine.current.x < x0, 'the still-held key must resume without a re-press');

  win.emit('keyup', keyEvent('ArrowLeft'));
  const x1 = engine.current.x;
  ui.step(DAS_MS + ARR_MS * 5);
  assert.equal(engine.current.x, x1, 'the keyup that follows must still stop the repeat');
});

test('gravity does not advance while the clear animation runs', () => {
  const { ui, engine } = harness();
  ui.newGame();
  setUpClear(engine);
  const snapshot = engine.board.map((row) => row.join(''));

  ui.step(0);
  for (let i = 0; i < 4; i++) {
    ui.step(100); // 400ms total, still under 450ms
    assert.equal(engine.phase, 'clearing');
    assert.equal(engine.current, null, 'no piece may exist mid-clear');
    assert.deepEqual(engine.board.map((row) => row.join('')), snapshot, 'the board must not move');
  }
});

test('pausing freezes the clear animation but keeps drawing', () => {
  const { ui, engine, renderer } = harness();
  ui.newGame();
  setUpClear(engine);
  ui.step(0);
  ui.step(100);
  const frozen = ui.anim.clearProgress;

  ui.togglePause();
  const draws = renderer.draws;
  ui.step(200);
  ui.step(200);
  assert.equal(ui.anim.clearProgress, frozen, 'the animation must not advance while paused');
  assert.equal(engine.phase, 'clearing');
  assert.ok(renderer.draws >= draws + 2, 'the paused frame must still be rendered');

  ui.togglePause();
  ui.step(400);
  assert.equal(engine.phase, 'playing');
});

test('the renderer receives clearProgress only while the engine is clearing', () => {
  const { ui, engine, renderer } = harness();
  ui.newGame();
  renderer.frames.length = 0;
  setUpClear(engine);
  ui.step(0);
  ui.step(200);
  ui.step(300);
  ui.step(16);

  for (const frame of renderer.frames) {
    if (frame.phase !== 'clearing') {
      assert.equal(frame.progress, 0, 'clearProgress must be 0 outside the clearing phase');
    }
    assert.ok(frame.progress >= 0 && frame.progress <= 1, `progress out of range: ${frame.progress}`);
  }
  assert.ok(renderer.frames.some((f) => f.phase === 'clearing' && f.progress > 0));
});

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

test('the contracted keys map to the contracted actions', () => {
  const { ui, win } = harness();
  ui.newGame();
  const seen = [];
  const real = ui.action.bind(ui);
  ui.action = (a) => {
    seen.push(a);
    return real(a);
  };

  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'x', 'X', 'z', 'Z', 'ArrowDown', ' ', 'p', 'P', 'Escape']) {
    win.emit('keydown', keyEvent(key));
    win.emit('keyup', keyEvent(key));
  }
  assert.deepEqual(seen, [
    'left', 'right',
    'rotateCW', 'rotateCW', 'rotateCW',
    'rotateCCW', 'rotateCCW',
    'softDrop', 'hardDrop',
    'pause', 'pause', 'pause'
  ]);
});

test('arrows and space are preventDefault-ed so the page never scrolls', () => {
  const { ui, win } = harness();
  ui.newGame();
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']) {
    const down = keyEvent(key);
    win.emit('keydown', down);
    assert.equal(down.prevented, 1, `keydown ${key} was not prevented`);
    const up = keyEvent(key);
    win.emit('keyup', up);
    assert.equal(up.prevented, 1, `keyup ${key} was not prevented`);
  }
  const other = keyEvent('p');
  win.emit('keydown', other);
  assert.equal(other.prevented, 0, 'unrelated keys must not be prevented');
});

test('space on a focused control activates it instead of hard dropping', () => {
  const { ui, win, engine, doc } = harness();
  ui.newGame();
  const y0 = engine.current.y;

  const btn = doc.createElement('button');
  const down = keyEvent(' ', { target: btn });
  win.emit('keydown', down);
  assert.equal(down.prevented, 0, 'preventDefault would stop the button activating');
  assert.equal(engine.current.y, y0, 'Space must not hard drop while a button has focus');

  const up = keyEvent(' ', { target: btn });
  win.emit('keyup', up);
  assert.equal(up.prevented, 0);

  // With nothing interactive focused it is a hard drop again.
  const score0 = engine.score;
  const loose = keyEvent(' ', { target: doc });
  win.emit('keydown', loose);
  assert.equal(loose.prevented, 1);
  assert.ok(engine.score > score0, 'Space still hard drops when no control has focus');
});

test('key repeat from the browser is ignored, but still prevented', () => {
  const { ui, win, engine } = harness();
  ui.newGame();
  const x0 = engine.current.x;
  const ev = keyEvent('ArrowLeft', { repeat: true });
  win.emit('keydown', ev);
  assert.equal(ev.prevented, 1);
  assert.equal(engine.current.x, x0, 'DAS is owned by the loop, not by the browser');
});

test('keys do nothing outside the game screen', () => {
  const { ui, win, engine } = harness();
  ui.newGame();
  const x0 = engine.current.x;
  ui.showScreen('start');
  const ev = keyEvent('ArrowLeft');
  win.emit('keydown', ev);
  assert.equal(engine.current.x, x0);
  assert.equal(ev.prevented, 0);
});

test('DAS waits 170ms, then ARR repeats every 50ms', () => {
  const { ui, win } = harness();
  ui.newGame();
  let repeats = 0;
  const real = ui.action.bind(ui);
  ui.action = (a) => {
    if (a === 'left') repeats++;
    return real(a);
  };

  win.emit('keydown', keyEvent('ArrowLeft'));
  assert.equal(repeats, 1, 'the first move is immediate');

  ui.step(DAS_MS - 1);
  assert.equal(repeats, 1, 'nothing may repeat before the DAS delay');

  ui.step(1);
  assert.equal(repeats, 2, 'the first autorepeat fires at the DAS delay');

  ui.step(ARR_MS * 3);
  assert.equal(repeats, 5, 'three more repeats at the ARR rate');

  win.emit('keyup', keyEvent('ArrowLeft'));
  ui.step(ARR_MS * 10);
  assert.equal(repeats, 5, 'releasing the key stops the repeat');
});

test('holding right cancels a held left', () => {
  const { ui, win } = harness();
  ui.newGame();
  const seen = [];
  const real = ui.action.bind(ui);
  ui.action = (a) => {
    seen.push(a);
    return real(a);
  };
  win.emit('keydown', keyEvent('ArrowLeft'));
  win.emit('keydown', keyEvent('ArrowRight'));
  seen.length = 0;
  ui.step(DAS_MS + ARR_MS);
  assert.ok(seen.every((a) => a === 'right'), `left kept repeating: ${seen.join(',')}`);
  assert.ok(seen.length >= 2);
});

test('touch buttons fire the same actions, and movement buttons repeat on hold', () => {
  const { ui, dom } = harness();
  ui.newGame();
  const seen = [];
  const real = ui.action.bind(ui);
  ui.action = (a) => {
    seen.push(a);
    return real(a);
  };

  for (const [key, action] of [['btnRotate', 'rotateCW'], ['btnDrop', 'hardDrop']]) {
    seen.length = 0;
    dom[key].emit('pointerdown', { pointerId: 1, preventDefault() {} });
    assert.deepEqual(seen, [action], `${key} should fire ${action} once`);
    ui.step(DAS_MS + ARR_MS * 4);
    assert.deepEqual(seen, [action], `${key} must not autorepeat`);
  }

  seen.length = 0;
  dom.btnLeft.emit('pointerdown', { pointerId: 1, preventDefault() {} });
  ui.step(DAS_MS + ARR_MS * 2);
  assert.ok(seen.length >= 3, `expected repeat-on-hold, saw ${seen.length}`);
  dom.btnLeft.emit('pointerup', { pointerId: 1 });
  const held = seen.length;
  ui.step(ARR_MS * 10);
  assert.equal(seen.length, held, 'releasing the button stops the repeat');
});

test('touch buttons answer the keyboard, and a pointer tap fires only once', () => {
  const { ui, dom } = harness();
  ui.newGame();
  const seen = [];
  const real = ui.action.bind(ui);
  ui.action = (a) => {
    seen.push(a);
    return real(a);
  };

  // detail === 0: the click came from Enter/Space on the focused button.
  dom.btnRotate.emit('click', { detail: 0, preventDefault() {} });
  assert.deepEqual(seen, ['rotateCW'], 'a focused touch button must not be inert to the keyboard');

  seen.length = 0;
  dom.btnLeft.emit('click', { detail: 0, preventDefault() {} });
  assert.deepEqual(seen, ['left']);

  // detail > 0: pointerdown already handled this tap.
  seen.length = 0;
  dom.btnDrop.emit('pointerdown', { pointerId: 1, preventDefault() {} });
  dom.btnDrop.emit('click', { detail: 1, preventDefault() {} });
  assert.deepEqual(seen, ['hardDrop'], 'a pointer-driven click must not double fire');
});

test('touch buttons opt out of browser gestures', () => {
  const { dom } = harness();
  for (const key of ['btnLeft', 'btnRight', 'btnRotate', 'btnDown', 'btnDrop']) {
    assert.equal(dom[key].style.touchAction, 'none', `${key} still allows browser gestures`);
  }
});

/* ------------------------------------------------------------------ *
 * Pause
 * ------------------------------------------------------------------ */

test('pause stops gravity, shows the overlay, and keeps rendering', () => {
  const { ui, engine, dom, renderer } = harness();
  ui.newGame();
  assert.equal(dom.pauseOverlay.hidden, true);

  ui.togglePause();
  assert.equal(engine.paused, true);
  assert.equal(dom.pauseOverlay.hidden, false);
  assert.equal(dom.btnPause.textContent, 'Resume');
  assert.equal(dom.btnPause.getAttribute('aria-pressed'), 'true');

  const y0 = engine.current.y;
  const draws = renderer.draws;
  for (let i = 0; i < 30; i++) ui.step(100); // 3 seconds
  assert.equal(engine.current.y, y0, 'gravity must be frozen');
  assert.ok(renderer.draws >= draws + 30, 'the paused frame must keep being drawn');

  ui.togglePause();
  assert.equal(dom.pauseOverlay.hidden, true);
  assert.equal(dom.btnPause.textContent, 'Pause');
  for (let i = 0; i < 10; i++) ui.step(100);
  assert.equal(engine.current.y, y0 + 1, 'gravity must resume');
});

test('input is ignored while paused, except the pause key itself', () => {
  const { ui, win, engine } = harness();
  ui.newGame();
  ui.togglePause();
  const before = { ...engine.current };
  win.emit('keydown', keyEvent('ArrowLeft'));
  win.emit('keydown', keyEvent(' '));
  assert.deepEqual({ ...engine.current }, before);

  win.emit('keydown', keyEvent('Escape'));
  assert.equal(engine.paused, false);
});

test('a blurred tab auto-pauses, and never auto-resumes', () => {
  const { ui, win, engine, doc, dom } = harness();
  ui.newGame();
  win.emit('blur');
  assert.equal(engine.paused, true);
  assert.equal(dom.pauseOverlay.hidden, false);

  win.emit('blur');
  assert.equal(engine.paused, true, 'a second blur must not toggle back');

  ui.togglePause();
  doc.hidden = true;
  doc.emit('visibilitychange');
  assert.equal(engine.paused, true);
});

test('blur on a non-game screen is a no-op', () => {
  const { ui, win, engine } = harness();
  ui.showScreen('start');
  win.emit('blur');
  assert.equal(engine.paused, false);
});

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

test('the HUD is written only when a number actually changes', () => {
  const { ui, engine, dom } = harness();
  ui.newGame();
  assert.equal(dom.hudScore.textContent, '0');
  assert.equal(dom.hudLines.textContent, '0');
  assert.equal(dom.hudLevel.textContent, '1');

  const writes = {
    score: dom.hudScore.writes,
    lines: dom.hudLines.writes,
    level: dom.hudLevel.writes
  };
  for (let i = 0; i < 20; i++) ui.step(16);
  assert.equal(dom.hudScore.writes, writes.score, 'idle frames must not touch the HUD');
  assert.equal(dom.hudLines.writes, writes.lines);
  assert.equal(dom.hudLevel.writes, writes.level);

  engine.hardDrop();
  ui.step(16);
  assert.equal(dom.hudScore.writes, writes.score + 1);
  assert.equal(dom.hudScore.textContent, String(engine.score));
  assert.equal(dom.hudLines.writes, writes.lines, 'lines did not change');
});

test('a completed line updates score, lines and level in the HUD', () => {
  const { ui, engine, dom } = harness();
  ui.newGame();
  setUpClear(engine);
  ui.step(0);
  ui.step(CLEAR_MS);
  assert.equal(dom.hudLines.textContent, '1');
  assert.equal(dom.hudScore.textContent, String(engine.score));
  assert.equal(dom.hudLevel.textContent, String(engine.level));
});

/* ------------------------------------------------------------------ *
 * Game over
 * ------------------------------------------------------------------ */

/**
 * Play one real piece so the run has a non-zero score, then block the spawn
 * area so the following spawn ends the game.
 */
function forceGameOver(engine) {
  engine.hardDrop(); // a genuine drop: +2 per cell, so the score is > 0
  assert.ok(engine.score > 0, 'the fixture must earn points, or isHighScore is a no-op');
  for (let y = 0; y < 4; y++) {
    for (let x = 3; x < 7; x++) engine.board[y][x] = 'S';
  }
  engine.hardDrop();
  assert.equal(engine.gameOver, true, 'the fixture must actually end the game');
}

test('game over shows the final numbers and saves a high score', () => {
  const scores = stubScores();
  const { ui, engine, doc, dom, win } = harness({ scores });
  ui.newGame();
  forceGameOver(engine);
  ui.step(16);

  assert.equal(engine.gameOver, true);
  assert.deepEqual(activeScreens(doc), ['screen-gameover']);
  assert.equal(dom.goScore.textContent, String(engine.score));
  assert.equal(dom.goLines.textContent, String(engine.lines));
  assert.equal(dom.goLevel.textContent, String(engine.level));
  assert.equal(dom.goNewHigh.hidden, false, '#go-newhigh must be revealed');
  assert.equal(scores.saved.length, 1);
  assert.deepEqual(
    { score: scores.saved[0].score, lines: scores.saved[0].lines, level: scores.saved[0].level },
    { score: engine.score, lines: engine.lines, level: engine.level }
  );
  assert.equal(win.frames.size, 0, 'the loop must stop at game over');
});

test('a score that does not make the table leaves #go-newhigh hidden', () => {
  const full = Array.from({ length: 10 }, (_, i) => ({ score: 100000 - i, lines: 5, level: 2, date: 'x' }));
  const scores = stubScores(full);
  const { ui, engine, dom } = harness({ scores });
  ui.newGame();
  forceGameOver(engine);
  ui.step(16);
  assert.equal(dom.goNewHigh.hidden, true);
  assert.equal(scores.saved.length, 0);
});

test('game over is announced exactly once', () => {
  const scores = stubScores();
  const { ui, engine } = harness({ scores });
  ui.newGame();
  forceGameOver(engine);
  for (let i = 0; i < 5; i++) ui.step(16);
  assert.equal(scores.saved.length, 1);
});

test('play again clears the game over badge and resets the HUD', () => {
  const { ui, engine, dom, doc } = harness();
  ui.newGame();
  forceGameOver(engine);
  ui.step(16);
  assert.equal(dom.goNewHigh.hidden, false);

  ui.newGame();
  assert.deepEqual(activeScreens(doc), ['screen-game']);
  assert.equal(dom.goNewHigh.hidden, true);
  assert.equal(dom.hudScore.textContent, '0');
  assert.equal(engine.gameOver, false);
});

/* ------------------------------------------------------------------ *
 * Leaderboard screen
 * ------------------------------------------------------------------ */

test('the leaderboard renders rank, score, lines, level and a formatted date', () => {
  const scores = stubScores([
    { score: 5000, lines: 40, level: 5, date: '2026-01-02T03:04:05.000Z' },
    { score: 1200, lines: 11, level: 2, date: '2026-01-01T00:00:00.000Z' }
  ]);
  const { ui, dom } = harness({ scores });
  ui.showLeaderboard('start');

  const rows = dom.leaderboardList.children;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].children.map((td) => td.textContent), ['1', '5000', '40', '5', 'DD/MM/YYYY HH:mm']);
  assert.deepEqual(rows[1].children.map((td) => td.textContent), ['2', '1200', '11', '2', 'DD/MM/YYYY HH:mm']);
  assert.equal(dom.leaderboardEmpty.hidden, true, 'the empty state must step aside');
});

test('an empty leaderboard shows the empty state and no rows', () => {
  const { ui, dom } = harness({ scores: stubScores([]) });
  ui.showLeaderboard('start');
  assert.equal(dom.leaderboardList.children.length, 0);
  assert.equal(dom.leaderboardEmpty.hidden, false);
});

test('re-rendering replaces the rows instead of appending', () => {
  const scores = stubScores([{ score: 10, lines: 1, level: 1, date: 'z' }]);
  const { ui, dom } = harness({ scores });
  ui.showLeaderboard('start');
  ui.renderLeaderboard();
  ui.renderLeaderboard();
  assert.equal(dom.leaderboardList.children.length, 1);
});

test('clearing the leaderboard asks first and honours a refusal', () => {
  const scores = stubScores([{ score: 10, lines: 1, level: 1, date: 'z' }]);
  const { ui, dom, win } = harness({ scores });
  ui.showLeaderboard('start');

  win.confirmAnswer = false;
  assert.equal(ui.clearLeaderboard(), false);
  assert.equal(win.confirmCount, 1);
  assert.equal(scores.cleared, 0);
  assert.equal(dom.leaderboardList.children.length, 1);

  win.confirmAnswer = true;
  assert.equal(ui.clearLeaderboard(), true);
  assert.equal(scores.cleared, 1);
  assert.equal(dom.leaderboardList.children.length, 0);
  assert.equal(dom.leaderboardEmpty.hidden, false);
});

test('a leaderboard that throws degrades to an empty list', () => {
  const scores = stubScores();
  scores.loadScores = () => {
    throw new Error('storage on fire');
  };
  const { ui, dom } = harness({ scores });
  assert.doesNotThrow(() => ui.showLeaderboard('start'));
  assert.equal(dom.leaderboardList.children.length, 0);
  assert.equal(dom.leaderboardEmpty.hidden, false);
});

/* ------------------------------------------------------------------ *
 * Canvas sizing
 * ------------------------------------------------------------------ */

test('the renderer is re-measured when the canvas box moves, and not otherwise', () => {
  const { ui, renderer, doc, win } = harness();
  ui.newGame();
  const baseline = renderer.resizes;

  for (let i = 0; i < 10; i++) ui.step(16);
  assert.equal(renderer.resizes, baseline, 'a stable layout must not re-measure every frame');

  doc.getElementById('board').clientWidth = 220;
  doc.getElementById('board').clientHeight = 440;
  ui.step(16);
  assert.equal(renderer.resizes, baseline + 1, 'a changed CSS box must re-measure');

  ui.step(16);
  assert.equal(renderer.resizes, baseline + 1, 'and only once');

  win.devicePixelRatio = 3;
  ui.step(16);
  assert.equal(renderer.resizes, baseline + 2, 'a changed devicePixelRatio must re-measure');
});

test('resize() forces a re-measure even when nothing moved', () => {
  const { ui, renderer } = harness();
  ui.newGame();
  const baseline = renderer.resizes;
  ui.resize();
  assert.equal(renderer.resizes, baseline + 1);
});

test('a hidden canvas (zero box) is left alone', () => {
  const { ui, renderer, doc } = harness();
  ui.newGame();
  const baseline = renderer.resizes;
  doc.getElementById('board').clientWidth = 0;
  doc.getElementById('board').clientHeight = 0;
  ui.step(16);
  assert.equal(renderer.resizes, baseline, 'never size a canvas that has no box');
});

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

test('destroy() removes every listener it added', () => {
  const { ui, win, doc, dom } = harness();
  assert.ok(win.listenerCount('keydown') > 0);
  ui.destroy();
  assert.equal(win.listenerCount('keydown'), 0);
  assert.equal(win.listenerCount('keyup'), 0);
  assert.equal(win.listenerCount('blur'), 0);
  assert.equal(doc.listenerCount('visibilitychange'), 0);
  assert.equal(dom.btnLeft.listenerCount('pointerdown'), 0);
});

test('the controller survives a DOM that is missing everything', () => {
  const doc = new Doc();
  const win = new Win(doc);
  const engine = new Engine(seeded(3));
  const ui = new UI({ engine, renderer: stubRenderer(), dom: collectDom(doc), leaderboard: stubScores(), window: win, document: doc });
  assert.doesNotThrow(() => {
    ui.mount();
    ui.newGame();
    ui.step(16);
    ui.togglePause();
    ui.showLeaderboard('start');
    ui.resize();
    ui.destroy();
  });
});
