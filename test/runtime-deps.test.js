const test = require('node:test');
const assert = require('node:assert/strict');

const RUNTIME_DEPENDENCIES = [
  'express',
  'compression',
  'cookie-session',
  'fast-xml-parser',
  'helmet',
  'socket.io',
];

test('all server runtime dependencies are declared and resolvable', () => {
  const pkg = require('../package.json');
  for (const name of RUNTIME_DEPENDENCIES) {
    assert.ok(pkg.dependencies?.[name], `${name} must be declared in dependencies`);
    assert.doesNotThrow(() => require.resolve(name), `${name} must be installed`);
  }
});
