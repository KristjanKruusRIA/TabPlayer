// Run with: node --test .claude/hooks/commit-guard.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./commit-guard.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-guard-'));
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, 'notes.md'), 'one\n');
  writeFileSync(join(cwd, 'tracked.gp'), 'one\n');
  git(cwd, 'add', 'notes.md');
  git(cwd, 'add', '-f', 'tracked.gp');
  git(cwd, 'commit', '-q', '-m', 'seed');
  return cwd;
};
const decide = (cwd, command, tool_name = 'Bash') => {
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name, cwd, tool_input: { command } }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
};
const stage = (cwd, file, directory) => {
  if (directory) mkdirSync(join(cwd, directory), { recursive: true });
  writeFileSync(join(cwd, file), 'data\n');
  git(cwd, 'add', '-f', file);
};

test('ignores commands that are not commits', () => {
  const cwd = repo();
  stage(cwd, 'song.gp');
  for (const command of ['git status', 'git log --grep commit', 'git commit-tree HEAD^{tree}', 'npm test']) assert.equal(decide(cwd, command), 'allow');
});

test('allows a commit of ordinary files, including a message naming a score', () => {
  const cwd = repo();
  stage(cwd, 'readme.md');
  assert.equal(decide(cwd, 'git commit -m "docs: song.gp output/ dist/x"'), 'allow');
  assert.equal(decide(cwd, 'git commit -am "song.exe"'), 'allow');
});

test('allows removing a blocked file from the repository', () => {
  const cwd = repo();
  git(cwd, 'rm', '-q', 'tracked.gp');
  assert.equal(decide(cwd, 'git commit -m remove'), 'allow');
});

test('denies each blocked kind once staged', () => {
  for (const [file, directory] of [['song.gp', ''], ['SONG.GP5', ''], ['song.gpx', ''], ['song.ptb', ''], ['song.tef', ''], ['song.tabplayer', ''], ['app.exe', ''], ['.analysis/x.json', '.analysis'], ['output/a.wav', 'output'], ['dist/a.js', 'dist'], ['src-tauri/target/a', 'src-tauri/target']]) {
    const cwd = repo();
    stage(cwd, file, directory);
    assert.equal(decide(cwd, 'git commit -m x'), 'deny', file);
  }
});

test('allows the public projects shipped in the library', () => {
  const cwd = repo();
  stage(cwd, 'assets/library/examples/demo.tabplayer', 'assets/library/examples');
  assert.equal(decide(cwd, 'git commit -m x'), 'allow');
});

test('sees every spelling of a commit', () => {
  const cwd = repo();
  stage(cwd, 'song.gp');
  for (const command of ['rtk git commit -m x', 'git -c a=b commit -m x', 'git --no-pager commit -m x', 'git.exe commit -m x', 'true && git commit -m x', 'GIT_AUTHOR_NAME=x git commit -m x', 'if ($?) { git commit -m x }']) assert.equal(decide(cwd, command), 'deny', command);
  assert.equal(decide(cwd, 'git commit -m x', 'PowerShell'), 'deny');
});

test('checks the repository a command actually targets', () => {
  const clean = repo();
  const dirty = repo();
  stage(dirty, 'song.gp');
  assert.equal(decide(clean, `git -C "${dirty}" commit -m x`), 'deny');
  assert.equal(decide(clean, `cd "${dirty}" && git commit -m x`), 'deny');
  assert.equal(decide(clean, `Set-Location "${dirty}"; git commit -m x`), 'deny');
});

test('denies when the target directory cannot be determined', () => {
  assert.equal(decide(repo(), 'cd "$WORKTREE" && git commit -m x'), 'deny');
});

test('counts tracked changes for commit -a and named paths', () => {
  const cwd = repo();
  writeFileSync(join(cwd, 'tracked.gp'), 'two\n');
  assert.equal(decide(cwd, 'git commit -m x'), 'allow');
  for (const command of ['git commit -a -m x', 'git commit -am x', 'git commit --all -m x', 'git commit tracked.gp -m x']) assert.equal(decide(cwd, command), 'deny', command);
});

test('sees files added earlier in the same command', () => {
  const cwd = repo();
  writeFileSync(join(cwd, 'song.gp'), 'data\n');
  mkdirSync(join(cwd, 'output'));
  writeFileSync(join(cwd, 'output', 'a.wav'), 'data\n');
  writeFileSync(join(cwd, 'safe.md'), 'data\n');
  assert.equal(decide(cwd, 'git add song.gp && git commit -m x'), 'deny');
  assert.equal(decide(cwd, 'git add ./output/a.wav; git commit -m x'), 'deny');
  assert.equal(decide(cwd, `git add "${join(cwd, 'song.gp')}" && git commit -m x`), 'deny');
  assert.equal(decide(cwd, 'git add safe.md && git commit -m x'), 'allow');
});

