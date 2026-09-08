/**
 * Orange Tetris - game rules core.
 *
 * Pure logic module: it touches no browser globals, no persistence and no
 * logging. Every source of randomness goes through the injected rng so runs are
 * fully reproducible in tests.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const COLS = 10;
export const ROWS = 20;

export const PIECE_COLORS = Object.freeze({
  I: '#4BB4E6',
  J: '#A885D8',
  L: '#FF7900',
  O: '#FFD200',
  S: '#50BE87',
  T: '#FFB4E6',
  Z: '#F16E00'
});

/** Canonical bag content, in a fixed order (the rng does the shuffling). */
export const PIECE_TYPES = Object.freeze(['I', 'J', 'L', 'O', 'S', 'T', 'Z']);

/** Gravity step in ms, index = level - 1, levels 1..10. */
export const GRAVITY_MS = Object.freeze([1000, 850, 720, 610, 500, 410, 330, 260, 200, 150]);

export const MAX_LEVEL = 10;
export const LOCK_DELAY_MS = 500;
export const MAX_LOCK_RESETS = 15;

/** Top-left of the 4x4 rotation matrix on spawn. */
export const SPAWN_X = 3;
export const SPAWN_Y = 0;

/** Base line-clear score, multiplied by the level in force before the clear. */
export const LINE_SCORES = Object.freeze([0, 100, 300, 500, 800]);
export const SOFT_DROP_POINTS = 1;
export const HARD_DROP_POINTS = 2;

/* ------------------------------------------------------------------ *
 * Tetrominoes - 4x4 matrices, 4 rotation states each (SRS)
 *
 * Rotation states: 0 = spawn, 1 = right (CW from spawn),
 *                  2 = 180, 3 = left (CCW from spawn).
 * JLSTZ use the 3x3 SRS bounding box anchored at the top-left of the
 * 4x4 matrix; I uses the full 4x4 box; O sits in columns 1-2 / rows 0-1
 * so that it is identical in all four states and never needs a kick.
 * ------------------------------------------------------------------ */

const SHAPE_ROWS = Object.freeze({
  I: [
    ['....', 'XXXX', '....', '....'],
    ['..X.', '..X.', '..X.', '..X.'],
    ['....', '....', 'XXXX', '....'],
    ['.X..', '.X..', '.X..', '.X..']
  ],
  J: [
    ['X...', 'XXX.', '....', '....'],
    ['.XX.', '.X..', '.X..', '....'],
    ['....', 'XXX.', '..X.', '....'],
    ['.X..', '.X..', 'XX..', '....']
  ],
  L: [
    ['..X.', 'XXX.', '....', '....'],
    ['.X..', '.X..', '.XX.', '....'],
    ['....', 'XXX.', 'X...', '....'],
    ['XX..', '.X..', '.X..', '....']
  ],
  O: [
    ['.XX.', '.XX.', '....', '....'],
    ['.XX.', '.XX.', '....', '....'],
    ['.XX.', '.XX.', '....', '....'],
    ['.XX.', '.XX.', '....', '....']
  ],
  S: [
    ['.XX.', 'XX..', '....', '....'],
    ['.X..', '.XX.', '..X.', '....'],
    ['....', '.XX.', 'XX..', '....'],
    ['X...', 'XX..', '.X..', '....']
  ],
  T: [
    ['.X..', 'XXX.', '....', '....'],
    ['.X..', '.XX.', '.X..', '....'],
    ['....', 'XXX.', '.X..', '....'],
    ['.X..', 'XX..', '.X..', '....']
  ],
  Z: [
    ['XX..', '.XX.', '....', '....'],
    ['..X.', '.XX.', '.X..', '....'],
    ['....', 'XX..', '.XX.', '....'],
    ['.X..', 'XX..', 'X...', '....']
  ]
});

/** TETROMINOES[type][rot] => 4x4 array of arrays of 0 | 1. */
export const TETROMINOES = Object.freeze(
  PIECE_TYPES.reduce((acc, type) => {
    acc[type] = Object.freeze(
      SHAPE_ROWS[type].map((state) =>
        Object.freeze(state.map((row) => Object.freeze(row.split('').map((c) => (c === '.' ? 0 : 1)))))
      )
    );
    return acc;
  }, {})
);

/** OFFSETS[type][rot] => array of [dx, dy] relative to the matrix top-left. */
const OFFSETS = PIECE_TYPES.reduce((acc, type) => {
  acc[type] = TETROMINOES[type].map((matrix) => {
    const list = [];
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        if (matrix[dy][dx]) list.push([dx, dy]);
      }
    }
    return list;
  });
  return acc;
}, {});

/* ------------------------------------------------------------------ *
 * SRS wall kicks
 *
 * Tables are stored in board coordinates (y grows downward), i.e. the
 * published SRS tables with the y component negated. Key is `${from}>${to}`.
 * ------------------------------------------------------------------ */

