import { mkdir, readFile, writeFile, copyFile, readdir, lstat, unlink, rmdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const preparationFingerprint = (config, script) =>
  sha256(JSON.stringify(config) + script.replaceAll('\r\n', '\n'));

function confined(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Resource path escapes root: ${name}`);
  }
  const path = resolve(root, name.replaceAll('\\', '/'));
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${name}`);
  }
  return path;
}

// samples/ holds no recordings in GM-only builds. Prune any stale files/subdirectories there
// left behind by earlier builds without ever following or removing links/junctions.
export async function prunePreparedSamples(outputRoot, manifest = { samples: [] }) {
  const keep = new Set((manifest.samples ?? []).map(item => item.path.replaceAll('\\', '/').toLowerCase()));
  let removed = 0;

  async function walk(dir, name) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    let hasLinkOrKept = false;
    for (const entry of entries) {
      const path = join(dir, entry);
      const child = `${name}/${entry}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        hasLinkOrKept = true;
        continue;
      }
      if (info.isDirectory()) {
        const empty = await walk(path, child);
        if (empty) {
          try {
            await rmdir(path);
          } catch {
            hasLinkOrKept = true;
          }
        } else {
          hasLinkOrKept = true;
        }
      } else if (info.isFile() && !keep.has(child.toLowerCase())) {
        await unlink(path);
        removed++;
      } else {
        hasLinkOrKept = true;
      }
    }
    return !hasLinkOrKept;
  }

  const base = join(outputRoot, 'samples');
  let info;
  try {
    info = await lstat(base);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return 0;
  const empty = await walk(base, 'samples');
  if (empty) {
    try {
      await rmdir(base);
    } catch {
      // Leave base directory if a platform lock or preserved entry keeps it non-empty.
    }
  }
  return removed;
}

async function pruneStaleLicenses(outputRoot) {
  const base = join(outputRoot, 'licenses');
  let info;
  try {
    info = await lstat(base);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return 0;
  let removed = 0;
  for (const entry of await readdir(base)) {
    if (entry.toLowerCase() === 'apache-2.0.txt') continue;
    const path = join(base, entry);
    const entryInfo = await lstat(path);
    if (entryInfo.isSymbolicLink()) continue;
    if (entryInfo.isFile()) {
      await unlink(path);
      removed++;
    } else if (entryInfo.isDirectory()) {
      await rm(path, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

function reportPruned(samplesRemoved, licensesRemoved = 0) {
  if (samplesRemoved > 0) {
    console.log(`Removed ${samplesRemoved} stale recorded sample${samplesRemoved === 1 ? '' : 's'}`);
  }
  if (licensesRemoved > 0) {
    console.log(`Removed ${licensesRemoved} stale license file${licensesRemoved === 1 ? '' : 's'}`);
  }
}

export async function prepareAudio({
  recordInventory = false,
  offline = false,
  root = fileURLToPath(new URL('../', import.meta.url)),
} = {}) {
  void recordInventory;
  const config = JSON.parse(await readFile(join(root, 'assets/audio/sources.json'), 'utf8'));
  if (!Array.isArray(config.sources) || config.sources.length > 0) {
    throw new Error('Bundled recorded soundbank sources have been removed; assets/audio/sources.json must keep "sources": []');
  }
  if (!config.soundFont) {
    throw new Error('assets/audio/sources.json is missing soundFont configuration');
  }
  const outputRoot = join(root, 'src-tauri/resources/audio');
  const scriptSource = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const preparationId = preparationFingerprint(config, scriptSource);
  const manifestPath = join(outputRoot, 'manifest.json');
  const apacheSource = await readFile(join(root, 'legal/Apache-2.0.txt'));

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.preparationId === preparationId &&
      Array.isArray(manifest.sources) &&
      manifest.sources.length === 0 &&
      Array.isArray(manifest.instruments) &&
      manifest.instruments.length === 0 &&
      Array.isArray(manifest.samples) &&
      manifest.samples.length === 0 &&
      manifest.soundFont?.sha256 === config.soundFont.sha256
    ) {
      const sfBytes = await readFile(confined(outputRoot, manifest.soundFont.path));
      if (sha256(sfBytes) !== config.soundFont.sha256) {
        throw new Error(`Bundled audio hash mismatch: ${manifest.soundFont.path}`);
      }
      const packagedApache = await readFile(confined(outputRoot, 'licenses/Apache-2.0.txt'));
      if (sha256(packagedApache) !== sha256(apacheSource)) {
        throw new Error('Bundled Apache-2.0 license hash mismatch');
      }
      await readFile(confined(outputRoot, 'soundfont/LICENSE'));
      const samplesRemoved = await prunePreparedSamples(outputRoot, manifest);
      const licensesRemoved = await pruneStaleLicenses(outputRoot);
      reportPruned(samplesRemoved, licensesRemoved);
      console.log(`Verified ${offline ? 'offline ' : ''}GM SoundFont audio (${sfBytes.length} bytes)`);
      return manifest;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && offline) throw error;
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && /mismatch/i.test(error.message)) {
      // Regenerate below when non-offline preparation repairs stale local outputs.
    } else if (error.code !== 'ENOENT' && offline) {
      throw error;
    }
  }

  const packageRoot = join(root, 'node_modules', config.soundFont.package);
  const sfPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (sfPackage.version !== config.soundFont.version) {
    throw new Error('GM SoundFont package version does not match its pin');
  }
  const sfPath = join(packageRoot, config.soundFont.path);
  const sf = await readFile(sfPath);
  if (sha256(sf) !== config.soundFont.sha256) {
    throw new Error('GM SoundFont source hash does not match its pin');
  }

  await mkdir(join(outputRoot, 'soundfont'), { recursive: true });
  await mkdir(join(outputRoot, 'licenses'), { recursive: true });
  await copyFile(sfPath, join(outputRoot, 'soundfont/sonivox.sf2'));
  await copyFile(join(dirname(sfPath), 'LICENSE'), join(outputRoot, 'soundfont/LICENSE'));
  await copyFile(join(root, 'legal/Apache-2.0.txt'), join(outputRoot, 'licenses/Apache-2.0.txt'));

  const manifest = {
    schemaVersion: 1,
    preparationId,
    sources: [],
    instruments: [],
    samples: [],
    soundFont: {
      path: 'soundfont/sonivox.sf2',
      sha256: sha256(sf),
      size: sf.length,
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const samplesRemoved = await prunePreparedSamples(outputRoot, manifest);
  const licensesRemoved = await pruneStaleLicenses(outputRoot);
  reportPruned(samplesRemoved, licensesRemoved);
  console.log(`Prepared GM SoundFont offline at ${outputRoot} (${sf.length} bytes)`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareAudio({
    recordInventory: process.argv.includes('--record-inventory'),
    offline: process.argv.includes('--offline'),
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
