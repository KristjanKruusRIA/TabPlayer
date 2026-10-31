import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateStringCountArguments,assertStringCountBuild,assertStringCountPortFree,stringCountEnvironment,assertStringCountIdentity,buildStringCountFixture,assertStringCountMusic} from './parity-string-count.mjs';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
test('import, default and help are inert, and run needs an absolute build packet',()=>{
  for(const args of [[],['--help']])assert.equal(validateStringCountArguments(args).mode,'help');
  for(const args of [['--run'],['--run','--build=relative.json'],['--run','--help'],['--help','--build=/tmp/x']])assert.throws(()=>validateStringCountArguments(args));
  assert.equal(validateStringCountArguments(['--run',`--build=${resolve(root,'packet.json')}`]).mode,'run');
  for(const args of [[],['--help']])assert.match(execFileSync(process.execPath,['tests/desktop/parity-string-count.mjs',...args],{cwd:root,encoding:'utf8'}),/Inert/);
  assert.equal(execFileSync(process.execPath,['--input-type=module','-e',"await import('./tests/desktop/parity-string-count.mjs')"],{cwd:root,encoding:'utf8'}),'');
});

function packetFixture(){
  const worktree=mkdtempSync(resolve(tmpdir(),'tabplayer-string-count-guard-'));
  const runtime=resolve(worktree,'.analysis/desktop-smoke/string-count-guard/runtime');mkdirSync(runtime,{recursive:true});
  const source=resolve(worktree,'source.txt');writeFileSync(source,'frozen source');
  const executable=resolve(runtime,'tabplayer.exe'),configPath=resolve(worktree,'build.json'),buildLogPath=resolve(worktree,'build.log');
  writeFileSync(executable,'MZ inert guard specimen');writeFileSync(configPath,'{}');writeFileSync(buildLogPath,'isolated guard specimen; never launched');
  const start=Date.now()-5000,end=start+2000;utimesSync(source,new Date(start-1000),new Date(start-1000));utimesSync(executable,new Date(start+1000),new Date(start+1000));
  const packet={format:'TabPlayerStringCountBuild',version:1,worktree,sourceRevision:'a'.repeat(40),sourceHashes:{'source.txt':sha256(readFileSync(source))},executable,executableSha256:sha256(readFileSync(executable)),configPath,configSha256:sha256(readFileSync(configPath)),buildLogPath,buildLogSha256:sha256(readFileSync(buildLogPath)),buildStartedAtUtc:new Date(start).toISOString(),builtAtUtc:new Date(end).toISOString()};
  return {packet,source,options:{worktree,manifest:()=>({'source.txt':sha256(readFileSync(source))})}};
}
test('build gate binds source, regular executable, config, log, unique location and chronology',()=>{
  const {packet,options,source}=packetFixture();assert.doesNotThrow(()=>assertStringCountBuild(packet,options));
  for(const mutation of [{format:'wrong'},{sourceRevision:'x'},{executableSha256:'0'.repeat(64)},{configSha256:'0'.repeat(64)},{buildLogSha256:'0'.repeat(64)},{builtAtUtc:new Date(Date.now()+10000).toISOString()},{buildStartedAtUtc:packet.builtAtUtc},{worktree:dirname(packet.worktree)}])assert.throws(()=>assertStringCountBuild({...packet,...mutation},options));
  writeFileSync(source,'changed source');assert.throws(()=>assertStringCountBuild(packet,options),/source/i);writeFileSync(source,'frozen source');utimesSync(source,new Date(0),new Date(0));
  writeFileSync(packet.executable,'MZ changed executable');assert.throws(()=>assertStringCountBuild(packet,options),/bytes/i);
  const outside=resolve(options.worktree,'stale.exe');writeFileSync(outside,'MZ old');assert.throws(()=>assertStringCountBuild({...packet,executable:outside,executableSha256:sha256(readFileSync(outside))},options),/runtime|directory/i);
});
test('occupied port and changed process identity refuse before a connection',()=>{
  assert.doesNotThrow(()=>assertStringCountPortFree([]));assert.throws(()=>assertStringCountPortFree([{pid:42}]),/9223/);
  const identity={pid:42,path:'C:/owned/tabplayer.exe',startTicks:'123456789'};
  assert.doesNotThrow(()=>assertStringCountIdentity(identity,{...identity}));
  for(const change of [{pid:43},{path:'C:/foreign/tabplayer.exe'},{startTicks:'123456790'}])assert.throws(()=>assertStringCountIdentity(identity,{...identity,...change}));
  const profile='C:/owned/run/profile',chain=[{pid:50,commandLine:`webview --user-data-dir="${profile}"`},{pid:42,commandLine:'tabplayer.exe'}];
  assert.doesNotThrow(()=>assertScoreLayoutListener(identity,profile,[{owner:50,chain}]));
  assert.throws(()=>assertScoreLayoutListener(identity,profile,[{owner:50,chain:chain.slice(0,1)}]));
  assert.throws(()=>assertScoreLayoutListener(identity,profile,[{owner:50,chain:[{pid:50,commandLine:`webview --user-data-dir="${profile}-foreign"`},chain[1]]}]));
  const env=stringCountEnvironment({TABPLAYER_TEST_PLAY:'1',tabplayer_test_open:'foreign',KEEP:'yes'});assert.deepEqual(env,{KEEP:'yes'});
});
test('public fixture roundtrip checks all literal placements and independent pitches',async()=>{
  const {bytes,oracle}=await buildStringCountFixture();const {importer,Settings}=await import('@coderline/alphatab');
  const score=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());assertStringCountMusic(score,oracle,'source');
  assert.equal(score.tracks.length,2);assert.equal(oracle.tracks[1].bars[0][0].some(note=>note[2]===23),true);
  score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret++;assert.throws(()=>assertStringCountMusic(score,oracle,'source'));
});
