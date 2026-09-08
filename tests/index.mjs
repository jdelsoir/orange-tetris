/**
 * Directory entry point for the test suite.
 *
 * Node 24's test runner treats every positional argument as a file, so
 * `node --test tests/` hands the *directory* to the child process. Node then
 * resolves the directory through this package.json/index.mjs pair, and this
 * module loads every `*.test.mjs` sitting next to it. Result: `node --test
 * tests/`, `node --test "tests/*.test.mjs"` and a bare `node --test` all run
 * the same suite. Nothing here is part of the game: no npm dependency, no
 * build step, and this folder is never shipped to GitHub Pages.
 */
import { readdirSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of files) {
  await import(new URL(name, here).href);
}
