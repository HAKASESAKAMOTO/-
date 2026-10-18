import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { EventBus } from './events.js';
import type { ReceiverConfig } from './config.js';
import type { SessionStore } from './session-store.js';

export class BrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private intentionallyStopping = false;
  private qrDataUrl: string | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryAttempts = 0;
  private readonly handledRows = new Set<string>();
  private readonly manualNotices = new Set<string>();

  constructor(
    private readonly config: ReceiverConfig,
    private readonly sessions: SessionStore,
    private readonly events: EventBus,
  ) {}

  isRunning(): boolean {
    return Boolean(this.context && this.page && !this.page.isClosed());
  }

  getQrDataUrl(): string | null {
    return this.qrDataUrl;
  }

  async focusPage(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.bringToFront();
  }

  async start(): Promise<void> {
    if (!this.config.browserEnabled) {
      await this.sessions.setMode('MANUAL_FALLBACK');
      return;
    }
    if (this.isRunning()) return;
    this.intentionallyStopping = false;
    await this.sessions.setStatus('INITIALIZING');
    try {
      await fs.mkdir(this.config.browserDir, { recursive: true });
      await fs.mkdir(this.config.downloadsDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.config.browserDir, {
        headless: false,
        acceptDownloads: true,
        downloadsPath: this.config.downloadsDir,
        viewport: { width: 1280, height: 820 },
        args: ['--start-minimized'],
      });
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.page.on('close', () => { if (!this.intentionallyStopping) void this.handleBrowserFailure('浏览器页面已关闭'); });
      this.page.on('crash', () => { if (!this.intentionallyStopping) void this.handleBrowserFailure('草船页面崩溃'); });
      this.page.on('requestfailed', request => {
        const failure = request.failure()?.errorText;
        if (failure) void this.events.emit({ sessionId: this.sessions.get().sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'PAGE_REQUEST_FAILED', message: failure, url: request.url() } });
      });
      await this.page.goto('https://2w.ma/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      this.recoveryAttempts = 0;
      this.qrDataUrl = await this.readQrDataUrl(this.page);
      await this.sessions.setStatus(this.sessions.get().imageCount >= this.sessions.get().targetCount ? 'IMAGES_READY' : 'WAITING_FOR_SCAN');
      await this.events.emit({ sessionId: this.sessions.get().sessionId, eventType: 'receiver.ready', timestamp: new Date().toISOString(), data: { url: this.page.url(), mode: this.sessions.get().mode } });
      this.emitQr();
      this.timer = setInterval(() => { void this.poll(); }, 1_500);
      await this.poll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.handleBrowserFailure(`草船浏览器启动失败：${message}`);
    }
  }

  async stop(): Promise<void> {
    this.intentionallyStopping = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.qrDataUrl = null;
    this.handledRows.clear();
    this.manualNotices.clear();
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => undefined);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async poll(): Promise<void> {
    const page = this.page;
    if (this.polling || !page || page.isClosed()) return;
    this.polling = true;
    try {
      const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      const nextQr = await this.readQrDataUrl(page);
      if (nextQr !== this.qrDataUrl) {
        this.qrDataUrl = nextQr;
        this.emitQr();
      }
      const hasConnection = /手机设备已连接|请在手机端选择内容传输/.test(bodyText);
      if (hasConnection && this.sessions.get().imageCount < this.sessions.get().targetCount && this.sessions.get().status !== 'DOWNLOADING') {
        await this.sessions.setStatus(this.sessions.get().mode === 'MANUAL_FALLBACK' ? 'MANUAL_FALLBACK' : 'COLLECTING');
      } else if (!hasConnection && await page.locator('canvas').count() > 0 && this.sessions.get().imageCount < this.sessions.get().targetCount) {
        await this.sessions.setStatus('WAITING_FOR_SCAN');
      }
      const rows = await this.findFileRows(page);
      for (const row of rows) await this.processRow(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.events.emit({ sessionId: this.sessions.get().sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'PAGE_POLL_FAILED', message } });
    } finally {
      this.polling = false;
    }
  }

  private async findFileRows(page: Page): Promise<Array<{ locator: ReturnType<Page['locator']>; key: string; text: string }>> {
    const rows: Array<{ locator: ReturnType<Page['locator']>; key: string; text: string }> = [];
    const list = page.locator('.file-item');
    const count = await list.count();
    if (count > 0) {
      for (let index = 0; index < count; index += 1) {
        const locator = list.nth(index);
        const text = await locator.innerText().catch(() => '');
        const name = await locator.locator('.file-name').first().innerText().catch(() => text.slice(0, 120));
        rows.push({ locator, key: `${name}|${text.includes('已接收')}`, text });
      }
      return rows;
    }
    const single = page.locator('.file-section');
    const singleCount = await single.count();
    for (let index = 0; index < singleCount; index += 1) {
      const locator = single.nth(index);
      const text = await locator.innerText().catch(() => '');
      const name = await locator.locator('.file-name').first().innerText().catch(() => text.slice(0, 120));
      if (text && name) rows.push({ locator, key: `${name}|${text.includes('已接收')}`, text });
    }
    return rows;
  }

  private async processRow(row: { locator: ReturnType<Page['locator']>; key: string; text: string }): Promise<void> {
    if (!row.text.includes('已接收') || this.handledRows.has(row.key)) return;
    if (this.sessions.get().imageCount >= this.sessions.get().targetCount) return;
    if (this.sessions.get().mode === 'MANUAL_FALLBACK') {
      if (!this.manualNotices.has(row.key)) {
        this.manualNotices.add(row.key);
        await this.events.emit({ sessionId: this.sessions.get().sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'MANUAL_DOWNLOAD_REQUIRED', message: '请在草船网页点击下载，或将文件放入 receiver/data/incoming。', file: row.key } });
      }
      return;
    }
    const button = row.locator.locator('button').filter({ hasText: /下载/ }).first();
    if (await button.count() === 0) {
      const fallback = row.locator.locator('.operate-btn').filter({ hasText: /下载/ }).first();
      if (await fallback.count() === 0) return;
      await this.downloadRow(fallback, row.key);
      return;
    }
    await this.downloadRow(button, row.key);
  }

  private async downloadRow(button: ReturnType<Page['locator']>, key: string): Promise<void> {
    if (!this.page) return;
    this.handledRows.add(key);
    const sessionId = this.sessions.get().sessionId;
    await this.sessions.setStatus('DOWNLOADING');
    await this.events.emit({ sessionId, eventType: 'image.download_started', timestamp: new Date().toISOString(), data: { key } });
    try {
      const downloadPromise = this.page.waitForEvent('download', { timeout: 20_000 });
      await button.click({ timeout: 10_000 });
      const download = await downloadPromise;
      const suggested = sanitizeFilename(download.suggestedFilename() || `download-${Date.now()}`);
      const destination = path.join(this.config.downloadsDir, `${Date.now()}-${suggested}`);
      await download.saveAs(destination);
      await this.events.emit({ sessionId, eventType: 'image.download_completed', timestamp: new Date().toISOString(), data: { key, path: destination, fileName: suggested } });
      if (this.sessions.get().imageCount < this.sessions.get().targetCount) await this.sessions.setStatus('COLLECTING');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handledRows.delete(key);
      await this.sessions.setMode('MANUAL_FALLBACK');
      await this.events.emit({ sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'AUTO_DOWNLOAD_FAILED', message, key } });
    }
  }

  private async handleBrowserFailure(message: string): Promise<void> {
    if (this.intentionallyStopping) return;
    const session = this.sessions.get();
    // A closed 草船 page can no longer refresh its QR; never keep serving the last frozen frame.
    if (this.qrDataUrl !== null) { this.qrDataUrl = null; this.emitQr(); }
    await this.events.emit({ sessionId: session.sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'BROWSER_UNAVAILABLE', message } });
    if (this.recoveryAttempts === 3) {
      // Downloads fall back to manual, but the QR page itself keeps recovering.
      await this.sessions.setMode('MANUAL_FALLBACK').catch(() => undefined);
      await this.events.emit({ sessionId: session.sessionId, eventType: 'receiver.error', timestamp: new Date().toISOString(), data: { code: 'AUTO_RECOVERY_EXHAUSTED', message: '草船页面连续重启失败，已切换人工下载模式；二维码页面继续自动重连。' } });
    }
    const delay = Math.min(30_000, 1_500 * 2 ** Math.min(this.recoveryAttempts, 5));
    this.recoveryAttempts += 1;
    if (this.recoveryTimer) return;
    await this.sessions.setStatus('INITIALIZING').catch(() => undefined);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.restart();
    }, delay);
  }
  private async readQrDataUrl(page: Page): Promise<string | null> {
    try {
      return await page.evaluate(() => {
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
        return canvas && canvas.width > 0 && canvas.height > 0 ? canvas.toDataURL('image/png') : null;
      });
    } catch {
      return null;
    }
  }

  private emitQr(): void {
    this.events.emitEphemeral({
      sessionId: this.sessions.get().sessionId,
      eventType: 'receiver.qr',
      timestamp: new Date().toISOString(),
      data: { qrDataUrl: this.qrDataUrl, refreshHint: '每 5 秒刷新一次' },
    });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || `download-${Date.now()}`;
}
