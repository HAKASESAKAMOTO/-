import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import type { EventBus } from './events.js';
import { validateImage, createDerivatives } from './image-pipeline.js';
import type { ImportResult, ImageRecord } from './types.js';
import type { ReceiverConfig } from './config.js';
import type { SessionStore } from './session-store.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ZIP_EXTENSIONS = new Set(['.zip']);
const TEMP_EXTENSIONS = new Set(['.crdownload', '.part', '.tmp', '.download']);

export class ImageImporter {
  private readonly processing = new Set<string>();
  private importQueue: Promise<void> = Promise.resolve();
  async idle(): Promise<void> { await this.importQueue; }

  constructor(
    private readonly config: ReceiverConfig,
    private readonly sessions: SessionStore,
    private readonly events: EventBus,
  ) {}

  async importFile(filePath: string, sourceName = path.basename(filePath)): Promise<ImportResult> {
    return this.enqueue(() => this.importFileNow(filePath, sourceName));
  }

  async importFiles(filePaths: Array<string | { filePath: string; originalName?: string }>): Promise<ImportResult> {
    return this.enqueue(() => this.importFilesNow(filePaths));
  }

  private async importFileNow(filePath: string, sourceName = path.basename(filePath)): Promise<ImportResult> {
    const absolutePath = path.resolve(filePath);
    if (this.processing.has(absolutePath)) return { imported: [], duplicate: [], invalid: [], overflow: [] };
    this.processing.add(absolutePath);
    try {
      await waitForStableFile(absolutePath);
      const extension = path.extname(absolutePath).toLowerCase();
      if (TEMP_EXTENSIONS.has(extension)) return { imported: [], duplicate: [], invalid: [], overflow: [] };
      if (ZIP_EXTENSIONS.has(extension)) return this.importZip(absolutePath, sourceName);
      if (!IMAGE_EXTENSIONS.has(extension)) {
        return { imported: [], duplicate: [], invalid: [{ name: path.basename(absolutePath), message: '不是支持的图片格式' }], overflow: [] };
      }
      return this.importImage(absolutePath, sourceName);
    } finally {
      this.processing.delete(absolutePath);
    }
  }

  private async importFilesNow(filePaths: Array<string | { filePath: string; originalName?: string }>): Promise<ImportResult> {
    const combined: ImportResult = { imported: [], duplicate: [], invalid: [], overflow: [] };
    for (const item of filePaths) {
      const filePath = typeof item === 'string' ? item : item.filePath;
      const result = await this.importFileNow(filePath, typeof item === 'string' ? path.basename(filePath) : item.originalName);
      combined.imported.push(...result.imported);
      combined.duplicate.push(...result.duplicate);
      combined.invalid.push(...result.invalid);
      combined.overflow.push(...result.overflow);
    }
    return combined;
  }

