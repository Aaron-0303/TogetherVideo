const test = require('node:test');
const assert = require('node:assert/strict');
const { WebDavClient, normalizeRelative } = require('../src/webdav');

test('WebDAV direct URL points to provider and contains Basic credentials', () => {
  const client = new WebDavClient({ url: 'https://webdav.example.com/webdav', username: 'user@example.com', password: 'app-pass', root: '/Movies' });
  const url = new URL(client.directUrl('Show/E01.mp4'));
  assert.equal(url.hostname, 'webdav.example.com');
  assert.equal(decodeURIComponent(url.pathname), '/webdav/Movies/Show/E01.mp4');
  assert.equal(decodeURIComponent(url.username), 'user@example.com');
  assert.equal(decodeURIComponent(url.password), 'app-pass');
});

test('relative paths reject traversal', () => {
  assert.throws(() => normalizeRelative('../secret.mp4'));
  assert.equal(normalizeRelative('/A/B.mp4'), 'A/B.mp4');
});
