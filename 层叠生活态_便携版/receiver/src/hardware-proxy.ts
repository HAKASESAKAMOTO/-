import http from 'node:http';
import type { Request, Response } from 'express';
import { AppError } from './application-store.js';

export function hardwareOrigin(): string {
  const url = new URL(process.env.HARDWARE_BASE_URL || 'http://127.0.0.1:8765');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new AppError('INVALID_HARDWARE_URL', '硬件服务必须为本机HTTP地址。', 500);
  return url.origin;
}
export function hardwareDto(raw: any) {
  const angle = raw?.angle;
  return { connected: raw?.connected === true, port: raw?.port ?? null, ageMs: raw?.age_ms ?? null, error: raw?.error ?? null,
    packet: raw?.latest ? { bootId: raw.latest.boot_id ?? null, uptimeMs: raw.latest.ms, sequence: raw.latest.seq ?? null } : null,
    rotation: angle ? { available: angle.available, steps: angle.steps, stepsPerTurn: angle.steps_per_turn, directionSign: angle.sign,
      angleDegrees: angle.angle, totalDegrees: angle.total_angle, positiveCount: angle.positive_count, negativeCount: angle.negative_count, gaps: angle.gaps, invalid: angle.invalid } : null };
}
export async function hardwareCall(route: string, body?: unknown) {
  const origin = hardwareOrigin();
  try {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(2500), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-GPIO-UI': '1' }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      if (response.status === 404) throw new AppError('HARDWARE_WRONG_SERVICE', '串口服务地址被其他程序占用或服务版本不匹配，请重启工作台。', 503);
      if (response.status === 403) throw new AppError('HARDWARE_FORBIDDEN', '串口服务未通过本机请求校验，请重启工作台。', 403);
      if (response.status === 400) throw new AppError('HARDWARE_INVALID_REQUEST', '串口已拔出或参数无效，请刷新串口列表后重试。', 400);
      throw new AppError('HARDWARE_REJECTED', `串口服务请求失败（HTTP ${response.status}）。`, response.status);
    }
    return response.status === 204 ? { ok: true } : response.json();
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('HARDWARE_UNAVAILABLE', '硬件服务尚未连接。', 503); }
}
export function hardwareStream(req: Request, res: Response, normalized = true): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (data: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(normalized ? { schemaVersion: '1.0', data: hardwareDto(data) } : data)}\n\n`); };
  let buffer = '';
  const upstream = http.get(hardwareOrigin() + '/api/stream', { timeout: 4000 }, response => {
    if (response.statusCode !== 200) { response.resume(); upstream.destroy(new Error('upstream')); return; }
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { upstream.destroy(new Error('oversized event')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) { try { send(JSON.parse(line.slice(5))); } catch { /* Ignore incomplete upstream packets. */ } }
      }
    });
    response.on('end', () => res.end());
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => { send({ connected: false, error: '硬件服务尚未连接', age_ms: null, angle: null, latest: null }); res.end(); });
  res.on('close', () => upstream.destroy());
}
