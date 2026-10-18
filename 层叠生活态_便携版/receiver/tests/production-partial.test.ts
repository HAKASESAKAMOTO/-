import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BuildingProduction, type ProductionState } from '../src/building-production.js';
import { PipelineService } from '../src/pipeline-service.js';
import { atomicJson } from '../src/atomic-file.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'partial-building-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = 'partial-test', sessionsDir = path.join(root, 'sessions');
  const dir = path.join(sessionsDir, sessionId);
  await fs.mkdir(path.join(dir, 'production'), { recursive: true });
  await fs.writeFile(path.join(root, 'model.glb'), 'existing-model');
  const images = Array.from({ length: 6 }, (_, i) => ({ imageId: `photo${i}`, index: i + 1, status: 'READY', processedPath: `photo${i}.png` }));
  const annotations = Object.fromEntries(images.map(image => [image.imageId, { photoId: image.imageId, inputVersion: 1, userLabel: image.imageId }]));
  const workspace = { annotations, assets: {} as Record<string, any>, analyses: {}, scene: null as any };
  await atomicJson(path.join(dir, 'workspace.json'), workspace);
  const state: ProductionState = {
    schemaVersion: '1.0', sessionId, status: 'failed', error: 'old batch failure', startedAt: null, updatedAt: '',
    photos: images.map((image, order) => ({ photoId: image.imageId, order, inputVersion: 1, userLabel: image.imageId, analysis: 'ready', aiName: 'AI object', aiReason: null, aiBbox: [0, 0, 1, 1], error: null })),
    objects: images.flatMap((image, floor) => (['user', 'ai'] as const).map(source => ({ objectId: `${image.imageId}:${source}`, photoId: image.imageId, source, floor, label: `${image.imageId}-${source}`, inputVersion: 1, status: 'ready', glb: 'model.glb', error: null, startedAt: null, finishedAt: null }))),
  };
  const config = { projectRoot: root, sessionsDir, dataRoot: root } as any;
  const session = { sessionId, images };
  const imports: string[][] = [];
  const job = new BuildingProduction(config, { get: () => session } as any, null, async current => {
    imports.push(current.objects.filter(object => object.status === 'ready' && object.glb).map(object => object.objectId));
  });
  const file = path.join(dir, 'production/state.json');
  const save = () => atomicJson(file, state);
  return { root, dir, state, job, imports, save, config, session, workspace };
}

test('one rejected model is skipped and the other eleven are imported; restart does not regenerate it', async t => {
  const f = await fixture(t);
  Object.assign(f.state.objects[8], { status: 'pending', glb: null });
  await f.save();
  let calls = 0;
  (f.job as any).crop = async () => { calls++; throw new Error('Provider error: IMAGE_CONTENT_VIOLATION'); };
  const result = await f.job.ensureRunning(f.session.sessionId);
  assert.equal(result.status, 'ready'); assert.equal(result.error, null);
  assert.equal(result.objects[8].status, 'skipped'); assert.equal(result.objects[8].glb, null);
  assert.match(result.objects[8].error!, /IMAGE_CONTENT_VIOLATION/);
  assert.equal(f.imports[0].length, 11);
  assert.equal(f.imports[0].includes(result.objects[8].objectId), false);
  assert.equal((await f.job.ensureRunning(f.session.sessionId)).status, 'ready');
  assert.equal(calls, 1);
});

test('an older failed batch finishes from existing assets without making provider calls', async t => {
  const f = await fixture(t);
  Object.assign(f.state.objects[8], { status: 'failed', glb: null, error: 'original provider rejection' });
  await f.save();
  (f.job as any).generate = async () => assert.fail('must not resubmit a completed batch');
  (f.job as any).analyze = async () => assert.fail('must reuse completed analysis');
  const result = await f.job.ensureRunning(f.session.sessionId);
  assert.equal(result.status, 'ready');
  assert.equal(result.objects[8].status, 'skipped');
  assert.equal(result.objects[8].error, 'original provider rejection');
  assert.equal(f.imports[0].length, 11);
});

