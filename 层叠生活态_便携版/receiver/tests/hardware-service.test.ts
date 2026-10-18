import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isHardwareService, startHardwareService } from '../src/hardware-service.js';
import { hardwareCall, hardwareOrigin } from '../src/hardware-proxy.js';

test('hardware identity requires the bridge marker, not just HTTP 200', async t => {
  let body = { service: 'another-app' };
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal(await isHardwareService(origin), false);
  body = { service: 'layered-life-serial' };
  assert.equal(await isHardwareService(origin), true);
});

test('proxy distinguishes a foreign service from invalid serial selection', async t => {
  const prior = process.env.HARDWARE_BASE_URL;
  process.env.HARDWARE_BASE_URL = 'http://127.0.0.1:8765';
  t.after(() => { if (prior === undefined) delete process.env.HARDWARE_BASE_URL; else process.env.HARDWARE_BASE_URL = prior; });
  let status = 404;
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status }));
  await assert.rejects(hardwareCall('/api/ports'), { code: 'HARDWARE_WRONG_SERVICE', status: 503 });
  status = 403;
  await assert.rejects(hardwareCall('/api/connection', { enabled: true }), { code: 'HARDWARE_FORBIDDEN' });
  status = 400;
  await assert.rejects(hardwareCall('/api/connection', { enabled: true, port: 'COM999' }), { code: 'HARDWARE_INVALID_REQUEST' });
});

test('occupied default port falls back to a ready Python bridge; POST and stream use its port', async t => {
  const root = path.resolve(import.meta.dirname, import.meta.dirname.endsWith(path.join('dist', 'tests')) ? '../../..' : '../..');
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'serial-bridge-'));
  const prior = process.env.HARDWARE_BASE_URL, priorEnabled = process.env.RECEIVER_HARDWARE;
  delete process.env.HARDWARE_BASE_URL; delete process.env.RECEIVER_HARDWARE;
  let stop = () => {};
  t.after(async () => {
    stop();
    if (prior === undefined) delete process.env.HARDWARE_BASE_URL; else process.env.HARDWARE_BASE_URL = prior;
    if (priorEnabled === undefined) delete process.env.RECEIVER_HARDWARE; else process.env.RECEIVER_HARDWARE = priorEnabled;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await fs.mkdir(path.join(dir, 'hardware/dashboard'), { recursive: true });
  await fs.symlink(path.join(root, 'hardware/runtime'), path.join(dir, 'hardware/runtime'), 'junction');
  // Exercise the real HTTP handler without opening a physical device or writing settings.
  await fs.writeFile(path.join(dir, 'hardware/dashboard/server.py'), `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(root, 'hardware/dashboard'))})\nfrom server import BridgeServer, Handler\ns = BridgeServer(('127.0.0.1', 0), Handler)\nprint(json.dumps(dict(service='layered-life-serial', port=s.server_port)), flush=True)\ns.serve_forever()\n`);
  const realFetch = globalThis.fetch;
  let foreignRequests = 0;
  t.mock.method(globalThis, 'fetch', (input: any, init?: any) => {
    if (String(input).startsWith('http://127.0.0.1:8765/')) {
      foreignRequests++;
      return Promise.resolve(new Response('{"service":"unrelated-app"}', { status: 200 }));
    }
    return realFetch(input, init);
  });
  stop = await startHardwareService(dir);
  assert.notEqual(hardwareOrigin(), 'http://127.0.0.1:8765');
  assert.equal((await hardwareCall('/api/state')).service, 'layered-life-serial');
  assert.ok(Array.isArray(await hardwareCall('/api/ports')));
  assert.deepEqual(await hardwareCall('/api/connection', { enabled: false }), { ok: true });
  assert.equal((await hardwareCall('/api/state')).control.enabled, false);
  await assert.rejects(hardwareCall('/api/connection', { enabled: true, port: 'COM999999' }), { code: 'HARDWARE_INVALID_REQUEST' });
  const rejected = await realFetch(hardwareOrigin() + '/api/connection', { method: 'POST', body: '{"enabled":false}', headers: { Origin: 'http://untrusted.invalid', 'X-GPIO-UI': '1' } });
  assert.equal(rejected.status, 403);
  const stream = await realFetch(hardwareOrigin() + '/api/stream', { signal: AbortSignal.timeout(2000) });
  const reader = stream.body!.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /data:.*layered-life-serial/);
  await reader.cancel();
  assert.equal(foreignRequests, 1, 'only the discovery probe reaches the occupied port');
});
