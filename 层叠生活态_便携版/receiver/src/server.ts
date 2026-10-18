import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import type { ReceiverConfig } from './config.js';
import type { EventBus } from './events.js';
import type { ImageImporter } from './importer.js';
import type { BrowserController } from './browser-controller.js';
import type { IncomingWatcher } from './watcher.js';
import type { SessionStore } from './session-store.js';
import type { ImageRecord, ReceiverMode, SessionManifest } from './types.js';
import { registerApplication, envelope, appError } from './application-api.js';
import { AppError } from './application-store.js';
import { registerProviderKeys } from './provider-keys.js';

export interface ReceiverServices {
  config: ReceiverConfig;
  sessions: SessionStore;
  importer: ImageImporter;
  watcher: IncomingWatcher;
  browser: BrowserController;
  events: EventBus;
}

export function createReceiverApp(services: ReceiverServices, options: { autoProduction?: boolean } = {}): express.Express {
  const { config, sessions, importer, watcher, browser, events } = services;
  const app = express();
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.tempDir,
      filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { files: 20, fileSize: config.maxImageBytes },
  });
  app.use(express.json({ limit: '1mb' }));
  let mutationQueue = Promise.resolve();
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>(resolve => { release = resolve; });
    res.once('finish', release); res.once('close', release);
    void previous.then(() => { if (res.destroyed) release(); else next(); });
  });
  registerProviderKeys(app, config.projectRoot);
  registerApplication(app, services, { autoProduction: options.autoProduction });
  app.use(express.static(config.publicDir, { extensions: ['html'] }));
  app.get(['/emotion-wheel', '/emotion-wheel.html'], async (_req, res, next) => {
    const built = path.join(config.projectRoot, 'emotion-wheel', 'dist', 'index.html');
    try { await fs.access(built); return res.sendFile(built); }
    catch { return res.sendFile(path.join(config.projectRoot, '情绪环.html'), error => { if (error) next(error); }); }
  });

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'layered-ecology-receiver', time: new Date().toISOString() }));

  app.get('/api/receiver/session/current', (_req, res) => res.json(publicManifest(sessions.get(), config)));

  app.post('/api/receiver/session', async (req, res, next) => {
    try {
      const body = req.body as { newSession?: boolean; mode?: ReceiverMode };
      if (body.newSession) {
        await sessions.close();
        await sessions.create(body.mode === 'MANUAL_FALLBACK' ? 'MANUAL_FALLBACK' : 'AUTO');
        await events.emit({ sessionId: sessions.get().sessionId, eventType: 'session.reset', timestamp: new Date().toISOString(), data: publicManifest(sessions.get(), config) });
        await browser.restart();
      } else if (body.mode) {
        await sessions.setMode(body.mode);
      }
      res.status(201).json(publicManifest(sessions.get(), config));
    } catch (error) { next(error); }
  });

  app.get('/api/receiver/images', (_req, res) => {
    const manifest = sessions.get();
    res.json({ sessionId: manifest.sessionId, status: manifest.status, images: manifest.images.filter(image => image.status === 'READY').sort((a, b) => a.index - b.index).map(image => publicImage(image, config)) });
  });

  app.get('/api/receiver/images/:id', async (req, res, next) => {
    try {
      const image = sessions.get().images.find(item => item.imageId === req.params.id);
      if (!image) return res.status(404).json({ error: 'IMAGE_NOT_FOUND' });
      const variant = req.query.variant === 'thumbnail' ? 'thumbnailPath' : req.query.variant === 'original' ? 'originalPath' : 'processedPath';
      const target = safeProjectPath(config.projectRoot, image[variant]);
      return res.sendFile(target, { dotfiles: 'allow' });
    } catch (error) { return next(error); }
  });

  app.post('/api/receiver/import', upload.array('files', 20), async (req, res, next) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length) {
        const result = await importer.importFiles(files.map(file => ({ filePath: file.path, originalName: file.originalname })));
        return res.json({ ...result, session: publicManifest(sessions.get(), config) });
      }
      await watcher.rescan();
      return res.json({ rescanned: true, session: publicManifest(sessions.get(), config) });
    } catch (error) { return next(error); }
  });

  app.post('/api/receiver/reorder', async (req, res, next) => {
    try {
      const imageIds = Array.isArray(req.body?.imageIds) ? req.body.imageIds as string[] : [];
      const current = sessions.get().images.filter(image => image.status === 'READY');
      if (imageIds.length !== current.length || new Set(imageIds).size !== current.length || imageIds.some(id => !current.some(image => image.imageId === id))) {
        return res.status(400).json({ error: 'INVALID_ORDER' });
      }
      await sessions.update(manifest => {
        const byId = new Map(manifest.images.map(image => [image.imageId, image]));
        imageIds.forEach((id, index) => { const image = byId.get(id); if (image) image.index = index + 1; });
        manifest.images.sort((a, b) => a.index - b.index);
      });
      await events.emit({ sessionId: sessions.get().sessionId, eventType: 'images.progress', timestamp: new Date().toISOString(), data: { reason: 'reordered', imageIds } });
      return res.json(publicManifest(sessions.get(), config));
    } catch (error) { return next(error); }
  });

  app.delete('/api/receiver/images/:id', async (req, res, next) => {
    try {
      const existing = sessions.get().images.find(image => image.imageId === req.params.id);
      if (!existing) return res.status(404).json({ error: 'IMAGE_NOT_FOUND' });
      await Promise.all([existing.originalPath, existing.processedPath, existing.thumbnailPath].map(relative => fs.rm(safeProjectPath(config.projectRoot, relative), { force: true })));
      await sessions.update(manifest => {
        manifest.images = manifest.images.filter(image => image.imageId !== existing.imageId);
        manifest.images.forEach((image, index) => { image.index = index + 1; });
        manifest.status = manifest.imageCount >= manifest.targetCount ? 'IMAGES_READY' : 'COLLECTING';
      });
      await events.emit({ sessionId: sessions.get().sessionId, eventType: 'images.progress', timestamp: new Date().toISOString(), data: { reason: 'deleted', imageId: existing.imageId, imageCount: sessions.get().imageCount } });
      return res.json(publicManifest(sessions.get(), config));
    } catch (error) { return next(error); }
  });

  app.post('/api/receiver/reset', async (req, res, next) => {
    try {
      await sessions.close();
      await sessions.create(req.body?.mode === 'MANUAL_FALLBACK' ? 'MANUAL_FALLBACK' : 'AUTO');
      await events.emit({ sessionId: sessions.get().sessionId, eventType: 'session.reset', timestamp: new Date().toISOString(), data: publicManifest(sessions.get(), config) });
      await browser.restart();
      return res.json(publicManifest(sessions.get(), config));
    } catch (error) { return next(error); }
  });

  app.post('/api/receiver/mode', async (req, res, next) => {
    try {
      const mode = req.body?.mode as ReceiverMode;
      if (mode !== 'AUTO' && mode !== 'MANUAL_FALLBACK') return res.status(400).json({ error: 'INVALID_MODE' });
      await sessions.setMode(mode);
      if (mode === 'AUTO') await browser.start();
      return res.json(publicManifest(sessions.get(), config));
    } catch (error) { return next(error); }
  });

  app.post('/api/receiver/browser/restart', async (_req, res, next) => {
    try { await browser.restart(); return res.json({ ok: true, session: publicManifest(sessions.get(), config) }); }
    catch (error) { return next(error); }
  });

  app.post('/api/receiver/browser/focus', async (_req, res, next) => {
    try { await browser.focusPage(); return res.json({ ok: true }); }
    catch (error) { return next(error); }
  });

  app.post('/api/receiver/open-download-folder', (_req, res) => res.json({ path: config.incomingDir }));

  app.get('/api/receiver/logs', async (_req, res, next) => {
    try {
      const logPath = path.join(config.eventsDir, 'receiver.log.jsonl');
      const content = await fs.readFile(logPath, 'utf8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean).slice(-100).map(line => JSON.parse(line));
      return res.json({ lines });
    } catch (error) { return next(error); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (_req.path.startsWith('/api/v1')) {
      return appError(res, error instanceof SyntaxError ? new AppError('INVALID_JSON', '请求JSON无效。') : error);
    }
    const message = error instanceof Error ? error.message : '服务器错误';
    res.status(500).json({ error: 'RECEIVER_ERROR', message });
  });
  return app;
}

export function attachWebSocket(server: http.Server, services: ReceiverServices): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const unified = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const target = pathname === '/ws' ? wss : pathname === '/api/v1/events' ? unified : null;
    if (!target) { socket.destroy(); return; }
    target.handleUpgrade(request, socket, head, client => target.emit('connection', client, request));
  });
  const unsubscribe = services.events.subscribe(event => {
    const serialized = JSON.stringify(event);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(serialized);
    const normalized = JSON.stringify(envelope({ sessionId: event.sessionId, type: event.eventType, timestamp: event.timestamp,
      data: event.eventType === 'receiver.qr' ? event.data : {}, refreshUrl: '/api/v1/session' }));
    for (const client of unified.clients) if (client.readyState === WebSocket.OPEN) client.send(normalized);
  });
  unified.on('connection', socket => {
    socket.send(JSON.stringify(envelope({ sessionId: services.sessions.get().sessionId, type: 'session.snapshot', timestamp: new Date().toISOString(), data: {}, refreshUrl: '/api/v1/session' })));
    const qrDataUrl = services.browser.getQrDataUrl();
    if (qrDataUrl) socket.send(JSON.stringify(envelope({ sessionId: services.sessions.get().sessionId, type: 'receiver.qr', timestamp: new Date().toISOString(), data: { qrDataUrl, refreshHint: '每5秒刷新一次' } })));
  });
  server.on('close', () => { unsubscribe(); for (const client of [...wss.clients, ...unified.clients]) client.terminate(); wss.close(); unified.close(); });
  wss.on('connection', socket => {
    socket.send(JSON.stringify({ sessionId: services.sessions.get().sessionId, eventType: 'receiver.snapshot', timestamp: new Date().toISOString(), data: publicManifest(services.sessions.get(), services.config) }));
    const qrDataUrl = services.browser.getQrDataUrl();
    if (qrDataUrl) socket.send(JSON.stringify({ sessionId: services.sessions.get().sessionId, eventType: 'receiver.qr', timestamp: new Date().toISOString(), data: { qrDataUrl, refreshHint: '每 5 秒刷新一次' } }));
  });
  return wss;
}

export function publicManifest(manifest: SessionManifest, config: ReceiverConfig): object {
  return {
    sessionId: manifest.sessionId,
    status: manifest.status,
    mode: manifest.mode,
    targetCount: manifest.targetCount,
    imageCount: manifest.imageCount,
    images: manifest.images.filter(image => image.status === 'READY').sort((a, b) => a.index - b.index).map(image => publicImage(image, config)),
    overflow: manifest.overflow,
    errors: manifest.errors,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    nextUrl: `/emotion-wheel?sessionId=${encodeURIComponent(manifest.sessionId)}`,
  };
}

function publicImage(image: ImageRecord, config: ReceiverConfig): object {
  return {
    id: image.imageId,
    imageId: image.imageId,
    index: image.index,
    originalName: image.originalName,
    url: `/api/receiver/images/${encodeURIComponent(image.imageId)}`,
    thumbnailUrl: `/api/receiver/images/${encodeURIComponent(image.imageId)}?variant=thumbnail`,
    width: image.width,
    height: image.height,
    mimeType: image.mimeType,
    fileSize: image.fileSize,
    sha256: image.sha256,
    importedAt: image.importedAt,
  };
}

function safeProjectPath(projectRoot: string, relativePath: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('非法文件路径');
  return target;
}
