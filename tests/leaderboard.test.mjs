/**
 * Tests for js/leaderboard.js
 *
 * The module holds module-level state (its in-memory fallback), so every test
 * imports a *fresh* instance via a cache-busting query string, and installs
 * its own fake localStorage on globalThis first.
 *
 * Run: node --test tests/leaderboard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE_URL = new URL('../js/leaderboard.js', import.meta.url).href;
let instance = 0;

/** Import a pristine copy of the module (no shared in-memory state). */
async function freshModule() {
  instance += 1;
  return import(`${MODULE_URL}?instance=${instance}`);
}

/** Minimal in-memory localStorage stand-in. */
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    get length() {
      return map.size;
    },
    _map: map,
  };
}

/** A localStorage that blows up on every access, as in hardened private mode. */
function makeThrowingStorage() {
  const boom = () => {
    throw new DOMExceptionLike('SecurityError: storage is disabled');
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, length: 0 };
}

class DOMExceptionLike extends Error {}

/** Install a storage (or nothing) for the duration of one test. */
function useStorage(t, storage) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = had ? globalThis.localStorage : undefined;
  if (storage === undefined) {
    delete globalThis.localStorage;
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
  t.after(() => {
    if (had) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete globalThis.localStorage;
    }
  });
  return storage;
}

/** Build an ISO string from local wall-clock parts, so tests are TZ-agnostic. */
function localIso(y, m, d, hh = 0, mm = 0) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

const iso = (n) => `2026-01-${String(n).padStart(2, '0')}T10:00:00.000Z`;

/* ------------------------------------------------------------------ */

test('loadScores returns an empty array when storage is empty', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  const list = lb.loadScores();
  assert.deepEqual(list, []);
  assert.equal(Array.isArray(list), true);
});

test('STORAGE_KEY is the contracted key and is what gets written', async (t) => {
  const store = useStorage(t, makeStorage());
  const lb = await freshModule();

  assert.equal(lb.STORAGE_KEY, 'orange-tetris.scores.v1');
  lb.saveScore({ score: 500, lines: 5, level: 1 }, iso(1));
  assert.equal(store._map.has('orange-tetris.scores.v1'), true);
  assert.deepEqual(JSON.parse(store.getItem(lb.STORAGE_KEY)), [
    { score: 500, lines: 5, level: 1, date: iso(1) },
  ]);
});

test('saveScore inserts in score-descending order', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  lb.saveScore({ score: 1200, lines: 12, level: 2 }, iso(1));
  lb.saveScore({ score: 300, lines: 3, level: 1 }, iso(2));
  const returned = lb.saveScore({ score: 5000, lines: 40, level: 5 }, iso(3));

  assert.deepEqual(returned.map((e) => e.score), [5000, 1200, 300]);
  assert.deepEqual(lb.loadScores().map((e) => e.score), [5000, 1200, 300]);
  // Companion fields travel with the score.
  assert.deepEqual(lb.loadScores()[0], {
    score: 5000,
    lines: 40,
    level: 5,
    date: iso(3),
  });
});

test('the list is capped at 10 entries and the lowest score is dropped', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  // 100, 200, ... 1000 (ten entries), then an eleventh that beats the lowest.
  for (let i = 1; i <= 10; i += 1) {
    lb.saveScore({ score: i * 100, lines: i, level: 1 }, iso(i));
  }
  assert.equal(lb.loadScores().length, 10);

  const list = lb.saveScore({ score: 150, lines: 1, level: 1 }, iso(11));
  assert.equal(list.length, 10);
  assert.deepEqual(
    list.map((e) => e.score),
    [1000, 900, 800, 700, 600, 500, 400, 300, 200, 150],
  );
  assert.equal(list.some((e) => e.score === 100), false, 'lowest score dropped');
  assert.equal(lb.loadScores().length, 10, 'storage never holds more than 10');

  // A score below the cut-off changes nothing.
  const unchanged = lb.saveScore({ score: 10, lines: 0, level: 1 }, iso(12));
  assert.equal(unchanged.length, 10);
  assert.equal(unchanged[9].score, 150);
});

