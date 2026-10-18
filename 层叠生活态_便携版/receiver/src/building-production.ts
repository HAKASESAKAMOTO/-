import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { ReceiverConfig } from './config.js';
import type { SessionStore } from './session-store.js';
import type { EventBus } from './events.js';
import { atomicJson, type Annotation, type Workspace } from './application-store.js';
import { pythonRuntime } from './python-runtime.js';

const execute = promisify(execFile);
const TECHATHON = 'Techathon_完整交付_20261017';
const RODIN_CONCURRENCY = 3;

type Step = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
export interface ProductionPhoto {
  photoId: string; order: number; inputVersion: number; userLabel: string;
  analysis: Step; aiName: string | null; aiReason: string | null; aiBbox: number[] | null; error: string | null;
}
export interface ProductionObject {
  objectId: string; photoId: string; source: 'user' | 'ai'; floor: number; label: string; inputVersion: number;
  status: Step; glb: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface ProductionState {
  schemaVersion: '1.0'; sessionId: string;
  status: 'idle' | 'analyzing' | 'generating' | 'importing' | 'ready' | 'failed';
  photos: ProductionPhoto[]; objects: ProductionObject[]; error: string | null; startedAt: string | null; updatedAt: string;
}
/** Optional hook used by the server to copy finished assets into the workspace. */
export type ImportHook = (state: ProductionState, analyses: Record<string, unknown>) => Promise<void>;

/**
 * Full chain after six annotations: AI analysis (new object + new word) -> crops -> Rodin GLB -> building ready.
 * Every step is resumable and file-backed; Rodin submissions are deduplicated by rodin.py's deterministic task key,
 * so restarting never pays twice for the same crop.
 */
export class BuildingProduction {
  private running = new Map<string, Promise<ProductionState>>();
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private config: ReceiverConfig, private sessions: SessionStore, private events: EventBus | null, private importHook: ImportHook | null) {}

  dir(sessionId: string) { return path.join(this.config.sessionsDir, sessionId, 'production'); }
  private stateFile(sessionId: string) { return path.join(this.dir(sessionId), 'state.json'); }

