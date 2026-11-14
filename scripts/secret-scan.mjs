// Scans the tracked files for private material before the repository goes public: private keys, common token shapes,
// credentials in config files, personal home paths, local drive-letter folders, and tracked score/audio/archive/binary/
// secret files outside the directories that legitimately hold them. Findings carry file, line and rule only, never the
// matched text, so a failing run cannot leak the value it found.
//
// Run `node scripts/secret-scan.mjs` for a report (exit code 1 on findings); `npm test` runs it through
// scripts/secret-scan.test.mjs.
//
// Undetectable by design: a short or low-entropy password, a secret written in prose or split over lines, a secret in
// an unlisted file type or in a binary file, and a private score (or other media file) placed in one of the directories
// listed in `allowedMediaDirectories`, because those hold real fixtures. Review new files in those directories by hand.
// The scan reads tracked files only; ignored and untracked files are never committed and are not its concern.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));

const MAX_BYTES = 8 * 1024 * 1024;
const LONG_LINE = 20_000;

// Token shapes with a distinctive prefix. Each needs a long random tail, so prose that merely mentions the prefix passes.
export const tokenRules = [
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { rule: 'minisign-secret-key', pattern: /untrusted comment: [^\r\n]*secret key/i },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'stripe-live-key', pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}/ },
  { rule: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { rule: 'anthropic-or-openai-key', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/ },
];