test('ties are broken by the earlier date first', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  lb.saveScore({ score: 900, lines: 9, level: 1 }, iso(5)); // later
  lb.saveScore({ score: 900, lines: 9, level: 1 }, iso(2)); // earlier
  lb.saveScore({ score: 900, lines: 9, level: 1 }, iso(3)); // middle

  assert.deepEqual(
    lb.loadScores().map((e) => e.date),
    [iso(2), iso(3), iso(5)],
  );

  // And a tie at the cap boundary keeps the older entry.
  const store2 = makeStorage();
  useStorage(t, store2);
  const lb2 = await freshModule();
  for (let i = 1; i <= 10; i += 1) {
    lb2.saveScore({ score: 1000, lines: 10, level: 1 }, iso(i));
  }
  const after = lb2.saveScore({ score: 1000, lines: 10, level: 1 }, iso(20));
  assert.equal(after.length, 10);
  assert.equal(after.some((e) => e.date === iso(20)), false, 'newcomer loses the tie');
  assert.equal(after[9].date, iso(10));
});

test('isHighScore is true below the cap and boundary-correct at the cap', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  assert.equal(lb.isHighScore(1), true, 'any positive score enters an empty board');
  assert.equal(lb.isHighScore(0), false, 'zero is never a high score');
  assert.equal(lb.isHighScore(-50), false);
  assert.equal(lb.isHighScore(NaN), false);
  assert.equal(lb.isHighScore(Infinity), false);
  assert.equal(lb.isHighScore(undefined), false);

  for (let i = 1; i <= 9; i += 1) {
    lb.saveScore({ score: i * 100, lines: i, level: 1 }, iso(i));
  }
  assert.equal(lb.loadScores().length, 9);
  assert.equal(lb.isHighScore(1), true, 'board not full yet, anything positive fits');

  lb.saveScore({ score: 1000, lines: 10, level: 1 }, iso(10)); // now exactly 10
  assert.equal(lb.loadScores().length, 10);

  assert.equal(lb.isHighScore(101), true, 'beats the lowest (100)');
  assert.equal(lb.isHighScore(100), false, 'ties the lowest, loses on date');
  assert.equal(lb.isHighScore(99), false, 'below the lowest');
});

test('corrupt or non-array JSON in storage recovers to an empty list', async (t) => {
  const lb1Store = useStorage(t, makeStorage({ 'orange-tetris.scores.v1': '{not json at all' }));
  const lb1 = await freshModule();
  assert.deepEqual(lb1.loadScores(), [], 'unparseable JSON');
  // and it recovers: saving over the corruption works.
  const recovered = lb1.saveScore({ score: 42, lines: 1, level: 1 }, iso(1));
  assert.deepEqual(recovered.map((e) => e.score), [42]);
  assert.deepEqual(JSON.parse(lb1Store.getItem('orange-tetris.scores.v1')).length, 1);

  useStorage(t, makeStorage({ 'orange-tetris.scores.v1': '{"score":100}' }));
  const lb2 = await freshModule();
  assert.deepEqual(lb2.loadScores(), [], 'valid JSON but not an array');

  useStorage(t, makeStorage({ 'orange-tetris.scores.v1': 'null' }));
  const lb3 = await freshModule();
  assert.deepEqual(lb3.loadScores(), [], 'JSON null');

  // Junk entries inside a real array are discarded, good ones survive.
  const junk = JSON.stringify([
    { score: 500, lines: 5, level: 1, date: iso(1) },
    { score: 'NaN', lines: 1, level: 1, date: iso(2) },
    { score: null, lines: 1, level: 1, date: iso(2) },
    { score: 700, lines: 7, level: 2 }, // missing date
    { score: 800, level: 2, date: iso(3) }, // missing lines
    { lines: 1, level: 1, date: iso(4) }, // missing score
    'nonsense',
    null,
    42,
    [],
    { score: 300, lines: 3, level: 1, date: iso(5) },
  ]);
  useStorage(t, makeStorage({ 'orange-tetris.scores.v1': junk }));
  const lb4 = await freshModule();
  assert.deepEqual(lb4.loadScores(), [
    { score: 500, lines: 5, level: 1, date: iso(1) },
    { score: 300, lines: 3, level: 1, date: iso(5) },
  ]);

  // An over-long stored array is trimmed back to 10 on load.
  const tooMany = JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({
      score: (i + 1) * 10,
      lines: i,
      level: 1,
      date: iso((i % 28) + 1),
    })),
  );
  useStorage(t, makeStorage({ 'orange-tetris.scores.v1': tooMany }));
  const lb5 = await freshModule();
  assert.equal(lb5.loadScores().length, 10);
  assert.equal(lb5.loadScores()[0].score, 250);
});

