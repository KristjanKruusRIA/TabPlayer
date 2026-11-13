// Guards the repository against private material: runs the scanner over the tracked files, and checks the scanner itself
// with synthetic cases. Every positive sample is assembled from parts at run time, so no real-looking secret is committed.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import test from 'node:test';
import { decode, describe, entropy, isAllowed, run, scanPath, scanText } from './secret-scan.mjs';

const rules = (file, text) => scanText(file, text).map(f => f.rule);
const join = (...parts) => parts.join('');
const random = alphabet => length => Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const alnum = random('aZ3kQ9mXr2LpB7vTc5dNw8EyH1JsUg4F');
const hex = length => Array.from({ length }, (_, i) => '0123456789abcdef'[(i * 5 + 3) % 16]).join('');

test('the tracked files hold no private keys, tokens, personal paths or stray score/audio/binary files', () => {
  const { skipped, findings } = run();
  if (skipped) return console.log(skipped);
  assert.deepEqual(findings, [], `private material found (file:line [rule], values are never printed):\n${describe(findings)}`);
});

test('without git or a repository the scan skips with a message instead of failing', async () => {
  const dir = await mkdtemp(joinPath(tmpdir(), 'secret-scan-'));
  try {
    const notARepository = run({ cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.match(notARepository.skipped, /skipped/);
    assert.deepEqual(notARepository.findings, []);
    const noGit = run({ env: { PATH: dir } });
    assert.match(noGit.skipped, /skipped/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanner flags private-key headers and token shapes', () => {
  assert.deepEqual(rules('a.txt', join('-----BEGIN ', 'RSA PRIVATE KEY', '-----')), ['private-key']);
  assert.deepEqual(rules('a.txt', join('-----BEGIN ', 'PRIVATE KEY', '-----')), ['private-key']);
  assert.deepEqual(rules('a.txt', join('untrusted comment: ', 'minisign secret key')), ['minisign-secret-key']);
  assert.deepEqual(rules('a.txt', `x = ${join('gh', 'p_', alnum(36))}`), ['github-token']);
  assert.deepEqual(rules('a.txt', `x = ${join('AK', 'IA', 'ABCDEFGHIJKLMNOP')}`), ['aws-access-key']);
  assert.deepEqual(rules('a.txt', `x = ${join('xo', 'xb-', '1234567890-', alnum(12))}`), ['slack-token']);
  assert.deepEqual(rules('a.ts', `const api_key = "${alnum(24)}";`), ['api-key-assignment']);
  assert.deepEqual(rules('a.yml', `apiKey: ${alnum(24)}`), ['api-key-assignment', 'config-secret']); // both rules agree
});

test('token rules also run on very long (minified) lines', () => {
  const line = `${'a'.repeat(30_000)} ${join('gh', 'p_', alnum(36))} ${'b'.repeat(30_000)}`;
  assert.deepEqual(rules('min.js', line), ['github-token']);
});

test('scanner flags a base64-wrapped Tauri updater private key but not the public key', () => {
  const secret = Buffer.from(join('untrusted comment: ', 'rsign encrypted secret key\n', alnum(60))).toString('base64');
  const pub = Buffer.from(join('untrusted comment: ', 'minisign public key: ABCD1234\n', alnum(40))).toString('base64');
  assert.deepEqual(rules('tauri.conf.json', `"x": "${secret}"`), ['tauri-signing-key']);
  assert.deepEqual(rules('tauri.conf.json', `"pubkey": "${pub}"`), []);
});

test('scanner flags Tauri signing variables with a value and accepts references and empty values', () => {
  for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_PRIVATE_KEY', 'TAURI_KEY_PASSWORD']) {
    assert.deepEqual(rules('ci.yml', `${name}: hunter2`), ['tauri-signing-secret'], name);
    assert.deepEqual(rules('a.ps1', `$env:${name} = 'hunter2'`), ['tauri-signing-secret'], name);
    assert.deepEqual(rules('a.env', `${name}=`), [], name);
    assert.deepEqual(rules('ci.yml', `${name}: \${{ secrets.${name} }}`), [], name);
    assert.deepEqual(rules('a.ps1', `$env:${name} = $secret`), [], name);
  }
});

test('scanner flags high-entropy and long-hex credentials in config files only, quoted or not', () => {
  const value = join('q8Zr', 'T2xK9mWp', 'L4vBn7Yc', 'D1sFg6Hj');
  assert.deepEqual(rules('c.json', `{"authToken": "${value}"}`), ['config-secret']);
  assert.deepEqual(rules('c.toml', `password = "${value}"`), ['config-secret']);
  assert.deepEqual(rules('c.yml', `  client_secret: ${value}`), ['config-secret']);
  assert.deepEqual(rules('.env', `SESSION_TOKEN=${value}`), ['config-secret']);
  assert.deepEqual(rules('c.yml', `deploy_token: ${hex(40)}`), ['config-secret-hex']);
  assert.deepEqual(rules('c.json', `{"api_secret": "${hex(64)}"}`), ['config-secret-hex']);
  assert.deepEqual(rules('c.ts', `const authToken = "${value}";`), []);
  assert.deepEqual(rules('c.yml', `token: \${{ secrets.DEPLOY_TOKEN }}`), []);
  assert.deepEqual(rules('c.json', `{"sha256": "${hex(64)}"}`), []);
  assert.deepEqual(rules('c.json', `{"docs/validation/gp8-password-locks.md": "${hex(64)}"}`), []);
  assert.ok(entropy(value) >= 4);
});

test('scanner flags personal home paths and accepts neutral ones', () => {
  const win = join('C:', '\\Users\\', 'someone-real', '\\Downloads');
  assert.deepEqual(rules('d.md', win), ['home-path']);
  assert.deepEqual(rules('d.md', join('C:', '/Users/', 'someone-real', '/.cargo')), ['home-path']);
  assert.deepEqual(rules('d.md', join('/Users/', 'someone-real', '/Library')), ['home-path']);
  assert.deepEqual(rules('d.md', join('/home/', 'someone-real', '/src')), ['home-path']);
  for (const neutral of ['C:\\Users\\Public\\x', 'C:/Users/<name>/x', 'C:\\Users\\%USERNAME%\\x', '/home/runner/work', '~/.cargo/bin', '<checkout>/src']) {
    assert.deepEqual(rules('d.md', neutral), [], neutral);
  }
});

test('scanner flags drive-letter checkout, scratch and cargo-target folders', () => {
  for (const folder of ['git', 'claude-tmp', 'cargo-target']) {
    assert.deepEqual(rules('d.md', join('E', ':/', folder, '/x')), ['local-folder'], folder);
    assert.deepEqual(rules('d.md', join('d', ':\\', folder, '\\x')), ['local-folder'], folder);
    assert.deepEqual(rules('d.json', join('"E', ':\\\\', folder, '\\\\x"')), ['local-folder'], folder);
  }
  assert.deepEqual(rules('d.md', join('cd /e', '/git/x')), ['local-folder']);
  assert.deepEqual(rules('d.md', '<cargo-target>/slot-1 and <checkout>/src and https://example.org/git/x'), []);
});

test('scanner accepts prose and placeholders that only resemble secrets', () => {
  const clean = [
    'Set the api key in the settings dialog.',
    'api_key = process.env.KEY_NAME',
    'apiKey: "your-api-key-goes-here"',
    'apiKey: SomeIdentifierName',
    '"sha256": "642eb400725ee7493de1695dafdd2cc12836c72ed0d8f8a7d1c8e1e21f50bd63"',
    'The PEM header is written as BEGIN PRIVATE KEY in the guide.',
    'the token "ghp_" prefix',
  ];
  for (const text of clean) assert.deepEqual(rules('e.json', text), [], text);
});

test('UTF-16 files with a byte-order mark are decoded and scanned; other binaries are skipped', () => {
  const secret = join('-----BEGIN ', 'PRIVATE KEY', '-----');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(secret, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(secret, 'utf16le').swap16()]);
  assert.deepEqual(rules('u.txt', decode(le)), ['private-key']);
  assert.deepEqual(rules('u.txt', decode(be)), ['private-key']);
  assert.equal(decode(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])), null);
  assert.equal(decode(Buffer.from('plain text')), 'plain text');
});