test('all models failing never claims that a building was completed', async t => {
  const f = await fixture(t);
  f.state.objects.forEach(object => Object.assign(object, { status: 'pending', glb: null }));
  await f.save();
  (f.job as any).crop = async () => { throw new Error('model unavailable'); };
  const result = await f.job.ensureRunning(f.session.sessionId);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /没有成功生成/);
  assert.equal(result.objects.filter(object => object.status === 'skipped').length, 12);
  assert.equal(f.imports.length, 0);
});

test('analysis failure skips only the AI candidate and still generates the user object', async t => {
  const f = await fixture(t);
  f.state.photos[0].analysis = 'pending';
  f.state.objects.slice(0, 2).forEach(object => Object.assign(object, { status: 'pending', glb: null }));
  await f.save();
  (f.job as any).analyze = async () => { throw new Error('analysis unavailable'); };
  const generated: string[] = [];
  (f.job as any).generate = async (id: string, object: any) => {
    generated.push(object.objectId);
    await (f.job as any).update(id, (state: ProductionState) => Object.assign(state.objects.find(o => o.objectId === object.objectId)!, { status: 'ready', glb: 'model.glb' }));
  };
  const result = await f.job.ensureRunning(f.session.sessionId);
  assert.equal(result.status, 'ready');
  assert.deepEqual(generated, ['photo0:user']);
  assert.equal(result.photos[0].analysis, 'skipped');
  assert.equal(result.objects[1].status, 'skipped');
  assert.equal(f.imports[0].length, 11);
});

test('editing an annotation creates a new plan instead of inheriting the previous skip', async t => {
  const f = await fixture(t);
  Object.assign(f.state.objects[0], { status: 'skipped', glb: null, error: 'old failure' });
  await f.save();
  f.workspace.annotations.photo0.inputVersion = 2;
  await atomicJson(path.join(f.dir, 'workspace.json'), f.workspace);
  const result: ProductionState = await (f.job as any).plan(f.session.sessionId);
  assert.equal(result.objects[0].status, 'pending');
  assert.equal(result.objects[0].inputVersion, 2);
  assert.equal(result.objects[0].error, null);
  assert.equal(result.objects[2].status, 'ready');
});

test('scene export leaves skipped slots empty, never creates replacement proxy objects, and checks versions', async t => {
  const f = await fixture(t);
  f.state.status = 'ready';
  Object.assign(f.state.objects[8], { status: 'skipped', glb: null, error: 'model rejected' });
  await f.save();
  for (const object of f.state.objects.filter(o => o.status === 'ready')) {
    f.workspace.assets[object.objectId] = { ...object, relativePath: 'model.glb', origin: 'generated' };
  }
  const store = { current: () => f.session, read: async () => f.workspace, transaction: async (_id: string, mutate: any) => mutate(f.workspace) };
  const pipeline = new PipelineService({ config: f.config } as any, store as any);
  const template = (pipeline as any).templatePath;
  await fs.mkdir(path.dirname(template), { recursive: true });
  await atomicJson(template, { version: 'test' });
  for (const mode of ['manifest', 'proxy'] as const) {
    const scene = await pipeline.createScene(f.session.sessionId, mode);
    assert.equal(scene.objects.length, 12, 'retain six paired floor slots');
    assert.equal(scene.objects[8].skipped, true);
    assert.equal(scene.objects[8].asset, null);
    assert.equal(scene.objects[8].allowProxy, false);
    assert.deepEqual(scene.missingObjectIds, []);
    assert.equal(f.workspace.scene.assetCount, 11);
    assert.equal(f.workspace.scene.objectCount, 11);
    assert.equal(scene.status, mode === 'manifest' ? 'ready_for_build' : 'proxy_ready');
  }
  f.workspace.annotations.photo4.inputVersion = 2;
  const stale = await pipeline.createScene(f.session.sessionId, 'manifest');
  assert.equal(stale.objects[8].skipped, undefined);
  assert.ok(stale.missingObjectIds.includes('photo4:user'));
  assert.equal(stale.status, 'awaiting_assets');
});
