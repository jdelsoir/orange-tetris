import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COLS,
  ROWS,
  PIECE_COLORS,
  PIECE_TYPES,
  GRAVITY_MS,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  TETROMINOES,
  Engine,
  levelForLines,
  gravityForLevel
} from '../js/engine.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) so every run is reproducible. */
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

function clearBoard(e) {
  for (let y = 0; y < ROWS; y++) e.board[y].fill('');
}

function snapshot(e) {
  return e.board.map((row) => row.join('|')).join('/');
}

/** Fill the bottom `n` rows on every column but column 0. */
function primeRows(e, n, filler = 'J') {
  clearBoard(e);
  for (let y = ROWS - n; y < ROWS; y++) {
    for (let x = 1; x < COLS; x++) e.board[y][x] = filler;
  }
}

/** Put a vertical I piece in column 0 at the top of the board. */
function verticalIAtColumn0(e) {
  e.current = { type: 'I', rot: 1, x: -2, y: 0 };
}

/** Collect the order pieces actually come out of the randomizer. */
function pieceSequence(e, count) {
  const seq = [];
  while (seq.length < count) {
    assert.ok(e.current, 'engine must always hold a current piece while playing');
    seq.push(e.current.type);
    clearBoard(e); // keep the stack empty so the run never tops out
    e.hardDrop();
    if (e.phase === 'clearing') e.commitClear();
  }
  return seq;
}

/* ------------------------------------------------------------------ *
 * Contract constants
 * ------------------------------------------------------------------ */

test('exports the board size and palette required by the contract', () => {
  assert.equal(COLS, 10);
  assert.equal(ROWS, 20);
  assert.deepEqual(PIECE_COLORS, {
    I: '#4BB4E6',
    J: '#A885D8',
    L: '#FF7900',
    O: '#FFD200',
    S: '#50BE87',
    T: '#FFB4E6',
    Z: '#F16E00'
  });
  assert.deepEqual([...GRAVITY_MS], [1000, 850, 720, 610, 500, 410, 330, 260, 200, 150]);
});

test('engine.js is pure logic: no DOM, storage or console access', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/engine.js', import.meta.url)), 'utf8');
  for (const forbidden of ['document', 'window', 'localStorage', 'sessionStorage', 'console', 'require(']) {
    assert.equal(
      new RegExp('\\b' + forbidden.replace('(', '\\(')).test(src),
      false,
      'engine.js must not reference ' + forbidden
    );
  }
});

test('every tetromino has 4 rotation states of 4x4 with exactly 4 filled cells', () => {
  assert.deepEqual([...PIECE_TYPES].sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  for (const type of PIECE_TYPES) {
    const states = TETROMINOES[type];
    assert.equal(states.length, 4, type + ' must have 4 rotation states');
    for (let rot = 0; rot < 4; rot++) {
      const m = states[rot];
      assert.equal(m.length, 4, type + ' rot ' + rot + ' must have 4 rows');
      let filled = 0;
      for (const row of m) {
        assert.equal(row.length, 4, type + ' rot ' + rot + ' rows must be 4 wide');
        for (const cell of row) filled += cell;
      }
      assert.equal(filled, 4, type + ' rot ' + rot + ' must have 4 filled cells');
    }
  }
});

/* ------------------------------------------------------------------ *
 * Level & gravity
 * ------------------------------------------------------------------ */

test('levelForLines boundaries, capped at 10', () => {
  assert.equal(levelForLines(0), 1);
  assert.equal(levelForLines(9), 1);
  assert.equal(levelForLines(10), 2);
  assert.equal(levelForLines(19), 2);
  assert.equal(levelForLines(20), 3);
  assert.equal(levelForLines(89), 9);
  assert.equal(levelForLines(90), 10);
  assert.equal(levelForLines(99), 10);
  assert.equal(levelForLines(100), 10);
  assert.equal(levelForLines(200), 10);
});

test('gravityForLevel is strictly decreasing over levels 1..10', () => {
  const values = [];
  for (let level = 1; level <= 10; level++) {
    const g = gravityForLevel(level);
    assert.equal(g, GRAVITY_MS[level - 1]);
    values.push(g);
  }
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] < values[i - 1], 'level ' + (i + 1) + ' must fall faster than level ' + i);
  }
  assert.equal(values[0], 1000);
  assert.equal(values[9], 150);
});

