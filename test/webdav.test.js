const test = require('node:test');
const assert = require('node:assert/strict');
const { WebDavClient, cleanRelative } = require('../src/webdav');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/webdav/Movies/</d:href>
    <d:propstat><d:prop><d:displayname>Movies</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/webdav/Movies/Show/</d:href>
    <d:propstat><d:prop><d:displayname>Show</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/webdav/Movies/E01.mp4</d:href>
    <d:propstat><d:prop><d:displayname>E01.mp4</d:displayname><d:resourcetype/><d:getcontentlength>12345</d:getcontentlength><d:getcontenttype>video/mp4</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

test('relative paths reject traversal', () => {
  assert.throws(() => cleanRelative('../secret.mp4'));
  assert.equal(cleanRelative('/A/B.mp4'), 'A/B.mp4');
});

test('WebDAV PROPFIND parses folders and video metadata', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    assert.equal(options.method, 'PROPFIND');
    assert.match(options.headers.Authorization, /^Basic /);
    return new Response(XML, { status: 207, headers: { 'content-type': 'application/xml' } });
  };

  const client = new WebDavClient({
    url: 'https://webdav.example.com/webdav',
    username: 'user@example.com',
    password: 'app-pass',
    root: '/Movies',
  });
  const result = await client.list('');
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => [item.name, item.isDir]), [['Show', true], ['E01.mp4', false]]);
  assert.equal(result.items[1].relativePath, 'E01.mp4');
  assert.equal(result.items[1].size, 12345);
});

test('123pan trusted WebDAV redirect keeps Basic auth and PROPFIND method', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.method, 'PROPFIND');
    assert.equal(options.redirect, 'manual');
    assert.match(options.headers.Authorization, /^Basic /);

    if (requests.length === 1) {
      return new Response(null, {
        status: 307,
        headers: { location: 'https://webdav-demo.pd1.123pan.cn/webdav' },
      });
    }
    return new Response(XML, { status: 207, headers: { 'content-type': 'application/xml' } });
  };

  const client = new WebDavClient({
    url: 'https://webdav.123pan.cn/webdav',
    username: 'example-user',
    password: 'example-app-password',
    root: '/',
  });

  const result = await client.test();
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).hostname, 'webdav-demo.pd1.123pan.cn');
});

test('WebDAV auth is not forwarded to an unrelated redirect host', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (_url, options) => {
    assert.match(options.headers.Authorization, /^Basic /);
    return new Response(null, {
      status: 307,
      headers: { location: 'https://evil.example.net/webdav' },
    });
  };

  const client = new WebDavClient({
    url: 'https://webdav.123pan.cn/webdav',
    username: 'example-user',
    password: 'example-app-password',
    root: '/',
  });

  await assert.rejects(
    () => client.test(),
    (error) => error.code === 'WEBDAV_UNTRUSTED_AUTH_REDIRECT' && error.status === 409,
  );
});

test('authenticated playback returns provider redirect without exposing credentials', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.match(options.headers.Authorization, /^Basic /);
    return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/signed/video.mp4' } });
  };

  const client = new WebDavClient({
    url: 'https://webdav.example.com/webdav',
    username: 'user@example.com',
    password: 'app-pass',
    root: '/Movies',
  });
  const result = await client.resolvePlayable('Show/E01.mp4');
  assert.equal(result.url, 'https://cdn.example.com/signed/video.mp4');
  assert.equal(result.strategy, 'webdav-redirect');
  assert.equal(result.url.includes('user@example.com'), false);
  assert.equal(result.url.includes('app-pass'), false);
});

test('authenticated WebDAV without a redirect is rejected instead of proxied', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200 });
    return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/100' } });
  };

  const client = new WebDavClient({
    url: 'https://webdav.example.com/webdav',
    username: 'u',
    password: 'p',
    root: '/',
  });
  await assert.rejects(
    () => client.resolvePlayable('video.mp4'),
    (error) => error.code === 'WEBDAV_NO_BROWSER_DIRECT_URL' && error.status === 409,
  );
});
