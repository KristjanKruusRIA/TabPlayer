import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exporter,importer,midi,model,Settings} from '@coderline/alphatab';
import {unzipSync,zipSync} from 'fflate';

export const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const manifestDigest=manifest=>sha256(JSON.stringify(manifest));
const json=value=>JSON.stringify(value,null,2);
const normalized=path=>resolve(path).replaceAll('\\','/').toLowerCase();
const hashPattern=/^[a-f0-9]{64}$/;
function canonical(path){assert.ok(typeof path==='string'&&isAbsolute(path),'Absolute path required');assert.equal(path.replaceAll('\\','/').toLowerCase(),normalized(realpathSync(path)),'Canonical path required');return path;}
export function contained(parent,child){const value=relative(resolve(parent),resolve(child));return Boolean(value&&!value.startsWith('..')&&!isAbsolute(value));}
function assertContained(parent,child){canonical(parent);canonical(child);assert.ok(contained(realpathSync(parent),realpathSync(child)),`Path escapes owned root: ${child}`);}
function inventory(root,prefix=''){
  const files={};
  const walk=part=>{for(const entry of readdirSync(resolve(root,part),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=part?`${part}/${entry.name}`:entry.name,path=resolve(root,name);assert.ok(!lstatSync(path).isSymbolicLink(),`Unexpected resource/source link: ${name}`);if(entry.isDirectory())walk(name);else{assert.ok(entry.isFile(),`Expected regular file: ${name}`);files[prefix+name]=sha256(readFileSync(path));}}};
  canonical(root);assert.ok(!lstatSync(root).isSymbolicLink());walk('');return files;
}
export function sourceManifest(worktree=repository){
  const files={};
  for(const dir of ['src','src-tauri/src','src-tauri/tests','src-tauri/capabilities','tests/desktop','scripts','public'])Object.assign(files,inventory(resolve(worktree,dir),`${dir}/`));
  for(const path of ['index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/tauri.test.conf.json','src-tauri/build.rs'])if(existsSync(resolve(worktree,path))){assert.ok(lstatSync(resolve(worktree,path)).isFile());files[path]=sha256(readFileSync(resolve(worktree,path)));}
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
function boundFile(path,hash,parent=repository){assertContained(parent,path);assert.ok(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),'Regular bound file required');assert.match(hash,hashPattern);assert.equal(sha256(readFileSync(path)),hash,`Bound bytes changed: ${path}`);}
export function assertScoreLayoutAdmission(a){
  assert.equal(a.format,'TabPlayerScoreLayoutBuildAdmission');assert.equal(a.version,1);canonical(a.worktree);assert.equal(normalized(a.worktree),normalized(repository));
  assert.equal(a.rootReviewed,true);assert.equal(a.diagnosticFeature,'desktop-test');assert.equal(a.frontendDesktopTest,true);
  assert.equal(a.sourceReview.status,'passed');assert.match(a.sourceReview.frozenRevision,/^[a-f0-9]{40}$/);boundFile(a.sourceReview.reportPath,a.sourceReview.reportSha256);
  assert.deepEqual(a.sourceHashes,sourceManifest(),'Exact frozen source inventory/bytes changed');assert.equal(a.buildSourceSha256,manifestDigest(a.sourceHashes));
  for(const name of ['score-layout-fixture.mjs','score-layout-observer.mjs','score-layout-acceptance.test.mjs','parity-score-layouts.mjs','score-layout-driver.test.mjs'])assert.match(a.sourceHashes[`tests/desktop/${name}`],hashPattern);
  const start=Date.parse(a.buildStartedAtUtc),end=Date.parse(a.builtAtUtc),newest=Math.max(...Object.keys(a.sourceHashes).map(p=>statSync(resolve(repository,p)).mtimeMs));
  assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&end<=Date.now(),'Ordered finite completed build timestamps required');assert.ok(start>=newest,'Build must start after source freeze');
  assertContained(resolve(repository,'.analysis/desktop-smoke'),a.executable);assert.match(basename(dirname(dirname(a.executable))),/^score-layout-/,'Fresh score-layout build directory required');
  for(const [path,hash]of [[a.executable,a.executableSha256],[a.configPath,a.configSha256],[a.buildLogPath,a.buildLogSha256],[a.frontendManifestPath,a.frontendManifestSha256],[a.runtimeResourceManifestPath,a.runtimeResourceManifestSha256]])boundFile(path,hash);
  const executableTime=statSync(a.executable).mtimeMs;assert.ok(executableTime>=start&&executableTime<=end,'Executable mtime must lie within current build');
  const frontend=JSON.parse(readFileSync(a.frontendManifestPath));assert.deepEqual(Object.keys(frontend).sort(),['buildSourceSha256','files']);assert.equal(frontend.buildSourceSha256,a.buildSourceSha256);
  assert.deepEqual(frontend.files,{...inventory(resolve(repository,'dist'),'dist/'),...inventory(resolve(repository,'src-tauri/resources'),'src-tauri/resources/')},'Exact frontend/resources inventory required');
  const runtime=JSON.parse(readFileSync(a.runtimeResourceManifestPath));assert.deepEqual(Object.keys(runtime).sort(),['audioFiles','audioLink','audioTarget','buildSourceSha256','libraryFiles','libraryRoot']);assert.equal(runtime.buildSourceSha256,a.buildSourceSha256);
  assert.equal(normalized(runtime.libraryRoot),normalized(resolve(dirname(a.executable),'Library')));assertContained(dirname(a.executable),runtime.libraryRoot);assert.deepEqual(runtime.libraryFiles,inventory(runtime.libraryRoot));assert.ok(Object.keys(runtime.libraryFiles).length>0);
  assert.ok(isAbsolute(runtime.audioLink));const linkRelative=relative(dirname(a.executable),runtime.audioLink);assert.ok(linkRelative&&!linkRelative.startsWith('..')&&!isAbsolute(linkRelative));canonical(runtime.audioTarget);assert.equal(normalized(realpathSync(runtime.audioLink)),normalized(runtime.audioTarget));assert.deepEqual(runtime.audioFiles,inventory(runtime.audioTarget));assert.ok(Object.keys(runtime.audioFiles).length>0);
  assert.ok(a.referencePacketHashes&&Object.keys(a.referencePacketHashes).length>0);for(const [path,hash]of Object.entries(a.referencePacketHashes))boundFile(path,hash);
}