  private async importImage(filePath: string, sourceName: string): Promise<ImportResult> {
    const name = path.basename(sourceName);
    await this.events.emit({ sessionId: this.sessions.get().sessionId, eventType: 'image.detected', timestamp: new Date().toISOString(), data: { name } });
    const session = this.sessions.get();
    await this.sessions.setStatus('IMPORTING');
    let validated;
    try {
      validated = await validateImage(filePath, this.config.maxImageBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片校验失败';
      await this.sessions.addError('INVALID_IMAGE', `${name}: ${message}`, 'importer');
      await this.events.emit({ sessionId: session.sessionId, eventType: 'image.failed', timestamp: new Date().toISOString(), data: { name, message } });
      return { imported: [], duplicate: [], invalid: [{ name, message }], overflow: [] };
    }
    if (session.images.some(image => image.sha256 === validated.sha256)) {
      const duplicateDir = path.join(this.config.dataRoot, 'duplicates');
      await fs.mkdir(duplicateDir, { recursive: true });
      await moveIntoDirectory(filePath, duplicateDir);
      await this.events.emit({ sessionId: session.sessionId, eventType: 'image.failed', timestamp: new Date().toISOString(), data: { name, reason: 'DUPLICATE' } });
      await this.sessions.setStatus(this.sessions.get().imageCount >= this.sessions.get().targetCount ? 'IMAGES_READY' : 'COLLECTING');
      return { imported: [], duplicate: [name], invalid: [], overflow: [] };
    }
    if (session.imageCount >= session.targetCount) {
      const overflowDir = path.join(this.config.dataRoot, 'overflow');
      await fs.mkdir(overflowDir, { recursive: true });
      const overflowPath = await moveIntoDirectory(filePath, overflowDir);
      await this.sessions.update(manifest => manifest.overflow.push({ originalName: name, path: overflowPath, reason: '已达到 6 张目标', detectedAt: new Date().toISOString() }));
      await this.events.emit({ sessionId: session.sessionId, eventType: 'image.failed', timestamp: new Date().toISOString(), data: { name, reason: 'OVERFLOW' } });
      await this.sessions.setStatus('IMAGES_READY');
      return { imported: [], duplicate: [], invalid: [], overflow: [name] };
    }

    const imageId = `img_${crypto.randomBytes(6).toString('hex')}`;
    const index = session.imageCount + 1;
    const sessionRoot = this.sessions.sessionDir(session.sessionId);
    const originalName = `${imageId}-${sanitizeBaseName(name)}${path.extname(name).toLowerCase()}`;
    const originalPath = path.join(sessionRoot, 'originals', originalName);
    const processedPath = path.join(sessionRoot, 'processed', `${imageId}.jpg`);
    const thumbnailPath = path.join(sessionRoot, 'thumbnails', `${imageId}.webp`);
    await fs.mkdir(path.dirname(originalPath), { recursive: true });
    await fs.rename(filePath, originalPath);
    await createDerivatives(originalPath, processedPath, thumbnailPath);
    const record: ImageRecord = {
      imageId,
      index,
      originalName: name,
      originalPath: relativeToProject(originalPath, this.config.projectRoot),
      processedPath: relativeToProject(processedPath, this.config.projectRoot),
      thumbnailPath: relativeToProject(thumbnailPath, this.config.projectRoot),
      mimeType: validated.mimeType,
      fileSize: validated.fileSize,
      width: validated.width,
      height: validated.height,
      sha256: validated.sha256,
      importedAt: new Date().toISOString(),
      status: 'READY',
    };
    await this.sessions.update(manifest => {
      manifest.images.push(record);
      manifest.images.sort((a, b) => a.index - b.index);
      manifest.status = manifest.images.length >= manifest.targetCount ? 'IMAGES_READY' : 'COLLECTING';
    });
    await this.events.emit({ sessionId: session.sessionId, eventType: 'image.imported', timestamp: new Date().toISOString(), data: record });
    await this.events.emit({ sessionId: session.sessionId, eventType: 'images.progress', timestamp: new Date().toISOString(), data: { imageCount: this.sessions.get().imageCount, targetCount: this.sessions.get().targetCount } });
    if (this.sessions.get().imageCount >= this.sessions.get().targetCount) {
      await this.events.emit({ sessionId: session.sessionId, eventType: 'images.ready', timestamp: new Date().toISOString(), data: this.publicSession() });
    }
    return { imported: [record], duplicate: [], invalid: [], overflow: [] };
  }

  private async importZip(filePath: string, sourceName: string): Promise<ImportResult> {
    const zipStat = await fs.stat(filePath);
    if (zipStat.size > this.config.maxZipBytes) {
      const name = path.basename(sourceName);
      const message = `ZIP 超过 ${Math.round(this.config.maxZipBytes / 1024 / 1024)} MB 限制`;
      await this.sessions.addError('ZIP_TOO_LARGE', `${name}: ${message}`, 'importer');
      return { imported: [], duplicate: [], invalid: [{ name, message }], overflow: [] };
    }
    const extractRoot = path.join(this.config.tempDir, `extract-${crypto.randomBytes(5).toString('hex')}`);
    await fs.mkdir(extractRoot, { recursive: true });
    const extracted: string[] = [];
    try {
      const directory = await unzipper.Open.file(filePath);
      let totalBytes = 0;
      for (const entry of directory.files) {
        if (entry.type === 'Directory') continue;
        if (extracted.length >= this.config.maxZipFiles) throw new Error(`ZIP 文件数量超过 ${this.config.maxZipFiles} 个限制`);
        const safeName = safeZipName(entry.path);
        if (!safeName) throw new Error('ZIP 包含不安全的文件路径');
        const output = path.resolve(extractRoot, safeName);
        if (!output.startsWith(`${extractRoot}${path.sep}`)) throw new Error('ZIP 路径越界');
        await fs.mkdir(path.dirname(output), { recursive: true });
        const content = await entry.buffer();
        totalBytes += content.byteLength;
        if (totalBytes > this.config.maxZipBytes) throw new Error(`ZIP 解压内容超过 ${Math.round(this.config.maxZipBytes / 1024 / 1024)} MB 限制`);
        await fs.writeFile(output, content);
        if (IMAGE_EXTENSIONS.has(path.extname(output).toLowerCase())) extracted.push(output);
      }
      const result = await this.importFilesNow(extracted);
      await moveIntoDirectory(filePath, path.join(this.config.dataRoot, 'processed-zips'));
      return result;
    } catch (error) {
      const name = path.basename(sourceName);
      const message = error instanceof Error ? error.message : 'ZIP 解压失败';
      await this.sessions.addError('ZIP_IMPORT_FAILED', `${name}: ${message}`, 'importer');
      return { imported: [], duplicate: [], invalid: [{ name, message }], overflow: [] };
    } finally {
      await fs.rm(extractRoot, { recursive: true, force: true });
    }
  }

  private publicSession(): object {
    const session = this.sessions.get();
    return { sessionId: session.sessionId, status: session.status, imageCount: session.imageCount, targetCount: session.targetCount };
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.importQueue.then(work);
    this.importQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export async function waitForStableFile(filePath: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  let previous = -1;
  let stableChecks = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const size = (await fs.stat(filePath)).size;
      if (size > 0 && size === previous) stableChecks += 1;
      else stableChecks = 0;
      previous = size;
      if (stableChecks >= 2) return;
    } catch {
      // The download may not have created the file yet.
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('文件写入未在规定时间内完成');
}

function sanitizeBaseName(name: string): string {
  const base = path.basename(name, path.extname(name)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80);
  return base || 'image';
}

function relativeToProject(filePath: string, projectRoot: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

async function moveIntoDirectory(filePath: string, directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${Date.now()}-${sanitizeBaseName(path.basename(filePath))}${path.extname(filePath).toLowerCase()}`);
  try {
    await fs.rename(filePath, destination);
  } catch {
    await fs.copyFile(filePath, destination);
    await fs.rm(filePath, { force: true });
  }
  return destination;
}

function safeZipName(name: string): string | null {
  const normalized = name.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const pieces = normalized.split('/').filter(Boolean);
  if (pieces.some(piece => piece === '..')) return null;
  return pieces.join(path.sep);
}
