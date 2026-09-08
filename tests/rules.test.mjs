/**
 * Adversarial game-rules suite.
 *
 * These tests exist to BREAK the engine, not to bless it. Everything is driven
 * through a seeded mulberry32 rng so a failure is byte-for-byte reproducible.
 *
 * Spec under test (README "Rules"):
 *   - Levels 1 to 10, one level per 10 cleared lines, gravity 1000ms -> 150ms.
 *   - 100 / 300 / 500 / 800 x level per clear, 1/cell soft drop, 2/cell hard drop.
 *   - 7-bag randomiser, SRS rotation with wall kicks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLS,
  ROWS,
  MAX_LEVEL,
  GRAVITY_MS,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  PIECE_TYPES,
  LINE_SCORES,
  SOFT_DROP_POINTS,
  HARD_DROP_POINTS,
  Engine,
  levelForLines,
  gravityForLevel
} from '../js/engine.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function newGame(seed = 1) {
  const e = new Engine(seeded(seed));
  e.start();
  return e;
}

function wipe(e) {
  for (let y = 0; y < ROWS; y++) e.board[y].fill('');
  return e;
}

function cellCount(board) {
  let n = 0;
  for (const row of board) for (const c of row) if (c !== '') n++;
  return n;
}

function snapshot(e) {
  return e.board.map((row) => row.join('|')).join('/');
}

/** Fill row y on every column except the listed holes. */
function fillRow(e, y, holes = [], filler = 'J') {
  for (let x = 0; x < COLS; x++) if (!holes.includes(x)) e.board[y][x] = filler;
}

/** Fill the bottom `n` rows on every column but column 0. */
function primeRows(e, n, filler = 'J') {
  wipe(e);
  for (let y = ROWS - n; y < ROWS; y++) fillRow(e, y, [0], filler);
}

/** A vertical I resting in column 0, bottom cell on the floor. */
function verticalIAtColumn0(e) {
  e.current = { type: 'I', rot: 1, x: -2, y: ROWS - 4 };
}

/** Public-API grounded test: the piece cannot fall any further. */
function grounded(e) {
  return e.current !== null && e.ghostY() === e.current.y;
}

/** Clear exactly one line through real play, leaving the board tidy. */
function clearOneLine(e) {
  wipe(e);
  fillRow(e, ROWS - 1, [0]);
  verticalIAtColumn0(e);
  e.hardDrop();
  assert.equal(e.phase, 'clearing', 'the primed row must complete');
  e.commitClear();
}

/** Ticks of `dt` needed for the current piece to fall `rows` rows. */
function ticksToFall(level, rows, dt = 16) {
  const e = wipe(newGame(31));
  e.level = level;
  e.current = { type: 'I', rot: 1, x: 3, y: -3 };
  const y0 = e.current.y;
  let ticks = 0;
  while (e.current && e.current.y - y0 < rows && ticks < 100000) {
    e.tick(dt);
    ticks++;
  }
  assert.ok(e.current, 'the probe piece must not lock before falling ' + rows + ' rows');
  assert.equal(e.current.y - y0, rows);
  return ticks;
}

/** Sequence of piece types the randomiser actually emits. */
function pieceSequence(e, count) {
  const seq = [];
  while (seq.length < count) {
    assert.ok(e.current, 'engine must hold a piece while playing');
    seq.push(e.current.type);
    wipe(e);
    e.hardDrop();
    if (e.phase === 'clearing') e.commitClear();
  }
  return seq;
}

/* ================================================================== *
 * 1. Level progression across a full run
 * ================================================================== */

test('levelForLines equals min(10, 1 + floor(lines / 10)) for 0..250', () => {
  for (let n = 0; n <= 250; n++) {
    assert.equal(levelForLines(n), Math.min(MAX_LEVEL, 1 + Math.floor(n / 10)), 'lines=' + n);
  }
});

