// PreToolUse: stop a commit that would include private scores, binaries or generated output.
// An accident guard, not a security boundary: it reads the command text, so xargs, update-index and the like pass.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const blocked = /\.(gp[x3-8]?|ptb|tef|tabplayer|exe|dll|msi|pdb)$|^(\.analysis|output|\.playwright-mcp|dist|src-tauri\/target)\//i;
const shipped = /^assets\/library\//i; // Public example and template projects.
const value = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const argument = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;
const cdCall = new RegExp(String.raw`^[\s({]*(?:\S*sh(?:\.exe)?\s+-c\s+["'])?(?:if\s*\([^)]*\)\s*\{\s*)?(?:cd|sl|pushd|Push-Location|Set-Location)\s+(?:-(?:Literal)?Path\s+)?(${value})`, 'i');
const popCall = /^\s*(?:popd|Pop-Location)\b/i;
const gitCall = new RegExp(String.raw`(?:^|[\s"'/\\&(])git(?:\.exe)?["']?((?:\s+(?:-[cC]\s+${argument}|--[\w-]+(?:=\S+)?))*)\s+(add|stage|mv|commit)(?=\s|$)(.*)$`, 'is');

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = input.tool_input?.command ?? '';

const deny = (reason) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
};
const unquote = (text) => text.replace(/^(["'])(.*)\1$/s, '$2');
const tokens = (text) => (text.match(new RegExp(value, 'g')) ?? []).map(unquote);
const git = (directory, ...args) => spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
// Git Bash spells C:\x as /c/x.
const native = (path) => (process.platform === 'win32' ? path.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : path);

// Paths in the command are relative to where git runs, stored paths to the repository root.
const repoPath = (top, directory, file) => relative(top, resolve(directory, native(file))).replaceAll('\\', '/');
const isDirectory = (place, file) => {
  const path = isAbsolute(native(file)) ? native(file) : resolve(place, file);
  return existsSync(path) && statSync(path).isDirectory();
};
const listed = (directory, ...args) => {
  const result = git(directory, 'diff', '--name-only', '--no-relative', '--diff-filter=ACMRT', '-z', ...args);
  if (result.status !== 0) deny(`Commit blocked: could not list changes in ${directory}. ${result.stderr?.trim()}`);
  return result.stdout.split('\0').filter(Boolean);
};
// Naming a deleted file stages the deletion, which is how a blocked file leaves the repository.
const deletedIn = (directory) => new Set(git(directory, 'ls-files', '--deleted', '--full-name', '-z').stdout?.split('\0') ?? []);
const refuseIfBlocked = (files) => {
  const found = [...new Set(files.filter((file) => blocked.test(file) && !shipped.test(file)))];
  if (found.length) deny(`Commit blocked: ${found.slice(0, 10).join(', ')} must not enter the repository (private scores, binaries or generated output). Unstage them. If one really belongs, the user commits it themselves.`);
};

// Join continuations and drop message text, so a message cannot read as a command or a path.
const script = command
  .replace(/<<-?\s*(['"]?)([\w.-]+)\1([^\r\n]*)\r?\n(?:[\s\S]*?\r?\n)??\s*\2(?=\s|$)/g, '$3')
  .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '""')
  .replace(/[\\`]\r?\n/g, ' ')
  .replace(/(?<=\s|^)(-[a-zA-Z]*[mF]|--message|--file|--trailer|--author)(?:=|\s*)("(?:[^"\\`]|[\\`].)*"|'[^']*')/gs, '$1 x');

let directory = input.cwd ?? process.cwd();
const pushed = [];
let unsure = false; // An earlier step in this command stages something not yet visible.

for (const segment of script.split(/&&|\|\||[;|\r\n]/)) {
  if (popCall.test(segment)) { directory = pushed.pop() ?? directory; continue; }
  const cd = segment.match(cdCall);
  if (cd) {
    if (/pushd|push-location/i.test(segment)) pushed.push(directory);
    directory = resolve(directory, native(unquote(cd[1])));
  }
  const call = segment.match(gitCall);
  if (!call) continue;

  const [, globals, verb, rest] = call;
  const target = tokens(globals).reduce((path, token, index, all) => (all[index - 1] === '-C' ? resolve(path, native(token)) : path), directory);
  if (!existsSync(target)) deny(`Commit blocked: cannot resolve the directory ${target}, so its staged files cannot be checked. Run the commit from that directory.`);
  const root = git(target, 'rev-parse', '--show-toplevel');
  if (root.error) deny(`Commit blocked: git could not run (${root.error.code}), so staged files cannot be checked.`);
  if (root.status !== 0) {
    if (/not a git repository/i.test(root.stderr)) continue;
    deny(`Commit blocked: ${root.stderr.trim()}`);
  }
  const top = realpathSync.native(root.stdout.trim());
  const place = realpathSync.native(target);
  const args = tokens(rest.replace(/\d?>>?\s*\S+/g, '').replace(/\s#.*$/s, '').replace(/\)+\s*$/, ''));

  if (verb === 'mv') {
    const destination = args.filter((token) => !token.startsWith('-')).at(-1);
    if (destination) refuseIfBlocked([repoPath(top, place, destination)]);
    unsure = true;
    continue;
  }
  if (verb === 'add' || verb === 'stage') {
    const paths = args.filter((token) => !token.startsWith('-'));
    const deleted = deletedIn(target);
    refuseIfBlocked(paths.map((file) => repoPath(top, place, file)).filter((file) => !deleted.has(file)));
    if (args.some((token) => /^-[a-zA-Z]*[Au]|^--(all|update|pathspec-from-file)/.test(token)) || paths.some((file) => /[*?[$`(]/.test(file) || file.endsWith('/') || isDirectory(place, file))) unsure = true;
    continue;
  }

  if (unsure) deny('Commit blocked: a broad git add or a git mv in the same command cannot be checked before it runs. Stage named files, or run that step first and commit in a separate command.');
  const paths = args.filter((token, index) => !token.startsWith('-') && !/^(-[a-zA-Z]*[mFt]|--message|--file|--template|--author|--date|--trailer|-C|-c)$/.test(args[index - 1] ?? ''));
  const all = args.some((token) => token === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(token)) || paths.some((file) => isDirectory(place, file));
  const deleted = deletedIn(target);
  refuseIfBlocked([...listed(target, '--cached'), ...(all ? listed(target) : []), ...paths.map((file) => repoPath(top, place, file)).filter((file) => !deleted.has(file))]);
}