test('the scan of a real directory reports file and line but never the value', async () => {
  const dir = await mkdtemp(joinPath(tmpdir(), 'secret-scan-'));
  try {
    const { execFileSync } = await import('node:child_process');
    const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git(['init', '-q']);
    const token = join('gh', 'p_', alnum(36));
    await writeFile(joinPath(dir, 'a.txt'), `ok\nvalue ${token}\n`);
    await writeFile(joinPath(dir, 'score.gp5'), 'x');
    git(['add', '-f', '.']);
    const { scanned, findings } = run({ cwd: dir, list: [] });
    assert.equal(scanned, 2);
    assert.deepEqual(findings.map(f => `${f.file}:${f.line}:${f.rule}`).sort(), ['a.txt:2:github-token', 'score.gp5:0:forbidden-file-type']);
    assert.ok(!describe(findings).includes(token));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanner flags forbidden file types outside the directories that hold them', () => {
  for (const file of ['notes/score.gp', 'x/legacy.GP5', 'a/b.gpif', 'a/b.m4a', 'a/b.aiff', 'a/b.tar', 'a/b.tgz', 'a/b.tar.gz', 'src/audio/take.wav', 'x.zip']) {
    assert.equal(scanPath(file).length, 1, file);
  }
  for (const file of ['release/setup.exe', 'a/b.vst3', 'a/b.so', 'a/b.dylib', 'config/signing.key', 'a/b.pem', '.env', 'app/.env.production']) {
    assert.equal(scanPath(file).length, 1, file);
  }
  assert.equal(scanPath('.env.example').length, 0);
  assert.equal(scanPath('src-tauri/resources/cabinet-irs/a.wav').length, 0);
  assert.equal(scanPath('tests/fixtures/legacy-gp3.gp3').length, 0);
  assert.equal(scanPath('src/interchange/fixtures/a.gpif').length, 0);
  assert.equal(scanPath('assets/library/examples/a.tabplayer').length, 0);
  assert.equal(scanPath('src/App.tsx').length, 0);
  assert.equal(scanPath('tests/inputs/a.xml').length, 0); // .xml is too common to forbid
});

test('secrets and executables are forbidden even inside the directories that hold fixtures', () => {
  for (const dir of ['assets/library/', 'src-tauri/resources/cabinet-irs/', 'src-tauri/tests/fixtures/', 'src/interchange/fixtures/', 'tests/fixtures/']) {
    for (const name of ['.env', 'x.pem', 'x.key', 'x.exe', 'x.dll', 'x.p12']) assert.equal(scanPath(dir + name).length, 1, dir + name);
    for (const name of ['x.gp5', 'x.wav', 'x.mid']) assert.equal(scanPath(dir + name).length, 0, dir + name);
  }
});

test('an allowlist entry silences exactly one rule on one path or directory', () => {
  const path = join('C:', '/Users/', 'someone-real', '/x');
  const list = [
    { rule: 'home-path', path: 'docs/a.md', reason: 'test' },
    { rule: 'home-path', path: 'docs/dir/', reason: 'test' },
  ];
  const files = ['docs/a.md', 'docs/b.md', 'docs/dir/c.md'];
  const findings = files.flatMap(file => scanText(file, path));
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.filter(f => !isAllowed(f, list)).map(f => f.file), ['docs/b.md']);
});