test('a full run of single-line clears tracks the level at every boundary', () => {
  const e = newGame(101);
  const seen = new Map();
  seen.set(0, e.level);

  assert.equal(e.lines, 0);
  assert.equal(e.level, 1);

  let prevLevel = e.level;
  for (let i = 1; i <= 130; i++) {
    clearOneLine(e);
    assert.equal(e.lines, i, 'one clear must credit exactly one line');

    const expected = Math.min(MAX_LEVEL, 1 + Math.floor(e.lines / 10));
    assert.equal(e.level, expected, 'at ' + e.lines + ' lines the level must be ' + expected);
    assert.ok(e.level <= MAX_LEVEL, 'level must never exceed ' + MAX_LEVEL);
    assert.ok(e.level >= prevLevel, 'the level must never go backwards');
    prevLevel = e.level;
    seen.set(e.lines, e.level);
  }

  // The exact boundaries called out by the spec.
  const boundaries = [
    [0, 1], [9, 1], [10, 2], [11, 2], [19, 2], [20, 3], [29, 3], [30, 4],
    [39, 4], [40, 5], [49, 5], [50, 6], [59, 6], [60, 7], [69, 7], [70, 8],
    [79, 8], [80, 9], [89, 9], [90, 10], [99, 10], [100, 10], [110, 10], [130, 10]
  ];
  for (const [lines, level] of boundaries) {
    assert.equal(seen.get(lines), level, lines + ' lines must be level ' + level);
  }
});

test('a multi-line clear that jumps a boundary lands on the right level', () => {
  for (const [before, after] of [[8, 12], [18, 22], [88, 92], [97, 101], [200, 204]]) {
    const e = newGame(102);
    e.lines = before;
    e.level = levelForLines(before);

    primeRows(e, 4);
    verticalIAtColumn0(e);
    e.hardDrop();
    e.commitClear();

    assert.equal(e.lines, after);
    assert.equal(e.level, Math.min(MAX_LEVEL, 1 + Math.floor(after / 10)), before + ' -> ' + after);
    assert.ok(e.level <= MAX_LEVEL);
  }
});

test('start() rewinds the level to 1 no matter how far the run went', () => {
  const e = newGame(103);
  for (let i = 0; i < 95; i++) clearOneLine(e);
  assert.equal(e.level, 10);
  e.start();
  assert.equal(e.level, 1);
  assert.equal(e.lines, 0);
  assert.equal(gravityForLevel(e.level), GRAVITY_MS[0]);
});

/* ================================================================== *
 * 2. Speed
 * ================================================================== */

test('gravityForLevel strictly decreases from level 1 to 10 and clamps outside', () => {
  for (let level = 2; level <= MAX_LEVEL; level++) {
    assert.ok(
      gravityForLevel(level) < gravityForLevel(level - 1),
      'level ' + level + ' (' + gravityForLevel(level) + 'ms) must be faster than level ' +
        (level - 1) + ' (' + gravityForLevel(level - 1) + 'ms)'
    );
  }
  assert.equal(gravityForLevel(1), 1000);
  assert.equal(gravityForLevel(MAX_LEVEL), 150);
  assert.equal(gravityForLevel(0), gravityForLevel(1), 'below range clamps to level 1');
  assert.equal(gravityForLevel(-5), gravityForLevel(1));
  assert.equal(gravityForLevel(11), gravityForLevel(MAX_LEVEL), 'above range clamps to level 10');
  assert.equal(gravityForLevel(999), gravityForLevel(MAX_LEVEL));
});

test('every level takes strictly fewer 16ms ticks to fall 10 rows than the level below', () => {
  const ticks = [];
  for (let level = 1; level <= MAX_LEVEL; level++) ticks.push(ticksToFall(level, 10));
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(
      ticks[i] < ticks[i - 1],
      'level ' + (i + 1) + ' took ' + ticks[i] + ' ticks, level ' + i + ' took ' + ticks[i - 1]
    );
  }
});

test('a piece at level 10 falls measurably faster in wall-clock ticks than at level 1', () => {
  const slow = ticksToFall(1, 10);
  const fast = ticksToFall(MAX_LEVEL, 10);
  assert.ok(slow >= 620 && slow <= 632, 'level 1 needs ~625 ticks of 16ms, got ' + slow);
  assert.ok(fast >= 90 && fast <= 100, 'level 10 needs ~94 ticks of 16ms, got ' + fast);
  assert.ok(fast * 6 < slow, 'level 10 must be more than 6x faster (' + fast + ' vs ' + slow + ')');
});

