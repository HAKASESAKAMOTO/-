import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { AppError, atomicJson } from './application-store.js';
import type { ReceiverConfig } from './config.js';

const execute = promisify(execFile);
export interface PosterInput { buildingId: 'classic' | 'ecology'; generatorId: 'classic-poster' | 'ecology-poster'; theme: string; face: string; view: { angleDegrees: number; zoom: number }; sessionId?: string; sceneId?: string; sceneStatus?: string }
export interface PosterJob { jobId: string; status: 'queued' | 'running' | 'ready' | 'failed'; input: PosterInput; createdAt: string; updatedAt: string; downloadUrl?: string; width?: number; height?: number; source?: 'prebuilt' | 'rendered'; error?: { code: string; message: string } }
export function posterInput(value: any): PosterInput {
  if (!value || !['classic', 'ecology'].includes(value.buildingId)) throw new AppError('BUILDING_NOT_FOUND', '请选择现有的两栋示例楼。', 404);
  const classic = value.buildingId === 'classic';
  const generatorId = classic ? 'classic-poster' : 'ecology-poster';
  if (value.generatorId !== generatorId) throw new AppError('GENERATOR_MISMATCH', '此海报工具不属于所选大楼。');
  const theme = value.theme ?? (classic ? 'blue' : 'original'), face = value.face ?? 'front';
  if (!(classic ? ['blue', 'yellow'] : ['original']).includes(theme) || !['front', 'back', 'left', 'right'].includes(face)) throw new AppError('INVALID_POSTER_OPTIONS', '海报配色或观看面无效。');
  const angleDegrees = value.view?.angleDegrees ?? 0, zoom = value.view?.zoom ?? 1;
  if (typeof angleDegrees !== 'number' || !Number.isFinite(angleDegrees) || Math.abs(angleDegrees) > 36000 || typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < .65 || zoom > 1.6) throw new AppError('INVALID_VIEW', '海报视角参数无效。');
  return { buildingId: value.buildingId, generatorId, theme, face, view: { angleDegrees, zoom },
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.sceneId === 'string' ? { sceneId: value.sceneId } : {}),
    ...(typeof value.sceneStatus === 'string' ? { sceneStatus: value.sceneStatus } : {}) };
}
export type PosterRenderer = (input: PosterInput, destination: string, origin: string) => Promise<'prebuilt' | 'rendered'>;
export class PosterJobs {
  private queue: Promise<void> = Promise.resolve();
  private active = 0;
  private owned = new Set<string>();
  private folder: string;
  constructor(private config: ReceiverConfig, private renderer?: PosterRenderer) { this.folder = path.join(config.dataRoot, 'posters'); }
  private file(id: string, extension = 'json') {
    if (!/^poster_[a-f0-9-]{36}$/.test(id)) throw new AppError('POSTER_NOT_FOUND', '找不到这张海报。', 404);
    return path.join(this.folder, `${id}.${extension}`);
  }
  async get(id: string): Promise<PosterJob> {
    let job: PosterJob;
    try { job = JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('POSTER_NOT_FOUND', '找不到这张海报。', 404); throw error; }
    if (['queued', 'running'].includes(job.status) && !this.owned.has(id)) {
      job.status = 'failed'; job.error = { code: 'INTERRUPTED', message: '服务重启中断了导出，请重新生成。' }; job.updatedAt = new Date().toISOString(); await atomicJson(this.file(id), job);
    }
    return job;
  }
  async download(id: string) { const job = await this.get(id); if (job.status !== 'ready') throw new AppError('POSTER_NOT_READY', '海报还未生成完成。', 409); return this.file(id, 'png'); }
  async create(value: unknown, origin: string): Promise<PosterJob> {
    const input = posterInput(value);
    if (this.active >= 4) throw new AppError('EXPORT_BUSY', '已有多张海报等待导出，请稍后再试。', 429);
    const now = new Date().toISOString();
    const job: PosterJob = { jobId: `poster_${crypto.randomUUID()}`, status: 'queued', input, createdAt: now, updatedAt: now };
    this.active++; this.owned.add(job.jobId);
    try { await atomicJson(this.file(job.jobId), job); } catch (error) { this.active--; this.owned.delete(job.jobId); throw error; }
    this.queue = this.queue.then(async () => {
      try {
        job.status = 'running'; job.updatedAt = new Date().toISOString(); await atomicJson(this.file(job.jobId), job);
        job.source = await (this.renderer ?? this.render.bind(this))(input, this.file(job.jobId, 'png'), origin);
        const info = await sharp(this.file(job.jobId, 'png')).metadata();
        if (info.format !== 'png' || !info.width || !info.height) throw new Error('Invalid PNG');
        job.status = 'ready'; job.width = info.width; job.height = info.height; job.downloadUrl = `/api/v1/posters/${job.jobId}/file`;
      } catch { job.status = 'failed'; job.error = { code: 'EXPORT_FAILED', message: '海报生成失败。请检查Blender/浏览器依赖后重试。' }; }
      finally { job.updatedAt = new Date().toISOString(); await atomicJson(this.file(job.jobId), job); this.active--; this.owned.delete(job.jobId); }
    }).catch(() => { this.active = Math.max(0, this.active - 1); this.owned.delete(job.jobId); });
    return structuredClone(job);
  }
  async idle() { await this.queue; }
  private async render(input: PosterInput, destination: string, origin: string): Promise<'prebuilt' | 'rendered'> {
    if (input.buildingId === 'classic') {
      const name = `test_building_1_${input.face}_${input.theme}.png`;
      const cached = path.join(this.config.projectRoot, 'outputs/posters', name);
      try { await fs.copyFile(cached, destination); return 'prebuilt'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const output = path.join(this.folder, `${path.basename(destination, '.png')}-render`);
      await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.config.projectRoot, 'scripts/Render-Poster.ps1'),
        '-InputModel', path.join(this.config.projectRoot, 'test_building_1.blend'), '-Theme', input.theme, '-Face', input.face, '-OutputDir', output, '-NoInstall'],
      { windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
      await fs.copyFile(path.join(output, name), destination); return 'rendered';
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      await page.goto(origin + '/buildings/ecology/?api=v1&render=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => (window as any).layeredLifeViewer?.getState().ready, undefined, { timeout: 60000 });
      const data = await page.evaluate(async view => {
        const viewer = (window as any).layeredLifeViewer;
        viewer.setView(view);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const blob: Blob = await viewer.renderPosterBlob();
        return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
      }, input.view);
      await fs.writeFile(destination, Buffer.from(data, 'base64'));
      return 'rendered';
    } finally { await browser.close(); }
  }
}
