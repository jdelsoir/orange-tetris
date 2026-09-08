/**
 * js/render.js - Orange Tetris canvas renderer.
 *
 * Canvas drawing only. No game rules, no timers, no requestAnimationFrame,
 * no DOM outside the two canvases it is handed. The whole line-clear
 * animation is a pure function of anim.clearProgress, so the same value
 * always produces the same frame.
 *
 * Public API (contract):
 *   new Renderer(boardCanvas, nextCanvas)
 *   renderer.resize()
 *   renderer.draw(state, anim)   // anim = { clearProgress: 0..1 }
 *
 * anim may also carry `reducedMotion: true` (prefers-reduced-motion). It is
 * optional and defaults to false; when set, the clearing rows are drawn plainly
 * and the white flash and the pulsing border glow are skipped entirely, so the
 * shortened animation cannot read as a strobe.
 */

/* The piece palette has exactly one owner. It used to be copied here, which is
 * one silent divergence away from the board and the preview disagreeing about
 * what colour an S is. No rules, timers or state come across with it. */
import { PIECE_COLORS } from './engine.js';

/* ------------------------------------------------------------------ *
 * Constants (drawing data only)
 * ------------------------------------------------------------------ */

const COLS = 10;
const ROWS = 20;

const FIELD_BG    = '#000000';
const GRID_LINE   = '#595959';
const GRID_ALPHA  = 0.18;
const BRAND       = '#FF7900';
const WHITE       = '#FFFFFF';
const FALLBACK    = '#8F8F8F';

/** Spawn (rot 0) cell offsets inside the 4x4 matrix, used by the preview. */
const SHAPES = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]]
};

/* Line-clear animation beats, in clearProgress units. */
const BEAT_FLASH_END = 0.35; // 0.00 -> 0.35 : ramp the rows to white
const BEAT_WIPE_END  = 0.80; // 0.35 -> 0.80 : wipe outward from the centre
/*                              0.80 -> 1.00 : residue fades, border glows   */

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

function clamp01(v) {
  // NaN must collapse to 0, not sail through: `NaN < 0` and `NaN > 1` are both
  // false, and a single NaN turns a whole frame into fillRect(x, NaN, w, NaN).
  const n = +v;
  if (!(n > 0)) return 0;
  return n > 1 ? 1 : n;
}

/** Even integer >= n, so strokes with that width land on whole pixels. */
function evenPx(n) {
  const i = Math.max(2, Math.round(n));
  return i % 2 === 0 ? i : i + 1;
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function parseHex(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!isFinite(n)) return [143, 143, 143];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r, g, b) {
  return '#' + ((1 << 24) | (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b))
    .toString(16).slice(1);
}