test('the faster gravity applies immediately after the clear that raises the level', () => {
  const e = newGame(104);
  e.lines = 9;
  e.level = levelForLines(9);
  assert.equal(e.level, 1);

  clearOneLine(e);
  assert.equal(e.lines, 10);
  assert.equal(e.level, 2);

  wipe(e);
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  e._gravityTimer = 0;
  e.tick(GRAVITY_MS[1] - 1);
  assert.equal(e.current.y, 0, 'still up at 849ms');
  e.tick(1);
  assert.equal(e.current.y, 1, 'the level-2 step is 850ms, not the level-1 1000ms');
});

/* ================================================================== *
 * 3. Scoring
 * ================================================================== */

test('every clear size scores base x level at every level 1..10', () => {
  for (let level = 1; level <= MAX_LEVEL; level++) {
    for (let rows = 1; rows <= 4; rows++) {
      const e = newGame(200 + level * 10 + rows);
      e.lines = (level - 1) * 10;
      e.level = levelForLines(e.lines);
      assert.equal(e.level, level);

      primeRows(e, rows);
      verticalIAtColumn0(e);
      const before = e.score;
      e.hardDrop();
      assert.equal(e.pendingClear.length, rows);
      e.commitClear();

      assert.equal(
        e.score - before,
        LINE_SCORES[rows] * level,
        rows + '-row clear at level ' + level
      );
    }
  }
});

test('soft drop pays exactly 1 point per cell and nothing for the locking press', () => {
  const e = wipe(newGame(210));
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  const landing = e.ghostY();

  let moved = 0;
  while (e.softDrop()) moved++;

  assert.equal(moved, landing, 'the O falls ' + landing + ' rows');
  assert.equal(e.score, SOFT_DROP_POINTS * landing, 'exactly 1 point per soft-dropped cell');
  assert.equal(e.board[ROWS - 1][4], 'O', 'the failing press is the one that locks');
});

test('hard drop pays exactly 2 points per cell, and 0 when the piece cannot move', () => {
  const e = wipe(newGame(211));
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  const landing = e.ghostY();
  assert.equal(e.hardDrop(), landing);
  assert.equal(e.score, HARD_DROP_POINTS * landing);

  const f = wipe(newGame(212));
  for (let y = 2; y < ROWS; y++) {
    f.board[y][4] = 'Z';
    f.board[y][5] = 'Z';
  }
  f.current = { type: 'O', rot: 0, x: 3, y: 0 };
  const before = f.score;
  assert.equal(f.hardDrop(), 0, 'nowhere to fall');
  assert.equal(f.score - before, 0, 'a 0-cell hard drop pays nothing');
});

test('refused inputs never touch the score', () => {
  const e = wipe(newGame(213));
  // sealed 1-wide well: no rotation fits, no sideways move fits
  for (let y = ROWS - 6; y < ROWS; y++) fillRow(e, y, [4], 'L');
  e.current = { type: 'I', rot: 1, x: 2, y: ROWS - 4 };
  const before = e.score;
  for (let i = 0; i < 20; i++) {
    assert.equal(e.rotateCW(), false);
    assert.equal(e.rotateCCW(), false);
    assert.equal(e.moveLeft(), false);
    assert.equal(e.moveRight(), false);
  }
  assert.equal(e.score, before);
});

test('the score never decreases over a long randomised game', () => {
  for (const seed of [11, 222, 3333, 44444]) {
    const e = newGame(seed);
    const rng = seeded(seed * 7 + 1);
    let prev = e.score;
    let guard = 0;
    while (!e.gameOver && guard++ < 5000) {
      const presses = Math.floor(rng() * 6);
      for (let k = 0; k < presses; k++) {
        const a = Math.floor(rng() * 5);
        if (a === 0) e.moveLeft();
        else if (a === 1) e.moveRight();
        else if (a === 2) e.rotateCW();
        else if (a === 3) e.rotateCCW();
        else e.softDrop();
        assert.ok(e.score >= prev, 'score dropped from ' + prev + ' to ' + e.score);
        prev = e.score;
      }
      if (rng() < 0.5) e.hardDrop();
      else for (let t = 0; t < 40; t++) e.tick(50);
      assert.ok(e.score >= prev, 'score dropped from ' + prev + ' to ' + e.score);
      prev = e.score;
      if (e.phase === 'clearing') e.commitClear();
      assert.ok(e.score >= prev, 'commitClear dropped the score');
      assert.ok(e.level >= 1 && e.level <= MAX_LEVEL, 'level out of range: ' + e.level);
      prev = e.score;
    }
  }
});