test('denies a broad add joined to a commit, but not on its own', () => {
  const cwd = repo();
  mkdirSync(join(cwd, 'src'));
  for (const add of ['git add .', 'git add -A', 'git add --all', 'git add -u', 'git add src', 'git add src/', 'git add *.md']) assert.equal(decide(cwd, `${add} && git commit -m x`), 'deny', add);
  assert.equal(decide(cwd, 'git add .'), 'allow');
});

test('review regressions: commit and add spellings', () => {
  const cwd = repo();
  stage(cwd, 'song.gp');
  assert.equal(decide(cwd, 'git -c user.name="Foo Bar" -c user.email=a@b.c commit -m x'), 'deny');
  const fresh = repo();
  writeFileSync(join(fresh, 'other.gp'), 'data\n');
  for (const command of ['git stage other.gp && git commit -m x', 'git mv notes.md output/notes.md && git commit -m x', 'f=other.gp; git add "$f" && git commit -m x', 'git add $(git ls-files -o) && git commit -m x', 'git add -Av && git commit -m x', 'git add -fA && git commit -m x', 'git add `\n  other.gp; git commit -m x']) assert.equal(decide(fresh, command), 'deny', command);
});

test('review regressions: directory changes', () => {
  const dirty = repo();
  stage(dirty, 'song.gp');
  const clean = repo();
  const other = `"${dirty}"`;
  for (const command of [`Push-Location ${other}; git commit -m x; Pop-Location`, `(cd ${other} && git commit -m x)`, `sh -c 'cd ${dirty.replaceAll('\\', '/')} && git commit -m x'`, `{ cd ${other}; git commit -m x; }`, `if ($?) { cd ${other}; git commit -m x }`]) assert.equal(decide(clean, command), 'deny', command);
  assert.equal(decide(dirty, `pushd "${clean}"; git status; popd; git commit -m x`), 'deny');
  assert.equal(decide(clean, `pushd "${dirty}"; git status; popd; git commit -m x`), 'allow');
});

test('review regressions: a directory named to commit takes tracked changes', () => {
  const cwd = repo();
  writeFileSync(join(cwd, 'tracked.gp'), 'two\n');
  assert.equal(decide(cwd, 'git commit . -m x'), 'deny');
});

test('review regressions: Git Bash paths resolve', { skip: process.platform !== 'win32' }, () => {
  const cwd = repo();
  const bash = `/${cwd[0].toLowerCase()}${cwd.slice(2).replaceAll('\\', '/')}`;
  assert.equal(decide(cwd, `cd ${bash} && git commit -m x`), 'allow');
  assert.equal(decide(cwd, `git -C ${bash} commit -m x`), 'allow');
});

test('review regressions: deletions, messages and redirects stay allowed', () => {
  const cwd = repo();
  rmSync(join(cwd, 'tracked.gp'));
  assert.equal(decide(cwd, 'git add tracked.gp && git commit -m remove'), 'allow');
  assert.equal(decide(cwd, 'git commit tracked.gp -m remove'), 'allow');
  const messages = repo();
  for (const command of ['git commit -m "handle song.gp import\n\nbody"', 'git commit -m "handle song.gp files; fix parser"', 'git commit --message="docs mention song.gp in text"', 'git commit -m "say \\"hi\\" about song.gp today"', "git commit -m \"$(cat <<'EOF'\ngit add song.gp is now refused\nEOF\n)\"", "git commit -m @'\ngit add song.gp is now refused\n'@", 'git commit -m x > output/commit.log']) assert.equal(decide(messages, command), 'allow', command);
});

test('re-review regressions: a heredoc keeps the rest of its opening line', () => {
  const cwd = repo();
  stage(cwd, 'song.gp');
  assert.equal(decide(cwd, "cat <<'EOF' | git commit -F -\nmsg\nEOF"), 'deny');
  const fresh = repo();
  writeFileSync(join(fresh, 'other.gp'), 'data\n');
  assert.equal(decide(fresh, "cat > m.txt <<'EOF' && git add other.gp && git commit -F m.txt\nmsg\nEOF"), 'deny');
});

test('re-review regressions: heredoc bodies never count as commands', () => {
  const cwd = repo();
  assert.equal(decide(cwd, "cat > x.md <<'EOF'\n```bash\ngit add song.gp\ngit commit -am x\n```\nEOF\nnpm test"), 'allow');
  assert.equal(decide(cwd, "cat > x.md <<'COMMIT-MSG'\ngit add song.gp\nCOMMIT-MSG\ngit commit -m x"), 'allow');
});

test('re-review regressions: a closing parenthesis does not hide a path', () => {
  const cwd = repo();
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'sub', 'inner.gp'), 'data\n');
  assert.equal(decide(cwd, '(cd sub && git add inner.gp) && git commit -m x'), 'deny');
  assert.equal(decide(cwd, '(git add .) && git commit -m x'), 'deny');
});

test('denies when git itself cannot run', () => {
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: repo(), tool_input: { command: 'git commit -m x' } }), encoding: 'utf8', env: { ...process.env, PATH: '', Path: '' } });
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('does not stand in the way outside a repository', () => {
  assert.equal(decide(mkdtempSync(join(tmpdir(), 'commit-guard-')), 'echo git commit'), 'allow');
});
