import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReceiverMode, SessionManifest, SessionStatus } from './types.js';
import { TARGET_COUNT } from './types.js';
import { atomicJson } from './atomic-file.js';

export class SessionStore {
  private current: SessionManifest | null = null;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly sessionsDir: string) {}

  private currentPointer(): string {
    return path.join(this.sessionsDir, 'current.json');
  }

  sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  async load(): Promise<SessionManifest | null> {
    try {
      const pointer = JSON.parse(await fs.readFile(this.currentPointer(), 'utf8')) as { sessionId: string };
      const manifest = JSON.parse(await fs.readFile(path.join(this.sessionDir(pointer.sessionId), 'manifest.json'), 'utf8')) as SessionManifest;
      this.current = manifest;
      return manifest;
    } catch {
      return null;
    }
  }

  async create(mode: ReceiverMode = 'AUTO'): Promise<SessionManifest> {
    await this.updateQueue;
    const now = new Date().toISOString();
    const suffix = crypto.randomBytes(3).toString('hex');
    const id = `session_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${suffix}`;
    const manifest: SessionManifest = {
      sessionId: id,
      status: 'INITIALIZING',
      mode,
      targetCount: TARGET_COUNT,
      imageCount: 0,
      images: [],
      overflow: [],
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.ensureSessionDirectories(id);
    this.current = manifest;
    await this.persist();
    return manifest;
  }

  async ensure(mode: ReceiverMode = 'AUTO'): Promise<SessionManifest> {
    return (await this.load()) ?? this.create(mode);
  }

  get(): SessionManifest {
    if (!this.current) throw new Error('No active receiver session');
    return this.current;
  }

  async update(mutator: (manifest: SessionManifest) => void): Promise<SessionManifest> {
    const operation = this.updateQueue.then(async () => {
      const manifest = this.get();
      mutator(manifest);
      manifest.imageCount = manifest.images.filter(image => image.status === 'READY').length;
      manifest.updatedAt = new Date().toISOString();
      await this.persist();
    });
    this.updateQueue = operation.catch(() => undefined);
    await operation;
    return this.get();
  }

  async setStatus(status: SessionStatus): Promise<SessionManifest> {
    return this.update(manifest => { manifest.status = status; });
  }

  async setMode(mode: ReceiverMode): Promise<SessionManifest> {
    return this.update(manifest => {
      manifest.mode = mode;
      if (mode === 'MANUAL_FALLBACK' && manifest.imageCount < manifest.targetCount) manifest.status = 'MANUAL_FALLBACK';
    });
  }

  async addError(code: string, message: string, source?: string): Promise<SessionManifest> {
    return this.update(manifest => {
      manifest.errors = [{ code, message, source, at: new Date().toISOString() }, ...manifest.errors].slice(0, 50);
      manifest.status = manifest.imageCount >= manifest.targetCount ? 'IMAGES_READY' : 'ERROR';
    });
  }

  async close(): Promise<SessionManifest> {
    return this.setStatus('SESSION_CLOSED');
  }

  private async ensureSessionDirectories(sessionId: string): Promise<void> {
    const root = this.sessionDir(sessionId);
    await Promise.all([
      fs.mkdir(path.join(root, 'originals'), { recursive: true }),
      fs.mkdir(path.join(root, 'processed'), { recursive: true }),
      fs.mkdir(path.join(root, 'thumbnails'), { recursive: true }),
    ]);
  }

  private async persist(): Promise<void> {
    const manifest = this.get();
    const dir = this.sessionDir(manifest.sessionId);
    await this.ensureSessionDirectories(manifest.sessionId);
    const manifestPath = path.join(dir, 'manifest.json');
    await atomicJson(manifestPath, manifest);
    await atomicJson(this.currentPointer(), { sessionId: manifest.sessionId });
  }
}