/* ------------------------------------------------------------------ *
 * Randomizer
 * ------------------------------------------------------------------ */

test('7-bag never repeats a piece inside a bag', () => {
  const e = newGame(2024);
  const seq = pieceSequence(e, 70);
  for (let bag = 0; bag < 10; bag++) {
    const chunk = seq.slice(bag * 7, bag * 7 + 7);
    assert.equal(new Set(chunk).size, 7, 'bag ' + bag + ' repeats a piece: ' + chunk.join(''));
    assert.deepEqual([...chunk].sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  }
});

test('nextQueue always holds 3 upcoming pieces', () => {
  const e = newGame(7);
  for (let i = 0; i < 25; i++) {
    assert.equal(e.nextQueue.length, 3);
    for (const t of e.nextQueue) assert.ok(PIECE_TYPES.includes(t));
    clearBoard(e);
    e.hardDrop();
    if (e.phase === 'clearing') e.commitClear();
  }
});

test('the injected rng makes runs fully deterministic', () => {
  const a = pieceSequence(newGame(99), 30);
  const b = pieceSequence(newGame(99), 30);
  const c = pieceSequence(newGame(100), 30);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

for (const [name, rows, base] of [
  ['single', 1, 100],
  ['double', 2, 300],
  ['triple', 3, 500],
  ['tetris', 4, 800]
]) {
  test(name + ' scores ' + base + ' x level', () => {
    for (const level of [1, 3, 10]) {
      const e = newGame(5);
      e.lines = (level - 1) * 10;
      e.level = levelForLines(e.lines);
      assert.equal(e.level, level);

      primeRows(e, rows);
      verticalIAtColumn0(e);
      e.hardDrop();

      assert.equal(e.phase, 'clearing');
      assert.equal(e.pendingClear.length, rows);

      const before = e.score;
      e.commitClear();
      assert.equal(e.score - before, base * level, name + ' at level ' + level);
      assert.equal(e.lines, (level - 1) * 10 + rows);
    }
  });
}

test('line score uses the level in force BEFORE the clear', () => {
  const e = newGame(11);
  e.lines = 9; // one line away from level 2
  e.level = levelForLines(e.lines);
  assert.equal(e.level, 1);

  primeRows(e, 1);
  verticalIAtColumn0(e);
  e.hardDrop();
  const before = e.score;
  e.commitClear();

  assert.equal(e.score - before, 100 * 1, 'scored at level 1, not the new level 2');
  assert.equal(e.lines, 10);
  assert.equal(e.level, 2);
});

test('hard drop scores 2 points per cell dropped and locks the piece', () => {
  const e = newGame(3);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };

  const landing = e.ghostY();
  assert.equal(landing, ROWS - 2);

  const before = e.score;
  const dropped = e.hardDrop();

  assert.equal(dropped, landing);
  assert.equal(e.score - before, 2 * landing);
  assert.equal(e.board[ROWS - 1][4], 'O');
  assert.equal(e.board[ROWS - 1][5], 'O');
  assert.equal(e.phase, 'playing');
  assert.ok(e.current, 'a fresh piece spawns immediately when nothing was cleared');
});

test('soft drop scores 1 point per cell and locks when it cannot fall', () => {
  const e = newGame(4);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: ROWS - 4 };

  assert.equal(e.softDrop(), true);
  assert.equal(e.score, 1);
  assert.equal(e.softDrop(), true);
  assert.equal(e.score, 2);
  assert.equal(e.current.y, ROWS - 2);

  assert.equal(e.softDrop(), false, 'returns false when the drop locked the piece');
  assert.equal(e.score, 2, 'a locking soft drop scores nothing');
  assert.equal(e.board[ROWS - 1][4], 'O');
});

/* ------------------------------------------------------------------ *
 * Clearing protocol
 * ------------------------------------------------------------------ */

test('clearing protocol: phase, pendingClear, frozen board, then commitClear', () => {
  const e = newGame(8);
  primeRows(e, 4);
  e.board[ROWS - 5][5] = 'T'; // marker sitting just above the four full rows
  verticalIAtColumn0(e);
  e.hardDrop();

  // 1. the engine parks in the clearing phase and hands the rows to the UI
  assert.equal(e.phase, 'clearing');
  assert.deepEqual(e.pendingClear, [ROWS - 4, ROWS - 3, ROWS - 2, ROWS - 1]);
  assert.equal(e.current, null, 'no new piece spawns while clearing');

  // 2. the rows are still on the board so the animation has something to wipe
  for (const y of e.pendingClear) {
    for (let x = 0; x < COLS; x++) assert.notEqual(e.board[y][x], '', 'row ' + y + ' col ' + x);
  }

  // 3. tick() is a no-op while clearing
  const frozen = snapshot(e);
  const score = e.score;
  for (let i = 0; i < 20; i++) e.tick(500);
  assert.equal(snapshot(e), frozen, 'board must not change until commitClear()');
  assert.equal(e.phase, 'clearing');
  assert.equal(e.pendingClear.length, 4);
  assert.equal(e.score, score);
  assert.equal(e.lines, 0, 'lines are only credited by commitClear()');

  // 4. commitClear removes the rows, shifts everything above down and resumes
  e.commitClear();
  assert.equal(e.phase, 'playing');
  assert.deepEqual(e.pendingClear, []);
  assert.equal(e.lines, 4);
  assert.equal(e.level, 1);
  assert.ok(e.current, 'the next piece spawns on commitClear()');

  assert.equal(e.board[ROWS - 1][5], 'T', 'the marker row shifted down by 4');
  for (let x = 0; x < COLS; x++) {
    if (x !== 5) assert.equal(e.board[ROWS - 1][x], '', 'rest of the shifted row is empty');
  }
  for (let y = 0; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS; x++) assert.equal(e.board[y][x], '', 'row ' + y + ' must be empty');
  }
  assert.equal(e.board.length, ROWS);
  for (const row of e.board) assert.equal(row.length, COLS);
});

