import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function hostTriple() {
  const rustc = process.platform === 'win32'
    ? (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo/bin/rustc.exe') : 'rustc')
    : 'rustc';
  const output = execFileSync(rustc, ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host:\s*([^\r\n]+)/m);
  if (!match) throw new Error('Could not determine host target triple from rustc -vV');
  return match[1].trim();
}

export function helperBinaryName(triple = hostTriple()) {
  const isWindows = triple.includes('windows');
  return isWindows ? `tabplayer-plugin-host-${triple}.exe` : `tabplayer-plugin-host-${triple}`;
}

export async function copyPluginHost({
  targetDir = join(root, 'src-tauri/target'),
  outputDir = join(root, 'src-tauri/binaries'),
  triple = hostTriple(),
  profile = 'release',
} = {}) {
  const isWindows = triple.includes('windows');
  const sourceName = isWindows ? 'tabplayer-plugin-host.exe' : 'tabplayer-plugin-host';
  const sourcePath = join(targetDir, profile, sourceName);

  try {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      throw new Error(`Built plug-in host helper is not a file: ${sourcePath}`);
    }
  } catch (err) {
    throw new Error(`Built plug-in host helper not found at ${sourcePath}`);
  }

  await mkdir(outputDir, { recursive: true });
  const destName = helperBinaryName(triple);
  const destPath = join(outputDir, destName);
  await copyFile(sourcePath, destPath);
  return destPath;
}

export async function buildPluginHost({
  debug = false,
  manifestPath = join(root, 'src-tauri/Cargo.toml'),
  targetDir = join(root, 'src-tauri/target'),
  outputDir = join(root, 'src-tauri/binaries'),
} = {}) {
  const cargo = process.platform === 'win32'
    ? (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo')
    : 'cargo';
  const profile = debug ? 'debug' : 'release';
  const args = ['build', '--manifest-path', manifestPath, '-p', 'tabplayer-plugin-host'];
  if (!debug) {
    args.push('--release');
  }

  execFileSync(cargo, args, { stdio: 'inherit' });
  return copyPluginHost({ targetDir, outputDir, profile });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const debug = args.includes('--debug');
  await buildPluginHost({ debug });
}
