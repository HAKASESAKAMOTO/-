import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReceiverServices } from './server.js';
import { AppError, ApplicationStore, atomicJson, type AssetRecord, type SceneRecord } from './application-store.js';
import type { ProductionState } from './building-production.js';

const execute = promisify(execFile);
const TECHATHON = 'Techathon_完整交付_20261017';

type SceneMode = 'manifest' | 'proxy';

export interface SceneObject {
  id: string; photoId: string; floor: number; source: 'user' | 'ai'; displayName: string;
  asset: string | null; origin: 'generated' | 'library' | 'proxy'; allowProxy: boolean; inputVersion: number; skipped?: boolean;
}

export interface SceneManifest {
  schemaVersion: '1.0'; sceneId: string; sessionId: string; template: string; templateVersion: string;
  coordinateSystem: 'Y_UP'; mode: SceneMode; objects: SceneObject[]; createdAt: string;
}

export class PipelineService {
  private readonly templatePath: string;
  private readonly sceneRoot: string;

  constructor(private readonly services: ReceiverServices, private readonly store: ApplicationStore) {
    this.templatePath = path.join(services.config.projectRoot, TECHATHON, 'pipelines/model-production/examples/template.json');
    this.sceneRoot = path.join(services.config.projectRoot, TECHATHON, 'pipelines/model-production');
  }

  async status(sessionId: string) {
    const workspace = await this.store.read(sessionId);
    const assets = Object.values(workspace.assets ?? {}).map(asset => this.publicAsset(sessionId, asset));
    return { sessionId, assetCount: assets.length, assets, scene: workspace.scene };
  }

  async importAsset(sessionId: string, objectId: string, inputVersion: number, origin: 'generated' | 'library', sourcePath: string): Promise<AssetRecord> {
    const parsed = /^(.+):(user|ai)$/.exec(objectId);
    if (!parsed) throw new AppError('INVALID_OBJECT_ID', 'objectId 必须使用 photoId:user 或 photoId:ai 格式。');
    const photoId = parsed[1], source = parsed[2] as 'user' | 'ai';
    const photo = this.store.photo(sessionId, photoId);
    const workspace = await this.store.read(sessionId);
    const annotation = workspace.annotations[photoId];
    if (!annotation || annotation.inputVersion !== inputVersion) throw new AppError('VERSION_CONFLICT', '物件资产必须匹配当前照片标注版本。', 409);
    if (!await this.exists(this.templatePath)) throw new AppError('TECHATHON_DELIVERY_MISSING', 'Techathon 场景生产模板不存在。', 500);
    const header = Buffer.alloc(12);
    const handle = await fs.open(sourcePath, 'r');
    try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
    if (header.subarray(0, 4).toString('ascii') !== 'glTF' || header.readUInt32LE(4) !== 2) throw new AppError('INVALID_GLB', '只接受 glTF 2.0 GLB 文件。');
    const stat = await fs.stat(sourcePath);
    if (stat.size < 20 || stat.size > 100 * 1024 * 1024 || header.readUInt32LE(8) !== stat.size) throw new AppError('INVALID_GLB', 'GLB 文件长度或大小无效。');
    const digest = await this.sha256(sourcePath);
    const directory = path.join(this.services.config.sessionsDir, sessionId, 'assets');
    await fs.mkdir(directory, { recursive: true });
    const safeObjectId = objectId.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const filename = `${safeObjectId}-v${inputVersion}-${digest.slice(0, 12)}.glb`;
    const target = path.join(directory, filename);
    await fs.copyFile(sourcePath, target);
    const relativePath = path.relative(this.services.config.projectRoot, target).replaceAll(path.sep, '/');
    const asset: AssetRecord = { objectId, photoId, source, origin, inputVersion, relativePath, sha256: digest, bytes: stat.size, importedAt: new Date().toISOString() };
    await this.store.transaction(sessionId, current => { current.assets[objectId] = asset; current.scene = null; });
    void photo;
    return asset;
  }

  async assetFile(sessionId: string, objectId: string): Promise<string> {
    const workspace = await this.store.read(sessionId);
    const asset = workspace.assets[objectId];
    if (!asset) throw new AppError('ASSET_NOT_FOUND', '找不到这个物件资产。', 404);
    const target = path.resolve(this.services.config.projectRoot, asset.relativePath);
    const root = path.resolve(this.services.config.dataRoot);
    if (target !== root && !target.startsWith(root + path.sep)) throw new AppError('INVALID_ASSET_PATH', '资产路径不在会话数据目录中。', 500);
    return target;
  }

