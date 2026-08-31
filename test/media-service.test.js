const test = require('node:test');
const assert = require('node:assert/strict');
const { MediaService } = require('../src/media-service');

test('media service filters unsupported files while keeping folders', async () => {
  const service = new MediaService({ webdav: () => ({}) });
  service.currentWebDav = () => ({
    list: async () => ({
      relativePath: 'Movies',
      items: [
        { name: 'Season', relativePath: 'Movies/Season', isDir: true },
        { name: 'video.mp4', relativePath: 'Movies/video.mp4', isDir: false },
        { name: 'notes.txt', relativePath: 'Movies/notes.txt', isDir: false },
      ],
    }),
  });

  const result = await service.list('Movies');
  assert.equal(result.path, 'Movies');
  assert.deepEqual(result.items.map((item) => item.name), ['Season', 'video.mp4']);
  assert.deepEqual(result.items.map((item) => item.path), ['Movies/Season', 'Movies/video.mp4']);
});

test('playable URL resolution is cached for the configured TTL', async () => {
  let calls = 0;
  const service = new MediaService({ webdav: () => ({}) }, { cacheTtlMs: 60_000 });
  service.currentWebDav = () => ({
    resolvePlayable: async () => {
      calls += 1;
      return { url: 'https://cdn.example.test/video.mp4', strategy: 'test' };
    },
  });

  const first = await service.resolvePlayable('video.mp4');
  const second = await service.resolvePlayable('video.mp4');
  assert.equal(calls, 1);
  assert.deepEqual(second, first);

  service.clearCache();
  await service.resolvePlayable('video.mp4');
  assert.equal(calls, 2);
});

test('media descriptors keep browser-facing MIME decisions centralized', () => {
  const service = new MediaService({ webdav: () => ({}) });
  assert.equal(service.isSupportedPath('movie.mp4'), true);
  assert.equal(service.isSupportedPath('movie.txt'), false);
  assert.deepEqual(service.descriptor('movie.mp4'), {
    extension: '.mp4',
    expectedMime: 'video/mp4',
    mobilePreferred: true,
  });
});