/* ================================================================== *
 * 4. Clearing protocol
 * ================================================================== */

test('a clear cannot be committed twice', () => {
  const e = newGame(300);
  primeRows(e, 2);
  verticalIAtColumn0(e);
  e.hardDrop();
  assert.equal(e.phase, 'clearing');

  assert.equal(e.commitClear(), true);
  const board = snapshot(e);
  const { score, lines, level } = e;
  const piece = e.current;
  const queue = e.nextQueue.slice();

  for (let i = 0; i < 5; i++) {
    assert.equal(e.commitClear(), false, 'the ' + (i + 2) + 'nd commit must be refused');
  }
  assert.equal(e.score, score, 'no second score credit');
  assert.equal(e.lines, lines, 'no second line credit');
  assert.equal(e.level, level);
  assert.equal(snapshot(e), board, 'the board must not shift twice');
  assert.equal(e.current, piece, 'no second piece spawned');
  assert.deepEqual(e.nextQueue, queue, 'the queue must not advance twice');
});

test('tick() is a no-op mid-clear for any dt', () => {
  const e = newGame(301);
  primeRows(e, 3);
  e.board[ROWS - 4][7] = 'T';
  verticalIAtColumn0(e);
  e.hardDrop();
  assert.equal(e.phase, 'clearing');

  const board = snapshot(e);
  const pending = e.pendingClear.slice();
  const { score, lines, level } = e;

  for (const dt of [0, 1, 16, 500, 5000, 100000, -1, NaN, Infinity]) {
    e.tick(dt);
    assert.equal(e.phase, 'clearing', 'tick(' + dt + ') left the clearing phase');
    assert.equal(e.current, null, 'tick(' + dt + ') spawned a piece mid-clear');
    assert.equal(snapshot(e), board, 'tick(' + dt + ') changed the board');
    assert.deepEqual(e.pendingClear, pending, 'tick(' + dt + ') changed pendingClear');
    assert.equal(e.score, score, 'tick(' + dt + ') changed the score');
    assert.equal(e.lines, lines, 'tick(' + dt + ') credited lines');
    assert.equal(e.level, level);
  }

  e.commitClear();
  assert.equal(e.lines, 3, 'the clear still lands once the UI commits');
});

test('a 4-row clear removes exactly 4 rows and drops the stack above intact', () => {
  const e = newGame(302);
  primeRows(e, 4);
  // A recognisable stack sitting on top of the four doomed rows.
  const pattern = [
    ['L', '', '', 'S', '', '', '', 'T', '', ''],
    ['', 'Z', '', '', 'O', '', '', '', 'I', ''],
    ['', '', 'J', '', '', 'L', '', '', '', 'S']
  ];
  for (let i = 0; i < pattern.length; i++) {
    for (let x = 0; x < COLS; x++) e.board[ROWS - 7 + i][x] = pattern[i][x];
  }

  verticalIAtColumn0(e);
  const before = cellCount(e.board) + 4; // the I is about to add its 4 cells
  e.hardDrop();
  assert.deepEqual(e.pendingClear, [ROWS - 4, ROWS - 3, ROWS - 2, ROWS - 1]);

  e.commitClear();
  assert.equal(e.lines, 4);
  assert.equal(
    cellCount(e.board),
    before - 4 * COLS,
    'exactly 4 full rows (40 cells) must disappear'
  );
  assert.equal(e.board.length, ROWS);
  for (const row of e.board) assert.equal(row.length, COLS);

  // The pattern shifted down by exactly 4 and kept every cell.
  for (let i = 0; i < pattern.length; i++) {
    for (let x = 0; x < COLS; x++) {
      assert.equal(
        e.board[ROWS - 3 + i][x],
        pattern[i][x],
        'pattern row ' + i + ' col ' + x + ' must land on row ' + (ROWS - 3 + i)
      );
    }
  }
  for (let y = 0; y < ROWS - 3; y++) {
    for (let x = 0; x < COLS; x++) assert.equal(e.board[y][x], '', 'row ' + y + ' must be empty');
  }
});