const KICKS_JLSTZ = Object.freeze({
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
});

const KICKS_I = Object.freeze({
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]
});

const NO_KICKS = Object.freeze([[0, 0]]);

function kicksFor(type, from, to) {
  if (type === 'O') return NO_KICKS;
  const table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
  return table[from + '>' + to] || NO_KICKS;
}

/* ------------------------------------------------------------------ *
 * Level / gravity helpers
 * ------------------------------------------------------------------ */

export function levelForLines(lines) {
  const n = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 0;
  return Math.min(MAX_LEVEL, 1 + Math.floor(n / 10));
}

export function gravityForLevel(level) {
  const n = Number.isFinite(level) ? Math.floor(level) : 1;
  const clamped = Math.min(MAX_LEVEL, Math.max(1, n));
  return GRAVITY_MS[clamped - 1];
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

function emptyBoard() {
  const board = new Array(ROWS);
  for (let y = 0; y < ROWS; y++) {
    board[y] = new Array(COLS).fill('');
  }
  return board;
}

export class Engine {
  /**
   * @param {() => number} [rng] random source returning a float in [0, 1).
   */
  constructor(rng = Math.random) {
    this.rng = typeof rng === 'function' ? rng : Math.random;

    /** @type {string[][]} ROWS x COLS, '' or a piece letter. */
    this.board = emptyBoard();
    /** @type {{type:string, rot:number, x:number, y:number}|null} */
    this.current = null;
    /** @type {string[]} */
    this.nextQueue = [];

    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.gameOver = false;
    this.paused = false;
    /** @type {'ready'|'playing'|'clearing'|'over'} */
    this.phase = 'ready';
    /** @type {number[]} */
    this.pendingClear = [];

    // Internals (never read by the UI).
    this._bag = [];
    this._gravityTimer = 0;
    this._lockTimer = 0;
    this._lockResets = 0;
    // Deepest row this piece has reached, and the piece the figure belongs to.
    // The reset budget is refunded by downward PROGRESS only, never by simply
    // being airborne, so a kick that lifts the piece cannot buy free time.
    this._lowestY = SPAWN_Y;
    this._lockPiece = null;
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    this.board = emptyBoard();
    this.current = null;
    this.nextQueue = [];
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.gameOver = false;
    this.paused = false;
    this.phase = 'playing';
    this.pendingClear = [];
    this._bag = [];
    this._gravityTimer = 0;
    this._lockTimer = 0;
    this._lockResets = 0;
    this._lowestY = SPAWN_Y;
    this._lockPiece = null;
    this._fillQueue();
    this._spawn();
    return this;
  }

  togglePause() {
    if (this.gameOver || this.phase === 'ready' || this.phase === 'over') return this.paused;
    this.paused = !this.paused;
    return this.paused;
  }

  /* ---------------- randomizer (7-bag) ---------------- */

  _randomInt(n) {
    const r = this.rng();
    const v = Number.isFinite(r) ? r : 0;
    const i = Math.floor(v * n);
    if (i < 0) return 0;
    if (i >= n) return n - 1;
    return i;
  }

  _refillBag() {
    const bag = PIECE_TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = this._randomInt(i + 1);
      const tmp = bag[i];
      bag[i] = bag[j];
      bag[j] = tmp;
    }
    this._bag = bag;
  }

  _drawPiece() {
    if (this._bag.length === 0) this._refillBag();
    return this._bag.shift();
  }

  _fillQueue() {
    while (this.nextQueue.length < 3) this.nextQueue.push(this._drawPiece());
  }

  /* ---------------- geometry helpers ---------------- */

  _offsets(type, rot) {
    return OFFSETS[type][((rot % 4) + 4) % 4];
  }

  /** True when the given placement overlaps a wall, the floor or a filled cell. */
  _collides(type, rot, x, y) {
    const offsets = this._offsets(type, rot);
    for (let i = 0; i < offsets.length; i++) {
      const bx = x + offsets[i][0];
      const by = y + offsets[i][1];
      if (bx < 0 || bx >= COLS) return true;
      if (by >= ROWS) return true;
      if (by < 0) continue; // above the ceiling is free space
      if (this.board[by][bx] !== '') return true;
    }
    return false;
  }

  _canAct() {
    return this.phase === 'playing' && !this.paused && !this.gameOver && this.current !== null;
  }

  _grounded() {
    const p = this.current;
    if (!p) return false;
    return this._collides(p.type, p.rot, p.x, p.y + 1);
  }

  /**
   * Adopt whatever piece `current` points at. Tests (and only tests) assign
   * `engine.current` by hand; without this the progress baseline would be the
   * previous piece's and the first move would look like a free fall.
   */
  _trackPiece() {
    const p = this.current;
    if (!p) {
      this._lockPiece = null;
      return;
    }
    if (this._lockPiece !== p) {
      this._lockPiece = p;
      this._lowestY = p.y;
    }
  }

  /**
   * Downward progress: the piece reached a row it had never reached before.
   * Only this refunds the reset budget and restarts the countdown for free.
   * @returns {boolean} true when the piece broke its own depth record.
   */
  _noteProgress() {
    const p = this.current;
    if (!p) return false;
    if (p.y <= this._lowestY) return false;
    this._lowestY = p.y;
    this._lockResets = 0;
    this._lockTimer = 0;
    return true;
  }

  /**
   * Called after a successful move/rotate: refresh the lock delay countdown.
   *
   * Groundedness is deliberately NOT consulted. A rotation whose SRS kick lifts
   * the piece off the stack used to zero the countdown for free, so a player
   * holding rotate could stall forever; now every move and rotation spends one
   * of the MAX_LOCK_RESETS refreshes unless the piece actually fell deeper.
   */
  _touchLockDelay() {
    if (!this.current) return;
    if (this._noteProgress()) return;
    if (this._lockResets < MAX_LOCK_RESETS) {
      this._lockResets++;
      this._lockTimer = 0;
    }
    // Budget spent: the running 500ms countdown keeps running and forces the lock.
  }

  /* ---------------- public read helpers ---------------- */

  cells() {
    const p = this.current;
    if (!p) return [];
    const offsets = this._offsets(p.type, p.rot);
    const out = new Array(offsets.length);
    for (let i = 0; i < offsets.length; i++) {
      out[i] = { x: p.x + offsets[i][0], y: p.y + offsets[i][1], type: p.type };
    }
    return out;
  }

  ghostY() {
    const p = this.current;
    if (!p) return 0;
    let y = p.y;
    while (!this._collides(p.type, p.rot, p.x, y + 1)) y++;
    return y;
  }

  /* ---------------- movement ---------------- */

  _move(dx, dy) {
    const p = this.current;
    if (this._collides(p.type, p.rot, p.x + dx, p.y + dy)) return false;
    p.x += dx;
    p.y += dy;
    return true;
  }

  moveLeft() {
    if (!this._canAct()) return false;
    this._trackPiece();
    if (!this._move(-1, 0)) return false;
    this._touchLockDelay();
    return true;
  }

  moveRight() {
    if (!this._canAct()) return false;
    this._trackPiece();
    if (!this._move(1, 0)) return false;
    this._touchLockDelay();
    return true;
  }

  _rotate(dir) {
    if (!this._canAct()) return false;
    this._trackPiece();
    const p = this.current;
    const from = ((p.rot % 4) + 4) % 4;
    const to = ((from + dir) % 4 + 4) % 4;
    const kicks = kicksFor(p.type, from, to);
    for (let i = 0; i < kicks.length; i++) {
      const nx = p.x + kicks[i][0];
      const ny = p.y + kicks[i][1];
      if (!this._collides(p.type, to, nx, ny)) {
        p.rot = to;
        p.x = nx;
        p.y = ny;
        this._touchLockDelay();
        return true;
      }
    }
    return false;
  }

  rotateCW() {
    return this._rotate(1);
  }

  rotateCCW() {
    return this._rotate(-1);
  }

  softDrop() {
    if (!this._canAct()) return false;
    this._trackPiece();
    if (this._collides(this.current.type, this.current.rot, this.current.x, this.current.y + 1)) {
      this._lock();
      return false;
    }
    this.current.y += 1;
    this.score += SOFT_DROP_POINTS;
    this._gravityTimer = 0;
    // Same budget as any other input: falling to a new lowest row refreshes the
    // countdown for free, dropping back into a row already visited does not.
    // Zeroing it unconditionally here let rotate-up + soft-drop-down stall
    // forever once the rotation budget was spent.
    this._touchLockDelay();
    return true;
  }

  hardDrop() {
    if (!this._canAct()) return 0;
    this._trackPiece();
    const p = this.current;
    let dropped = 0;
    while (!this._collides(p.type, p.rot, p.x, p.y + 1)) {
      p.y += 1;
      dropped++;
    }
    this.score += HARD_DROP_POINTS * dropped;
    this._lock();
    return dropped;
  }

  /* ---------------- gravity ---------------- */

  tick(dtMs) {
    if (this.phase !== 'playing' || this.paused || this.gameOver || !this.current) return;
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    if (dt === 0) return;

    this._trackPiece();
    const step = gravityForLevel(this.level);

    // Walk the frame in gravity-sized slices so we know WHEN inside the frame
    // the piece came to rest: only the time after that counts against the lock
    // delay. Charging the whole frame shortened the delay by up to one frame.
    let elapsed = 0;
    let groundedSince = this._grounded() ? 0 : -1;
    let guard = 0;
    while (guard++ < 64) {
      const need = step - this._gravityTimer;
      if (need > dt - elapsed) {
        this._gravityTimer += dt - elapsed;
        elapsed = dt;
        break;
      }
      elapsed += need;
      this._gravityTimer = 0;
      if (this._collides(this.current.type, this.current.rot, this.current.x, this.current.y + 1)) {
        break; // blocked: the rest of the frame is time spent on the ground
      }
      this.current.y += 1;
      this._noteProgress();
      groundedSince = this._grounded() ? elapsed : -1;
    }

    if (!this.current || this.phase !== 'playing') return;

    if (this._grounded()) {
      const since = groundedSince < 0 ? elapsed : groundedSince;
      this._lockTimer += dt - since;
      if (this._lockTimer >= LOCK_DELAY_MS) this._lock();
    } else if (this._lockResets >= MAX_LOCK_RESETS) {
      // Budget spent. A kick that lifts the piece off the stack must not buy
      // more time, so the countdown keeps running in the air too. When it runs
      // out on a piece that is still hovering (rotation kicks can keep lifting
      // it off the stack indefinitely), the piece falls to its landing row and
      // locks there - never frozen in mid-air, and never immortal either.
      this._lockTimer += dt;
      if (this._lockTimer >= LOCK_DELAY_MS) {
        const p = this.current;
        while (!this._collides(p.type, p.rot, p.x, p.y + 1)) p.y += 1;
        this._lock();
      }
    }
    // Airborne with budget left: the countdown is frozen, NOT reset. Only real
    // downward progress (_noteProgress) clears it.
  }

  /* ---------------- locking / clearing ---------------- */

  _lock() {
    const p = this.current;
    if (!p) return;
    const offsets = this._offsets(p.type, p.rot);
    let aboveCeiling = false;
    for (let i = 0; i < offsets.length; i++) {
      const bx = p.x + offsets[i][0];
      const by = p.y + offsets[i][1];
      if (by < 0) {
        // The playfield has no buffer rows, so this cell has nowhere to go.
        aboveCeiling = true;
        continue;
      }
      if (by >= ROWS || bx < 0 || bx >= COLS) continue;
      this.board[by][bx] = p.type;
    }
    this.current = null;
    this._lockPiece = null;
    this._gravityTimer = 0;
    this._lockTimer = 0;
    this._lockResets = 0;

    if (aboveCeiling) {
      // Lock-out: a legal SRS kick can push a piece above row 0, and locking
      // there used to drop the outside cells on the floor and play on. The
      // stack has reached the ceiling, so the run ends instead.
      this.pendingClear = [];
      this.gameOver = true;
      this.phase = 'over';
      return;
    }

    const full = [];
    for (let y = 0; y < ROWS; y++) {
      let complete = true;
      for (let x = 0; x < COLS; x++) {
        if (this.board[y][x] === '') {
          complete = false;
          break;
        }
      }
      if (complete) full.push(y);
    }

    if (full.length > 0) {
      // Rows stay filled on the board; the UI animates then calls commitClear().
      this.pendingClear = full;
      this.phase = 'clearing';
      return;
    }

    this.pendingClear = [];
    this._spawn();
  }

  commitClear() {
    if (this.phase !== 'clearing') return false;
    const rows = this.pendingClear;
    const cleared = rows.length;

    if (cleared > 0) {
      const doomed = new Set(rows);
      const kept = [];
      for (let y = 0; y < ROWS; y++) {
        if (!doomed.has(y)) kept.push(this.board[y]);
      }
      const board = new Array(ROWS);
      for (let y = 0; y < cleared; y++) board[y] = new Array(COLS).fill('');
      for (let i = 0; i < kept.length; i++) board[cleared + i] = kept[i];
      this.board = board;

      // Level in force BEFORE the clear multiplies the line score.
      const base = LINE_SCORES[Math.min(cleared, LINE_SCORES.length - 1)];
      this.score += base * this.level;
      this.lines += cleared;
      this.level = levelForLines(this.lines);
    }

    this.pendingClear = [];
    this.phase = 'playing';
    this._spawn();
    return true;
  }

  /* ---------------- spawning ---------------- */

  _spawn() {
    this._fillQueue();
    const type = this.nextQueue.shift();
    this._fillQueue();

    const piece = { type, rot: 0, x: SPAWN_X, y: SPAWN_Y };
    this.current = piece;
    this._gravityTimer = 0;
    this._lockTimer = 0;
    this._lockResets = 0;
    this._lowestY = piece.y;
    this._lockPiece = piece;

    if (this._collides(piece.type, piece.rot, piece.x, piece.y)) {
      this.gameOver = true;
      this.phase = 'over';
    } else {
      this.phase = 'playing';
    }
  }
}

export default Engine;
