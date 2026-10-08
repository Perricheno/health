import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export class FileState {
  constructor(directory) { this.directory = path.resolve(directory, 'state'); }
  async get(key) {
    if (!['monitor', 'auth'].includes(key)) throw new Error('Invalid state key');
    try { return JSON.parse(await readFile(path.join(this.directory, `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async put(key, value) {
    if (!['monitor', 'auth'].includes(key)) throw new Error('Invalid state key');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${key}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  }
}
