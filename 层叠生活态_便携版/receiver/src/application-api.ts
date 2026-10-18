import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import type { ReceiverServices } from './server.js';
import { AppError, ApplicationStore } from './application-store.js';
import { PosterJobs, type PosterRenderer } from './poster-jobs.js';
import { AnalysisService, type Analyze } from './analysis-service.js';
import { hardwareCall, hardwareDto, hardwareStream } from './hardware-proxy.js';
import { PipelineService } from './pipeline-service.js';
import { BuildingProduction, type ProductionState } from './building-production.js';

export const envelope = (data: unknown) => ({ schemaVersion: '1.0', data });
export function appError(res: Response, error: unknown) {
  const known = error instanceof AppError;
  return res.status(known ? error.status : 500).json({ schemaVersion: '1.0', error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '操作未完成，请稍后重试。' } });
}
function route(action: (req: Request, res: Response) => unknown | Promise<unknown>): express.RequestHandler {
  return (req, res) => { void Promise.resolve().then(() => action(req, res)).then(data => { if (!res.headersSent && data !== undefined) res.json(envelope(data)); }).catch(error => { if (!res.headersSent) appError(res, error); }); };
}
const param = (req: Request, name: string) => String(req.params[name]);
export function registerApplication(app: express.Express, services: ReceiverServices, options: { posterRenderer?: PosterRenderer; analyze?: Analyze; autoProduction?: boolean } = {}) {
  const { config, sessions, importer, browser, watcher } = services;
  const catalog = JSON.parse(readFileSync(path.join(config.projectRoot, 'shared/app-catalog.json'), 'utf8'));
  const techathon = JSON.parse(readFileSync(path.join(config.projectRoot, 'shared/techathon-catalog.json'), 'utf8'));
  const store = new ApplicationStore(services), posters = new PosterJobs(config, options.posterRenderer), analysis = new AnalysisService(services, store, options.analyze), pipeline = new PipelineService(services, store);
  const api = express.Router();
  // 六张照片标注完成后的完整生产链：AI 识别新物体 -> Rodin 生成 12 个 GLB -> 导入会话 -> 大楼完成。
  const production = new BuildingProduction(config, sessions, services.events, async (state, analyses) => {
    for (const object of state.objects) {
      if (object.status !== 'ready' || !object.glb) continue;
      const workspace = await store.read(state.sessionId), source = path.resolve(config.projectRoot, object.glb);
      const current = workspace.assets[object.objectId];
      if (current?.inputVersion === object.inputVersion && current.bytes === (await fs.stat(source)).size) continue;
      await pipeline.importAsset(state.sessionId, object.objectId, object.inputVersion, 'generated', path.resolve(config.projectRoot, object.glb));
    }
    await store.transaction(state.sessionId, workspace => {
      for (const photo of state.photos) if (analyses[photo.photoId] && workspace.annotations[photo.photoId]?.inputVersion === photo.inputVersion)
        workspace.analyses[photo.photoId] = { photoId: photo.photoId, inputVersion: photo.inputVersion, status: 'ready', result: analyses[photo.photoId], updatedAt: new Date().toISOString() };
    });
  });
  const productionView = async (sessionId: string) => {
    const currentSession = store.current(sessionId);
    const state = await production.read(sessionId);
    if (!state) return { sessionId, status: 'idle', running: false, photos: [], objects: [], error: null };
    // The building only counts as finished when its plan still matches every current annotation version.
    const workspace = await store.read(sessionId);
    const currentIds = currentSession.images.filter(image => image.status === 'READY').map(image => image.imageId);
    const stale = state.sessionId !== sessionId || currentIds.length !== 6 || state.photos.length !== 6 || state.photos.some(photo => !currentIds.includes(photo.photoId) || workspace.annotations[photo.photoId]?.inputVersion !== photo.inputVersion);
    return { ...state, status: stale ? 'idle' : state.status, running: production.isRunning(sessionId), objects: state.objects.map(object => ({ ...object, glb: undefined,
      assetUrl: !stale && object.status === 'ready' ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/production/objects/${encodeURIComponent(object.objectId)}/file` : null })) };
  };
  const startProductionIfAnnotated = async (sessionId: string) => {
    if (!options.autoProduction || production.isRunning(sessionId)) return;
    const snapshot = await store.snapshot(sessionId);
    if (snapshot.photoCount < 6 || snapshot.annotationCount < 6) return;
    const view = await productionView(sessionId);
    if (view.status === 'ready') return;
    void production.ensureRunning(sessionId);
  };
  if (options.autoProduction) setTimeout(() => { void startProductionIfAnnotated(sessions.get().sessionId).catch(() => undefined); }, 3000);
  const building = (id: string) => { const item = catalog.buildings.find((entry: any) => entry.buildingId === id); if (!item) throw new AppError('BUILDING_NOT_FOUND', '找不到这栋大楼。', 404); return item; };
  const photoPath = (sessionId: string, photoId: string, variant: unknown) => {
    const image = store.photo(sessionId, photoId);
    const relative = variant === 'thumbnail' ? image.thumbnailPath : variant === 'original' ? image.originalPath : image.processedPath;
    const absolute = path.resolve(config.projectRoot, relative), dataRoot = path.resolve(config.dataRoot);
    if (!absolute.startsWith(dataRoot + path.sep)) throw new AppError('INVALID_PHOTO_PATH', '照片路径不在会话存储中。', 500);
    return absolute;
  };
  const upload = multer({ storage: multer.diskStorage({ destination: config.tempDir, filename: (_req, file, done) => done(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()) }), limits: { files: 20, fileSize: config.maxImageBytes } });
  const assetUpload = multer({ storage: multer.diskStorage({ destination: config.tempDir, filename: (_req, file, done) => done(null, crypto.randomUUID() + '.glb') }), limits: { files: 1, fileSize: 100 * 1024 * 1024 } });

  app.get('/', (_req, res) => res.sendFile(path.join(config.publicDir, 'studio.html')));
  app.get('/receive', (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
  app.get('/buildings/classic/', (_req, res) => res.sendFile(path.join(config.projectRoot, '建筑旋转海报.html')));
  app.use('/buildings/ecology', express.static(path.join(config.projectRoot, 'LayeredEcology_V2/apps/layered-ecology/dist')));
  app.get('/tools/wireframe/:pair', route((req, res) => {
    const names: Record<string, string> = { 'vending-postbox': '双视角线框.html', 'bicycle-cone': '自行车与交通锥双视角线框.html' };
    const file = names[param(req, 'pair')]; if (!file) throw new AppError('TOOL_NOT_FOUND', '找不到这个工具。', 404);
    res.sendFile(path.join(config.projectRoot, file));
  }));
  // Compatibility routes for a standalone V2 viewer hosted by the unified service.
  app.get('/api/hardware', route(async (_req, res) => { const raw = await hardwareCall('/api/state').catch(() => ({ connected: false, error: '硬件服务尚未连接' })); res.json(raw); }));
  app.get('/api/hardware-stream', (req, res) => hardwareStream(req, res, false));

  api.get('/capabilities', route(async () => ({ apiVersion: '1.0', scope: catalog.scope, buildings: catalog.buildings, posterGenerators: catalog.posterGenerators,
    analysis: await analysis.capability(), rodin: techathon.capabilities.rodin, deliveryModules: techathon.modules, eventsUrl: '/api/v1/events' })));
  api.get('/session', route(() => store.snapshot()));
  api.get('/sessions/:sessionId', route(req => store.snapshot(param(req, 'sessionId'))));
  api.post('/session', route(async (req, res) => {
    const mode = req.body?.mode ?? 'AUTO'; if (!['AUTO', 'MANUAL_FALLBACK'].includes(mode)) throw new AppError('INVALID_MODE', '接收模式无效。');
    // Stop old intake before changing the session pointer, then drain queued imports.
    await browser.stop(); await watcher.stop(); await importer.idle();
    await sessions.close(); await sessions.create(mode);
    await watcher.start();
    void browser.start();
    services.events.emitEphemeral({ sessionId: sessions.get().sessionId, eventType: 'session.created', timestamp: new Date().toISOString(), data: {} });
    res.status(201); return store.snapshot();
  }));
  api.post('/sessions/:sessionId/photos', (req, res, next) => { try { store.current(param(req, 'sessionId')); next(); } catch (error) { appError(res, error); } }, upload.array('files', 20), route(async req => {
    const sessionId = param(req, 'sessionId');
    store.current(sessionId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const result = files.length ? await importer.importFiles(files.map(file => ({ filePath: file.path, originalName: file.originalname }))) : (await watcher.rescan(), null);
      store.current(sessionId);
      return { session: await store.snapshot(sessionId), import: result ? { importedPhotoIds: result.imported.map(image => image.imageId), duplicates: result.duplicate, invalid: result.invalid, overflow: result.overflow } : null };
    } finally { await Promise.all(files.map(file => fs.rm(file.path, { force: true }).catch(() => undefined))); }
  }));
  api.put('/sessions/:sessionId/photos/order', route(async req => {
    const sessionId = param(req, 'sessionId'), session = store.current(sessionId), ids = req.body?.photoIds;
    if (!Array.isArray(ids) || ids.length !== session.images.length || new Set(ids).size !== ids.length || ids.some(id => !session.images.some(image => image.imageId === id))) throw new AppError('INVALID_ORDER', '必须提交当前所有照片的完整顺序。');
    await sessions.update(current => { store.current(sessionId); current.images.sort((a, b) => ids.indexOf(a.imageId) - ids.indexOf(b.imageId)); current.images.forEach((image, index) => { image.index = index + 1; }); });
    return store.snapshot(sessionId);
  }));
  api.delete('/sessions/:sessionId/photos/:photoId', route(async req => {
    const sessionId = param(req, 'sessionId'), photoId = param(req, 'photoId');
    const files = ['original', 'processed', 'thumbnail'].map(variant => photoPath(sessionId, photoId, variant));
    await sessions.update(current => { store.current(sessionId); current.images = current.images.filter(image => image.imageId !== photoId); current.images.forEach((image, index) => { image.index = index + 1; }); current.status = 'COLLECTING'; });
    await store.transaction(sessionId, workspace => { delete workspace.annotations[photoId]; delete workspace.analyses[photoId]; });
    await Promise.all(files.map(file => fs.rm(file, { force: true })));
    return store.snapshot(sessionId);
  }));
  api.get('/photos/:photoId/file', route((req, res) => { res.sendFile(photoPath(sessions.get().sessionId, param(req, 'photoId'), req.query.variant), { dotfiles: 'allow' }); }));
  api.put('/sessions/:sessionId/photos/:photoId/annotation', route(async req => {
    const saved = await store.save(param(req, 'sessionId'), param(req, 'photoId'), req.body);
    void startProductionIfAnnotated(param(req, 'sessionId')).catch(() => undefined);
    return saved;
  }));
  api.get('/sessions/:sessionId/production', route(req => productionView(param(req, 'sessionId'))));
  api.post('/sessions/:sessionId/production', route(async (req, res) => {
    const sessionId = param(req, 'sessionId'), snapshot = await store.snapshot(sessionId);
    if (snapshot.annotationCount < 6) throw new AppError('ANNOTATIONS_INCOMPLETE', '六张照片全部标注后才能生成大楼。', 409);
    void production.ensureRunning(sessionId); res.status(202); return productionView(sessionId);
  }));
  api.get('/sessions/:sessionId/production/objects/:objectId/file', route(async (req, res) => {
    const sessionId = param(req, 'sessionId'), objectId = param(req, 'objectId');
    store.current(sessionId);
    const state = await production.read(sessionId);
    const object = state?.objects.find(item => item.objectId === objectId && item.status === 'ready' && item.glb);
    if (!object?.glb) throw new AppError('ASSET_NOT_FOUND', '这个物件的模型还没有生成。', 404);
    const workspace = await store.read(sessionId);
    if (workspace.annotations[object.photoId]?.inputVersion !== object.inputVersion) throw new AppError('ASSET_OUTDATED', '标注已更新，物件正在重新生成。', 409);
    const file = path.resolve(config.projectRoot, object.glb);
    if (!file.startsWith(production.dir(sessionId) + path.sep)) throw new AppError('ASSET_NOT_FOUND', '模型路径无效。', 404);
    res.type('model/gltf-binary'); res.sendFile(file, { dotfiles: 'allow' });
  }));
  api.post('/sessions/:sessionId/photos/:photoId/analysis', route(async (req, res) => { const result = await analysis.start(param(req, 'sessionId'), param(req, 'photoId'), req.body?.inputVersion); res.status(result?.status === 'ready' ? 200 : 202); return result; }));
  api.get('/sessions/:sessionId/photos/:photoId/analysis', route(req => analysis.get(param(req, 'sessionId'), param(req, 'photoId'))));
  api.get('/sessions/:sessionId/pipeline', route(req => pipeline.status(param(req, 'sessionId'))));
  api.post('/sessions/:sessionId/assets', assetUpload.single('file'), route(async req => {
    const file = req.file;
    if (!file) throw new AppError('ASSET_FILE_REQUIRED', '请上传一个 GLB 文件。');
    try {
      const objectId = String(req.body?.objectId ?? ''), inputVersion = Number(req.body?.inputVersion), origin = req.body?.origin === 'generated' ? 'generated' : req.body?.origin === 'library' ? 'library' : null;
      if (!objectId || !Number.isInteger(inputVersion) || !origin) throw new AppError('INVALID_ASSET_INPUT', '需要 objectId、整数 inputVersion 和 origin。');
      return await pipeline.importAsset(param(req, 'sessionId'), objectId, inputVersion, origin, file.path);
    } finally { await fs.rm(file.path, { force: true }).catch(() => undefined); }
  }));
  api.get('/sessions/:sessionId/assets/:objectId/file', route(async (req, res) => { res.sendFile(await pipeline.assetFile(param(req, 'sessionId'), param(req, 'objectId')), { dotfiles: 'allow' }); }));
  api.post('/sessions/:sessionId/scene', route(async (req, res) => { const result = await pipeline.createScene(param(req, 'sessionId'), req.body?.mode ?? 'manifest'); res.status(201); return result; }));
  api.get('/sessions/:sessionId/scene', route(req => pipeline.getScene(param(req, 'sessionId'))));
  api.post('/sessions/:sessionId/scene/build', route(req => pipeline.buildScene(param(req, 'sessionId'))));
  api.post('/intake/mode', route(async req => { if (!['AUTO', 'MANUAL_FALLBACK'].includes(req.body?.mode)) throw new AppError('INVALID_MODE', '接收模式无效。'); await sessions.setMode(req.body.mode); if (req.body.mode === 'AUTO') await browser.start(); return store.snapshot(); }));
  api.post('/intake/browser/restart', route(async () => { await browser.restart(); return store.snapshot(); }));
  api.post('/intake/browser/focus', route(async () => { await browser.focusPage(); return { ok: true }; }));
  api.get('/intake/incoming', route(() => ({ path: config.incomingDir })));
  api.get('/intake/qr', route(() => ({ qrDataUrl: browser.getQrDataUrl() })));
  api.get('/intake/qr', route(() => ({ qrDataUrl: browser.getQrDataUrl() })));
  api.get('/intake/logs', route(async () => { const text = await fs.readFile(path.join(config.eventsDir, 'receiver.log.jsonl'), 'utf8').catch(() => ''); return { events: text.split('\n').filter(Boolean).slice(-100).map(line => JSON.parse(line)) }; }));
  api.get('/buildings', route(() => ({ buildings: catalog.buildings })));
  api.get('/buildings/:buildingId', route(req => building(param(req, 'buildingId'))));
  api.get('/buildings/:buildingId/preview', route((req, res) => {
    const item = building(param(req, 'buildingId'));
    res.sendFile(path.join(config.projectRoot, item.buildingId === 'classic' ? 'outputs/posters/test_building_1_front_blue.png' : 'LayeredEcology_V2/apps/layered-ecology/dist/assets/poster-preview.jpg'));
  }));
  api.get('/poster-generators', route(() => ({ generators: catalog.posterGenerators })));
  api.post('/posters', route(async (req, res) => {
    const input = { ...(req.body ?? {}) };
    if (input.sessionId) {
      const scene = await pipeline.getScene(String(input.sessionId));
      if (!scene) throw new AppError('SCENE_NOT_FOUND', '该会话还没有场景清单。', 404);
      if (input.sceneId && input.sceneId !== scene.sceneId) throw new AppError('SCENE_VERSION_MISMATCH', '海报请求中的 sceneId 不是当前场景。', 409);
      input.sceneId = scene.sceneId; input.sceneStatus = scene.status;
    }
    const result = await posters.create(input, `http://127.0.0.1:${req.socket.localPort}`); res.status(202); return result;
  }));
  api.get('/posters/:jobId', route(req => posters.get(param(req, 'jobId'))));
  api.get('/posters/:jobId/file', route(async (req, res) => { res.type('png').setHeader('Content-Disposition', `attachment; filename="${param(req, 'jobId')}.png"`); res.sendFile(await posters.download(param(req, 'jobId')), { dotfiles: 'allow' }); }));
  api.get('/hardware/state', route(async () => hardwareDto(await hardwareCall('/api/state').catch(() => ({ connected: false, error: '硬件服务尚未连接' })))));
  api.get('/hardware/ports', route(() => hardwareCall('/api/ports')));
  api.get('/hardware/events', (req, res) => hardwareStream(req, res));
  api.post('/hardware/connection', route(req => hardwareCall('/api/connection', req.body)));
  api.post('/hardware/settings', route(req => hardwareCall('/api/angle', { ...(req.body?.stepsPerTurn === undefined ? {} : { steps_per_turn: req.body.stepsPerTurn }), ...(req.body?.directionSign === undefined ? {} : { sign: req.body.directionSign }), ...(req.body?.transitions === undefined ? {} : { transitions: req.body.transitions }), zero: req.body?.zero === true })));
  api.get('/tools', route(() => ({ tools: [
    { toolId: 'vending-postbox', title: '贩卖机与邮箱', kind: 'browser', viewerUrl: '/tools/wireframe/vending-postbox', status: 'implemented' },
    { toolId: 'bicycle-cone', title: '自行车与交通锥', kind: 'browser', viewerUrl: '/tools/wireframe/bicycle-cone', status: 'implemented' },
    ...techathon.modules.map((module: any) => ({ toolId: module.id, title: module.title, kind: module.kind, status: module.status,
      deliveryPath: module.entrypoint ?? module.source, contract: module.contract ?? module.contracts ?? null }))
  ] })));
  api.use((_req, res) => appError(res, new AppError('NOT_FOUND', '此接口未实现或已移出当前范围。', 404)));
  api.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => appError(res, error instanceof multer.MulterError ? new AppError('UPLOAD_REJECTED', error.message, 400) : error));
  app.use('/api/v1', api);
  return { store, posters, analysis, pipeline };
}
