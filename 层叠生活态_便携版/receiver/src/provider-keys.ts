import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type express from 'express';

export const keyNames = ['DEEPSEEK_API_KEY', 'RODIN_API_KEY', 'QWEN_API_KEY'] as const;
export type ProviderKeys = Record<typeof keyNames[number], string>;
export const providerKeysPath = (root: string) => path.join(root, '.local', 'api-keys.json');
const emptyKeys = (): ProviderKeys => ({ DEEPSEEK_API_KEY: '', RODIN_API_KEY: '', QWEN_API_KEY: '' });

function validate(value: unknown): ProviderKeys {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_KEYS');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keyNames.length || keyNames.some(name =>
    typeof data[name] !== 'string' || (data[name] as string).length > 4096 || /\s/.test(data[name] as string))) {
    throw new Error('INVALID_KEYS');
  }
  return Object.fromEntries(keyNames.map(name => [name, data[name]])) as ProviderKeys;
}

export function readProviderKeys(root: string): ProviderKeys {
  const file = providerKeysPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(emptyKeys(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('KEY_FILE_UNAVAILABLE'); }
  try { return validate(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
  catch { throw new Error('KEY_FILE_INVALID'); }
}

// A blank field preserves its stored value; explicit clearing is possible in the private JSON.
export function saveProviderKeys(root: string, input: unknown): ProviderKeys {
  const updates = validate(input), current = readProviderKeys(root);
  for (const name of keyNames) if (updates[name]) current[name] = updates[name];
  const file = providerKeysPath(root), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return current;
}

export function registerProviderKeys(app: express.Express, root: string): void {
  readProviderKeys(root);
  app.use('/api/provider-keys', (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // JSON parser messages can include request fragments, which may contain keys.
    res.set('Cache-Control', 'no-store').status(400).json({ error: '请求格式无效，请使用配置页面重新保存。' });
  });
  const status = (keys: ProviderKeys) => ({ configured: Object.fromEntries(keyNames.map(name => [name, Boolean(keys[name])])) });
  app.all('/api/provider-keys', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const host = req.get('host') || '';
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
    if (!local || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) ||
        (req.get('origin') && req.get('origin') !== `${req.protocol}://${host}`) ||
        req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: '仅支持本机同源访问。' }); return;
    }
    try {
      if (req.method === 'GET') { res.json(status(readProviderKeys(root))); return; }
      if (req.method !== 'POST') { res.status(405).json({ error: '不支持此操作。' }); return; }
      if (!req.is('application/json')) { res.status(415).json({ error: '请使用 JSON 提交。' }); return; }
      res.json(status(saveProviderKeys(root, req.body)));
    } catch (error) {
      const invalid = error instanceof Error && error.message === 'INVALID_KEYS';
      res.status(invalid ? 400 : 500).json({ error: invalid
        ? '请填写三个有效的 Key 字段，Key 中不能含空格或换行。'
        : '无法读取或保存 .local/api-keys.json，请检查文件格式和写入权限。' });
    }
  });
}