export function buildScoreLayoutFixture(){
  const score=new model.Score(),settings=new Settings();score.title='Twenty-four windows';score.artist='TabPlayer authored layout study';score.systemsLayout=[3,3,3,3,3,3,3,3];score.defaultSystemsLayout=3;
  const offsets=[0,2,4,5,7,5,4,2,0,2,4,7,5,4,2,0,2,5,7,4,2,0,4,5];
  const notes=[],rests=[];let barId=0,voiceId=0,beatId=0,noteId=0;
  for(let bar=0;bar<24;bar++){const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;if(bar===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];if(bar===6)master.isRepeatStart=true;if(bar===7)master.repeatCount=2;score.addMasterBar(master);}
  const tracks=[{index:0,name:'Window guitar',staves:1,voices:2},{index:1,name:'Window keyboard',staves:2,voices:2}];
  for(const authored of tracks){
    const track=new model.Track();track.name=authored.name;track.shortName=authored.index===0?'Gtr':'Keys';track.systemsLayout=[3,3,3,3,3,3,3,3];track.defaultSystemsLayout=3;Object.assign(track.playbackInfo,{program:authored.index===0?25:0,primaryChannel:authored.index*2,secondaryChannel:authored.index*2+1});score.addTrack(track);
    for(let staffIndex=0;staffIndex<authored.staves;staffIndex++){
      const staff=new model.Staff();staff.showStandardNotation=true;staff.showTablature=authored.index===0;staff.stringTuning.tunings=authored.index===0?[64,59,55,50,45,40]:[];track.addStaff(staff);
      if(authored.index===0){const chord=new model.Chord();chord.name='Am';chord.strings=[0,1,2,2,0,-1];chord.firstFret=1;chord.showDiagram=true;chord.showName=true;staff.addChord('authored-am',chord);}
      for(let barIndex=0;barIndex<24;barIndex++){
        const bar=new model.Bar();bar.id=barId++;bar.clef=staffIndex===1?model.Clef.F4:model.Clef.G2;staff.addBar(bar);
        for(let voiceIndex=0;voiceIndex<2;voiceIndex++){
          const voice=new model.Voice();voice.id=voiceId++;bar.addVoice(voice);
          for(let beatIndex=0;beatIndex<4;beatIndex++){
            const beat=new model.Beat();beat.id=beatId++;beat.duration=model.Duration.Quarter;beat.isEmpty=authored.index===1&&staffIndex===1&&barIndex===23&&voiceIndex===1&&beatIndex===3;voice.addBeat(beat);
            const target={track:authored.index,staff:staffIndex,bar:barIndex,voice:voiceIndex,beat:beatIndex};
            if(beatIndex%2===0){const note=new model.Note();note.id=noteId++;const key=(authored.index===0?45:staffIndex===0?72:48)+offsets[barIndex]+(barIndex===2?0:voiceIndex*7)+(beatIndex===2?2:0);if(authored.index===0){note.string=1;note.fret=key-40;}else{note.octave=Math.floor(key/12);note.tone=key%12;}beat.addNote(note);notes.push({target,noteIndex:0,string:authored.index===0?1:-1,key});}else rests.push({target});
            if(authored.index===0&&voiceIndex===0&&barIndex===0&&beatIndex===0)beat.chordId='authored-am';
            if(authored.index===0&&voiceIndex===0&&barIndex===23&&beatIndex===2)beat.text='Last window — complete';
          }
        }
      }
    }
  }
  const lyrics=new model.Lyrics();lyrics.startBar=0;lyrics.text='First window';score.tracks[0].applyLyrics([lyrics]);score.rebuildRepeatGroups();score.finish(settings);
  const gpBytes=Buffer.from(zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)}));
  const copy=importer.ScoreLoader.loadScoreFromBytes(gpBytes,settings);assert.equal(copy.masterBars.length,24);
  const performedBars=[0,1,2,3,4,5,6,7,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],counts=new Map();
  const occurrences=performedBars.map((bar,index)=>{const occurrence=counts.get(bar)??0;counts.set(bar,occurrence+1);return {bar,occurrence,startTick:index*3840,endTick:(index+1)*3840};});
  const generator=new midi.MidiFileGenerator(copy,settings,new midi.AlphaSynthMidiFileHandler(new midi.MidiFile(),true));generator.generate();assert.deepEqual(generator.tickLookup.masterBars.map(b=>[b.masterBar.index,b.start,b.end]),occurrences.map(b=>[b.bar,b.startTick,b.endTick]));
  const target=(bar,beat=0,voice=0)=>({track:0,staff:0,bar,voice,beat});
  const range=(startBar,startTick,endBar,endTick,voices=[0])=>({kind:'range',range:{start:{bar:startBar,tick:startTick},end:{bar:endBar,tick:endTick},lanes:voices.map(voice=>({track:0,staff:0,voice}))}});
  // These authored intervals are independent of the application's selection implementation.
  const cases=[
    ['shiftRange',target(2,2),target(3,0),range(2,1920,3,960)],
    ['toggleNotes',target(0),target(3,2),{kind:'notes',notes:[{target:target(0),noteIndex:0},{target:target(3,2),noteIndex:0}]}],
    ['tripleTrack',target(0),target(0),{kind:'bars',tracks:[0],firstBar:0,lastBar:23}],
    ['crossPageDrag',target(2),target(9,2),range(2,0,9,2880)],
    ['resizeStart',target(2,2),target(1),range(1,0,3,960)],
    ['resizeEnd',target(3),target(6,2),range(2,1920,6,2880)],
  ];
  const gestureCases=cases.map(([name,origin,target,expectedSelection])=>({name,kind:name,origin,target,expectedSelection,expectedAffectedNotes:notes.filter(note=>{const t=note.target;if(expectedSelection.kind==='notes')return expectedSelection.notes.some(n=>JSON.stringify(n.target)===JSON.stringify(t));if(expectedSelection.kind==='bars')return t.track===0;const r=expectedSelection.range;return t.track===0&&t.staff===0&&r.lanes.some(l=>l.voice===t.voice)&&t.bar*3840+t.beat*960>=r.start.bar*3840+r.start.tick&&t.bar*3840+t.beat*960<r.end.bar*3840+r.end.tick;})}));
  const initialPrint={paper:'A4',orientation:'portrait',marginMm:15,scale:1,profile:'ScoreTab'};
  const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'ScoreTab'};
  const oversizePage={widthMm:210,heightMm:50,marginsMm:{top:0,right:15,bottom:0,left:15},scale:1,profile:'document'};
  return {gpBytes,oracle:{writtenBars:24,tracks,notes,rests,emptyBeats:[],emptyBeatPending:{authoredTarget:{track:1,staff:1,bar:23,voice:1,beat:3},authoredIsEmpty:true,reimportedIsEmpty:false,reason:'Public GP7 export/reimport converts this authored empty beat to a rest; actual empty-hit acceptance remains unproven.'},systemsLayout:[3,3,3,3,3,3,3,3],performedBars,occurrences,seekCases:[{tick:480,seconds:.25,target:target(0),occurrence:0},{tick:12000,seconds:6.25,target:target(3),occurrence:0},{tick:31200,seconds:16.25,target:target(6),occurrence:1},{tick:81120,seconds:42.25,target:target(19),occurrence:0}],gestureCases,leadingText:['Twenty-four windows','TabPlayer authored layout study','Am','First'],trailingText:['Last window — complete'],initialPrint,page,oversizePage,upperLimit:null,upperLimitPending:'Upper-limit fixture pending actual measured host and a valid content-fitting page; no fabricated setup.'}};
}