test('non-contiguous completed rows clear together and only what is above them falls', () => {
  const e = wipe(newGame(303));
  fillRow(e, ROWS - 4, [0], 'A'); // 16 - completes with the I
  fillRow(e, ROWS - 3, [0, 9], 'B'); // 17 - keeps a hole at column 9
  fillRow(e, ROWS - 2, [0], 'C'); // 18
  fillRow(e, ROWS - 1, [0], 'D'); // 19
  e.board[ROWS - 6][5] = 'M'; // marker well above the doomed rows

  verticalIAtColumn0(e);
  e.hardDrop();
  assert.deepEqual(e.pendingClear, [ROWS - 4, ROWS - 2, ROWS - 1], 'rows 16, 18 and 19');

  const before = e.score;
  e.commitClear();
  assert.equal(e.lines, 3);
  assert.equal(e.score - before, LINE_SCORES[3] * 1, 'three rows is a triple, contiguous or not');

  // Survivor: the old row 17 (B row + the I cell at column 0) is now the floor.
  assert.equal(e.board[ROWS - 1][0], 'I');
  for (let x = 1; x < COLS - 1; x++) assert.equal(e.board[ROWS - 1][x], 'B', 'col ' + x);
  assert.equal(e.board[ROWS - 1][COLS - 1], '', 'the hole survives the clear');

  // The marker fell by exactly 3.
  assert.equal(e.board[ROWS - 3][5], 'M');
  // Survivors: 8 'B' cells (columns 1..8) + the 'I' at column 0 + the marker.
  assert.equal(cellCount(e.board), (COLS - 2) + 1 + 1, 'nothing else is left on the board');
});

test('rows cleared at the very top leave the stack below them where it was', () => {
  const e = wipe(newGame(304));
  for (let y = 0; y < 4; y++) fillRow(e, y, [0], 'S');
  for (let y = 4; y < ROWS; y++) e.board[y][0] = 'L';
  e.board[6][3] = 'M';

  e.current = { type: 'I', rot: 1, x: -2, y: 0 };
  assert.equal(e.hardDrop(), 0, 'column 0 is already full below, the I cannot fall');
  assert.deepEqual(e.pendingClear, [0, 1, 2, 3]);
  e.commitClear();

  assert.equal(e.lines, 4);
  assert.equal(e.board[6][3], 'M', 'the marker below the cleared rows must not move');
  for (let y = 4; y < ROWS; y++) assert.equal(e.board[y][0], 'L', 'column 0 row ' + y);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < COLS; x++) assert.equal(e.board[y][x], '', 'row ' + y + ' must be empty');
  }
});

test('a lock never silently discards cells above the ceiling', () => {
  const e = newGame(305);
  wipe(e);
  // A stack that reaches row 2 everywhere but column 9, so nothing can clear.
  for (let y = 2; y < ROWS; y++) fillRow(e, y, [9], 'J');
  e.nextQueue = ['J', 'J', 'J'];
  e.current = { type: 'J', rot: 0, x: 6, y: 0 };

  // A legal SRS kick lifts the piece one row above the ceiling. The kick is
  // standard SRS and must stay legal, so the only question is what LOCKING
  // there does. `board` is exactly ROWS x COLS with no buffer rows, so those
  // cells cannot be stored: the honest outcome is a lock-out, never a lock
  // that quietly deletes part of the tetromino and plays on.
  assert.equal(e.rotateCW(), true, 'the 0>1 kick [-1,-1] applies');
  assert.equal(e.current.y, -1);

  const before = cellCount(e.board);
  assert.equal(e.hardDrop(), 0, 'the piece is already resting on the stack');
  const added = cellCount(e.board) - before;

  if (added === 4) {
    assert.equal(e.gameOver, false, 'a complete lock inside the board keeps the run alive');
  } else {
    assert.equal(
      e.gameOver,
      true,
      'only ' + added + ' of 4 cells could be stored, so this must end the run as a lock-out'
    );
    assert.equal(e.phase, 'over');
    assert.deepEqual(e.pendingClear, [], 'a lock-out clears nothing');
  }
});

