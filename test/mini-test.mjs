// Mini-framework de test sans dépendance (Node ≥ 18).
import { isDeepStrictEqual, inspect } from 'node:util';

let pass = 0;
let fail = 0;

export function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

export function eq(actual, expected, msg = '') {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${msg} attendu ${inspect(expected)}, obtenu ${inspect(actual)}`);
  }
}

export function ok(cond, msg = 'assertion') {
  if (!cond) throw new Error(msg);
}

export function done() {
  console.log(`\n${pass} ok, ${fail} échec(s)`);
  if (fail) process.exitCode = 1;
}
