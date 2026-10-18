import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Keep the old complete document visible until Windows permits atomic replacement. */
export async function atomicJson(file: string, data: unknown): Promise<void> {
  const contents = JSON.stringify(data, null, 2) + '\n';
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        await delay(Math.min(50 * 2 ** attempt, 1000));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
