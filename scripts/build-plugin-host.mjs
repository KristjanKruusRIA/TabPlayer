import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The folder cargo writes to: `CARGO_TARGET_DIR` (relative to the working directory, as cargo reads it), else `src-tauri/target`. */
export function resolveTargetDir(env = process.env) {
  const configured = env.CARGO_TARGET_DIR;
  return configured ? resolve(configured) : join(root, 'src-tauri/target');
}

/** Finds a toolchain program on PATH, then in `~/.cargo/bin` (or `CARGO_HOME/bin`), and otherwise falls back to the bare name. */
export function findTool(name, env = process.env) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const pathValue = env.PATH ?? env.Path ?? '';
  const folders = pathValue.split(delimiter).filter(Boolean);
  const home = env.CARGO_HOME ? env.CARGO_HOME : (env.USERPROFILE || env.HOME) ? join(env.USERPROFILE || env.HOME, '.cargo') : '';
  if (home) folders.push(join(home, 'bin'));
  for (const folder of folders) {
    const candidate = join(folder, file);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function guessTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

/** The host target triple from `rustc -vV`; a machine with no rustc to find gets the one its platform and architecture imply. */
export function hostTriple(env = process.env) {
  try {
    const output = execFileSync(findTool('rustc', env), ['-vV'], { encoding: 'utf8' });
    const match = output.match(/^host:\s*([^\r\n]+)/m);
    if (match) return match[1].trim();
  } catch {
    // No usable rustc: fall through to the platform guess. The build step that follows fails loudly if cargo is missing too.
  }
  return guessTriple();
}

export function helperBinaryName(triple = hostTriple()) {
  const isWindows = triple.includes('windows');
  return isWindows ? `tabplayer-plugin-host-${triple}.exe` : `tabplayer-plugin-host-${triple}`;
}

export async function copyPluginHost({
  targetDir = resolveTargetDir(),
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

/** The cargo arguments for the helper. `--locked` holds the build to the committed Cargo.lock, as the Tauri builds do. */
export function cargoBuildArgs({ debug = false, manifestPath = join(root, 'src-tauri/Cargo.toml') } = {}) {
  const args = ['build', '--locked', '--manifest-path', manifestPath, '-p', 'tabplayer-plugin-host'];
  if (!debug) args.push('--release');
  return args;
}

export async function buildPluginHost({
  debug = false,
  manifestPath = join(root, 'src-tauri/Cargo.toml'),
  targetDir = resolveTargetDir(),
  outputDir = join(root, 'src-tauri/binaries'),
} = {}) {
  const profile = debug ? 'debug' : 'release';
  execFileSync(findTool('cargo'), cargoBuildArgs({ debug, manifestPath }), { stdio: 'inherit' });
  return copyPluginHost({ targetDir, outputDir, profile });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const debug = args.includes('--debug');
  await buildPluginHost({ debug });
}
