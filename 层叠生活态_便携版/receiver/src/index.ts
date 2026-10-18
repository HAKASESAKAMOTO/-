import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ensureDirectories } from './config.js';
import { EventBus } from './events.js';
import { SessionStore } from './session-store.js';
import { ImageImporter } from './importer.js';
import { IncomingWatcher } from './watcher.js';
import { BrowserController } from './browser-controller.js';
import { attachWebSocket, createReceiverApp } from './server.js';
import { startHardwareService } from './hardware-service.js';

const config = getConfig();
const providerConfig = path.join(config.projectRoot, '.env.local');
if (fs.existsSync(providerConfig)) process.loadEnvFile(providerConfig);
await ensureDirectories(config);
const sessions = new SessionStore(config.sessionsDir);
// A new launch is a new round. Explicitly opt in to recovery when needed.
if (process.env.RECEIVER_RESUME_SESSION === '1') await sessions.ensure('AUTO');
else await sessions.create('AUTO');
const stopHardware = await startHardwareService(config.projectRoot);
const events = new EventBus(config.eventsDir);
const importer = new ImageImporter(config, sessions, events);
const watcher = new IncomingWatcher(config, sessions, importer, events);
const browser = new BrowserController(config, sessions, events);
const app = createReceiverApp({ config, sessions, importer, watcher, browser, events }, { autoProduction: process.env.RECEIVER_AUTO_PRODUCTION !== '0' });
const server = http.createServer(app);
attachWebSocket(server, { config, sessions, importer, watcher, browser, events });

await watcher.start();
if (config.autoStartBrowser) await browser.start();
server.listen(config.port, config.host, () => {
  console.log(`Layered Ecology receiver: http://${config.host}:${config.port}`);
  console.log(`Manual import folder: ${config.incomingDir}`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopHardware();
  console.log(`Stopping receiver (${signal})`);
  // Windows 关闭控制台窗口只给几秒：先关草船浏览器，超时则强制退出。
  setTimeout(() => process.exit(0), 4_000).unref();
  await watcher.stop();
  await browser.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
// 关闭 cmd 窗口时 Node 收到 SIGHUP，随窗口一起停止服务。
process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
