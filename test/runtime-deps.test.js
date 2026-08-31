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

test('2.1 HEVC fallback dependency ships browser ESM assets', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.dependencies?.['@libmedia/avplayer'], '@libmedia/avplayer must be declared in dependencies');

  const esmDir = path.join(
    process.cwd(),
    'node_modules',
    '@libmedia',
    'avplayer',
    'dist',
    'esm',
  );
  const entry = path.join(esmDir, 'avplayer.js');
  assert.ok(fs.existsSync(entry), 'libmedia AVPlayer ESM entry must exist after npm install');

  const files = fs.readdirSync(esmDir).filter((name) => name.endsWith('.js'));
  const chunks = files.filter((name) => /^\d+\.avplayer\.js$/.test(name));
  assert.ok(chunks.length > 0, 'libmedia dynamic AVPlayer chunks must be installed beside avplayer.js');

  // TogetherVideo serves this prebuilt ESM directory directly to browsers. A
  // bare npm specifier such as @libmedia/avutil would require an import map or a
  // bundler, neither of which is part of the zero-build deployment model.
  for (const name of files) {
    const source = fs.readFileSync(path.join(esmDir, name), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:\bfrom\s*|\bimport\s*\()\s*['"]@libmedia\//,
      `${name} must not contain bare @libmedia imports`,
    );
  }
});
