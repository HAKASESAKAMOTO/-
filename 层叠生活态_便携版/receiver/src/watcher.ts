import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { EventBus } from './events.js';
import type { ReceiverConfig } from './config.js';
import type { ImageImporter } from './importer.js';
import type { SessionStore } from './session-store.js';

export class IncomingWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly config: ReceiverConfig,
    private readonly sessions: SessionStore,
    private readonly importer: ImageImporter,
    private readonly events: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.stop();
    this.watcher = chokidar.watch([this.config.incomingDir, this.config.downloadsDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 900, pollInterval: 200 },
      ignored: (filePath: string) => {
        const lower = filePath.toLowerCase();
        return lower.endsWith('.crdownload') || lower.endsWith('.part') || lower.endsWith('.tmp') || lower.includes(`${path.sep}processed-zips${path.sep}`);
      },
    });
    this.watcher.on('add', (filePath: string) => { void this.handle(filePath); });
    this.watcher.on('change', (filePath: string) => { void this.handle(filePath); });
    this.watcher.on('error', (error: unknown) => { void this.sessions.addError('WATCHER_ERROR', String(error), 'watcher'); });
  }

  async rescan(): Promise<void> {
    const files = [this.config.incomingDir, this.config.downloadsDir];
    for (const directory of files) {
      const entries = await import('node:fs/promises').then(fs => fs.readdir(directory, { withFileTypes: true }));
      for (const entry of entries) {
        if (entry.isFile()) await this.handle(path.join(directory, entry.name));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
  }

  private async handle(filePath: string): Promise<void> {
    if (this.sessions.get().status === 'SESSION_CLOSED') return;
    const result = await this.importer.importFile(filePath);
    if (result.imported.length || result.duplicate.length || result.invalid.length || result.overflow.length) {
      await this.events.emit({
        sessionId: this.sessions.get().sessionId,
        eventType: 'image.detected',
        timestamp: new Date().toISOString(),
        data: { filePath, imported: result.imported.length, duplicate: result.duplicate, invalid: result.invalid, overflow: result.overflow },
      });
    }
  }
}