// A Tauri updater private key file is the base64 of a minisign text block ("untrusted comment: ..."), usually stored or
// pasted as one base64 string. The public key has the same prefix, so the decoded text decides.
const base64Block = /dW50cnVzdGVkIGNvbW1lbnQ6[A-Za-z0-9+/]{20,}={0,2}/g;
const tauriSecretVariable = /\bTAURI_(?:SIGNING_PRIVATE_KEY(?:_PASSWORD)?|PRIVATE_KEY|KEY_PASSWORD)\b["']?\s*[:=]\s*["']?([^\s"'#]*)/g;
const reference = /^(?:[$%<{(]|process\.env|env\.|secrets\.)/; // `${{ secrets.X }}`, `$env:X`, `%X%`, `<placeholder>`

// api_key = "..." / api-key: ... with a long value. Values that name an environment variable, a template or a
// placeholder are not secrets.
const genericKey = /\bapi[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{16,})/i;
const placeholderValue = /^(?:x+|\*+|\.+|your|example|sample|changeme|placeholder|dummy|test|fake|none|null|undefined|process|env)/i;

// Credential-looking keys in config files (quoted or unquoted, YAML, TOML, JSON, .env), with a long value that is
// either high-entropy or a long hex string.
const configExtensions = new Set(['.json', '.toml', '.yml', '.yaml', '.ini', '.conf', '.properties', '.cfg', '.env']);
const secretKeyName = /(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential|auth[_-]?key)/i;
const configAssignment = /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?([^"'\s#,;]{20,})/g;
const ENTROPY_BITS_PER_CHAR = 4.0;
const fileLikeName = /.(?:md|json|ts|tsx|rs|mjs|txt|png|css)$/i; // a path used as a key, as in a manifest of file hashes
const longHex = /^[0-9a-fA-F]{40,}$/;

// Personal home paths: C:\Users\name, /Users/name and /home/name, except neutral placeholder names.
const homePath = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'`)\]<>:*?|]+)/g;
const neutralHomeName = /^(?:public|default|default user|all users|user|users|username|name|you|me|yourname|your-name|example|someone|runner|runneradmin|vsts|admin|administrator|ubuntu|root|[<{$%~.].*|\*)$/i;

// The author's checkout, scratch and cargo-target folders: X:\git\..., X:/claude-tmp/..., X:/cargo-target/..., also
// as /x/git/... and JSON-escaped.
const localFolder = /(?:\b[A-Za-z]:[\\/]+|(?:^|[\s"'(=])\/[a-z]\/)(?:git|claude-tmp|cargo-target)[\\/]/;

// Score, audio and archive files. Tracked ones are acceptable only inside the directories below (the same locations
// that .gitignore re-includes).
export const mediaExtensions = new Set([
  '.gp', '.gp3', '.gp4', '.gp5', '.gp8', '.gpx', '.gpif', '.ptb', '.tg', '.tabplayer', '.musicxml', '.mxl', '.mid', '.midi',
  '.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aif', '.aiff', '.nam',
  '.zip', '.7z', '.rar', '.tar', '.tgz', '.gz',
]);
export const allowedMediaDirectories = [
  'assets/library/', // factory templates and the examples, authored for this project
  'src-tauri/resources/cabinet-irs/', // 58 CC0 cabinet impulse responses
  'src-tauri/tests/fixtures/', // synthetic audio and NAM fixtures
  'src/interchange/fixtures/', // authored interchange fixtures
  'tests/fixtures/', // legacy-format fixtures
];
// Executables, installers, plug-ins and secrets are never acceptable as tracked files, in any directory.
export const neverTracked = new Set([
  '.exe', '.msi', '.dmg', '.dll', '.so', '.dylib', '.vst3',
  '.pem', '.key', '.p12', '.pfx', '.p8', '.jks', '.keystore',
]);
// `.xml` is deliberately not forbidden: it is too common (MusicXML test inputs share it with ordinary configuration).

// Explicit exceptions. Each entry names one rule and one path (a directory when it ends in "/") and says why.
// Add to this list only for a documented, deliberate reason; a real secret is removed, never listed.
export const allowlist = [
  // Declared exceptions: functional defaults and project guidance that name the author's folders.
  { rule: 'local-folder', path: 'CLAUDE.md', reason: 'project guidance naming the shared cargo-target slots' },
  // The scanner's own rules and tests spell out the shapes they look for, so they match themselves.
  { rule: 'minisign-secret-key', path: 'scripts/secret-scan.mjs', reason: 'the rule text itself' },
  { rule: 'home-path', path: 'scripts/secret-scan.mjs', reason: 'the rule text itself' },
  { rule: 'local-folder', path: 'scripts/secret-scan.mjs', reason: 'the rule text itself' },
  { rule: 'minisign-secret-key', path: 'scripts/secret-scan.test.mjs', reason: 'synthetic samples for the rule, built at test time' },
];

export const isAllowed = (finding, list) =>
  list.some(entry => entry.rule === finding.rule && (entry.path.endsWith('/') ? finding.file.startsWith(entry.path) : entry.path === finding.file));

export function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const decodesToSecretKey = block => {
  try {
    return /secret key/i.test(Buffer.from(block, 'base64').toString('latin1'));
  } catch {
    return false;
  }
};

// Text of a file, or null for a binary one. UTF-16 files with a byte-order mark are decoded.
export function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  if (buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString('utf8');
}

// Content findings for one file: [{ file, line, rule }].
export function scanText(file, text) {
  const findings = [];
  const config = configExtensions.has(extname(file).toLowerCase()) || basename(file).startsWith('.env');
  text.split(/\r?\n/).forEach((line, index) => {
    const at = rule => findings.push({ file, line: index + 1, rule });
    // These rules are linear in the line length, so they run on every line, minified or not.
    for (const { rule, pattern } of tokenRules) if (pattern.test(line)) at(rule);
    for (const match of line.matchAll(base64Block)) if (decodesToSecretKey(match[0])) at('tauri-signing-key');
    for (const match of line.matchAll(tauriSecretVariable)) if (match[1] !== '' && !reference.test(match[1])) at('tauri-signing-secret');
    for (const match of line.matchAll(homePath)) if (!neutralHomeName.test(match[1])) at('home-path');
    if (localFolder.test(line)) at('local-folder');
    if (line.length > LONG_LINE) return; // the assignment rules below are for hand-written lines
    const key = genericKey.exec(line);
    if (key && !placeholderValue.test(key[1]) && !/^[A-Za-z_]+$/.test(key[1])) at('api-key-assignment');
    if (config) {
      for (const match of line.matchAll(configAssignment)) {
        const [, name, value] = match;
        if (!secretKeyName.test(name) || fileLikeName.test(name) || reference.test(value) || placeholderValue.test(value)) continue;
        if (longHex.test(value)) at('config-secret-hex');
        else if (entropy(value) >= ENTROPY_BITS_PER_CHAR) at('config-secret');
      }
    }
  });
  return findings;
}

// Findings about the tracked path itself.
export function scanPath(file) {
  const name = basename(file);
  const ext = extname(file).toLowerCase();
  const isEnvFile = (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
  if (isEnvFile || neverTracked.has(ext)) return [{ file, line: 0, rule: 'forbidden-file-type' }];
  if (mediaExtensions.has(ext) && !allowedMediaDirectories.some(dir => file.startsWith(dir))) return [{ file, line: 0, rule: 'forbidden-file-type' }];
  return [];
}

// The tracked files, or null when git is missing or `cwd` is not a repository (a source tarball, for example).
export function trackedFiles(cwd = root, env = process.env) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function scanTree({ cwd = root, files, list = allowlist } = {}) {
  const findings = [];
  for (const file of files) {
    findings.push(...scanPath(file));
    let buffer;
    try {
      buffer = readFileSync(`${cwd}/${file}`);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') continue; // deleted in the working tree, or a submodule
      throw error;
    }
    if (buffer.length > MAX_BYTES) continue;
    const text = decode(buffer);
    if (text !== null) findings.push(...scanText(file, text));
  }
  return findings.filter(finding => !isAllowed(finding, list));
}

// { skipped } when there is nothing to scan, otherwise { scanned, findings }.
export function run({ cwd = root, env = process.env, list = allowlist } = {}) {
  const files = trackedFiles(cwd, env);
  if (files === null) return { skipped: 'secret scan skipped: git is not available or this is not a git checkout (a source tarball has no tracked-file list)', scanned: 0, findings: [] };
  return { scanned: files.length, findings: scanTree({ cwd, files, list }) };
}

export const describe = findings => findings.map(f => `${f.file}${f.line ? `:${f.line}` : ''} [${f.rule}]`).join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = run();
  if (result.skipped) {
    console.log(result.skipped);
  } else {
    console.log(`Scanned ${result.scanned} tracked files; ${result.findings.length} finding(s).`);
    for (const f of result.findings) console.log(`${f.rule}\t${f.file}\t${f.line || '-'}`);
    if (result.findings.length) process.exitCode = 1;
  }
}