test('random play never loses blocks: every lock adds 4 cells or ends the run', () => {
  for (let seed = 900; seed < 940; seed++) {
    const e = newGame(seed);
    const rng = seeded(seed + 7);
    let placements = 0;

    while (!e.gameOver && placements < 60) {
      // Shuffle the piece about, then slam it down.
      const moves = 1 + Math.floor(rng() * 6);
      for (let m = 0; m < moves; m++) {
        const r = rng();
        if (r < 0.3) e.moveLeft();
        else if (r < 0.6) e.moveRight();
        else if (r < 0.85) e.rotateCW();
        else e.rotateCCW();
      }

      const before = cellCount(e.board);
      e.hardDrop();
      placements++;

      if (e.gameOver) break; // a lock-out or a blocked spawn is a legal ending
      // pendingClear rows are still filled at this point, so the count is
      // comparable whether or not the lock completed a line.
      assert.equal(
        cellCount(e.board) - before,
        4,
        'seed ' + seed + ' placement ' + placements + ': a lock must store all 4 cells'
      );
      if (e.phase === 'clearing') e.commitClear();
    }
  }
});

/* ================================================================== *
 * 5. Edge cases
 * ================================================================== */

for (const [name, xs] of [
  ['left wall', [-3, -2, -1, 0, 1]],
  ['right wall', [COLS - 5, COLS - 4, COLS - 3, COLS - 2, COLS - 1]]
]) {
  test('rotating against the ' + name + ' never puts a cell off the board', () => {
    let tried = 0;
    for (const type of PIECE_TYPES) {
      for (let rot = 0; rot < 4; rot++) {
        for (const x of xs) {
          for (const dir of ['rotateCW', 'rotateCCW']) {
            const e = wipe(newGame(400));
            e.current = { type, rot, x, y: 8 };
            if (e._collides(type, rot, x, 8)) continue;
            tried++;
            const moved = e[dir]();
            for (const c of e.cells()) {
              assert.ok(
                c.x >= 0 && c.x < COLS,
                type + ' rot' + rot + ' x=' + x + ' ' + dir + ' -> cell x=' + c.x
              );
              assert.ok(c.y < ROWS, type + ' rot' + rot + ' ' + dir + ' -> cell y=' + c.y);
            }
            if (!moved) {
              assert.equal(e.current.rot, rot, 'a refused rotation must not move the piece');
              assert.equal(e.current.x, x);
            }
          }
        }
      }
    }
    assert.ok(tried > 40, 'the sweep must actually exercise placements, got ' + tried);
  });
}

test('rotating on the floor kicks upward and never drops a cell through it', () => {
  let kicked = 0;
  for (const type of PIECE_TYPES) {
    for (let rot = 0; rot < 4; rot++) {
      for (const dir of ['rotateCW', 'rotateCCW']) {
        const e = wipe(newGame(401));
        e.current = { type, rot, x: 3, y: ROWS - 4 };
        if (e._collides(type, rot, 3, ROWS - 4)) continue;
        while (!grounded(e)) e.current.y++;
        const y0 = e.current.y;
        const moved = e[dir]();
        for (const c of e.cells()) {
          assert.ok(c.y < ROWS, type + ' rot' + rot + ' ' + dir + ' -> cell below the floor');
          assert.ok(c.x >= 0 && c.x < COLS);
          assert.equal(e.board[c.y] && e.board[c.y][c.x], '', 'rotation must not overlap a block');
        }
        if (moved && e.current.y < y0) kicked++;
      }
    }
  }
  assert.ok(kicked > 0, 'at least one piece must kick up off the floor');
});