/** Linear mix between two hex colours, t = 0 -> a, t = 1 -> b. */
function mixHex(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  const k = clamp01(t);
  return toHex(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
}

const shadeCache = new Map();

/** amt > 0 lightens toward white, amt < 0 darkens toward black. Cached. */
function shade(hex, amt) {
  const key = hex + '|' + amt;
  let out = shadeCache.get(key);
  if (out === undefined) {
    out = amt >= 0 ? mixHex(hex, WHITE, amt) : mixHex(hex, '#000000', -amt);
    shadeCache.set(key, out);
  }
  return out;
}

function easeOut(t) {
  const k = clamp01(t);
  return 1 - (1 - k) * (1 - k);
}

function colorFor(type) {
  return PIECE_COLORS[type] || FALLBACK;
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export class Renderer {
  /**
   * @param {HTMLCanvasElement} boardCanvas
   * @param {HTMLCanvasElement} nextCanvas
   */
  constructor(boardCanvas, nextCanvas) {
    this.boardCanvas = boardCanvas || null;
    this.nextCanvas = nextCanvas || null;
    this.bctx = this.boardCanvas && typeof this.boardCanvas.getContext === 'function'
      ? this.boardCanvas.getContext('2d')
      : null;
    this.nctx = this.nextCanvas && typeof this.nextCanvas.getContext === 'function'
      ? this.nextCanvas.getContext('2d')
      : null;
    this.dpr = 1;
    this.bm = null; // board metrics, all in device pixels
    this.nm = null; // preview metrics, all in device pixels
    this.resize();
  }

  /* -------------------------------------------------------------- *
   * Sizing
   * -------------------------------------------------------------- */

  /** Size both backing stores to their CSS box * devicePixelRatio. */
  resize() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.dpr = Math.max(1, dpr);
    this._sizeCanvas(this.boardCanvas);
    this._sizeCanvas(this.nextCanvas);
    this._measure();
  }

  _sizeCanvas(canvas) {
    if (!canvas) return;
    let cssW = 0;
    let cssH = 0;
    if (typeof canvas.getBoundingClientRect === 'function') {
      const r = canvas.getBoundingClientRect();
      if (r) {
        cssW = r.width || 0;
        cssH = r.height || 0;
      }
    }
    if (!cssW || !cssH) {
      cssW = canvas.clientWidth || 0;
      cssH = canvas.clientHeight || 0;
    }
    // No CSS box yet (detached / headless): keep whatever backing store it has.
    if (!cssW || !cssH) return;
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  /** Recompute integer-pixel geometry from the current backing stores. */
  _measure() {
    const dpr = this.dpr;
    const px = (cssPx) => Math.max(1, Math.round(cssPx * dpr));

    // ---- board ----
    const bc = this.boardCanvas;
    if (bc && bc.width > 0 && bc.height > 0) {
      const W = bc.width;
      const H = bc.height;
      const border = evenPx(2 * dpr);        // 2px brand border
      const glowRoom = px(5);                // breathing room for the glow rings
      const pad = border + glowRoom;
      let cell = Math.floor(Math.min((W - 2 * pad) / COLS, (H - 2 * pad) / ROWS));
      if (!isFinite(cell) || cell < 3) {
        cell = Math.max(3, Math.floor(Math.min(W / COLS, H / ROWS)));
      }
      const fw = cell * COLS;
      const fh = cell * ROWS;
      this.bm = {
        W, H, cell, fw, fh,
        ox: Math.floor((W - fw) / 2),
        oy: Math.floor((H - fh) / 2),
        border,
        gap: px(1),                                  // 1px black gutter between cells
        bevel: Math.max(1, Math.round(cell * 0.13)), // inner highlight / edge thickness
        line: px(1),                                 // 1px grid line
        ghost: evenPx(2 * dpr)                       // 2px ghost outline
      };
    } else {
      this.bm = null;
    }

    // ---- next preview ----
    const nc = this.nextCanvas;
    if (nc && nc.width > 0 && nc.height > 0) {
      const W = nc.width;
      const H = nc.height;
      const horizontal = W > H * 1.4;
      const pad = px(6);
      const slotW = horizontal ? W / 3 : W;
      const slotH = horizontal ? H : H / 3;
      let cell = Math.floor(Math.min((slotW - 2 * pad) / 4, (slotH - 2 * pad) / 2.4));
      if (!isFinite(cell) || cell < 3) cell = Math.max(3, Math.floor(Math.min(W / 12, H / 8)));
      this.nm = {
        W, H, cell, horizontal, slotW, slotH,
        gap: px(1),
        bevel: Math.max(1, Math.round(cell * 0.13))
      };
    } else {
      this.nm = null;
    }
  }

  /** Cheap per-frame check: re-measure only if a backing store changed. */
  _sync() {
    const bc = this.boardCanvas;
    if (bc && (!this.bm || this.bm.W !== bc.width || this.bm.H !== bc.height)) this._measure();
    const nc = this.nextCanvas;
    if (nc && (!this.nm || this.nm.W !== nc.width || this.nm.H !== nc.height)) this._measure();
  }

  /* -------------------------------------------------------------- *
   * Public draw
   * -------------------------------------------------------------- */

  /**
   * @param {object} state Engine instance (read-only use of its public API).
   * @param {{clearProgress:number, reducedMotion?:boolean}} [anim]
   */
  draw(state, anim) {
    this._sync();
    const p = clamp01(anim && typeof anim.clearProgress === 'number' ? anim.clearProgress : 0);
    const reduced = !!(anim && anim.reducedMotion);
    this._drawBoard(state, p, reduced);
    this._drawNext(state);
  }

  /* -------------------------------------------------------------- *
   * Board
   * -------------------------------------------------------------- */

  _drawBoard(state, p, reduced) {
    const ctx = this.bctx;
    const m = this.bm;
    if (!ctx || !m) return;

    ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, m.W, m.H);
    ctx.fillStyle = FIELD_BG;
    ctx.fillRect(0, 0, m.W, m.H);

    this._drawGrid(ctx, m);

    const board = state && Array.isArray(state.board) ? state.board : null;
    const phase = state ? state.phase : 'ready';
    const clearing = phase === 'clearing';
    const pending = clearing && Array.isArray(state.pendingClear) ? state.pendingClear : [];
    const clearRows = new Set(pending);

    // Locked cells (clearing rows are handled by the animation instead).
    if (board) {
      const rows = Math.min(ROWS, board.length);
      for (let y = 0; y < rows; y++) {
        if (clearRows.has(y)) continue;
        const row = board[y];
        if (!row) continue;
        const cols = Math.min(COLS, row.length);
        for (let x = 0; x < cols; x++) {
          const t = row[x];
          if (!t) continue;
          this._block(ctx, m.ox + x * m.cell, m.oy + y * m.cell, m.cell, colorFor(t), m.gap, m.bevel);
        }
      }
    }

    // Ghost + active piece (never during the clear animation - no piece exists then).
    if (!clearing && state && state.current) {
      const cells = this._pieceCells(state);
      if (cells) {
        const color = colorFor(state.current.type);
        if (phase === 'playing' && !state.paused && !state.gameOver) {
          this._drawGhost(ctx, m, state, cells, color);
        }
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (c.y < 0 || c.y >= ROWS || c.x < 0 || c.x >= COLS) continue;
          this._block(ctx, m.ox + c.x * m.cell, m.oy + c.y * m.cell, m.cell,
            colorFor(c.type || state.current.type), m.gap, m.bevel);
        }
      }
    }

    // Line-clear animation: pure function of p.
    let glow = 0;
    if (clearing && pending.length) {
      for (let i = 0; i < pending.length; i++) {
        const y = pending[i];
        if (typeof y !== 'number' || y < 0 || y >= ROWS) continue;
        this._drawClearRow(ctx, m, board, y, p, reduced);
      }
      glow = !reduced && p >= BEAT_WIPE_END
        ? Math.sin(((p - BEAT_WIPE_END) / (1 - BEAT_WIPE_END)) * Math.PI)
        : 0;
    }

    ctx.globalAlpha = 1;
    this._drawBorder(ctx, m);
    if (glow > 0) this._drawGlow(ctx, m, glow);

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** 1px #595959 lines at 18% over the black field. */
  _drawGrid(ctx, m) {
    const lw = m.line;
    ctx.globalAlpha = GRID_ALPHA;
    ctx.fillStyle = GRID_LINE;
    for (let c = 0; c <= COLS; c++) {
      const x = m.ox + c * m.cell - (c === COLS ? lw : 0);
      ctx.fillRect(x, m.oy, lw, m.fh);
    }
    for (let r = 0; r <= ROWS; r++) {
      const y = m.oy + r * m.cell - (r === ROWS ? lw : 0);
      ctx.fillRect(m.ox, y, m.fw, lw);
    }
    ctx.globalAlpha = 1;
  }

  /** Flat fill + lighter top-left inner highlight + darker bottom-right edge. */
  _block(ctx, x, y, cell, color, gap, bevel) {
    const w = cell - gap;
    if (w <= 0) return;
    const b = Math.max(1, Math.min(bevel, Math.floor(w / 3)));
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, w);
    ctx.fillStyle = shade(color, 0.34);
    ctx.fillRect(x, y, w, b);
    ctx.fillRect(x, y, b, w);
    ctx.fillStyle = shade(color, -0.42);
    ctx.fillRect(x, y + w - b, w, b);
    ctx.fillRect(x + w - b, y, b, w);
  }

  _pieceCells(state) {
    if (!state || typeof state.cells !== 'function') return null;
    let cells;
    try {
      cells = state.cells();
    } catch (e) {
      return null;
    }
    return Array.isArray(cells) ? cells : null;
  }

  /** 2px translucent outline at the landing position, no fill. */
  _drawGhost(ctx, m, state, cells, color) {
    if (typeof state.ghostY !== 'function') return;
    let gy;
    try {
      gy = state.ghostY();
    } catch (e) {
      return;
    }
    if (typeof gy !== 'number' || !isFinite(gy)) return;
    const dy = gy - state.current.y;
    if (dy <= 0) return;

    const lw = m.ghost;
    const size = m.cell - m.gap - lw;
    if (size <= 0) return;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const y = c.y + dy;
      if (y < 0 || y >= ROWS || c.x < 0 || c.x >= COLS) continue;
      ctx.strokeRect(
        m.ox + c.x * m.cell + lw / 2,
        m.oy + y * m.cell + lw / 2,
        size,
        size
      );
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * One clearing row, driven only by p (0..1).
   *   0.00 - 0.35 flash to #FFFFFF, ramping
   *   0.35 - 0.80 wipe outward from the two centre columns to both edges
   *   0.80 - 1.00 residue fades out
   */
  _drawClearRow(ctx, m, board, y, p, reduced) {
    const rowY = m.oy + y * m.cell;
    const cw = m.cell - m.gap;
    const row = board && board[y] ? board[y] : null;

    if (reduced) {
      // prefers-reduced-motion: no flash, no wipe, no fade. The row simply
      // stays as it is until the UI commits the clear and it disappears.
      for (let x = 0; x < COLS; x++) {
        const t = row ? row[x] : '';
        if (!t) continue;
        this._block(ctx, m.ox + x * m.cell, rowY, m.cell, colorFor(t), m.gap, m.bevel);
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (p < BEAT_FLASH_END) {
      const f = easeOut(p / BEAT_FLASH_END);
      for (let x = 0; x < COLS; x++) {
        const t = row ? row[x] : '';
        if (!t) continue;
        this._block(ctx, m.ox + x * m.cell, rowY, m.cell,
          mixHex(colorFor(t), WHITE, f), m.gap, m.bevel);
      }
      ctx.globalAlpha = 0.55 * f;
      ctx.fillStyle = WHITE;
      ctx.fillRect(m.ox, rowY, m.fw, cw);
      ctx.globalAlpha = 1;
      return;
    }

    if (p < BEAT_WIPE_END) {
      const u = (p - BEAT_FLASH_END) / (BEAT_WIPE_END - BEAT_FLASH_END);
      const half = COLS / 2;             // centre columns are half-1 and half
      const front = u * (half + 1);      // wipe front, in columns from the centre
      ctx.fillStyle = WHITE;
      for (let x = 0; x < COLS; x++) {
        const dist = x < half ? (half - 1 - x) : (x - half);
        const w = clamp01(front - dist); // 0 = untouched, 1 = gone
        if (w >= 1) continue;
        const h = Math.max(1, Math.round(cw * (1 - w)));
        ctx.globalAlpha = 1 - 0.35 * w;
        ctx.fillRect(m.ox + x * m.cell, rowY + Math.round((cw - h) / 2), cw, h);
      }
      ctx.globalAlpha = 1;
      return;
    }

    // Residue afterimage.
    const v = (p - BEAT_WIPE_END) / (1 - BEAT_WIPE_END);
    const fade = 1 - v;
    const h = Math.max(1, Math.round(cw * 0.22 * fade));
    ctx.globalAlpha = 0.45 * fade;
    ctx.fillStyle = WHITE;
    ctx.fillRect(m.ox, rowY + Math.round((cw - h) / 2), m.fw, h);
    ctx.globalAlpha = 1;
  }

  /** 2px #FF7900 board border, drawn just outside the field. */
  _drawBorder(ctx, m) {
    const bw = m.border;
    ctx.globalAlpha = 1;
    ctx.lineWidth = bw;
    ctx.strokeStyle = BRAND;
    ctx.strokeRect(m.ox - bw / 2, m.oy - bw / 2, m.fw + bw, m.fh + bw);
  }

  /** Orange glow rings around the border, intensity 0..1. */
  _drawGlow(ctx, m, intensity) {
    const k = clamp01(intensity);
    if (k <= 0) return;
    const rings = 4;
    const lw = evenPx(2 * this.dpr);
    const room = Math.max(0, Math.min(m.ox, m.oy) - m.border - 1);
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = BRAND;
    for (let i = rings; i >= 1; i--) {
      const t = i / rings;
      const off = m.border + Math.round(t * room * (0.35 + 0.65 * k));
      ctx.globalAlpha = 0.32 * k * (1 - t * 0.7);
      ctx.strokeRect(m.ox - off, m.oy - off, m.fw + 2 * off, m.fh + 2 * off);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* -------------------------------------------------------------- *
   * Next-piece preview
   * -------------------------------------------------------------- */

  _drawNext(state) {
    const ctx = this.nctx;
    const n = this.nm;
    if (!ctx || !n) return;

    ctx.save();
    if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, n.W, n.H);
    ctx.fillStyle = FIELD_BG;
    ctx.fillRect(0, 0, n.W, n.H);

    const queue = state && Array.isArray(state.nextQueue) ? state.nextQueue : [];
    const count = Math.min(3, queue.length);
    for (let i = 0; i < count; i++) {
      const type = queue[i];
      const shape = SHAPES[type];
      if (!shape) continue;

      let minX = 4;
      let maxX = -1;
      let minY = 4;
      let maxY = -1;
      for (let c = 0; c < shape.length; c++) {
        const sx = shape[c][0];
        const sy = shape[c][1];
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
      const bw = (maxX - minX + 1) * n.cell;
      const bh = (maxY - minY + 1) * n.cell;

      const slotX = n.horizontal ? i * n.slotW : 0;
      const slotY = n.horizontal ? 0 : i * n.slotH;
      const px = Math.round(slotX + (n.slotW - bw) / 2);
      const py = Math.round(slotY + (n.slotH - bh) / 2);

      const color = colorFor(type);
      for (let c = 0; c < shape.length; c++) {
        this._block(
          ctx,
          px + (shape[c][0] - minX) * n.cell,
          py + (shape[c][1] - minY) * n.cell,
          n.cell, color, n.gap, n.bevel
        );
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
