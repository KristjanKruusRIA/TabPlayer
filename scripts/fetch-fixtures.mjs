import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sources = JSON.parse(await readFile(new URL('../tests/fixtures/sources.json', import.meta.url), 'utf8'));
const directory = new URL('../.analysis/compatibility/', import.meta.url);
await mkdir(directory, {recursive:true});
for (const source of sources) {
  const destination = new URL(source.name, directory);
  let bytes;
  try { bytes = await readFile(destination); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Fixture download failed: ${source.name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Fixture checksum failed: ${source.name}`);
    await writeFile(destination, bytes);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Cached fixture checksum failed: ${source.name}`);
}