test('an I piece kicks out of a shallow 1-wide well but not out of a deep one', () => {
  // Shallow: walls only 2 rows high, the horizontal I fits above them.
  const shallow = wipe(newGame(402));
  for (let y = ROWS - 2; y < ROWS; y++) fillRow(shallow, y, [4], 'L');
  shallow.current = { type: 'I', rot: 1, x: 2, y: ROWS - 4 };
  assert.deepEqual(shallow.cells().map((c) => c.x + ',' + c.y), ['4,16', '4,17', '4,18', '4,19']);
  assert.equal(shallow.rotateCW(), true, 'the I must escape a 2-deep well');
  assert.equal(shallow.current.rot, 2);
  assert.deepEqual(
    shallow.cells().map((c) => c.x + ',' + c.y),
    ['1,16', '2,16', '3,16', '4,16'],
    'kick [-1,-2]: one left, two up'
  );
  for (const c of shallow.cells()) assert.equal(shallow.board[c.y][c.x], '');

  // Deep: walls 4 rows high, every kick lands inside the wall.
  const deep = wipe(newGame(403));
  for (let y = ROWS - 4; y < ROWS; y++) fillRow(deep, y, [4], 'L');
  deep.current = { type: 'I', rot: 1, x: 2, y: ROWS - 4 };
  assert.equal(deep.rotateCW(), false, 'no kick fits a 4-deep 1-wide well');
  assert.equal(deep.rotateCCW(), false);
  assert.equal(deep.current.rot, 1, 'a refused rotation leaves the piece alone');
  assert.equal(deep.current.x, 2);
  assert.equal(deep.current.y, ROWS - 4);
});

test('a blocked spawn ends the game and freezes everything', () => {
  const e = wipe(newGame(404));
  for (let y = 0; y <= 1; y++) for (let x = 3; x <= 6; x++) e.board[y][x] = 'Z';
  e.current = { type: 'O', rot: 0, x: 0, y: 0 };
  e.hardDrop();

  assert.equal(e.gameOver, true);
  assert.equal(e.phase, 'over');

  const board = snapshot(e);
  const { score, lines, level } = e;

  assert.equal(e.moveLeft(), false);
  assert.equal(e.moveRight(), false);
  assert.equal(e.rotateCW(), false);
  assert.equal(e.rotateCCW(), false);
  assert.equal(e.softDrop(), false);
  assert.equal(e.hardDrop(), 0);
  assert.equal(e.commitClear(), false);
  assert.equal(e.togglePause(), false, 'a finished game cannot be paused');
  for (const dt of [16, 1000, 100000]) e.tick(dt);

  assert.equal(snapshot(e), board, 'nothing may change after game over');
  assert.equal(e.score, score);
  assert.equal(e.lines, lines);
  assert.equal(e.level, level);
  assert.equal(e.gameOver, true);
  assert.equal(e.phase, 'over');
});

test('hard dropping onto an already-full column locks in place for 0 points', () => {
  const e = wipe(newGame(405));
  for (let y = 2; y < ROWS; y++) {
    e.board[y][4] = 'Z';
    e.board[y][5] = 'Z';
  }
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  const before = cellCount(e.board);
  assert.equal(e.hardDrop(), 0);
  assert.equal(e.score, 0);
  assert.equal(cellCount(e.board) - before, 4, 'the piece still lands, all 4 cells');
  assert.equal(e.board[0][4], 'O');
  assert.equal(e.board[0][5], 'O');
  assert.equal(e.board[1][4], 'O');
  assert.equal(e.board[1][5], 'O');
  assert.equal(e.gameOver, true, 'and the next spawn tops out');
});

test('the 7-bag hands out all 7 pieces in each of 100 bags', () => {
  for (const seed of [1, 4242, 987654]) {
    const seq = pieceSequence(newGame(seed), 700);
    const total = {};
    for (let bag = 0; bag < 100; bag++) {
      const chunk = seq.slice(bag * 7, bag * 7 + 7);
      assert.deepEqual(
        [...chunk].sort(),
        ['I', 'J', 'L', 'O', 'S', 'T', 'Z'],
        'seed ' + seed + ' bag ' + bag + ' was ' + chunk.join('')
      );
      for (const t of chunk) total[t] = (total[t] || 0) + 1;
    }
    for (const t of PIECE_TYPES) {
      assert.equal(total[t], 100, 'seed ' + seed + ' piece ' + t + ' appeared ' + total[t] + ' times');
    }
    // A shuffled bag must not be the same order every time.
    assert.notEqual(seq.slice(0, 7).join(''), seq.slice(7, 14).join(''));
  }
});

