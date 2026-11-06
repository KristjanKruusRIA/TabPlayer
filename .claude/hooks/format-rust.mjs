// PostToolUse: format an edited Rust file so CI's cargo fmt check stays green.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = input.tool_input?.file_path ?? '';
if (!file.endsWith('.rs') || !existsSync(file)) process.exit(0);

const binary = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt');
const result = spawnSync(existsSync(binary) ? binary : 'rustfmt', ['--edition', '2024', file], { encoding: 'utf8' });
if (result.error || result.status !== 0) {
  // A file that does not parse yet is normal mid-edit; report it without blocking.
  console.log(JSON.stringify({ systemMessage: `rustfmt skipped ${file}: ${(result.error?.message ?? result.stderr).trim().split('\n')[0]}` }));
}
