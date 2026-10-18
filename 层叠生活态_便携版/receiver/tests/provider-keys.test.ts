import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import http from 'node:http';
import { readProviderKeys, saveProviderKeys, providerKeysPath, registerProviderKeys } from '../src/provider-keys.js';

const blank = { DEEPSEEK_API_KEY: '', RODIN_API_KEY: '', QWEN_API_KEY: '' };
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'provider-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('missing file initializes empty keys; saving replaces keys and blanks preserve them', async t => {
  const root = await fixture(t);
  assert.deepEqual(readProviderKeys(root), blank);
  saveProviderKeys(root, { ...blank, DEEPSEEK_API_KEY: 'test-first', RODIN_API_KEY: 'test-rodin' });
  saveProviderKeys(root, { ...blank, DEEPSEEK_API_KEY: 'test-replacement' });
  assert.deepEqual(readProviderKeys(root), { ...blank, DEEPSEEK_API_KEY: 'test-replacement', RODIN_API_KEY: 'test-rodin' });
  assert.deepEqual(await fs.readdir(path.dirname(providerKeysPath(root))), ['api-keys.json']);
});

test('invalid submissions and corrupt files never overwrite stored keys or expose content', async t => {
  const root = await fixture(t);
  saveProviderKeys(root, { ...blank, QWEN_API_KEY: 'test-kept' });
  for (const input of [null, [], {}, { ...blank, RODIN_API_KEY: 123 }, { ...blank, QWEN_API_KEY: 'bad\nkey' }, { ...blank, extra: 'x' }]) {
    assert.throws(() => saveProviderKeys(root, input), /INVALID_KEYS/);
  }
  assert.equal(readProviderKeys(root).QWEN_API_KEY, 'test-kept');
  await fs.writeFile(providerKeysPath(root), '{secret-fragment');
  assert.throws(() => readProviderKeys(root), /^Error: KEY_FILE_INVALID$/);
  assert.equal(await fs.readFile(providerKeysPath(root), 'utf8'), '{secret-fragment');
});

test('settings HTTP only returns status, rejects cross-origin writes and conceals parser errors', async t => {
  const root = await fixture(t), app = express();
  app.use(express.json());
  registerProviderKeys(app, root);
  app.use(express.static(path.join(root, 'public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (originHeader: string, body: string) => fetch(`${origin}/api/provider-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: originHeader }, body });
  const saved = await post(origin, JSON.stringify({ ...blank, RODIN_API_KEY: 'test-private-value' }));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { configured: { DEEPSEEK_API_KEY: false, RODIN_API_KEY: true, QWEN_API_KEY: false } });
  const fetched = await fetch(`${origin}/api/provider-keys`);
  assert.equal(fetched.headers.get('cache-control'), 'no-store');
  assert.equal((await fetched.text()).includes('test-private-value'), false);
  assert.equal((await post('https://outside.invalid', JSON.stringify(blank))).status, 403);
  const malformed = await post(origin, '{"test-private-value":');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes('test-private-value'), false);
  assert.equal((await fetch(`${origin}/.local/api-keys.json`)).status, 404);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(`${origin}/api/provider-keys`, { headers: { Host: 'outside.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(readProviderKeys(root).RODIN_API_KEY, 'test-private-value');
});