  async read(sessionId: string): Promise<ProductionState | null> {
    try { return JSON.parse(await fs.readFile(this.stateFile(sessionId), 'utf8')) as ProductionState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private async update(sessionId: string, mutate: (state: ProductionState) => void): Promise<ProductionState> {
    const operation = this.lock.then(async () => {
      const state = await this.read(sessionId);
      if (!state) throw new Error('production state missing');
      mutate(state); state.updatedAt = new Date().toISOString();
      await atomicJson(this.stateFile(sessionId), state);
      return state;
    });
    this.lock = operation.catch(() => undefined);
    const state = await operation;
    this.events?.emitEphemeral({ sessionId, eventType: 'production.progress', timestamp: state.updatedAt, data: { status: state.status } });
    return state;
  }

  isRunning(sessionId: string) { return this.running.has(sessionId) || this.lockOwner(sessionId) !== null; }

  /** Another process (CLI or a second server) holding a live lock means the run is already in progress. */
  private lockOwner(sessionId: string): number | null {
    try {
      const pid = Number(readFileSync(path.join(this.dir(sessionId), 'run.lock'), 'utf8'));
      if (!Number.isInteger(pid) || pid === process.pid) return null;
      process.kill(pid, 0); return pid;
    } catch { return null; }
  }
  private async withProcessLock(sessionId: string, action: () => Promise<ProductionState>): Promise<ProductionState> {
    const owner = this.lockOwner(sessionId);
    if (owner !== null) { const state = await this.read(sessionId); if (state) return state; throw new Error(`生产任务已由进程 ${owner} 运行`); }
    const lock = path.join(this.dir(sessionId), 'run.lock');
    await fs.mkdir(this.dir(sessionId), { recursive: true });
    await fs.writeFile(lock, String(process.pid));
    try { return await action(); } finally { await fs.rm(lock, { force: true }).catch(() => undefined); }
  }

  /** Fire-and-forget, single flight per session. */
  ensureRunning(sessionId: string): Promise<ProductionState> {
    const existing = this.running.get(sessionId);
    if (existing) return existing;
    const job = this.withProcessLock(sessionId, () => this.run(sessionId)).finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, job);
    job.catch(() => undefined);
    return job;
  }

  private async workspace(sessionId: string): Promise<Workspace> {
    const raw = JSON.parse(await fs.readFile(path.join(this.config.sessionsDir, sessionId, 'workspace.json'), 'utf8'));
    return { schemaVersion: '1.1', sessionId, annotations: raw.annotations ?? {}, analyses: raw.analyses ?? {}, assets: raw.assets ?? {}, scene: raw.scene ?? null };
  }

  private photos(sessionId: string) {
    const session = this.sessions.get();
    if (session.sessionId !== sessionId) throw new Error('会话已切换');
    return session.images.filter(image => image.status === 'READY').sort((a, b) => a.index - b.index);
  }

  /** Builds or refreshes the plan; photos whose annotation version changed are reset. */
  private async plan(sessionId: string): Promise<ProductionState> {
    const images = this.photos(sessionId), workspace = await this.workspace(sessionId);
    if (images.length < 6 || images.slice(0, 6).some(image => !workspace.annotations[image.imageId])) throw new Error('六张照片尚未全部标注');
    const previous = await this.read(sessionId);
    const now = new Date().toISOString();
    const photos: ProductionPhoto[] = [], objects: ProductionObject[] = [];
    images.slice(0, 6).forEach((image, order) => {
      const annotation = workspace.annotations[image.imageId];
      const old = previous?.photos.find(item => item.photoId === image.imageId && item.inputVersion === annotation.inputVersion);
      photos.push(old ? { ...old, order } : { photoId: image.imageId, order, inputVersion: annotation.inputVersion, userLabel: annotation.userLabel, analysis: 'pending', aiName: null, aiReason: null, aiBbox: null, error: null });
      for (const source of ['user', 'ai'] as const) {
        const objectId = `${image.imageId}:${source}`;
        const prior = previous?.objects.find(item => item.objectId === objectId && item.inputVersion === annotation.inputVersion);
        objects.push(prior ? { ...prior, floor: order } : { objectId, photoId: image.imageId, source, floor: order, label: source === 'user' ? annotation.userLabel : 'AI 新物体', inputVersion: annotation.inputVersion, status: 'pending', glb: null, error: null, startedAt: null, finishedAt: null });
      }
    });
    // Resume interrupted work, but do not let a rejected object block the rest of the building.
    for (const object of objects) if (object.status === 'running') object.status = 'pending';
    // A ready object whose browser copy is gone (e.g. re-encoded at a new quality) is rebuilt from the paid download.
    for (const object of objects) if (object.status === 'ready' && (!object.glb || !await fs.access(path.resolve(this.config.projectRoot, object.glb)).then(() => true, () => false))) { object.status = 'pending'; object.glb = null; }
    for (const photo of photos) {
      if (photo.analysis === 'running') { photo.analysis = 'pending'; photo.error = null; }
      if (photo.analysis === 'failed') {
        photo.analysis = 'skipped';
        const ai = objects.find(object => object.photoId === photo.photoId && object.source === 'ai')!;
        if (ai.status !== 'ready') { ai.status = 'skipped'; ai.error = photo.error || 'AI 识别失败，已跳过此候选物件'; ai.glb = null; }
      }
    }
    // Also recover runs saved by older versions, retaining the original failure details.
    for (const object of objects) if (object.status === 'failed') { object.status = 'skipped'; object.glb = null; }
    const state: ProductionState = { schemaVersion: '1.0', sessionId, status: 'analyzing', photos, objects, error: null, startedAt: previous?.startedAt ?? now, updatedAt: now };
    await atomicJson(this.stateFile(sessionId), state);
    return state;
  }

  private async run(sessionId: string): Promise<ProductionState> {
    try {
      let state = await this.plan(sessionId);
      if (state.objects.every(object => object.status === 'ready' || object.status === 'skipped')) return await this.finish(sessionId);
      const workspace = await this.workspace(sessionId);
      const images = this.photos(sessionId);
      // 1) AI analysis, serial (one paid vision call at a time).
      for (const photo of state.photos) {
        if (photo.analysis === 'ready' || photo.analysis === 'skipped') continue;
        await this.update(sessionId, s => { const p = s.photos.find(x => x.photoId === photo.photoId)!; p.analysis = 'running'; });
        const image = images.find(item => item.imageId === photo.photoId)!;
        try {
          const result = await this.analyze(sessionId, workspace.annotations[photo.photoId], path.resolve(this.config.projectRoot, image.processedPath));
          const candidate = result.ai_object ?? result.alternatives?.[0] ?? null;
          await this.update(sessionId, s => {
            const p = s.photos.find(x => x.photoId === photo.photoId)!;
            p.analysis = 'ready'; p.aiName = candidate?.name ?? null; p.aiReason = candidate?.reason ?? null; p.aiBbox = candidate?.bbox ?? null;
            const object = s.objects.find(x => x.objectId === `${photo.photoId}:ai`)!;
            if (candidate) object.label = candidate.name; else { object.status = 'skipped'; object.error = 'AI 未找到可靠的新物体'; }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.update(sessionId, s => {
            const p = s.photos.find(x => x.photoId === photo.photoId)!;
            p.analysis = 'skipped'; p.error = message.slice(0, 300);
            const ai = s.objects.find(x => x.photoId === photo.photoId && x.source === 'ai')!;
            ai.status = 'skipped'; ai.glb = null; ai.error = p.error; ai.finishedAt = new Date().toISOString();
          });
        }
      }
      state = (await this.read(sessionId))!;
      // 2) Crops + Rodin, limited concurrency.
      state = await this.update(sessionId, s => { s.status = 'generating'; });
      const queue = state.objects.filter(object => object.status === 'pending');
      const worker = async () => {
        for (let object = queue.shift(); object; object = queue.shift()) await this.generate(sessionId, object, workspace.annotations[object.photoId], state.photos.find(p => p.photoId === object!.photoId)!, images.find(i => i.imageId === object!.photoId)!.processedPath);
      };
      // Never release the run lock while sibling workers can still write or submit jobs.
      const workers = await Promise.allSettled(Array.from({ length: RODIN_CONCURRENCY }, worker));
      const rejected = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      state = (await this.read(sessionId))!;
      return await this.finish(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await this.read(sessionId)) return this.update(sessionId, s => { s.status = 'failed'; s.error = message.slice(0, 300); });
      throw error;
    }
  }

  private async finish(sessionId: string): Promise<ProductionState> {
    let state = (await this.read(sessionId))!;
    if (state.objects.some(object => object.status === 'pending' || object.status === 'running')) throw new Error('仍有模型未处理完成，暂不能结束本轮建模。');
    if (!state.objects.some(object => object.status === 'ready' && object.glb)) {
      return this.update(sessionId, s => { s.status = 'failed'; s.error = '本轮没有成功生成的模型；已保留照片和标注，请更换物件或图片后重试。'; });
    }
    if (!this.importHook) return this.update(sessionId, s => { s.status = 'importing'; });
    state = await this.update(sessionId, s => { s.status = 'importing'; });
    const analyses: Record<string, unknown> = {};
    for (const photo of state.photos) analyses[photo.photoId] = await this.readAnalysis(sessionId, photo.photoId, photo.inputVersion);
    await this.importHook(state, analyses);
    return this.update(sessionId, s => { s.status = 'ready'; s.error = null; });
  }

  private analysisFile(sessionId: string, photoId: string, version: number) { return path.join(this.dir(sessionId), `analysis-${photoId}-v${version}.json`); }
  private async readAnalysis(sessionId: string, photoId: string, version: number) {
    try { return JSON.parse((await fs.readFile(this.analysisFile(sessionId, photoId, version), 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
  }

  private async analyze(sessionId: string, annotation: Annotation, imagePath: string): Promise<any> {
    const output = this.analysisFile(sessionId, annotation.photoId, annotation.inputVersion);
    const cached = await this.readAnalysis(sessionId, annotation.photoId, annotation.inputVersion);
    if (cached?.photo_id === annotation.photoId && ['success', 'no_reliable_object'].includes(cached.status)) return cached;
    await fs.mkdir(this.dir(sessionId), { recursive: true });
    const script = path.join(this.config.projectRoot, 'scripts/test_deepseek_json_mode.ps1');
    const prompt = process.env.ANALYSIS_SYSTEM_PROMPT || path.join(this.config.projectRoot, 'deepseek-image-analysis/system-prompt.txt');
    const inputFile = output.replace(/\.json$/, '.input.json');
    const box = annotation.userBox;
    await fs.writeFile(inputFile, JSON.stringify({ photo_id: annotation.photoId, user_object_label: annotation.userLabel,
      user_object_bbox: box ? [box.x, box.y, box.w, box.h] : null, user_object_point: [annotation.userPoint.x, annotation.userPoint.y],
      user_emotion_label: annotation.emotion.label ?? '', user_emotion_coordinates: { valence: annotation.emotion.valence, arousal: annotation.emotion.arousal }, asset_catalog: [] }), 'utf8');
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Fixed script and argv array; user labels are never interpolated into a shell string.
        await execute(process.env.POWERSHELL_EXE || 'pwsh.exe', ['-NoProfile', '-File', script, '-SystemPromptPath', prompt, '-ImagePath', imagePath,
          '-PhotoId', annotation.photoId, '-UserObjectLabel', annotation.userLabel, '-UserEmotionLabel', annotation.emotion.label ?? '',
          '-Valence', String(annotation.emotion.valence ?? 0), '-Arousal', String(annotation.emotion.arousal ?? 0), '-OutputPath', output, '-InputJsonPath', inputFile],
        { windowsHide: true, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
        const result = await this.readAnalysis(sessionId, annotation.photoId, annotation.inputVersion);
        if (result?.photo_id === annotation.photoId && ['success', 'no_reliable_object'].includes(result.status)) return result;
        lastError = new Error('分析结果格式无效');
      } catch (error) { lastError = new Error('AI 分析调用失败：' + ((error as { stderr?: string }).stderr || (error as Error).message).toString().slice(-300)); }
    }
    throw lastError;
  }

  private async crop(sessionId: string, object: ProductionObject, annotation: Annotation, photo: ProductionPhoto, processedPath: string) {
    const file = path.join(this.dir(sessionId), 'crops', `${object.photoId}-${object.source}-v${object.inputVersion}.png`);
    if (await fs.access(file).then(() => true, () => false)) return file;
    const source = path.resolve(this.config.projectRoot, processedPath);
    const oriented = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
    const { width, height } = oriented.info;
    let box: [number, number, number, number];
    if (object.source === 'ai') {
      const [x, y, w, h] = photo.aiBbox!; const pad = 0.12;
      box = [x - w * pad, y - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad)];
    } else if (annotation.userBox) {
      const b = annotation.userBox; box = [b.x - b.w * 0.08, b.y - b.h * 0.08, b.w * 1.16, b.h * 1.16];
    } else {
      // Only a tap point is known: take a square around it, 55% of the short edge.
      const side = 0.55 * Math.min(width, height);
      box = [annotation.userPoint.x - side / width / 2, annotation.userPoint.y - side / height / 2, side / width, side / height];
    }
    const left = Math.max(0, Math.round(box[0] * width)), top = Math.max(0, Math.round(box[1] * height));
    const right = Math.min(width, Math.round((box[0] + box[2]) * width)), bottom = Math.min(height, Math.round((box[1] + box[3]) * height));
    if (right - left < 16 || bottom - top < 16) throw new Error('物件区域太小，无法裁剪');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp(oriented.data).extract({ left, top, width: right - left, height: bottom - top })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toFile(file);
    return file;
  }

  private async generate(sessionId: string, object: ProductionObject, annotation: Annotation, photo: ProductionPhoto, processedPath: string) {
    const mark = (patch: Partial<ProductionObject>) => this.update(sessionId, s => { Object.assign(s.objects.find(x => x.objectId === object.objectId)!, patch); });
    await mark({ status: 'running', startedAt: new Date().toISOString(), error: null });
    try {
      const image = await this.crop(sessionId, object, annotation, photo, processedPath);
      const rodinDir = path.join(this.dir(sessionId), 'rodin');
      const db = path.join(rodinDir, `${object.objectId.replace(/[^a-zA-Z0-9_-]/g, '_')}.sqlite3`);
      const script = path.join(this.config.projectRoot, TECHATHON, 'pipelines/model-production/scripts/rodin.py');
      const python = await pythonRuntime(this.config.projectRoot);
      await fs.mkdir(rodinDir, { recursive: true });
      const run = async (args: string[]) => {
        const { stdout } = await execute(python, [script, '--db', db, ...args], { windowsHide: true, timeout: 1_800_000, maxBuffer: 4 * 1024 * 1024, cwd: this.config.projectRoot, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        const parsed = JSON.parse(stdout) as { key: string; state: string; asset_path?: string; path?: string };
        // rodin.py returns 'path' for a fresh download and 'asset_path' for an already-downloaded row.
        return { ...parsed, asset_path: parsed.asset_path ?? parsed.path };
      };
      let result = await run(['submit', '--object-id', object.objectId, '--image', image, '--version', String(object.inputVersion), '--session', sessionId, '--wait', '1500', '--out', rodinDir]);
      for (let i = 0; i < 4 && result.state !== 'DOWNLOADED'; i++) result = await run(['resume', result.key, '--wait', '900', '--out', rodinDir]);
      if (result.state !== 'DOWNLOADED' || !result.asset_path) throw new Error('Rodin 任务仍未完成，稍后重试会续接原任务，不会重复扣费。');
      // Rodin GLBs are ~30 MB / 500k triangles with three 2048 PNG maps. The browser copy keeps 2048 maps and
      // half the vertices (tight error bound), WebP q92 for color/ORM, near-lossless normals, then Draco: ~4 MB.
      const web = path.join(this.dir(sessionId), 'web', `${object.objectId.replace(/[^a-zA-Z0-9_-]/g, '_')}-v${object.inputVersion}-q2.glb`);
      if (!await fs.access(web).then(() => true, () => false)) {
        await fs.mkdir(path.dirname(web), { recursive: true });
        const cli = path.join(this.config.projectRoot, 'receiver/node_modules/@gltf-transform/cli/bin/cli.js');
        const step = (args: string[]) => execute(process.execPath, [cli, ...args], { windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
        const a = web + '.a.glb', b = web + '.b.glb', c = web + '.c.glb';
        try {
          await step(['optimize', result.asset_path, a, '--compress', 'false', '--texture-compress', 'false', '--texture-size', '2048', '--simplify-ratio', '0.5', '--simplify-error', '0.0005']);
          await step(['webp', a, b, '--slots', '{baseColorTexture,metallicRoughnessTexture}', '--quality', '92']);
          await step(['webp', b, c, '--slots', 'normalTexture', '--near-lossless', 'true']);
          await step(['draco', c, web + '.part.glb']);
          await fs.rename(web + '.part.glb', web);
        } finally { await Promise.all([a, b, c].map(file => fs.rm(file, { force: true }))); }
      }      await mark({ status: 'ready', glb: path.relative(this.config.projectRoot, web).replaceAll(path.sep, '/'), finishedAt: new Date().toISOString() });
    } catch (error) {
      const detail = ((error as { stderr?: string }).stderr || (error as Error).message || String(error)).toString().trim().split(/\r?\n/).slice(-2).join(' ');
      await mark({ status: 'skipped', glb: null, error: detail.slice(0, 300), finishedAt: new Date().toISOString() });
    }
  }
}
