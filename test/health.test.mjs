import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.mjs';

test('health reports the app and Codespace without requesting external schedule data', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'schedule-health-'));
  const getHololive = t.mock.fn();
  const { server } = createApp({ file: join(dataDir, 'schedule.json'), providers: { getHololive } });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previousName = process.env.CODESPACE_NAME;
  t.after(() => {
    if (previousName === undefined) delete process.env.CODESPACE_NAME;
    else process.env.CODESPACE_NAME = previousName;
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/healthz`;

  delete process.env.CODESPACE_NAME;
  const local = await fetch(url);
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await local.json(), { app: 'haishin-biyori', codespace: null });

  process.env.CODESPACE_NAME = 'verified-codespace';
  const remote = await fetch(url);
  assert.equal(remote.status, 200);
  assert.deepEqual(await remote.json(), { app: 'haishin-biyori', codespace: 'verified-codespace' });
  assert.equal(getHololive.mock.callCount(), 0);
});
