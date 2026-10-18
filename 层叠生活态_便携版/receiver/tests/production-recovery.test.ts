import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson } from '../src/atomic-file.js';
import { pythonRuntime } from '../src/python-runtime.js';
import { BuildingProduction } from '../src/building-production.js';

test('transient Windows replacement errors retry without exposing partial JSON', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.TEMP || tmpdir(), 'atomic-json-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); await atomicJson(file, { version: 1 });
  const rename = fs.rename.bind(fs); let calls = 0;
  t.mock.method(fs, 'rename', async (source: string, destination: string) => {
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1 });
    if (calls++ < 3) throw Object.assign(new Error('Windows sharing violation'), { code: ['EPERM', 'EBUSY', 'EACCES'][calls - 1] });
    return rename(source, destination);
  });
  await atomicJson(file, { version: 2 });
  assert.equal(calls, 4); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 2 });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('permanent failure preserves last valid state and cleans its temporary file', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.TEMP || tmpdir(), 'atomic-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json'); await atomicJson(file, { saved: true });
  let calls = 0;
  t.mock.method(fs, 'rename', async () => { calls++; throw Object.assign(new Error('bad destination'), { code: 'EIO' }); });
  await assert.rejects(atomicJson(file, { saved: false }), { code: 'EIO' });
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { saved: true });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('portable Python runs Rodin dependencies without a system Python installation', async t => {
  const prior = process.env.PYTHON_EXE; delete process.env.PYTHON_EXE;
  t.after(() => { if (prior === undefined) delete process.env.PYTHON_EXE; else process.env.PYTHON_EXE = prior; });
  const root = path.resolve(import.meta.dirname, '../../..');
  const executable = await pythonRuntime(root);
  assert.equal(executable, path.join(root, 'hardware/runtime/python.exe'));
  const { stdout } = await promisify(execFile)(executable, ['-c', 'import sqlite3,ssl,urllib.request; print("ready")'], { windowsHide: true });
  assert.equal(stdout.trim(), 'ready');
});

test('a failed worker cannot finish the run while siblings still generate', async () => {
  const job = new BuildingProduction({} as any, {} as any, null, null) as any;
  const state = { status: 'analyzing', photos: [], objects: [0,1,2].map(i => ({ objectId: String(i), photoId: String(i), status: 'pending' })) };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false, siblings = 0;
  job.plan = async () => state; job.workspace = async () => ({ annotations: {} });
  job.photos = () => [0,1,2].map(i => ({ imageId: String(i), processedPath: '' }));
  job.read = async () => state;
  job.update = async (_id: string, mutate: (s: any) => void) => { mutate(state); return state; };
  job.generate = async (_id: string, object: any) => { if (object.objectId === '0') throw new Error('write blocked'); await gate; siblings++; };
  const run = job.run('test').then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished, false); release(); await run;
  assert.equal(siblings, 2); assert.equal(state.status, 'failed');
});