  async createScene(sessionId: string, mode: SceneMode = 'manifest'): Promise<SceneManifest & { status: SceneRecord['status']; missingObjectIds: string[] }> {
    if (!['manifest', 'proxy'].includes(mode)) throw new AppError('INVALID_SCENE_MODE', '场景模式必须是 manifest 或 proxy。');
    const session = this.store.current(sessionId);
    const workspace = await this.store.read(sessionId);
    const photos = session.images.filter(image => image.status === 'READY').sort((a, b) => a.index - b.index);
    if (photos.length !== 6) throw new AppError('PHOTOS_INCOMPLETE', '需要先完成6张照片接收。', 409);
    const missingAnnotations = photos.filter(photo => !workspace.annotations[photo.imageId]);
    if (missingAnnotations.length) throw new AppError('ANNOTATIONS_INCOMPLETE', `还有 ${missingAnnotations.length} 张照片未完成标注。`, 409);
    const template = JSON.parse(await fs.readFile(this.templatePath, 'utf8')) as { version?: string };
    const objects: SceneObject[] = [];
    const missingObjectIds: string[] = [];
    let production: ProductionState | null = null;
    try { production = JSON.parse(await fs.readFile(path.join(this.services.config.sessionsDir, sessionId, 'production/state.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const [floor, photo] of photos.entries()) {
      const annotation = workspace.annotations[photo.imageId];
      const aiName = this.aiName(workspace.analyses[photo.imageId]?.result) ?? 'AI候选物件';
      for (const [source, displayName] of [['user', annotation.userLabel], ['ai', aiName] ] as const) {
        const objectId = `${photo.imageId}:${source}`;
        const skipped = production?.sessionId === sessionId && production.status === 'ready' && production.objects.some(object => object.objectId === objectId && object.inputVersion === annotation.inputVersion && object.status === 'skipped');
        const asset = workspace.assets[objectId];
        const currentAsset = !skipped && asset?.inputVersion === annotation.inputVersion ? asset : undefined;
        if (!currentAsset && !skipped && mode === 'manifest') missingObjectIds.push(objectId);
        objects.push({ id: objectId, photoId: photo.imageId, floor, source, displayName, asset: currentAsset?.relativePath ?? null,
          origin: currentAsset?.origin ?? 'proxy', allowProxy: !skipped && mode === 'proxy', inputVersion: annotation.inputVersion, ...(skipped ? { skipped: true } : {}) });
      }
    }
    const now = new Date().toISOString();
    const sceneId = `scene_${sessionId}_v${Date.now()}`;
    const directory = path.join(this.services.config.sessionsDir, sessionId, 'scenes');
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(this.templatePath, path.join(directory, 'template.json'));
    const manifest: SceneManifest = { schemaVersion: '1.0', sceneId, sessionId, template: 'template.json',
      templateVersion: template.version ?? 'unknown', coordinateSystem: 'Y_UP', mode, objects, createdAt: now };
    for (const object of manifest.objects) if (object.asset) object.asset = path.relative(directory, path.resolve(this.services.config.projectRoot, object.asset)).replaceAll(path.sep, '/');
    const manifestPath = path.join(directory, `${sceneId}.json`);
    await atomicJson(manifestPath, manifest);
    const relativePath = path.relative(this.services.config.projectRoot, manifestPath).replaceAll(path.sep, '/');
    const assetCount = objects.filter(object => object.asset).length;
    const status: SceneRecord['status'] = mode === 'proxy' ? 'proxy_ready' : missingObjectIds.length ? 'awaiting_assets' : 'ready_for_build';
    const scene: SceneRecord = { sceneId, status, mode, relativePath, objectCount: objects.filter(object => !object.skipped).length, assetCount, missingObjectIds, createdAt: now, updatedAt: now };
    await this.store.transaction(sessionId, current => { current.scene = scene; });
    return { ...manifest, status, missingObjectIds };
  }

  async getScene(sessionId: string): Promise<(SceneManifest & { status: SceneRecord['status']; missingObjectIds: string[] }) | null> {
    const workspace = await this.store.read(sessionId);
    if (!workspace.scene) return null;
    const file = path.resolve(this.services.config.projectRoot, workspace.scene.relativePath);
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as SceneManifest;
    return { ...manifest, status: workspace.scene.status, missingObjectIds: workspace.scene.missingObjectIds };
  }

  async buildScene(sessionId: string) {
    const workspace = await this.store.read(sessionId);
    if (!workspace.scene) throw new AppError('SCENE_NOT_FOUND', '请先创建场景清单。', 404);
    if (workspace.scene.status !== 'ready_for_build') throw new AppError('ASSETS_INCOMPLETE', '本轮待展示的物件资产尚未全部导入。', 409);
    const blender = process.env.BLENDER_EXE || 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
    if (!await this.exists(blender)) throw new AppError('BLENDER_NOT_CONFIGURED', '场景清单已就绪，但当前机器没有配置 Blender。', 503);
    const scene = await this.getScene(sessionId);
    if (!scene) throw new AppError('SCENE_NOT_FOUND', '请先创建场景清单。', 404);
    const output = path.join(this.services.config.sessionsDir, sessionId, 'scene-build', scene.sceneId);
    const script = path.join(this.sceneRoot, 'scripts/build_scene.py');
    await fs.mkdir(output, { recursive: true });
    await execute(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', '--manifest', path.resolve(this.services.config.projectRoot, workspace.scene.relativePath), '--out', output, '--skip-preview'], { windowsHide: true, timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
    await this.store.transaction(sessionId, current => { if (current.scene?.sceneId === scene.sceneId) { current.scene.status = 'built'; current.scene.updatedAt = new Date().toISOString(); } });
    return { sceneId: scene.sceneId, status: 'built', outputPath: path.relative(this.services.config.projectRoot, output).replaceAll(path.sep, '/') };
  }

  private publicAsset(sessionId: string, asset: AssetRecord) {
    const { relativePath: _relativePath, ...publicAsset } = asset;
    return { ...publicAsset, assetUrl: `/api/v1/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(asset.objectId)}/file` };
  }
  private async exists(file: string) { return fs.access(file).then(() => true, () => false); }
  private async sha256(file: string) {
    const hash = crypto.createHash('sha256');
    const data = await fs.readFile(file); hash.update(data); return hash.digest('hex');
  }
  private aiName(result: unknown) {
    const value = result as { ai_object?: { name?: unknown } } | undefined;
    return typeof value?.ai_object?.name === 'string' && value.ai_object.name.trim() ? value.ai_object.name.trim().slice(0, 80) : null;
  }
}
