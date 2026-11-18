import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter,join,resolve } from 'node:path';

/**
 * Runs the decode_audio example (Symphonia's reading of a FLAC, MP3 or OGG file) and returns its JSON report, which is what the format drivers
 * decode their exports with. It uses, in this order: the build DECODE_AUDIO names; the release example already built in the checkout's default
 * Cargo output folder; `cargo run --release --example decode_audio`, with ~/.cargo/bin on the path because a plain shell often lacks it
 * (the CLAUDE.md note). Never a Cargo output folder of its own: a release build of the app's library is large.
 * @param {string[]} args the audio file, the sample width in bits and the output file for the samples
 */
export function runDecodeAudio(args) {
  const built = process.env.DECODE_AUDIO || [resolve('src-tauri/target/release/examples/decode_audio.exe'), resolve('src-tauri/target/release/examples/decode_audio')].find(existsSync);
  if (built) return execFileSync(built, args, { encoding: 'utf8' });
  const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` };
  return execFileSync('cargo', ['run', '--quiet', '--release', '--example', 'decode_audio', '--', ...args], { cwd: resolve('src-tauri'), encoding: 'utf8', env });
}