test('locking without a completed row spawns immediately and stays playing', () => {
  const e = newGame(9);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  e.hardDrop();
  assert.equal(e.phase, 'playing');
  assert.deepEqual(e.pendingClear, []);
  assert.ok(e.current);
  assert.equal(e.current.y, 0, 'the new piece spawns at the top');
});

test('commitClear is a no-op outside the clearing phase', () => {
  const e = newGame(10);
  assert.equal(e.phase, 'playing');
  const before = snapshot(e);
  assert.equal(e.commitClear(), false);
  assert.equal(snapshot(e), before);
  assert.equal(e.phase, 'playing');
});

test('non-adjacent completed rows are cleared and the gaps close up', () => {
  const e = newGame(12);
  clearBoard(e);
  // rows 19 and 17 complete once column 0 is filled; row 18 keeps a hole
  for (let x = 1; x < COLS; x++) {
    e.board[ROWS - 1][x] = 'S';
    e.board[ROWS - 3][x] = 'Z';
  }
  e.board[ROWS - 2][1] = 'L';
  verticalIAtColumn0(e);
  e.hardDrop();

  assert.deepEqual(e.pendingClear, [ROWS - 3, ROWS - 1]);
  e.commitClear();

  assert.equal(e.lines, 2);
  // what is left: the leftover row (col 0 from the I plus the L at col 1)
  assert.equal(e.board[ROWS - 1][0], 'I');
  assert.equal(e.board[ROWS - 1][1], 'L');
  for (let x = 2; x < COLS; x++) assert.equal(e.board[ROWS - 1][x], '');
  assert.equal(e.board[ROWS - 2][0], 'I', 'the I cell that was above row 17 dropped by two');
});

/* ------------------------------------------------------------------ *
 * SRS rotation & wall kicks
 * ------------------------------------------------------------------ */

test('SRS: T kicks off the left wall when rotating CW', () => {
  const e = newGame(13);
  clearBoard(e);
  e.current = { type: 'T', rot: 1, x: -1, y: 5 }; // nose right, spine hugging column 0
  assert.deepEqual(
    e.cells().map((c) => c.x + ',' + c.y).sort(),
    ['0,5', '0,6', '0,7', '1,6'].sort()
  );

  assert.equal(e.rotateCW(), true);
  assert.equal(e.current.rot, 2);
  assert.equal(e.current.x, 0, 'kicked one column right');
  assert.equal(e.current.y, 5);
  for (const c of e.cells()) assert.ok(c.x >= 0 && c.x < COLS, 'kick must land inside the board');
});

