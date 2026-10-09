'use strict';

const MAX_NESTING_DEPTH = 128;

const assertNestingDepth = depth => {
  if (depth > MAX_NESTING_DEPTH) {
    throw new RangeError(`brace nesting depth exceeds the security limit of ${MAX_NESTING_DEPTH}`);
  }
};

const validateAst = ast => {
  const stack = [{ node: ast, depth: 0 }];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    assertNestingDepth(current.depth);

    const node = current.node;
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue;
    }

    seen.add(node);
    if (!Array.isArray(node.nodes)) {
      continue;
    }

    for (let index = node.nodes.length - 1; index >= 0; index--) {
      stack.push({ node: node.nodes[index], depth: current.depth + 1 });
    }
  }

  return ast;
};

module.exports = {
  MAX_NESTING_DEPTH,
  assertNestingDepth,
  validateAst
};
