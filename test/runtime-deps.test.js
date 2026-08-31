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

test('stable browser fallback ships libmedia ESM assets', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.dependencies?.['@libmedia/avplayer'], '1.3.1');
  const esmDir = path.join(process.cwd(), 'node_modules', '@libmedia', 'avplayer', 'dist', 'esm');
  const entry = path.join(esmDir, 'avplayer.js');
  assert.ok(fs.existsSync(entry), 'libmedia AVPlayer ESM entry must exist after npm install');
  assert.ok(fs.statSync(entry).size > 1000, 'libmedia browser entry should not be empty');
});
