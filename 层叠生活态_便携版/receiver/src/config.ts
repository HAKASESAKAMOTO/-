import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface ReceiverConfig {
  projectRoot: string;
  dataRoot: string;
  incomingDir: string;
  downloadsDir: string;
  tempDir: string;
  sessionsDir: string;
  browserDir: string;
  eventsDir: string;
  publicDir: string;
  port: number;
  host: string;
  browserEnabled: boolean;
  autoStartBrowser: boolean;
  maxImageBytes: number;
  maxZipBytes: number;
  maxZipFiles: number;
}

export function getConfig(): ReceiverConfig {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const receiverDirectory = path.basename(moduleRoot) === 'dist' ? path.dirname(moduleRoot) : moduleRoot;
  const inferredRoot = path.dirname(receiverDirectory);
  const projectRoot = path.resolve(process.env.RECEIVER_PROJECT_ROOT || inferredRoot);
  const receiverRoot = path.resolve(projectRoot, 'receiver');
  const dataRoot = path.resolve(process.env.RECEIVER_DATA_ROOT || path.join(receiverRoot, 'data'));
  return {
    projectRoot,
    dataRoot,
    incomingDir: path.join(dataRoot, 'incoming'),
    downloadsDir: path.join(dataRoot, 'downloads'),
    tempDir: path.join(dataRoot, 'temp'),
    sessionsDir: path.join(dataRoot, 'sessions'),
    browserDir: path.join(receiverRoot, 'browser'),
    eventsDir: path.join(dataRoot, 'events'),
    publicDir: path.join(receiverRoot, 'public'),
    port: Number(process.env.RECEIVER_PORT || 8787),
    host: process.env.RECEIVER_HOST || '127.0.0.1',
    browserEnabled: process.env.RECEIVER_BROWSER !== '0',
    autoStartBrowser: process.env.RECEIVER_AUTO_BROWSER !== '0',
    maxImageBytes: Number(process.env.RECEIVER_MAX_IMAGE_BYTES || 20 * 1024 * 1024),
    maxZipBytes: Number(process.env.RECEIVER_MAX_ZIP_BYTES || 100 * 1024 * 1024),
    maxZipFiles: Number(process.env.RECEIVER_MAX_ZIP_FILES || 30),
  };
}

export async function ensureDirectories(config: ReceiverConfig): Promise<void> {
  await Promise.all([
    fs.mkdir(config.incomingDir, { recursive: true }),
    fs.mkdir(config.downloadsDir, { recursive: true }),
    fs.mkdir(config.tempDir, { recursive: true }),
    fs.mkdir(config.sessionsDir, { recursive: true }),
    fs.mkdir(config.browserDir, { recursive: true }),
    fs.mkdir(config.eventsDir, { recursive: true }),
  ]);
}
