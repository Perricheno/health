import { mkdir, readFile, rename, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// The same small storage interface as an R2 bucket; Docker persists to a volume.
export class FileBucket {
  constructor(directory) { this.directory = path.resolve(directory); }
  filename(key) {
    if (!/^history\/\d{4}-\d{2}-\d{2}\.json$/.test(key)) throw new Error('Invalid history key');
    return path.join(this.directory, key);
  }
  async get(key) {
    try {
      const text = await readFile(this.filename(key), 'utf8');
      return { etag: createHash('sha256').update(text).digest('hex'), json: async () => JSON.parse(text) };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async put(key, text, options = {}) {
    const current = await this.get(key);
    if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const file = this.filename(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, text);
    await rename(temporary, file);
    return { etag: createHash('sha256').update(text).digest('hex') };
  }
  async cleanup() {
    const directory = path.join(this.directory, 'history');
    const threshold = new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10);
    for (const name of await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < threshold) await unlink(path.join(directory, name));
    }
  }
}
