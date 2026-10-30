// D12 desktop acceptance: text typography (font family, text, title and tab-number sizes) and the Classic, Jazz and Rock
// notation presets change how the score is drawn through one undoable setEngraving edit, with no overflowing text and
// the exported music unchanged; a saved style carries its typography; and a version 1 style library from before
// typography is read, listed and upgraded without losing its styles. Reuses the S14 build packet and owned-process
// checks. Build with tests/desktop/string-count-build.mjs, then:
// node tests/desktop/parity-style-typography.mjs --run --build=<absolute build.json>
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from './score-layout-fixture.mjs';
import {assertScoreLayoutListener} from './parity-score-layouts.mjs';
import {assertStringCountBuild,assertStringCountIdentity,assertStringCountPortFree,stringCountEnvironment,validateStringCountArguments} from './parity-string-count.mjs';
import {buildSavedTuningsFixture} from './parity-saved-tunings.mjs';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const samePath=(a,b)=>a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
const hashFile=path=>sha256(readFileSync(path));
const typed={family:'mono',textScale:1.5,titleScale:1.5,tabScale:1.25};
const oldStyleId='7d9b0b64-3a9e-4a52-9c1e-0d1f3f6f2a10';

export async function runStyleTypographyAcceptance({buildPath}={}){
  validateStringCountArguments(['--run',`--build=${buildPath??''}`]);assert.equal(process.platform,'win32');assert.ok(samePath(realpathSync(process.cwd()),realpathSync(repository)),'Use authoritative worktree');
  const packetBytes=readFileSync(buildPath),packet=JSON.parse(packetBytes),ownedDirectory=assertStringCountBuild(packet);
  const {execFileSync}=await import('node:child_process');let identity=null,browser=null,page=null,failure=null;
  const ps=(script,extra={})=>execFileSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop';${script}`],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...stringCountEnvironment(process.env),STRING_COUNT_EXE:packet.executable,STRING_COUNT_PID:String(identity?.pid??''),STRING_COUNT_START:identity?.startTicks??'',...extra}}).trim();
  const portRows=()=>JSON.parse(ps('$rows=@(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess}});ConvertTo-Json -InputObject $rows -Compress'));
  assertStringCountPortFree(portRows());
  // The user's real library must be untouched; the run's library lives in its own app-data folder.
  const realLibrary=resolve(process.env.APPDATA,'dev.tabplayer.desktop','style-library.json'),realHash=()=>existsSync(realLibrary)?hashFile(realLibrary):null,realBefore=realHash();
  const runDirectory=mkdtempSync(resolve(ownedDirectory,'style-typography-')),appData=resolve(runDirectory,'app-data'),results=resolve(runDirectory,'results'),exportDirectory=resolve(runDirectory,'export'),input=resolve(runDirectory,'input');
  for(const path of [appData,results,exportDirectory,input])mkdirSync(path);
  const libraryPath=resolve(appData,'style-library.json'),inputPath=resolve(input,'typography.gp'),exportBase=resolve(exportDirectory,'typography');
  const result={format:'TabPlayerStyleTypographyReceipt',version:1,status:'running',buildPath,buildSha256:sha256(packetBytes),build:packet,runDirectory,appData,libraryPath,realLibrary,realBefore,assertions:[],exports:[],screenshots:[],launches:[],pageErrors:[],fallbacks:[],cleanup:[],startedAtUtc:new Date().toISOString()};
  const step=(name,evidence)=>result.assertions.push({name,time:new Date().toISOString(),evidence});
  const healthy=()=>{assert.deepEqual(result.pageErrors,[],'Page error');assert.deepEqual(result.fallbacks,[],'Tauri transport fallback');};
  const ownedScript='$p=Get-Process -Id $env:STRING_COUNT_PID -ErrorAction SilentlyContinue;if($null -ne $p){if(-not [string]::Equals($p.Path,$env:STRING_COUNT_EXE,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:STRING_COUNT_START){throw "Captured process identity changed"}};';
  const inspect=()=>{const actual=JSON.parse(ps(`${ownedScript}if($null -eq $p){'null'}else{@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`));if(actual)assertStringCountIdentity(identity,actual);return actual;};
  const owned=()=>{healthy();assert.ok(identity&&inspect(),'Owned process exited');assert.equal(hashFile(packet.executable),packet.executableSha256.toLowerCase(),'Executable bytes changed');};
  const poll=async(read,predicate,label)=>{const until=performance.now()+30000;let value;do{value=await read();if(predicate(value))return value;await sleep(50);}while(performance.now()<until);throw Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const listeners=()=>JSON.parse(ps(`${ownedScript}if($null -eq $p){throw 'Owned process exited'};$rows=@();foreach($port in @(Get-NetTCPConnection -State Listen -LocalPort 9223 -ErrorAction SilentlyContinue)){$chain=@();$cursor=[int]$port.OwningProcess;for($depth=0;$depth -lt 20 -and $cursor -gt 0;$depth++){$child=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$cursor);if($null -eq $child){break};$chain+=@{pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;commandLine=$child.CommandLine};if([int]$child.ProcessId -eq $p.Id){break};$cursor=[int]$child.ParentProcessId};$rows+=@{owner=[int]$port.OwningProcess;chain=$chain}};ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress`));
  const stop=async()=>{if(browser){await browser.close();browser=null;page=null;}if(identity){if(inspect())ps(`${ownedScript}if($null -ne $p){Stop-Process -Id $p.Id;if(-not $p.WaitForExit(5000)){throw 'Owned process did not exit'}}`);assert.equal(inspect(),null);identity=null;}await poll(portRows,rows=>rows.length===0,'diagnostic port released');};
  let ui,load,jsonModel;
  const launch=async label=>{
    assertStringCountBuild(packet);assertStringCountPortFree(portRows());
    const own=resolve(runDirectory,label),paths=Object.fromEntries(['session','profile'].map(name=>[name,resolve(own,name)]));for(const path of Object.values(paths))mkdirSync(path,{recursive:true});
    const identityPath=resolve(own,'launch-identity.json');
    const environment={...stringCountEnvironment(process.env),TABPLAYER_DESKTOP_TEST:'1',TABPLAYER_TEST_SESSION_DIR:paths.session,TABPLAYER_TEST_APP_DATA_DIR:appData,TABPLAYER_TEST_OPEN:inputPath,TABPLAYER_TEST_EXPORT:exportBase,WEBVIEW2_USER_DATA_FOLDER:paths.profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223',STRING_COUNT_EXE:packet.executable,STRING_COUNT_IDENTITY:identityPath};
    const script='$ErrorActionPreference="Stop";$p=Start-Process -FilePath $env:STRING_COUNT_EXE -WindowStyle Hidden -PassThru;$text=@{pid=$p.Id;path=$p.Path;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($env:STRING_COUNT_IDENTITY,$text);$text';
    identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000,env:environment}).trim());
    assertStringCountIdentity(identity,json(identityPath));assert.ok(samePath(identity.path,packet.executable));owned();
    const before=await poll(listeners,rows=>rows.length>0,'owned CDP listener');assertScoreLayoutListener(identity,paths.profile,before);
    const {chromium}=await import('playwright');browser=await chromium.connectOverCDP('http://127.0.0.1:9223');owned();assertScoreLayoutListener(identity,paths.profile,listeners());
    assert.equal(browser.contexts().length,1);assert.equal(browser.contexts()[0].pages().length,1);page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('IPC custom protocol failed, Tauri will now use the postMessage interface instead'))result.fallbacks.push(message.text());});
    result.launches.push({label,inputPath,identity,paths});
    await page.locator('.app-shell').waitFor();const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
    await idle();await button('Open');await page.locator('[aria-label="Music notation"] svg').first().waitFor();await native();
  };
  const invoke=async(command,args={})=>{assert.ok(['workspace_snapshot','project_snapshot','audio_status'].includes(command));owned();const value=await page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);healthy();return value;};
  const workspace=()=>invoke('workspace_snapshot'),record=async()=>invoke('project_snapshot',{documentId:(await workspace()).active.documentId});
  const native=()=>poll(()=>invoke('audio_status'),value=>{assert.equal(value.playing,false);assert.equal(value.error,null);return value.ready&&value.generation===value.desiredGeneration;},'paused current native preparation');
  const idle=async()=>{owned();await ui.waitForWorkspaceIdle(page);healthy();};
  const button=async name=>{owned();await ui.clickWorkstationButton(page,name);await idle();};
  const shot=async name=>{const path=resolve(results,`${String(result.screenshots.length+1).padStart(2,'0')}-${name}.png`);await page.screenshot({path});result.screenshots.push(path);};
  const details=async name=>{await page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});};
  const choose=(name,value)=>page.getByRole('combobox',{name:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\s|$)`)}).selectOption(value);
  const percent=async(label,value)=>{const field=page.getByLabel(label,{exact:true});await field.fill(String(value));await field.press('Enter');};
  const openPanels=async()=>{await button('Presentation');for(const name of ['Engraving','Typography','Notation style presets','Saved styles'])await details(name);};
  // Notes of the exported score: typography may change how the score is drawn, never what it holds.
  const notesOf=bytes=>JSON.stringify(load(bytes).tracks.map(track=>track.staves.map(staff=>staff.bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>[beat.duration,beat.text??null,beat.notes.map(note=>[note.string,note.fret,note.realValue])]))))));
  let baseline=null;
  const exportCheck=async label=>{
    const beforeRecord=await record(),path=`${exportBase}.gp`;assert.equal(existsSync(path),false);await button('Export GP');const bytes=readFileSync(path),music=notesOf(bytes);
    baseline??=music;assert.equal(music,baseline,`${label}: the exported notes are unchanged`);assert.deepEqual(await record(),beforeRecord,'Export must not change project/history/revision');
    const saved=resolve(exportDirectory,`${String(result.exports.length+1).padStart(2,'0')}-${label}.gp`);renameSync(path,saved);result.exports.push({label,path:saved,sha256:sha256(bytes)});await native();
  };
  // PDF, PNG and SVG pages come from one render; each is exported through the real dialog. An SVG page is outlined
  // paths, so its spill is measured by laying it out: nothing may leave its own page.
  const svgSpill=text=>page.evaluate(svgText=>{
    const host=document.createElement('div');host.style.cssText='position:absolute;left:-100000px;top:0';host.innerHTML=svgText;document.body.append(host);
    try{const svg=host.querySelector('svg'),frame=svg.getBoundingClientRect();return {width:frame.width,height:frame.height,paths:svg.querySelectorAll('path').length,spill:[...svg.querySelectorAll('path')].filter(path=>{const box=path.getBoundingClientRect();return box.width>0&&(box.left<frame.left-2||box.right>frame.right+2||box.top<frame.top-2||box.bottom>frame.bottom+2);}).length};}finally{host.remove();}
  },text);
  const exportPages=async label=>{
    const beforeRecord=await record(),found={};
    for(const format of ['pdf','png','svg']){
      const path=`${exportBase}.${format}`;assert.equal(existsSync(path),false);
      await ui.clickWorkspaceCommand(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});
      await dialog.getByLabel('Export format').selectOption(format);if(format==='png')await dialog.getByLabel('Resolution').selectOption('150');
      await dialog.getByRole('button',{name:'Export',exact:true}).click();
      const until=Date.now()+120000;while(!existsSync(path)){const failure=dialog.getByRole('alert');if(await failure.count())throw new Error(`${label} ${format}: ${await failure.innerText()}`);if(Date.now()>until)throw new Error(`${label} ${format}: no output`);await sleep(200);}
      await dialog.waitFor({state:'hidden'});await idle();
      const bytes=readFileSync(path);
      if(format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      if(format==='png'){assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.readUInt32BE(16)>1000&&bytes.readUInt32BE(20)>1000,'PNG page size');}
      if(format==='svg'){const text=bytes.toString('utf8');assert.ok(text.startsWith('<svg'));const measured=await svgSpill(text);assert.ok(measured.paths>2&&measured.width>0,'SVG page has laid-out notation');assert.equal(measured.spill,0,`${label}: no SVG content leaves its page`);found.svgPage=[measured.width,measured.height];}
      found[format]=sha256(bytes);renameSync(path,resolve(exportDirectory,`${String(result.exports.length+1).padStart(2,'0')}-${label}.${format}`));result.exports.push({label,format,sha256:found[format]});
    }
    assert.deepEqual(await record(),beforeRecord,'Exporting pages never edits the document');return found;
  };
  // The text actually drawn: families and sizes of annotations and of fret digits, and any text outside its own tile or page.
  const drawn=()=>page.locator('[aria-label="Music notation"] svg').evaluateAll(nodes=>{
    const texts=nodes.flatMap(svg=>[...svg.querySelectorAll('text')].filter(text=>text.textContent.trim()).map(text=>({svg,text,style:getComputedStyle(text),content:text.textContent.trim()})));
    const words=texts.filter(({style})=>!/alphatab|bravura/i.test(style.fontFamily)),digits=words.filter(({content})=>/^\d+$/.test(content)),labels=words.filter(({content})=>!/^\d+$/.test(content));
    const size=list=>Math.max(0,...list.map(({style})=>parseFloat(style.fontSize)));
    const spill=texts.filter(({svg,text})=>{const box=svg.getBoundingClientRect(),rect=text.getBoundingClientRect();return rect.width>0&&(rect.left<box.left-2||rect.right>box.right+2||rect.top<box.top-2||rect.bottom>box.bottom+2);}).map(({content})=>content);
    const sheets=[...document.querySelectorAll('.score-sheet')],pageSpill=sheets.flatMap(sheet=>{const frame=sheet.getBoundingClientRect();return [...sheet.querySelectorAll('svg text')].filter(text=>text.textContent.trim()).filter(text=>{const rect=text.getBoundingClientRect();return rect.width>0&&(rect.left<frame.left-2||rect.right>frame.right+2||rect.top<frame.top-2||rect.bottom>frame.bottom+2);}).map(text=>text.textContent.trim());});
    const annotation=labels.find(({content})=>content.includes('同じ楽譜')),chord=labels.find(({content})=>/maj7|m7|sus4/.test(content));
    return {families:[...new Set(labels.map(({style})=>style.fontFamily))],largest:size(words),digitSize:size(digits),annotationSize:annotation?parseFloat(annotation.style.fontSize):0,chordSize:chord?parseFloat(chord.style.fontSize):0,
      cjk:annotation?annotation.text.getBoundingClientRect().width:0,count:words.length,sheets:sheets.length,spill,pageSpill};
  });
  const sans=/arial|sans-serif/i,serif=/georgia|serif/i,mono=/consolas|monospace/i;
  const clean=value=>{assert.deepEqual(value.spill,[],'No text spills out of its tile');assert.deepEqual(value.pageSpill,[],'No text spills out of its page');};
  const edits=async()=>(await record()).snapshot.project.edits;
  // A preset fills the form (no edit), then Apply is exactly one more edit holding the preset's choices.
  const preset=async(name,typography,stylesheet,notation,family)=>{
    const count=(await edits()).length;await page.getByRole('button',{name:`Load ${name} preset`,exact:true}).click();await idle();
    assert.equal((await edits()).length,count,`${name}: loading never edits`);await button('Apply engraving');
    const after=await record(),edit=after.snapshot.project.edits.at(-1);assert.equal(after.snapshot.project.edits.length,count+1,`${name}: one edit`);
    assert.equal(edit.type,'setEngraving');assert.deepEqual(typography?edit.engraving.typography:Object.hasOwn(edit.engraving,'typography'),typography??false,`${name}: typography`);
    for(const [key,value] of Object.entries(stylesheet))assert.equal(edit.engraving.stylesheet[key],value,`${name}: ${key}`);
    for(const [key,value] of Object.entries(notation))assert.equal(edit.engraving.notation[key],value,`${name}: ${key}`);
    const now=await poll(drawn,value=>value.families.length>0&&value.families.every(entry=>family.test(entry)),`${name}: text drawn in its family`);clean(now);await shot(`${name.toLowerCase()}-preset`);await exportCheck(name.toLowerCase());
    return {edit,now};
  };
  const ratio=(now,before,key)=>Math.round(now[key]/before[key]*100)/100;
  try{
    ui=await import('./workstation-commands.mjs');const {importer,exporter,model,Settings}=await import('@coderline/alphatab');load=bytes=>importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings());
    // Several bars with chord names, beat text in CJK and a long Latin line, so glyphs and widths are really exercised.
    const fixture=load(await buildSavedTuningsFixture()),staff=fixture.tracks[0].staves[0];
    assert.ok(staff.bars.length>=2,'The fixture has several bars');
    const words=['同じ楽譜 🎸','A long annotation that needs room','Öö ä ü','漢字かな交じり文'],names=['Cmaj7(♯11)/G','F♯m7♭5','Dsus4','Am7'];let annotated=0;
    staff.bars.forEach((bar,b)=>bar.voices[0].beats.forEach((beat,i)=>{
      if(i%2===0){beat.text=words[(b+i/2)%words.length];annotated++;}
      if(i===0){const chord=new model.Chord();chord.name=names[b%names.length];chord.firstFret=1;chord.strings=staff.tuning.map(()=>-1);staff.addChord(`d12-${b}`,chord);beat.chordId=`d12-${b}`;}
    }));
    assert.ok(annotated>=3);
    writeFileSync(inputPath,Buffer.from(new exporter.Gp7Exporter().export(fixture,new Settings())),{flag:'wx'});result.input={inputPath,sha256:hashFile(inputPath)};
    assert.equal(existsSync(libraryPath),false);

    // Launch 1: typography is one undoable edit that changes the drawing and nothing in the music.
    await launch('launch-1');let initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);
    await native();await exportCheck('before');
    const plain=await drawn(),drawnBefore=await rendered();assert.ok(plain.count>0,'The score draws text');assert.ok(plain.annotationSize>0&&plain.chordSize>0&&plain.digitSize>0,'The fixture draws annotations, chord names and fret numbers');clean(plain);assert.ok(plain.cjk>0,'CJK text has a drawn width');
    const plainPages=await exportPages('before');
    await openPanels();
    await choose('Text font','mono');await percent('Text size (%)',150);await percent('Title size (%)',150);await percent('Tab number size (%)',125);
    assert.deepEqual((await record()).snapshot.project.edits,[],'Typing and choosing never edit the document before Apply');
    await button('Apply engraving');
    const applied=await record();assert.deepEqual(applied.snapshot.project.edits.map(edit=>edit.type),['setEngraving']);assert.deepEqual(applied.snapshot.project.edits[0].engraving.typography,typed);
    const large=await poll(drawn,value=>value.families.length>0&&value.families.every(family=>mono.test(family)),'the score is drawn in the chosen font');
    // As drawn, not as recorded: annotations at 150%, fret numbers at 125% (and still in the default family).
    assert.equal(ratio(large,plain,'annotationSize'),1.5,'Annotations are drawn at the text size');assert.equal(ratio(large,plain,'chordSize'),1.5,'Chord names are drawn at the text size');assert.equal(ratio(large,plain,'digitSize'),1.25,'Fret numbers are drawn at the tab number size');
    assert.ok(large.cjk>plain.cjk,'CJK text is drawn wider');clean(large);
    const drawnTyped=await rendered();assert.notEqual(drawnTyped,drawnBefore);await shot('typography-applied');await exportCheck('typography');
    const typedPages=await exportPages('typography');for(const format of ['pdf','png','svg'])assert.notEqual(typedPages[format],plainPages[format],`${format}: export draws the new sizes`);
    assert.deepEqual(typedPages.svgPage,plainPages.svgPage,'Typography never changes the page size');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,initial.snapshot.project,'Undo restores the record');assert.equal(await poll(rendered,value=>value===drawnBefore,'undo restores the drawing'),drawnBefore);await exportCheck('typography-undo');
    await button('Redo');assert.deepEqual((await record()).snapshot.project,applied.snapshot.project,'Redo restores the record');assert.equal(await poll(rendered,value=>value===drawnTyped,'redo restores the drawing'),drawnTyped);
    step('Typography is one undoable edit; text and fret numbers are drawn at the chosen sizes with no overflow, and PDF, PNG and SVG are exported',{typography:typed,plain,large,plainPages,typedPages});

    // Title size alone changes the exported page header and nothing else.
    await choose('Text font','inherit');await percent('Text size (%)','');await percent('Tab number size (%)','');await percent('Title size (%)',200);await button('Apply engraving');
    const titled=await exportPages('title-only');assert.notEqual(titled.svg,plainPages.svg,'Title size changes the exported page header');assert.deepEqual(titled.svgPage,plainPages.svgPage);
    step('Title size scales the exported page header',{titled});

    // The smallest sizes must lay out too, without the music changing.
    await percent('Title size (%)',50);await percent('Text size (%)',50);await percent('Tab number size (%)',75);await button('Apply engraving');
    const small=await poll(drawn,value=>value.largest<plain.largest,'smaller text');clean(small);await exportCheck('smallest');await exportPages('smallest');

    // Each preset applies as one edit and is drawn in its family; Classic and Rock too, not only Jazz.
    const classic=await preset('Classic',{family:'serif',textScale:null,titleScale:1.25,tabScale:null},{barNumbers:'firstSystem',brackets:'staves',chords:'top',multiRests:'on'},{tabRhythm:'hidden'},serif);
    const jazz=await preset('Jazz',{family:'serif',textScale:1.15,titleScale:1.4,tabScale:null},{barNumbers:'all',chords:'both',multiRests:'on',hideEmptyStaves:true},{tabRhythm:'hidden'},serif);
    const rock=await preset('Rock',{family:'sans',textScale:null,titleScale:null,tabScale:1.15},{barNumbers:'all',chords:'inline',multiRests:'off',brackets:'similar'},{tabRhythm:'beams',extendBendArrows:true,extendLineEffects:true},sans);
    assert.equal(rock.edit.engraving.typography.tabScale,1.15);assert.ok(jazz.now.annotationSize>classic.now.annotationSize,'Jazz text is larger than Classic');
    await exportPages('rock');
    await button('Undo');await button('Redo');
    step('Classic, Jazz and Rock each apply as one undoable edit, are drawn in their family and leave the music unchanged',{classic:classic.edit.engraving,jazz:jazz.edit.engraving,rock:rock.edit.engraving});

    // A saved style carries its typography into the personal library. Plain styles keep the file at version 1.
    await page.getByLabel('Style name',{exact:true}).fill('Rock house');await page.getByRole('button',{name:'Save current style',exact:true}).click();
    await poll(()=>existsSync(libraryPath),Boolean,'library file written');await page.getByRole('status').filter({hasText:'Saved Rock house.'}).waitFor();
    const library=json(libraryPath);assert.equal(library.version,2);assert.equal(library.entries.length,1);assert.deepEqual(library.entries[0].engraving.typography,rock.edit.engraving.typography);assert.deepEqual(library.entries[0].engraving.profiles,[]);
    const rockRecord=await record();
    // Force default style clears typography with the rest, as one undoable edit.
    await page.getByRole('button',{name:'Force default style',exact:true}).click();await idle();
    const forced=await record();assert.equal(forced.snapshot.project.edits.length,rockRecord.snapshot.project.edits.length+1);assert.equal(Object.hasOwn(forced.snapshot.project.edits.at(-1).engraving,'typography'),false,'Default typography is not stored');
    assert.equal(await poll(rendered,value=>value===drawnBefore,'the factory style draws the original score'),drawnBefore);await exportCheck('forced');
    await button('Undo');assert.deepEqual((await record()).snapshot.project,rockRecord.snapshot.project);
    step('A saved style carries typography and Force default style clears it',{entry:library.entries[0]});
    await stop();

    // Launch 2: a version 1 library written before typography is read, listed and applied; saving a style without typography keeps it version 1.
    const oldEngraving={stylesheet:{...library.entries[0].engraving.stylesheet,barNumbers:'hidden'},notation:library.entries[0].engraving.notation,systemSpacing:null,profiles:[]};
    const oldLibrary=Buffer.from(JSON.stringify({format:'tabplayer-style-library',version:1,entries:[{id:oldStyleId,name:'Older style',engraving:oldEngraving}]}));writeFileSync(libraryPath,oldLibrary);const oldHash=hashFile(libraryPath);
    baseline=null;await launch('launch-2');initial=await record();assert.deepEqual(initial.snapshot.project.edits,[]);await openPanels();
    await page.getByRole('combobox',{name:'Saved style',exact:true}).selectOption(oldStyleId);
    assert.equal(hashFile(libraryPath),oldHash,'Reading a version 1 library never rewrites it');assert.equal(await page.getByRole('alert').filter({hasText:'Could not read saved styles'}).count(),0,'A version 1 library is not damaged');
    await page.getByRole('button',{name:'Apply saved style',exact:true}).click();await idle();
    const oldApplied=await record();assert.equal(oldApplied.snapshot.project.edits.length,1);assert.equal(oldApplied.snapshot.project.edits[0].engraving.stylesheet.barNumbers,'hidden');assert.equal(Object.hasOwn(oldApplied.snapshot.project.edits[0].engraving,'typography'),false);
    await page.getByLabel('Style name',{exact:true}).fill('Newer style');await page.getByRole('button',{name:'Save current style',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved Newer style.'}).waitFor();
    const kept=json(libraryPath);assert.equal(kept.version,1,'No style uses typography, so an older build can still read the file');assert.deepEqual(kept.entries.map(entry=>entry.name),['Older style','Newer style']);assert.deepEqual(kept.entries[0].engraving,oldEngraving,'The older style is kept as it was');
    // Typography in the next saved style makes the file version 2, keeping the older styles.
    await percent('Text size (%)',120);await button('Apply engraving');await page.getByLabel('Style name',{exact:true}).fill('Larger text');await page.getByRole('button',{name:'Save current style',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved Larger text.'}).waitFor();
    const upgraded=json(libraryPath);assert.equal(upgraded.version,2);assert.deepEqual(upgraded.entries.map(entry=>entry.name),['Older style','Newer style','Larger text']);assert.equal(upgraded.entries[2].engraving.typography.textScale,1.2);assert.deepEqual(upgraded.entries[0].engraving,oldEngraving);
    await shot('old-library-upgraded');step('A version 1 style library stays readable, stays version 1 until a style uses typography, then becomes version 2',{oldHash,kept,upgraded});
    assert.equal(realHash(),realBefore,'Real user library untouched');healthy();
  }catch(error){failure=error;result.error={message:String(error),stack:error.stack};if(page)try{await page.screenshot({path:resolve(results,'failure.png')});}catch{}}
  finally{
    try{await stop();result.cleanup.push({name:'Stop owned process',ok:true});}catch(error){failure??=error;result.cleanup.push({name:'Stop owned process',ok:false,error:String(error)});}
    try{assertStringCountBuild(packet);assert.equal(hashFile(buildPath),result.buildSha256);assert.equal(realHash(),realBefore);result.cleanup.push({name:'Build and real library integrity',ok:true});}catch(error){failure??=error;result.cleanup.push({name:'Build and real library integrity',ok:false,error:String(error)});}
    result.status=failure?'failed':'passed';result.finishedAtUtc=new Date().toISOString();writeFileSync(resolve(results,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  }
  if(failure)throw failure;return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const options=validateStringCountArguments(process.argv.slice(2));if(options.mode==='help')console.log('Desktop acceptance for style typography and notation presets. --run --build=<absolute TabPlayerStringCountBuild JSON>.');
  else{const outcome=await runStyleTypographyAcceptance(options);console.log(JSON.stringify({status:outcome.status,runDirectory:outcome.runDirectory,assertions:outcome.assertions.map(a=>a.name),screenshots:outcome.screenshots},null,2));}
}
