/**
 * Orange Tetris - leaderboard persistence.
 *
 * localStorage only, no DOM, no game rules. Every exported function is
 * bulletproof: if localStorage is missing (private mode, disabled, non-browser
 * host) or throws, the module silently degrades to an in-memory array and
 * never propagates an exception to the caller.
 *
 * Ordering: score descending, ties broken by the earlier date first.
 * The stored list never holds more than MAX_ENTRIES entries.
 */

export const STORAGE_KEY = 'orange-tetris.scores.v1';

/** Hard cap on persisted entries. */
const MAX_ENTRIES = 10;

/** In-memory mirror, and the sole store once storage proves unusable. */
let memoryScores = [];
let memoryOnly = false;

/* ------------------------------------------------------------------ *
 * Storage plumbing (never throws)
 * ------------------------------------------------------------------ */

function fallbackToMemory() {
  memoryOnly = true;
}

/**
 * @returns {Storage|null} a usable storage object, or null when we must
 * operate purely from memory. Merely reading globalThis.localStorage can
 * throw in some hardened browsers, hence the try/catch.
 */
function getStorage() {
  if (memoryOnly) return null;
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    if (typeof store.getItem !== 'function') return null;
    if (typeof store.setItem !== 'function') return null;
    return store;
  } catch {
    fallbackToMemory();
    return null;
  }
}

function cloneList(list) {
  return list.map((entry) => ({
    score: entry.score,
    lines: entry.lines,
    level: entry.level,
    date: entry.date,
  }));
}

/* ------------------------------------------------------------------ *
 * Normalisation helpers
 * ------------------------------------------------------------------ */

/**
 * Coerce a value to a finite number, or return null when impossible.
 * Accepts numbers and numeric strings (hand-edited storage happens).
 */
function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function toFiniteOr(value, fallback) {
  const num = toFinite(value);
  return num === null ? fallback : num;
}

/**
 * Validate one raw entry read back from storage.
 * A non-finite score or any missing field discards the entry.
 * @returns {{score:number,lines:number,level:number,date:string}|null}
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const score = toFinite(raw.score);
  const lines = toFinite(raw.lines);
  const level = toFinite(raw.level);
  if (score === null || lines === null || level === null) return null;
  if (typeof raw.date !== 'string' || raw.date.trim() === '') return null;
  return { score, lines, level, date: raw.date };
}

/** Unparseable dates sort last so they never steal a tie-break. */
function timeOf(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/** Score descending, then earlier date first. Array#sort is stable. */
function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = timeOf(a.date);
  const tb = timeOf(b.date);
  if (ta !== tb) return ta - tb;
  return 0;
}

function sanitize(value) {
  if (!Array.isArray(value)) return [];
  const cleaned = [];
  for (const raw of value) {
    const entry = normalizeEntry(raw);
    if (entry) cleaned.push(entry);
  }
  cleaned.sort(compareEntries);
  return cleaned.slice(0, MAX_ENTRIES);
}

function parseJson(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function persist(list) {
  memoryScores = cloneList(list);
  const store = getStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    fallbackToMemory();
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Read the leaderboard.
 * @returns {Array<{score:number,lines:number,level:number,date:string}>}
 * sorted score descending, at most 10 entries. Never throws: absent,
 * unreadable, corrupt or non-array storage all yield [] (or the in-memory
 * list when storage itself is unusable).
 */
export function loadScores() {
  const store = getStorage();
  if (!store) return cloneList(memoryScores);

  let raw = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    fallbackToMemory();
    return cloneList(memoryScores);
  }

  const list = sanitize(parseJson(raw));
  memoryScores = cloneList(list);
  return list;
}

/**
 * Would this score enter the top 10?
 * A score equal to the current lowest does not qualify at the cap, because
 * the incumbent entry is older and wins the tie-break.
 * @param {number} score
 * @returns {boolean}
 */
export function isHighScore(score) {
  const value = toFinite(score);
  if (value === null || value <= 0) return false;
  const list = loadScores();
  if (list.length < MAX_ENTRIES) return true;
  return value > list[list.length - 1].score;
}

/**
 * Persist one run, trim to the top 10, and return the new list.
 * @param {{score:number,lines:number,level:number}} entry
 * @param {string} [nowIso] ISO-8601 timestamp, injectable for deterministic
 *   tests. Defaults to the current time.
 * @returns {Array<{score:number,lines:number,level:number,date:string}>}
 */
export function saveScore(entry, nowIso = new Date().toISOString()) {
  const date =
    typeof nowIso === 'string' && nowIso.trim() !== ''
      ? nowIso
      : new Date().toISOString();

  const record = {
    score: toFiniteOr(entry && entry.score, 0),
    lines: toFiniteOr(entry && entry.lines, 0),
    level: toFiniteOr(entry && entry.level, 1),
    date,
  };

  const list = loadScores();
  list.push(record);
  list.sort(compareEntries);
  const trimmed = list.slice(0, MAX_ENTRIES);
  persist(trimmed);
  return cloneList(trimmed);
}

/** Wipe the leaderboard, and give storage a fresh chance to work. */
export function clearScores() {
  memoryScores = [];
  memoryOnly = false;
  const store = getStorage();
  if (!store) return;
  try {
    if (typeof store.removeItem === 'function') {
      store.removeItem(STORAGE_KEY);
    } else {
      store.setItem(STORAGE_KEY, '[]');
    }
  } catch {
    fallbackToMemory();
  }
}

/**
 * Render an ISO date for display, in the viewer's local time.
 * @param {string} iso
 * @returns {string} 'DD/MM/YYYY HH:mm', or '-' when the date is absent or invalid.
 */
export function formatDate(iso) {
  if (typeof iso !== 'string' || iso.trim() === '') return '-';
  let date;
  try {
    date = new Date(iso);
  } catch {
    return '-';
  }
  const time = date.getTime();
  if (!Number.isFinite(time)) return '-';

  const pad = (num) => String(num).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear()).padStart(4, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}
