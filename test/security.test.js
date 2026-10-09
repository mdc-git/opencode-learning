'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const braces = require('../index');

test('preserves normal compile and expansion behavior', () => {
  assert.deepEqual(braces('{a,b}'), ['(a|b)']);
  assert.deepEqual(braces.expand('{a,b}'), ['a', 'b']);
  assert.deepEqual(braces('file-{1..3}.js'), ['file-([1-3]).js']);
});

test('rejects excessively nested brace input before recursive processing', () => {
  const input = '{'.repeat(129) + 'a,b' + '}'.repeat(129);
  assert.throws(() => braces(input), {
    name: 'RangeError',
    message: /nesting depth exceeds/
  });
});

test('rejects excessively nested externally supplied ASTs', () => {
  const root = { type: 'root', nodes: [] };
  let current = root;

  for (let depth = 0; depth < 129; depth++) {
    const child = { type: 'brace', nodes: [] };
    current.nodes.push(child);
    current = child;
  }

  assert.throws(() => braces.compile(root), {
    name: 'RangeError',
    message: /nesting depth exceeds/
  });
});

test('rejects deeply nested expansion arrays without recursive stack exhaustion', () => {
  const utils = require('../lib/utils');
  let nested = 'value';

  for (let depth = 0; depth < 129; depth++) {
    nested = [nested];
  }

  assert.throws(() => utils.flatten(nested), {
    name: 'RangeError',
    message: /nesting depth exceeds/
  });
});
