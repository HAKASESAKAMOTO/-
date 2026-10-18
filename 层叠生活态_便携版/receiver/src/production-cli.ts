// Runs the production chain for the current session outside the HTTP server (no workspace writes).
// The server later imports the finished assets; every step is resumable and idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { BuildingProduction } from './building-production.js';
import { readProviderKeys } from './provider-keys.js';

const config = getConfig();
readProviderKeys(config.projectRoot);
const env = path.join(config.projectRoot, '.env.local');
if (fs.existsSync(env)) process.loadEnvFile(env);
const sessions = new SessionStore(config.sessionsDir);
const session = await sessions.load();
if (!session) throw new Error('没有当前会话');
const production = new BuildingProduction(config, sessions, null, null);
const timer = setInterval(async () => {
  const state = await production.read(session.sessionId).catch(() => null);
  if (state) console.log(new Date().toLocaleTimeString(), state.status, state.photos.map(p => `${p.userLabel}/${p.aiName ?? '?'}:${p.analysis}`).join(' '), '|', state.objects.map(o => o.status[0]).join(''));
}, 20_000);
const result = await production.ensureRunning(session.sessionId);
clearInterval(timer);
console.log(JSON.stringify(result, null, 2));
