import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReceiverServices } from './server.js';
import { ApplicationStore, AppError, type Annotation, type AnalysisRecord } from './application-store.js';
const execute = promisify(execFile);
export type Analyze = (annotation: Annotation, imagePath: string, outputPath: string) => Promise<unknown>;
export class AnalysisService {
  private active = new Set<string>();
  constructor(private services: ReceiverServices, private store: ApplicationStore, private analyze?: Analyze) {}
  async capability() {
    const prompt = process.env.ANALYSIS_SYSTEM_PROMPT || path.join(this.services.config.projectRoot, 'deepseek-image-analysis/system-prompt.txt');
    const configured = !!this.analyze || await fs.access(prompt).then(() => true, () => false);
    return { status: configured ? 'configured' : 'not_configured', reason: configured ? null : '请配置ANALYSIS_SYSTEM_PROMPT或放入deepseek-image-analysis/system-prompt.txt。', liveConnectionVerified: false };
  }
  async get(sessionId: string, photoId: string) {
    this.store.photo(sessionId, photoId);
    return this.store.transaction(sessionId, workspace => {
      const record = workspace.analyses[photoId];
      if (record?.status === 'running' && !this.active.has(`${sessionId}:${photoId}:${record.inputVersion}`)) {
        record.status = 'failed'; record.error = { code: 'INTERRUPTED', message: '分析被服务重启中断，请重试。' }; record.updatedAt = new Date().toISOString();
      }
      return record ?? null;
    });
  }
  async start(sessionId: string, photoId: string, expectedVersion: number) {
    if ((await this.capability()).status !== 'configured') throw new AppError('ANALYSIS_NOT_CONFIGURED', 'AI分析尚未配置系统提示词。', 503);
    const photo = this.store.photo(sessionId, photoId);
    const record = await this.store.read(sessionId);
    const annotation = record.annotations[photoId];
    if (!annotation || annotation.inputVersion !== expectedVersion) throw new AppError('VERSION_CONFLICT', '请先保存当前标注再分析。', 409);
    const key = `${sessionId}:${photoId}:${annotation.inputVersion}`;
    const existing = await this.get(sessionId, photoId);
    if (this.active.has(key) || existing?.status === 'ready') return existing;
    if (this.active.size) throw new AppError('ANALYSIS_BUSY', '已有照片正在分析，请稍后再试。', 429);
    this.active.add(key);
    const pending: AnalysisRecord = { photoId, inputVersion: annotation.inputVersion, status: 'running', updatedAt: new Date().toISOString() };
    try { await this.store.transaction(sessionId, workspace => {
      if (workspace.annotations[photoId]?.inputVersion !== annotation.inputVersion) throw new AppError('VERSION_CONFLICT', '标注已经更新，请重试。', 409);
      workspace.analyses[photoId] = pending;
    }); } catch (error) { this.active.delete(key); throw error; }
    const output = path.join(this.services.config.sessionsDir, sessionId, `analysis-${photoId}-v${annotation.inputVersion}.json`);
    void (async () => {
      let finished: AnalysisRecord;
      try {
        const result = await (this.analyze ?? this.run.bind(this))(annotation, path.resolve(this.services.config.projectRoot, photo.processedPath), output) as any;
        if (result?.photo_id !== photoId || !['success', 'no_reliable_object'].includes(result?.status)) throw new Error('Invalid result identity');
        finished = { ...pending, status: 'ready', result, updatedAt: new Date().toISOString() };
      } catch { finished = { ...pending, status: 'failed', error: { code: 'ANALYSIS_FAILED', message: '分析失败，请检查提示词、密钥和网络后重试。' }, updatedAt: new Date().toISOString() }; }
      try { await this.store.transaction(sessionId, workspace => {
        this.store.photo(sessionId, photoId);
        if (workspace.annotations[photoId]?.inputVersion === annotation.inputVersion) workspace.analyses[photoId] = finished;
      }); } catch { /* A closed session, deleted photo or newer revision never receives an old result. */ }
      finally { this.active.delete(key); }
    })();
    return pending;
  }
  private async run(annotation: Annotation, imagePath: string, output: string) {
    const script = path.join(this.services.config.projectRoot, 'scripts/test_deepseek_json_mode.ps1');
    const prompt = process.env.ANALYSIS_SYSTEM_PROMPT || path.join(this.services.config.projectRoot, 'deepseek-image-analysis/system-prompt.txt');
    const inputFile = output.replace(/\.json$/, '.input.json');
    const box = annotation.userBox;
    await fs.writeFile(inputFile, JSON.stringify({ photo_id: annotation.photoId, user_object_label: annotation.userLabel,
      user_object_bbox: box ? [box.x, box.y, box.w, box.h] : null, user_object_point: [annotation.userPoint.x, annotation.userPoint.y],
      user_emotion_label: annotation.emotion.label ?? '', user_emotion_coordinates: { valence: annotation.emotion.valence, arousal: annotation.emotion.arousal }, asset_catalog: [] }), 'utf8');
    // Fixed script path and argument vector; no shell interpolation of user labels or paths.
    await execute(process.env.POWERSHELL_EXE || 'pwsh.exe', ['-NoProfile', '-File', script, '-SystemPromptPath', prompt, '-ImagePath', imagePath,
      '-PhotoId', annotation.photoId, '-UserObjectLabel', annotation.userLabel, '-UserEmotionLabel', annotation.emotion.label ?? '',
      '-Valence', String(annotation.emotion.valence ?? 0), '-Arousal', String(annotation.emotion.arousal ?? 0), '-OutputPath', output, '-InputJsonPath', inputFile],
    { windowsHide: true, timeout: 210000, maxBuffer: 1024 * 1024 });
    return JSON.parse((await fs.readFile(output, 'utf8')).replace(/^\uFEFF/, ''));
  }
}
