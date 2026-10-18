import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './atomic-file.js';
export { atomicJson } from './atomic-file.js';
import sharp from 'sharp';
import type { ReceiverServices } from './server.js';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface EmotionValue {
  status: 'selected' | 'unsure'; label: string | null; valence: number | null; arousal: number | null;
  selection: Record<string, unknown> | null;
}
export interface Annotation {
  photoId: string; objectId: string; inputVersion: number; userLabel: string;
  userPoint: { x: number; y: number }; userBox: { x: number; y: number; w: number; h: number } | null;
  referenceTime: 'capture' | 'review'; emotion: EmotionValue; savedAt: string;
}
export interface AnalysisRecord { photoId: string; inputVersion: number; status: 'running' | 'ready' | 'failed'; result?: unknown; error?: { code: string; message: string }; updatedAt: string }
export interface AssetRecord {
  objectId: string; photoId: string; source: 'user' | 'ai'; origin: 'generated' | 'library'; inputVersion: number;
  relativePath: string; sha256: string; bytes: number; importedAt: string;
}
export interface SceneRecord {
  sceneId: string; status: 'awaiting_assets' | 'ready_for_build' | 'proxy_ready' | 'built' | 'failed'; mode: 'manifest' | 'proxy';
  relativePath: string; objectCount: number; assetCount: number; missingObjectIds: string[]; createdAt: string; updatedAt: string;
}
export interface Workspace {
  schemaVersion: '1.1'; sessionId: string; annotations: Record<string, Annotation>; analyses: Record<string, AnalysisRecord>;
  assets: Record<string, AssetRecord>; scene: SceneRecord | null;
}
const words = [['轻快','愉快','开心','狂喜'],['好奇','期待','兴奋','狂热'],['不安','紧张','焦虑','惊恐'],['介意','烦躁','愤怒','暴怒'],['低落','失落','悲伤','悲恸'],['倦怠','孤单','孤独','绝望'],['松弛','放松','宁静','安详'],['舒适','温暖','满足','幸福']];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
export function validateAnnotation(input: any): Omit<Annotation, 'photoId' | 'objectId' | 'inputVersion' | 'savedAt'> {
  if (!input || typeof input !== 'object' || typeof input.userLabel !== 'string' || !input.userLabel.trim() || input.userLabel.trim().length > 80) throw new AppError('INVALID_LABEL', '请填写物件名称（最多80字）。');
  if (!unit(input.userPoint?.x) || !unit(input.userPoint?.y)) throw new AppError('INVALID_POINT', '关注位置必须在图片内。');
  const box = input.userBox ?? null;
  if (box && (!unit(box.x) || !unit(box.y) || !unit(box.w) || !unit(box.h) || box.w <= 0 || box.h <= 0 || box.x + box.w > 1.000001 || box.y + box.h > 1.000001)) throw new AppError('INVALID_BOX', '物件框超出图片范围。');
  if (!['capture', 'review'].includes(input.referenceTime)) throw new AppError('INVALID_REFERENCE_TIME', '请选择拍摄时或回看时的感受。');
  let emotion: EmotionValue;
  if (input.emotion?.status === 'unsure') {
    emotion = { status: 'unsure', label: null, valence: null, arousal: null, selection: null };
  } else {
    const selection = input.emotion?.selection;
    const center = selection?.sector === null && selection?.ring === 0;
    const cell = Number.isInteger(selection?.sector) && selection.sector >= 0 && selection.sector < 8 && Number.isInteger(selection?.ring) && selection.ring >= 1 && selection.ring <= 4;
    if (input.emotion?.status !== 'selected' || !selection || selection.phase !== 'confirmed' || (!center && !cell) || !finite(selection.x) || !finite(selection.y) || Math.hypot(selection.x, selection.y) > 1.000001) throw new AppError('INVALID_EMOTION', '请确认情绪，或选择“不确定”。');
    const label = center ? '复杂' : words[selection.sector][selection.ring - 1];
    if (selection.emotion !== label) throw new AppError('INVALID_EMOTION', '情绪词与环层不一致。');
    emotion = { status: 'selected', label, valence: selection.x, arousal: selection.y, selection: structuredClone(selection) };
  }
  return { userLabel: input.userLabel.trim(), userPoint: { x: input.userPoint.x, y: input.userPoint.y }, userBox: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null, referenceTime: input.referenceTime, emotion };
}
export class ApplicationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private services: ReceiverServices) {}
  current(sessionId?: string) {
    const session = this.services.sessions.get();
    if (sessionId && session.sessionId !== sessionId) throw new AppError('SESSION_CHANGED', '当前会话已切换，请返回照片接收页。', 409);
    return session;
  }
  photo(sessionId: string, photoId: string) {
    const photo = this.current(sessionId).images.find(item => item.imageId === photoId && item.status === 'READY');
    if (!photo) throw new AppError('PHOTO_NOT_FOUND', '照片已删除或不属于当前会话。', 404);
    return photo;
  }
  private filename(sessionId: string) { return path.join(this.services.config.sessionsDir, sessionId, 'workspace.json'); }
  async read(sessionId: string): Promise<Workspace> {
    this.current(sessionId);
    try {
      const workspace = JSON.parse(await fs.readFile(this.filename(sessionId), 'utf8')) as Partial<Workspace>;
      return { schemaVersion: '1.1', sessionId, annotations: workspace.annotations ?? {}, analyses: workspace.analyses ?? {}, assets: workspace.assets ?? {}, scene: workspace.scene ?? null };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: '1.1', sessionId, annotations: {}, analyses: {}, assets: {}, scene: null };
    }
  }
  async transaction<T>(sessionId: string, action: (workspace: Workspace) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const workspace = await this.read(sessionId);
      workspace.schemaVersion = '1.1'; workspace.assets ??= {}; workspace.scene ??= null;
      const result = action(workspace);
      this.current(sessionId);
      await atomicJson(this.filename(sessionId), workspace);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async save(sessionId: string, photoId: string, input: any): Promise<Annotation> {
    const value = validateAnnotation(input);
    return this.transaction(sessionId, workspace => {
      this.photo(sessionId, photoId);
      const previous = workspace.annotations[photoId];
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== (previous?.inputVersion ?? 0)) throw new AppError('VERSION_CONFLICT', '记录已在另一页面更新，请刷新后重试。', 409);
      const annotation: Annotation = { ...value, photoId, objectId: `${photoId}:user`, inputVersion: (previous?.inputVersion ?? 0) + 1, savedAt: new Date().toISOString() };
      workspace.annotations[photoId] = annotation;
      delete workspace.analyses[photoId];
      return annotation;
    });
  }
  async snapshot(sessionId?: string) {
    const session = this.current(sessionId);
    const workspace = await this.read(session.sessionId);
    const photos = await Promise.all(session.images.filter(item => item.status === 'READY').sort((a, b) => a.index - b.index).map(async item => {
      const dimensions = await sharp(path.resolve(this.services.config.projectRoot, item.processedPath)).metadata();
      return { photoId: item.imageId, order: item.index - 1, name: item.originalName, width: dimensions.width, height: dimensions.height,
        url: `/api/v1/photos/${item.imageId}/file`, thumbnailUrl: `/api/v1/photos/${item.imageId}/file?variant=thumbnail`,
        annotation: workspace.annotations[item.imageId] ?? null, analysis: workspace.analyses[item.imageId] ?? null };
    }));
    this.current(session.sessionId);
    const annotationCount = photos.filter(photo => photo.annotation).length;
    const assets = Object.values(workspace.assets ?? {});
    const readyAssets = assets.filter(asset => workspace.annotations[asset.photoId]?.inputVersion === asset.inputVersion);
    return { sessionId: session.sessionId, intakeStatus: session.status, intakeMode: session.mode, targetCount: session.targetCount, photoCount: photos.length, annotationCount,
      status: photos.length < session.targetCount ? 'COLLECTING' : annotationCount === session.targetCount ? 'ANNOTATED' : 'ANNOTATING', photos,
      errors: session.errors, nextUrl: `/emotion-wheel?sessionId=${encodeURIComponent(session.sessionId)}`, browseUrl: '/', updatedAt: session.updatedAt,
      pipeline: { assetCount: assets.length, readyAssetCount: readyAssets.length, scene: workspace.scene } };
  }
}