test('a throwing localStorage degrades to memory and never throws', async (t) => {
  useStorage(t, makeThrowingStorage());
  const lb = await freshModule();

  assert.doesNotThrow(() => lb.loadScores());
  assert.deepEqual(lb.loadScores(), []);

  let list;
  assert.doesNotThrow(() => {
    list = lb.saveScore({ score: 400, lines: 4, level: 1 }, iso(2));
  });
  assert.deepEqual(list, [{ score: 400, lines: 4, level: 1, date: iso(2) }]);

  // The in-memory list keeps working across calls.
  lb.saveScore({ score: 900, lines: 9, level: 2 }, iso(1));
  assert.deepEqual(lb.loadScores().map((e) => e.score), [900, 400]);
  assert.equal(lb.isHighScore(500), true);
  assert.equal(lb.isHighScore(0), false);
  assert.doesNotThrow(() => lb.clearScores());
  assert.deepEqual(lb.loadScores(), []);
});

test('a missing localStorage degrades to memory and never throws', async (t) => {
  useStorage(t, undefined);
  const lb = await freshModule();

  assert.equal('localStorage' in globalThis, false);
  assert.deepEqual(lb.loadScores(), []);
  const list = lb.saveScore({ score: 250, lines: 2, level: 1 }, iso(4));
  assert.deepEqual(list.map((e) => e.score), [250]);
  assert.deepEqual(lb.loadScores().map((e) => e.score), [250]);
  lb.clearScores();
  assert.deepEqual(lb.loadScores(), []);
});

test('clearScores empties both storage and the returned list', async (t) => {
  const store = useStorage(t, makeStorage());
  const lb = await freshModule();

  lb.saveScore({ score: 700, lines: 7, level: 2 }, iso(1));
  assert.equal(lb.loadScores().length, 1);

  lb.clearScores();
  assert.deepEqual(lb.loadScores(), []);
  assert.equal(store.getItem(lb.STORAGE_KEY), null);
});

test('saveScore defaults its timestamp to now when none is injected', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  const before = Date.now();
  const [entry] = lb.saveScore({ score: 111, lines: 1, level: 1 });
  const after = Date.now();

  assert.equal(typeof entry.date, 'string');
  const stamped = Date.parse(entry.date);
  assert.equal(Number.isFinite(stamped), true);
  assert.ok(stamped >= before - 1000 && stamped <= after + 1000);
});

test('the returned list is a copy, mutating it does not corrupt the store', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  const list = lb.saveScore({ score: 600, lines: 6, level: 2 }, iso(1));
  list[0].score = 999999;
  list.push({ score: 1, lines: 1, level: 1, date: iso(2) });

  assert.deepEqual(lb.loadScores(), [
    { score: 600, lines: 6, level: 2, date: iso(1) },
  ]);
});

test('formatDate renders DD/MM/YYYY HH:mm in local time', async (t) => {
  useStorage(t, makeStorage());
  const lb = await freshModule();

  // Built from local wall-clock parts, so the expectation holds in any timezone.
  assert.equal(lb.formatDate(localIso(2026, 1, 5, 7, 9)), '05/01/2026 07:09');
  assert.equal(lb.formatDate(localIso(2026, 12, 31, 23, 59)), '31/12/2026 23:59');
  assert.equal(lb.formatDate(localIso(2026, 9, 8, 0, 0)), '08/09/2026 00:00');
  assert.match(lb.formatDate(iso(3)), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

  // Invalid or absent input renders a dash.
  assert.equal(lb.formatDate('not a date'), '-');
  assert.equal(lb.formatDate(''), '-');
  assert.equal(lb.formatDate('   '), '-');
  assert.equal(lb.formatDate(undefined), '-');
  assert.equal(lb.formatDate(null), '-');
  assert.equal(lb.formatDate(12345), '-');
  assert.equal(lb.formatDate({}), '-');
});
