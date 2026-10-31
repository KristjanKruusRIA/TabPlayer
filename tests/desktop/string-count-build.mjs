// Builds the desktop-test app into a fresh .analysis/desktop-smoke/string-count-<stamp>/runtime and writes the
// TabPlayerStringCountBuild packet that parity-string-count.mjs admits. Run from the worktree root with STRING_COUNT_TARGET
// naming the Cargo target directory, then: node tests/desktop/parity-string-count.mjs --run --build=<printed path>.
import {copyFileSync,cpSync,mkdirSync,readFileSync,utimesSync,writeFileSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {resolve} from 'node:path';
import {sourceManifest,sha256} from './score-layout-fixture.mjs';
const worktree=resolve('.'),stamp=new Date().toISOString().replace(/[:.]/g,'-'),owned=resolve(worktree,`.analysis/desktop-smoke/string-count-${stamp}`),runtime=resolve(owned,'runtime');
mkdirSync(runtime,{recursive:true});
// The frontend build regenerates public/ assets, so it runs before the sources are frozen; the Tauri build then skips it.
const frontendLog=execSync('npm run build',{encoding:'utf8',env:{...process.env,VITE_DESKTOP_TEST:'1'},stdio:['ignore','pipe','pipe'],maxBuffer:1<<28});
const base=JSON.parse(readFileSync(resolve(worktree,'.analysis/desktop-smoke/tauri-test.json'),'utf8'));
// The acceptance run names its own WebView2 profile through WEBVIEW2_USER_DATA_FOLDER, so no data directory is pinned.
const windows=base.app.windows.map(({dataDirectory:_,...window})=>window);
writeFileSync(resolve(owned,'tauri-test.json'),JSON.stringify({app:{windows},build:{beforeBuildCommand:''}},null,2));
await new Promise(r=>setTimeout(r,1100));
const sourceHashes=sourceManifest(worktree),sourceRevision=execSync('git rev-parse HEAD',{encoding:'utf8'}).trim();
await new Promise(r=>setTimeout(r,50));
const buildStartedAtUtc=new Date().toISOString(),configPath=resolve(owned,'tauri-test.json'),buildLogPath=resolve(owned,'build.log');
const target=process.env.STRING_COUNT_TARGET;
const log=execSync(`npm run tauri -- build --no-bundle --features desktop-test --config "${configPath}"`,{encoding:'utf8',env:{...process.env,VITE_DESKTOP_TEST:'1',CARGO_TARGET_DIR:target},stdio:['ignore','pipe','pipe'],maxBuffer:1<<28});
writeFileSync(buildLogPath,frontendLog+log);
const executable=resolve(runtime,'tabplayer.exe');copyFileSync(resolve(target,'release/tabplayer.exe'),executable);
// An unbundled build reads its audio and library resources from beside the executable.
for(const name of ['audio','library'])cpSync(resolve(worktree,'src-tauri/resources',name),resolve(runtime,name),{recursive:true});
const now=new Date();utimesSync(executable,now,now);await new Promise(r=>setTimeout(r,50));
const builtAtUtc=new Date().toISOString();
const packet={format:'TabPlayerStringCountBuild',version:1,worktree,sourceRevision,sourceHashes,buildStartedAtUtc,builtAtUtc,
  executable,executableSha256:sha256(readFileSync(executable)),configPath,configSha256:sha256(readFileSync(configPath)),buildLogPath,buildLogSha256:sha256(readFileSync(buildLogPath))};
const packetPath=resolve(owned,'build.json');writeFileSync(packetPath,JSON.stringify(packet,null,2));console.log(packetPath);