export function prepareScoreLayoutFixture({admissionPath,confirmationPath}={}){
  canonical(admissionPath);const admissionBytes=readFileSync(admissionPath),admission=JSON.parse(admissionBytes);assertScoreLayoutAdmission(admission);
  const parent=resolve(repository,'.analysis/desktop-smoke');mkdirSync(parent,{recursive:true});
  const workDirectory=mkdtempSync(resolve(parent,'score-layout-')),inputs=resolve(workDirectory,'inputs'),outputs=resolve(workDirectory,'outputs'),ownershipId=randomUUID();mkdirSync(inputs);mkdirSync(outputs);
  const {gpBytes,oracle}=buildScoreLayoutFixture(),hashes={};
  const put=(name,bytes)=>{const path=resolve(inputs,name);writeFileSync(path,bytes,{flag:'wx'});hashes[path]=sha256(bytes);return path;};
  const scorePath=put('twenty-four-windows.gp',gpBytes),oraclePath=put('oracle.json',json(oracle));
  const project={format:'TabPlayer',schemaVersion:3,engineVersion:'1.8.4',base:{kind:'file',filename:scorePath,bytesBase64:gpBytes.toString('base64'),sha256:sha256(gpBytes)},baselineEdits:[{type:'setPageLayout',layout:oracle.oversizePage}],edits:[],assets:{}};
  const casePaths={main:scorePath,oversize:put('oversize.tabplayer',json(project)),upperLimit:null};
  let confirmation;
  if(confirmationPath){
    canonical(confirmationPath);const packet=JSON.parse(readFileSync(confirmationPath));assertConfirmationPacket(packet);
    const consumptionPath=resolve(parent,`score-layout-confirmation-${packet.initialReceiptSha256}.json`);writeFileSync(consumptionPath,json({confirmationPath,confirmationSha256:sha256(readFileSync(confirmationPath)),ownershipId}),{flag:'wx'});
    confirmation={...packet,packetPath:confirmationPath,packetSha256:sha256(readFileSync(confirmationPath)),consumptionPath,consumptionSha256:sha256(readFileSync(consumptionPath))};
  }
  const state={format:'TabPlayerScoreLayoutAcceptance',version:1,authored:true,ownershipId,workDirectory,inputs,outputs,scorePath,oraclePath,casePaths,hashes,admissionPath,admissionSha256:sha256(admissionBytes),sourceHashes:admission.sourceHashes,buildSourceSha256:admission.buildSourceSha256,...(confirmation?{confirmation}:{}),limits:[oracle.upperLimitPending,oracle.emptyBeatPending.reason,'Oversize fallback and three-page/complete ink gates require actual renderer and desktop evidence.','Paused-only Windows diagnostic slice; physical audio, other OS, GP8 runtime and shipping unproven.']};
  const statePath=resolve(workDirectory,'fixture-state.json');writeFileSync(statePath,json(state),{flag:'wx'});assertScoreLayoutFixture(state,statePath);return {statePath,stateSha256:sha256(readFileSync(statePath))};
}
function assertConfirmationPacket(packet){
  assert.deepEqual(Object.keys(packet).sort(),['affectedPairs','attempt','correctionPacketPath','correctionPacketSha256','initialReceiptPath','initialReceiptSha256']);assert.equal(packet.attempt,1);boundFile(packet.initialReceiptPath,packet.initialReceiptSha256);boundFile(packet.correctionPacketPath,packet.correctionPacketSha256);
  const correction=JSON.parse(readFileSync(packet.correctionPacketPath));assert.deepEqual(Object.keys(correction),['corrections']);assert.ok(Array.isArray(correction.corrections)&&correction.corrections.length>0);
  for(const item of correction.corrections){assert.deepEqual(Object.keys(item).sort(),['contracts','description']);assert.ok(typeof item.description==='string'&&item.description.trim());assert.ok(Array.isArray(item.contracts)&&item.contracts.length>0&&item.contracts.every(contract=>['presentation','fit','pointer'].includes(contract)));}
  const initial=JSON.parse(readFileSync(packet.initialReceiptPath));assert.equal(initial.format,'TabPlayerScoreLayoutReceipt');assert.equal(initial.version,1);assert.equal(initial.scope,'initial');assert.equal(initial.screenshots.length,12);assert.ok(Array.isArray(packet.affectedPairs)&&packet.affectedPairs.length>0&&packet.affectedPairs.length<=12);
  const pair=p=>`${p.layout}:${p.width}x${p.height}`;
  const expected=['verticalPage','horizontalPage','grid','parchment','verticalScreen','horizontalScreen'].flatMap(layout=>[`${layout}:1600x1000`,`${layout}:1024x600`]);assert.deepEqual(initial.screenshots.map(pair).sort(),expected.sort());
  for(const frame of initial.screenshots)boundFile(frame.path,frame.sha256);
  const affected=packet.affectedPairs.map(pair);assert.equal(new Set(affected).size,affected.length);assert.ok(affected.every(p=>expected.includes(p)));
}
export function assertScoreLayoutFixture(state,statePath){
  assert.deepEqual(state,JSON.parse(readFileSync(statePath)),'Fixture state must match immutable saved packet');
  assert.equal(state.format,'TabPlayerScoreLayoutAcceptance');assert.equal(state.version,1);assert.equal(state.authored,true);assert.match(state.ownershipId,/^[a-f0-9-]{36}$/);canonical(statePath);assert.equal(normalized(statePath),normalized(resolve(state.workDirectory,'fixture-state.json')));assertContained(resolve(repository,'.analysis/desktop-smoke'),state.workDirectory);assert.match(basename(state.workDirectory),/^score-layout-[a-zA-Z0-9]+$/);
  for(const name of ['inputs','outputs']){assert.equal(normalized(state[name]),normalized(resolve(state.workDirectory,name)));assertContained(state.workDirectory,state[name]);}
  assert.equal(state.casePaths.main,state.scorePath);const paths=[state.scorePath,state.oraclePath,state.casePaths.oversize,...(state.casePaths.upperLimit?[state.casePaths.upperLimit]:[])];assert.deepEqual(Object.keys(state.hashes).sort(),[...new Set(paths)].sort());assert.deepEqual(Object.keys(inventory(state.inputs)).sort(),paths.map(p=>basename(p)).sort());
  for(const path of paths)boundFile(path,state.hashes[path],state.inputs);
  boundFile(state.admissionPath,state.admissionSha256);const admission=JSON.parse(readFileSync(state.admissionPath));assertScoreLayoutAdmission(admission);assert.deepEqual(state.sourceHashes,admission.sourceHashes);assert.equal(state.buildSourceSha256,admission.buildSourceSha256);
  if(state.confirmation){const c=state.confirmation;assert.equal(c.attempt,1);for(const [path,hash]of [[c.packetPath,c.packetSha256],[c.initialReceiptPath,c.initialReceiptSha256],[c.correctionPacketPath,c.correctionPacketSha256],[c.consumptionPath,c.consumptionSha256]])boundFile(path,hash);const packet=JSON.parse(readFileSync(c.packetPath));assertConfirmationPacket(packet);for(const key of Object.keys(packet))assert.deepEqual(c[key],packet[key]);const consumed=JSON.parse(readFileSync(c.consumptionPath));assert.equal(consumed.ownershipId,state.ownershipId);assert.equal(consumed.confirmationPath,c.packetPath);assert.equal(consumed.confirmationSha256,c.packetSha256);assert.equal(c.consumptionPath,resolve(repository,'.analysis/desktop-smoke',`score-layout-confirmation-${c.initialReceiptSha256}.json`));}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  if(args.length===0||args.length===1&&args[0]==='--help')console.log('Inert. Root only: --prepare --admission=<absolute current build admission> [--confirmation=<absolute packet>].');
  else{assert.ok(args.length===2||args.length===3);assert.equal(args[0],'--prepare');assert.ok(args[1].startsWith('--admission='));if(args[2])assert.ok(args[2].startsWith('--confirmation='));console.log(json(prepareScoreLayoutFixture({admissionPath:args[1].slice(12),confirmationPath:args[2]?.slice(15)})));}
}
