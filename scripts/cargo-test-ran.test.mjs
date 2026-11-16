import test from 'node:test';
import assert from 'node:assert/strict';
import { ranAndPassed } from './cargo-test-ran.mjs';

const passed = 'running 1 test\ntest recorded_kit_kick_pairs ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 22 filtered out; finished in 1.45s\n';
const nothing = 'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.00s\n';

test('a_filter_that_matches_nothing_is_not_a_pass', () => {
  assert.equal(ranAndPassed(passed, 'recorded_kit_kick_pairs'), true);
  assert.equal(ranAndPassed(nothing, 'recorded_kit_kick_pairs'), false);
  // Another test passing is not this one passing, and a failure is not a pass.
  assert.equal(ranAndPassed(passed, 'recorded_kit_kick'), false);
  assert.equal(ranAndPassed(passed.replace('... ok', '... FAILED').replace('ok. 1 passed; 0 failed', 'FAILED. 0 passed; 1 failed'), 'recorded_kit_kick_pairs'), false);
  // Windows line endings.
  assert.equal(ranAndPassed(passed.replaceAll('\n', '\r\n'), 'recorded_kit_kick_pairs'), true);
});
