import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { hardwareOrigin } from './hardware-proxy.js';

export async function isHardwareService(origin: string): Promise<boolean> {
  try {
    const response = await fetch(origin + '/api/state', { signal: AbortSignal.timeout(700) });
    return response.ok && (await response.json()).service === 'layered-life-serial';
  } catch { return false; }
}

/** Reuse an existing bridge; only terminate the child owned by this Receiver. */
export async function startHardwareService(projectRoot: string): Promise<() => void> {
  if (process.env.RECEIVER_HARDWARE === '0') return () => {};
  const origin = hardwareOrigin();
  if (await isHardwareService(origin)) return () => {};
  if (process.env.HARDWARE_BASE_URL && origin !== 'http://127.0.0.1:8765') {
    console.warn('配置的硬件地址未提供串口服务，请检查 HARDWARE_BASE_URL。');
    return () => {};
  }
  const root = path.join(projectRoot, 'hardware');
  const executable = path.join(root, 'runtime/python.exe'), script = path.join(root, 'dashboard/server.py');
  try { await fs.access(executable); await fs.access(script); } catch { console.warn('串口组件缺失，可继续手动旋转。'); return () => {}; }
  // Let the OS reserve an available port atomically; never compete for port 8765.
  const child: ChildProcess = spawn(executable, ['-B', script, '--port', '0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
  const stop = () => {
    process.removeListener('exit', stop);
    if (child.exitCode === null && !child.killed) child.kill();
  };
  process.once('exit', stop);
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const finish = (error?: Error, value?: number) => {
        clearTimeout(timer); lines.close(); child.removeListener('exit', exited);
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error('串口服务启动超时')), 5000);
      const exited = (code: number | null) => finish(new Error(`串口服务退出（${code}）`));
      child.once('exit', exited);
      child.on('error', error => finish(error));
      lines.on('line', line => {
        try {
          const ready = JSON.parse(line);
          if (ready.service === 'layered-life-serial' && Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535) finish(undefined, ready.port);
        } catch { /* Ignore non-protocol startup output. */ }
      });
    });
    const selected = `http://127.0.0.1:${port}`;
    if (!await isHardwareService(selected)) throw new Error('串口服务身份检查失败');
    process.env.HARDWARE_BASE_URL = selected;
    console.log(`串口服务已就绪：${selected}`);
  } catch (error) {
    stop();
    console.warn('串口组件未启动，可继续手动旋转。', error instanceof Error ? error.message : error, diagnostics.trim());
  }
  return stop;
}
