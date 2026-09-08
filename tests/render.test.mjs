/**
 * Renderer contract tests.
 *
 * render.js only ever touches a canvas, so a recording stub for the 2D context
 * is enough to prove three things that matter to the integration:
 *   1. it reads the Engine through its public API and never throws;
 *   2. the line-clear animation is a pure function of anim.clearProgress;
 *   3. resize() sizes the backing store to the CSS box * devicePixelRatio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Renderer } from '../js/render.js';
import { Engine, COLS, ROWS } from '../js/engine.js';

/* ------------------------------------------------------------------ *
 * Canvas stubs
 * ------------------------------------------------------------------ */

function makeContext(log) {
  const ctx = {
    _state: { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0 },
    save: () => log.push('save'),
    restore: () => log.push('restore'),
    setTransform: (...a) => log.push('setTransform ' + a.join(',')),
    clearRect: (...a) => log.push('clearRect ' + a.join(',')),
    fillRect: (...a) => log.push(`fillRect ${a.join(',')} ${ctx._state.fillStyle} a=${ctx._state.globalAlpha}`),
    strokeRect: (...a) =>
      log.push(`strokeRect ${a.join(',')} ${ctx._state.strokeStyle} w=${ctx._state.lineWidth} a=${ctx._state.globalAlpha}`)
  };
  for (const prop of ['globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth']) {
    Object.defineProperty(ctx, prop, {
      get: () => ctx._state[prop],
      set: (v) => {
        ctx._state[prop] = v;
      }
    });
  }
  return ctx;
}

function makeCanvas(cssW, cssH) {
  const log = [];
  return {
    log,
    width: 0,
    height: 0,
    clientWidth: cssW,
    clientHeight: cssH,
    getBoundingClientRect: () => ({ width: cssW, height: cssH }),
    getContext: () => makeContext(log)
  };
}

/** A Renderer wired to two recording canvases. */
function makeRenderer(boardW = 300, boardH = 600, nextW = 104, nextH = 234) {
  const board = makeCanvas(boardW, boardH);
  const next = makeCanvas(nextW, nextH);
  return { renderer: new Renderer(board, next), board, next };
}

const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Lock a piece into the bottom row so the engine enters phase 'clearing'. */
function engineInClearingPhase() {
  const engine = new Engine(seeded(7));
  engine.start();
  for (let x = 1; x < COLS; x++) engine.board[ROWS - 1][x] = 'T';
  engine.current = { type: 'I', rot: 1, x: -2, y: 0 };
  engine.hardDrop();
  return engine;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('resize() sizes both backing stores to the CSS box (dpr 1 off-browser)', () => {
  const { renderer, board, next } = makeRenderer(300, 600, 104, 234);
  renderer.resize();
  assert.equal(board.width, 300);
  assert.equal(board.height, 600);
  assert.equal(next.width, 104);
  assert.equal(next.height, 234);
});

test('a canvas with no CSS box keeps whatever backing store it has', () => {
  const board = makeCanvas(0, 0);
  board.width = 42;
  board.height = 84;
  const renderer = new Renderer(board, makeCanvas(0, 0));
  renderer.resize();
  assert.equal(board.width, 42);
  assert.equal(board.height, 84);
});

test('draw() renders a live engine without touching anything private', () => {
  const { renderer, board, next } = makeRenderer();
  const engine = new Engine(seeded(1));
  engine.start();

  board.log.length = 0;
  next.log.length = 0;
  renderer.draw(engine, { clearProgress: 0 });

  assert.ok(board.log.length > 0, 'the board must be painted');
  assert.ok(next.log.length > 0, 'the preview must be painted');
  // 1px #595959 grid, per the contract.
  assert.ok(board.log.some((op) => op.includes('#595959')), 'grid lines missing');
  // 2px #FF7900 border.
  assert.ok(board.log.some((op) => op.startsWith('strokeRect') && op.includes('#FF7900')), 'board border missing');
});

test('draw() tolerates a fresh, never-started engine', () => {
  const { renderer } = makeRenderer();
  const engine = new Engine(seeded(2));
  assert.doesNotThrow(() => renderer.draw(engine, { clearProgress: 0 }));
  assert.doesNotThrow(() => renderer.draw(engine, undefined));
  assert.doesNotThrow(() => renderer.draw(null, null));
});

test('the ghost piece is drawn as a translucent outline above the landing row', () => {
  const { renderer, board } = makeRenderer();
  const engine = new Engine(seeded(3));
  engine.start();

  board.log.length = 0;
  renderer.draw(engine, { clearProgress: 0 });

  const pieceColor = { I: '#4BB4E6', J: '#A885D8', L: '#FF7900', O: '#FFD200', S: '#50BE87', T: '#FFB4E6', Z: '#F16E00' }[
    engine.current.type
  ];
  const ghost = board.log.filter((op) => op.startsWith('strokeRect') && op.includes(pieceColor) && op.includes('a=0.5'));
  assert.equal(ghost.length, 4, 'expected four translucent ghost cells');
  assert.ok(engine.ghostY() > engine.current.y, 'the fixture must have room to fall');
});

test('the clear animation is a pure function of anim.clearProgress', () => {
  const engine = engineInClearingPhase();
  assert.equal(engine.phase, 'clearing');
  assert.deepEqual(engine.pendingClear, [ROWS - 1]);

  const a = makeRenderer();
  const b = makeRenderer();
  for (const p of [0, 0.2, 0.35, 0.5, 0.8, 0.99, 1]) {
    a.board.log.length = 0;
    b.board.log.length = 0;
    a.renderer.draw(engine, { clearProgress: p });
    b.renderer.draw(engine, { clearProgress: p });
    assert.deepEqual(a.board.log, b.board.log, `frame at clearProgress ${p} is not deterministic`);
  }
});

test('different clearProgress values produce different frames', () => {
  const engine = engineInClearingPhase();
  const { renderer, board } = makeRenderer();
  const frames = new Map();
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    board.log.length = 0;
    renderer.draw(engine, { clearProgress: p });
    frames.set(p, board.log.join('\n'));
  }
  assert.equal(new Set(frames.values()).size, frames.size, 'the animation is not advancing');
});