test('SRS: I kicks two columns off the left wall when rotating CCW', () => {
  const e = newGame(14);
  clearBoard(e);
  e.current = { type: 'I', rot: 1, x: -2, y: 5 }; // vertical I in column 0

  assert.equal(e.rotateCCW(), true);
  assert.equal(e.current.rot, 0);
  assert.equal(e.current.x, 0, 'I uses its own kick table: +2 columns');
  assert.deepEqual(
    e.cells().map((c) => c.x).sort((a, b) => a - b),
    [0, 1, 2, 3]
  );
});

test('SRS: kicks off the right wall too', () => {
  const e = newGame(15);
  clearBoard(e);
  e.current = { type: 'T', rot: 3, x: COLS - 2, y: 5 }; // nose left, spine on the last column
  for (const c of e.cells()) assert.ok(c.x >= 0 && c.x < COLS);

  assert.equal(e.rotateCW(), true);
  assert.equal(e.current.rot, 0);
  assert.equal(e.current.x, COLS - 3, 'kicked one column left');
  for (const c of e.cells()) assert.ok(c.x >= 0 && c.x < COLS);
});

test('SRS: the O piece never kicks', () => {
  const e = newGame(16);
  clearBoard(e);
  // wedge the O between two solid columns so any offset would collide
  for (let y = 0; y < ROWS; y++) {
    e.board[y][0] = 'J';
    e.board[y][3] = 'J';
  }
  e.current = { type: 'O', rot: 0, x: 0, y: 5 };
  for (let i = 1; i <= 4; i++) {
    assert.equal(e.rotateCW(), true, 'O always rotates');
    assert.equal(e.current.rot, i % 4);
    assert.equal(e.current.x, 0, 'O never moves while rotating');
    assert.equal(e.current.y, 5);
  }
});

test('a rotation with no valid kick is refused', () => {
  const e = newGame(17);
  clearBoard(e);
  // bury a vertical I in a one-wide well: no horizontal placement fits
  for (let y = ROWS - 6; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x !== 4) e.board[y][x] = 'L';
    }
  }
  e.current = { type: 'I', rot: 1, x: 2, y: ROWS - 4 };
  assert.equal(e.rotateCW(), false);
  assert.equal(e.rotateCCW(), false);
  assert.equal(e.current.rot, 1, 'a refused rotation leaves the piece untouched');
  assert.equal(e.current.x, 2);
});

test('rotation states cycle both ways and ghostY tracks the landing row', () => {
  const e = newGame(18);
  clearBoard(e);
  e.current = { type: 'T', rot: 0, x: 3, y: 0 };
  e.rotateCW();
  assert.equal(e.current.rot, 1);
  e.rotateCW();
  e.rotateCW();
  e.rotateCW();
  assert.equal(e.current.rot, 0);
  e.rotateCCW();
  assert.equal(e.current.rot, 3);

  e.current = { type: 'T', rot: 0, x: 3, y: 0 };
  assert.equal(e.ghostY(), ROWS - 2, 'T rot0 rests with its bar on the floor');
  e.board[ROWS - 1][4] = 'Z';
  assert.equal(e.ghostY(), ROWS - 3, 'the ghost stops on top of the stack');
});

/* ------------------------------------------------------------------ *
 * Gravity, lock delay and pause
 * ------------------------------------------------------------------ */

test('gravity drops the piece one row per level step', () => {
  const e = newGame(19);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  e.tick(999);
  assert.equal(e.current.y, 0);
  e.tick(1);
  assert.equal(e.current.y, 1, 'one row after 1000ms at level 1');
  e.level = 10;
  e.tick(150);
  assert.equal(e.current.y, 2, 'level 10 steps every 150ms');
});

test('lock delay is 500ms once the piece is grounded', () => {
  const e = newGame(20);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: ROWS - 2 };
  e.tick(LOCK_DELAY_MS - 1);
  assert.equal(e.board[ROWS - 1][4], '', 'still floating at 499ms');
  e.tick(1);
  assert.equal(e.board[ROWS - 1][4], 'O', 'locked at exactly 500ms');
});

