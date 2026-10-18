import fs from 'node:fs/promises';
import path from 'node:path';

export async function pythonRuntime(projectRoot: string): Promise<string> {
  if (process.env.PYTHON_EXE?.trim()) return process.env.PYTHON_EXE.trim();
  for (const relative of ['runtime/python/python.exe', 'hardware/runtime/python.exe']) {
    const executable = path.join(projectRoot, relative);
    if (await fs.access(executable).then(() => true, () => false)) return executable;
  }
  return 'python';
}