test('prefers-reduced-motion drops the white flash and the border glow', () => {
  const engine = engineInClearingPhase();

  for (const p of [0.1, 0.3, 0.5, 0.9, 1]) {
    const plain = makeRenderer();
    plain.renderer.draw(engine, { clearProgress: p });
    const reduced = makeRenderer();
    reduced.renderer.draw(engine, { clearProgress: p, reducedMotion: true });

    assert.ok(
      plain.board.log.some((l) => l.includes('#FFFFFF')),
      `the normal frame at ${p} is expected to use white`
    );
    assert.ok(
      !reduced.board.log.some((l) => l.includes('#FFFFFF')),
      `the reduced frame at ${p} must not flash white`
    );
    assert.ok(
      reduced.board.log.filter((l) => l.startsWith('strokeRect')).length <= 1,
      `the reduced frame at ${p} must draw the border and no glow rings`
    );
  }

  // And it is not an animation at all: every progress value paints the same frame.
  const a = makeRenderer();
  a.renderer.draw(engine, { clearProgress: 0.1, reducedMotion: true });
  const b = makeRenderer();
  b.renderer.draw(engine, { clearProgress: 0.95, reducedMotion: true });
  assert.deepEqual(a.board.log, b.board.log);
});

test('clearProgress is clamped, and a missing anim is treated as 0', () => {
  const engine = engineInClearingPhase();
  const { renderer, board } = makeRenderer();

  const at = (anim) => {
    board.log.length = 0;
    renderer.draw(engine, anim);
    return board.log.join('\n');
  };
  assert.equal(at({ clearProgress: -5 }), at({ clearProgress: 0 }));
  assert.equal(at({ clearProgress: 99 }), at({ clearProgress: 1 }));
  assert.equal(at(undefined), at({ clearProgress: 0 }));
  assert.equal(at({ clearProgress: NaN }), at({ clearProgress: 0 }));
});

test('the orange glow only shows in the last beat of the animation', () => {
  const engine = engineInClearingPhase();
  const { renderer, board } = makeRenderer();
  const glowCount = (p) => {
    board.log.length = 0;
    renderer.draw(engine, { clearProgress: p });
    // The border itself is one #FF7900 strokeRect; the glow adds rings.
    return board.log.filter((op) => op.startsWith('strokeRect') && op.includes('#FF7900')).length;
  };
  assert.equal(glowCount(0.5), 1, 'no glow rings expected mid-wipe');
  assert.ok(glowCount(0.9) > 1, 'glow rings expected in the final beat');
});

test('the preview draws one block group per queued piece', () => {
  const { renderer, next } = makeRenderer();
  const engine = new Engine(seeded(5));
  engine.start();
  assert.equal(engine.nextQueue.length, 3);

  next.log.length = 0;
  renderer.draw(engine, { clearProgress: 0 });
  // Every cell is a flat fill plus four bevel fills.
  const fills = next.log.filter((op) => op.startsWith('fillRect'));
  assert.ok(fills.length >= 3 * 4 * 5, `expected at least 60 preview fills, saw ${fills.length}`);
});

test('a shrinking CSS box is picked up by the next resize()', () => {
  const board = makeCanvas(300, 600);
  const next = makeCanvas(104, 234);
  const renderer = new Renderer(board, next);
  assert.equal(board.width, 300);

  board.getBoundingClientRect = () => ({ width: 150, height: 300 });
  renderer.resize();
  assert.equal(board.width, 150);
  assert.equal(board.height, 300);

  const engine = new Engine(seeded(9));
  engine.start();
  assert.doesNotThrow(() => renderer.draw(engine, { clearProgress: 0 }));
});
