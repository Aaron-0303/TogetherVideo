const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_RUNTIME_DEPENDENCIES = [
  'express',
  'compression',
  'cookie-session',
  'fast-xml-parser',
  'helmet',
  'socket.io',
];

test('all server runtime dependencies are declared and resolvable', () => {
  const pkg = require('../package.json');
  for (const name of SERVER_RUNTIME_DEPENDENCIES) {
    assert.ok(pkg.dependencies?.[name], `${name} must be declared in dependencies`);
    assert.doesNotThrow(() => require.resolve(name), `${name} must be installed`);
  }
});

test('3.2.5 ships the ArtPlayer browser distribution locally', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies?.artplayer, '5.4.0');
  const distDir = path.join(process.cwd(), 'node_modules', 'artplayer', 'dist');
  const entry = path.join(distDir, 'artplayer.js');
  assert.ok(fs.existsSync(entry), 'ArtPlayer browser entry must exist after npm install');
  assert.ok(fs.statSync(entry).size > 10_000, 'ArtPlayer browser entry should not be empty');
});