test('moves reset the lock delay at most 15 times, then the lock is forced', () => {
  const e = newGame(21);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: ROWS - 2 };

  for (let i = 0; i < MAX_LOCK_RESETS; i++) {
    e.tick(LOCK_DELAY_MS - 1);
    assert.equal(e.board[ROWS - 1][4], '', 'must not lock on reset ' + i);
    const moved = i % 2 === 0 ? e.moveLeft() : e.moveRight();
    assert.equal(moved, true, 'move ' + i + ' should succeed');
  }

  e.tick(LOCK_DELAY_MS - 1);
  assert.ok(e.current, 'still alive just before the forced lock');
  const lockedX = e.current.x;
  assert.equal(e.moveLeft(), true, 'the 16th move still moves the piece');
  assert.equal(e.current.x, lockedX - 1);
  const finalX = e.current.x;

  e.tick(1);
  assert.equal(e.board[ROWS - 1][finalX + 1], 'O', 'the 16th move does not buy another 500ms');
  assert.equal(e.board[ROWS - 2][finalX + 1], 'O');
});

test('pause freezes gravity and ignores input', () => {
  const e = newGame(22);
  clearBoard(e);
  e.current = { type: 'O', rot: 0, x: 3, y: 0 };
  assert.equal(e.togglePause(), true);
  assert.equal(e.paused, true);

  e.tick(5000);
  assert.equal(e.current.y, 0);
  assert.equal(e.moveLeft(), false);
  assert.equal(e.moveRight(), false);
  assert.equal(e.rotateCW(), false);
  assert.equal(e.softDrop(), false);
  assert.equal(e.hardDrop(), 0);
  assert.equal(e.current.x, 3);

  assert.equal(e.togglePause(), false);
  assert.equal(e.moveLeft(), true);
});

/* ------------------------------------------------------------------ *
 * Game over
 * ------------------------------------------------------------------ */

test('game over when the spawn area is blocked', () => {
  const e = newGame(23);
  clearBoard(e);
  // block the whole spawn footprint (rows 0-1, columns 3-6)
  for (let y = 0; y <= 1; y++) {
    for (let x = 3; x <= 6; x++) e.board[y][x] = 'Z';
  }
  e.current = { type: 'O', rot: 0, x: 0, y: 0 }; // clear of the blocked columns
  e.hardDrop();

  assert.equal(e.gameOver, true);
  assert.equal(e.phase, 'over');
  assert.equal(e.moveLeft(), false, 'input is dead after game over');
  assert.equal(e.rotateCW(), false);
  const before = snapshot(e);
  e.tick(5000);
  assert.equal(snapshot(e), before, 'tick is a no-op after game over');
  assert.equal(e.togglePause(), false, 'cannot pause a finished game');
});

test('a game that is still playable does not report game over', () => {
  const e = newGame(24);
  assert.equal(e.gameOver, false);
  assert.equal(e.phase, 'playing');
  assert.ok(e.current);
  assert.equal(e.score, 0);
  assert.equal(e.lines, 0);
  assert.equal(e.level, 1);
  assert.deepEqual(e.pendingClear, []);
  assert.equal(e.board.length, ROWS);
  assert.equal(e.board[0].length, COLS);
});

test('start() resets a finished game back to a clean board', () => {
  const e = newGame(25);
  e.score = 4242;
  e.lines = 37;
  e.level = 4;
  e.gameOver = true;
  e.phase = 'over';
  e.board[ROWS - 1][0] = 'T';

  e.start();
  assert.equal(e.score, 0);
  assert.equal(e.lines, 0);
  assert.equal(e.level, 1);
  assert.equal(e.gameOver, false);
  assert.equal(e.paused, false);
  assert.equal(e.phase, 'playing');
  assert.deepEqual(e.pendingClear, []);
  assert.equal(e.nextQueue.length, 3);
  for (const row of e.board) for (const cell of row) assert.equal(cell, '');
});

test('cells() reports absolute board coordinates for the live piece', () => {
  const e = newGame(26);
  clearBoard(e);
  e.current = { type: 'T', rot: 0, x: 3, y: 4 };
  const cells = e.cells();
  assert.equal(cells.length, 4);
  for (const c of cells) assert.equal(c.type, 'T');
  assert.deepEqual(
    cells.map((c) => c.x + ',' + c.y).sort(),
    ['3,5', '4,4', '4,5', '5,5'].sort()
  );
});
