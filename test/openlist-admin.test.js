const test = require('node:test');
const assert = require('node:assert/strict');
const OpenListAdmin = require('../src/openlist-admin');

test('admin request does not replay a non-authentication failure', async () => {
  const admin = new OpenListAdmin({ baseUrl: 'http://127.0.0.1:5244', password: 'secret' });
  admin.token = 'token';
  let rawCalls = 0;
  let loginCalls = 0;
  admin.raw = async () => {
    rawCalls++;
    const error = new Error('storage update failed');
    error.status = 500;
    throw error;
  };
  admin.login = async () => { loginCalls++; admin.token = 'new-token'; return admin.token; };

  await assert.rejects(admin.request('/api/admin/storage/create', { method: 'POST', body: {} }), /storage update failed/);
  assert.equal(rawCalls, 1);
  assert.equal(loginCalls, 0);
});

test('admin request logs in again and retries once on a 401', async () => {
  const admin = new OpenListAdmin({ baseUrl: 'http://127.0.0.1:5244', password: 'secret' });
  admin.token = 'expired-token';
  let rawCalls = 0;
  let loginCalls = 0;
  admin.raw = async () => {
    rawCalls++;
    if (rawCalls === 1) {
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }
    return { ok: true };
  };
  admin.login = async () => { loginCalls++; admin.token = 'fresh-token'; return admin.token; };

  const result = await admin.request('/api/admin/storage/list');
  assert.deepEqual(result, { ok: true });
  assert.equal(rawCalls, 2);
  assert.equal(loginCalls, 1);
});