/* ================================================================== *
 * 6. Lock delay
 * ================================================================== */

test('rotating cannot keep a piece alive past the lock-reset budget', () => {
  // The engine promises the stall is bounded: MAX_LOCK_RESETS refreshes of a
  // LOCK_DELAY_MS countdown, then "the running countdown forces the lock".
  // Every one of these strategies used to stall forever, because a kick that
  // lifted the piece off the stack refreshed the countdown for free.
  const budget = MAX_LOCK_RESETS * LOCK_DELAY_MS + GRAVITY_MS[0] * ROWS + 2000;
  const strategies = {
    'rotate CW': (e) => { e.rotateCW(); },
    'rotate CCW': (e) => { e.rotateCCW(); },
    'rotate CW then CCW': (e) => { e.rotateCW(); e.rotateCCW(); },
    'move left and right': (e) => { e.moveLeft(); e.moveRight(); },
    // The nastiest one: rotate up off the stack, then soft drop back down.
    'rotate up, soft drop back': (e) => {
      e.rotateCW();
      if (e.current && e.ghostY() > e.current.y) e.softDrop();
    },
    'everything at once': (e) => {
      e.rotateCW();
      if (e.current && e.ghostY() > e.current.y) e.softDrop();
      if (e.current) {
        e.moveLeft();
        e.moveRight();
        e.rotateCCW();
      }
    }
  };

  for (const [name, play] of Object.entries(strategies)) {
    for (const type of PIECE_TYPES) {
      for (const frame of [16, 100]) {
        const e = wipe(newGame(500));
        e.current = { type, rot: 0, x: 4, y: ROWS - 2 };
        while (!grounded(e)) e.current.y++;

        let elapsed = 0;
        while (elapsed < budget && cellCount(e.board) === 0) {
          play(e); // up to 10 inputs per second at dt=100
          e.tick(frame);
          elapsed += frame;
        }
        assert.ok(
          cellCount(e.board) > 0,
          type + ' never locked under "' + name + '" after ' + elapsed + 'ms at dt=' + frame +
            'ms (budget ' + budget + 'ms) - the lock countdown is being refreshed for free'
        );
        assert.equal(e.gameOver, false, 'the forced lock must not end the run');
      }
    }
  }
});

test('a forced lock never freezes a piece in mid-air', () => {
  // When the budget runs out on a piece that rotation kicks keep lifting off
  // the stack, it must fall to its landing row before it locks.
  const e = wipe(newGame(502));
  e.current = { type: 'I', rot: 0, x: 4, y: ROWS - 2 };
  while (!grounded(e)) e.current.y++;

  let elapsed = 0;
  while (elapsed < 30000 && cellCount(e.board) === 0) {
    e.rotateCW();
    if (e.current && e.ghostY() > e.current.y) e.softDrop();
    e.tick(100);
    elapsed += 100;
  }

  assert.equal(cellCount(e.board), 4, 'the piece locked as a whole tetromino');
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (e.board[y][x] !== '') { rows.push(y); break; }
  }
  const lowest = Math.max(...rows);
  assert.equal(lowest, ROWS - 1, 'the forced lock left the piece floating at row ' + lowest);
});

test('the lock countdown starts when the piece grounds, not at the top of the frame', () => {
  const e = wipe(newGame(501));
  e.level = MAX_LEVEL; // 150ms gravity step
  e.current = { type: 'O', rot: 0, x: 3, y: ROWS - 3 };
  assert.equal(grounded(e), false, 'the probe starts one row above its resting place');

  // In this single frame the piece lands after 150ms, so it has only been
  // grounded for 450ms - less than the 500ms lock delay.
  e.tick(600);

  assert.equal(
    e.board[ROWS - 1][4],
    '',
    'locked after 450ms on the ground: tick() charges the whole frame to the lock timer'
  );
});
