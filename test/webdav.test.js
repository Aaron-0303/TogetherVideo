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

const XML_123PAN_ROOT = `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/webdav/</D:href><D:propstat><D:prop><D:displayname>TV</D:displayname><D:getlastmodified>Mon, 31 Aug 2026 01:16:58 GMT</D:getlastmodified><D:creationdate>Mon, 31 Aug 2026 01:16:58 GMT</D:creationdate><D:supportedlock><D:lockentry xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

test('relative paths reject traversal', () => {
  assert.throws(() => cleanRelative('../secret.mp4'));
  assert.equal(cleanRelative('/A/B.mp4'), 'A/B.mp4');
});

test('WebDAV PROPFIND parses folders and video metadata', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'PROPFIND');
    assert.match(options.headers.Authorization, /^Basic /);
    assert.equal(options.headers.Depth, '1');
    assert.equal(options.body, undefined);
    assert.equal(String(url).endsWith('/'), true);
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

test('123pan root PROPFIND mirrors the proven curl request and parses TV', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://webdav.123pan.cn/webdav/');
    assert.equal(options.method, 'PROPFIND');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Depth, '0');
    assert.match(options.headers.Authorization, /^Basic /);
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body, undefined);
    return new Response(XML_123PAN_ROOT, {
      status: 207,
      headers: { 'content-type': 'text/xml; charset=utf-8' },
    });
  };

  const client = new WebDavClient({
    url: 'https://webdav.123pan.cn/webdav',
    username: 'example-user',
    password: 'example-app-password',
    root: '/',
  });

  const result = await client.test();
  assert.equal(result.ok, true);
  assert.equal(result.displayName, 'TV');
  assert.equal(result.url, 'https://webdav.123pan.cn/webdav/');
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
        headers: { location: 'https://webdav-demo.pd1.123pan.cn/webdav/' },
      });
    }
    return new Response(XML_123PAN_ROOT, { status: 207, headers: { 'content-type': 'text/xml' } });
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
      headers: { location: 'https://evil.example.net/webdav/' },
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

test('authenticated playback resolves and verifies the final anonymous provider URL', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.redirect, 'manual');
    if (requests.length === 1) {
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/signed/video.mp4' } });
    }
    assert.equal(options.headers.Authorization, undefined);
    return new Response(null, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' },
    });
  };

  const client = new WebDavClient({
    url: 'https://webdav.example.com/webdav',
    username: 'user@example.com',
    password: 'app-pass',
    root: '/Movies',
  });
  const result = await client.resolvePlayable('Show/E01.mp4');
  assert.equal(result.url, 'https://cdn.example.com/signed/video.mp4');
  assert.equal(result.strategy, 'webdav-final-direct');
  assert.equal(result.url.includes('user@example.com'), false);
  assert.equal(result.url.includes('app-pass'), false);
  assert.equal(requests.length, 2);
});

test('123pan media chain keeps auth only on trusted WebDAV nodes', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options.headers.Authorization, method: options.method });
    if (requests.length === 1) {
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(null, {
        status: 307,
        headers: { location: 'https://webdav-demo.pd1.123pan.cn/webdav/TV/movie.mp4' },
      });
    }
    if (requests.length === 2) {
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(null, {
        status: 302,
        headers: { location: 'https://download.example-cdn.com/token/movie.mp4' },
      });
    }
    assert.equal(options.headers.Authorization, undefined);
    return new Response(null, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'content-range': 'bytes 0-0/1000000',
      },
    });
  };

  const client = new WebDavClient({
    url: 'https://webdav.123pan.cn/webdav',
    username: 'example-user',
    password: 'example-app-password',
    root: '/',
  });
  const result = await client.resolvePlayable('movie.mp4');
  assert.equal(result.url, 'https://download.example-cdn.com/token/movie.mp4');
  assert.equal(requests.length, 3);
});

test('authenticated WebDAV without an anonymous final URL is rejected instead of proxied', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (_url, options) => {
    const authenticated = Boolean(options.headers.Authorization);
    if (!authenticated) return new Response(null, { status: 401 });
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
