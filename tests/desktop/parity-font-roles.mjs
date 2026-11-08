import {waitForWorkspaceIdle,clickWorkstationButton} from './workstation-commands.mjs';
import {readActiveDocument} from './document-context.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {directory,launch,connect,stop} from './harness.mjs';
import {exporter,model,Settings} from '@coderline/alphatab';

// Font roles and music font (D12), in the vertical page view at A4. One authored guitar score (title, section markers, chord names,
// lyrics with a character Noto Serif lacks) is opened and:
//   - exported with no fonts chosen: the PDF embeds only the faces the exports always used (Noto Sans, plus CJK and Emoji where used,
//     and Bravura for the notation), and export draws music glyphs at the size the screen does (the 34/36 question, measured);
//   - given Lyrics = Noto Serif italic, Markers = Noto Sans Mono bold, Page header = Noto Serif 150% and music = Petaluma in ONE edit
//     (history grows by one, nothing is recorded before Apply): the drawn text uses the alias families (getComputedStyle), the music
//     glyphs use Petaluma, the PDF embeds NotoSerif-Italic, NotoSansMono-Bold, NotoSerif-Regular and Petaluma, and no text leaves the paper;
//   - warns about a lyric character outside the chosen face;
//   - undone, redone, saved and reopened; switched to Leland and back to Bravura; the native playback generation never changes;
//   - saved as a style with fonts (the library becomes version 3) and removed again (back to version 1), in an isolated app-data folder.
const fixtureFile=resolve(directory,'font-roles-fixture.gp');
const evidenceDirectory=resolve('.analysis/parity');mkdirSync(evidenceDirectory,{recursive:true});
const runDirectory=mkdtempSync(resolve(directory,'font-roles-run-'));
const appData=resolve(runDirectory,'app-data'),saved=resolve(runDirectory,'font-roles.tabplayer'),exported=resolve(runDirectory,'font-roles'),pdf=`${exported}.pdf`;
mkdirSync(appData);
const libraryPath=resolve(appData,'style-library.json');
const realLibrary=process.env.APPDATA?resolve(process.env.APPDATA,'dev.tabplayer.desktop','style-library.json'):null;
const hashOf=path=>path&&existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;
const realBefore=hashOf(realLibrary);
const result={fixture:fixtureFile,runDirectory,checks:[]},failures=[];
const check=async(name,body)=>{
  try{const detail=await body();console.log(`PASS ${name}${detail?` - ${detail}`:''}`);result.checks.push({name,pass:true,detail:detail??null});}
  catch(error){const message=error instanceof Error?error.message:String(error);console.log(`FAIL ${name} - ${message.split('\n').slice(0,6).join(' | ')}`);failures.push(name);result.checks.push({name,pass:false,detail:message});}
};

// An entirely authored score: eight bars of quarter-note tab, a section marker on the first and fifth, chord names, and lyrics whose
// second syllable is a CJK character (Noto Serif has no glyph for it) and whose third is an Estonian one (it has).
function buildFixture(){
  const settings=new Settings(),score=new model.Score();score.title='Font roles study';score.artist='TabPlayer authored';
  let barId=0,voiceId=0,beatId=0,noteId=0;
  for(let bar=0;bar<8;bar++){
    const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;
    if(bar===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];
    if(bar===0||bar===4){const section=new model.Section();section.marker=bar===0?'A':'B';section.text=bar===0?'Verseq':'Chorusq';master.section=section;}
    score.addMasterBar(master);
  }
  const track=new model.Track();track.name='Font guitar';track.shortName='Gtr';Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});score.addTrack(track);
  const staff=new model.Staff();staff.showStandardNotation=true;staff.showTablature=true;staff.stringTuning.tunings=[64,59,55,50,45,40];track.addStaff(staff);
  for(const [id,name] of [['c1','Cmaj7'],['c2','Am7']]){const chord=new model.Chord();chord.name=name;chord.firstFret=1;chord.strings=[-1,-1,-1,-1,-1,-1];chord.showName=true;staff.addChord(id,chord);}
  for(let barIndex=0;barIndex<8;barIndex++){
    const bar=new model.Bar();bar.id=barId++;bar.clef=model.Clef.G2;staff.addBar(bar);
    const voice=new model.Voice();voice.id=voiceId++;bar.addVoice(voice);
    for(let beatIndex=0;beatIndex<4;beatIndex++){
      const beat=new model.Beat();beat.id=beatId++;beat.duration=model.Duration.Quarter;voice.addBeat(beat);
      const note=new model.Note();note.id=noteId++;note.string=2+((barIndex+beatIndex)%4);note.fret=(barIndex*2+beatIndex*3)%9;beat.addNote(note);
      if(beatIndex===0)beat.chordId=barIndex%2?'c2':'c1';
    }
  }
  // Track.applyLyrics fills only the first beat in alphaTab 1.8.4, so the syllables are set on the beats themselves.
  ['Lyriq','中','õ'].forEach((syllable,index)=>{staff.bars[0].voices[0].beats[index].lyrics=[syllable];});
  score.rebuildRepeatGroups();score.finish(settings);
  return Buffer.from(new exporter.Gp7Exporter().export(score,settings));
}
mkdirSync(directory,{recursive:true});writeFileSync(fixtureFile,buildFixture());

const sleep=ms=>new Promise(accept=>setTimeout(accept,ms));
let id=launch({TABPLAYER_TEST_OPEN:fixtureFile,TABPLAYER_TEST_SAVE:saved,TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_APP_DATA_DIR:appData}),browser,page;
const errors=[];
try{
  const attach=async()=>{
    browser=await connect();page=browser.contexts()[0].pages()[0];await waitForWorkspaceIdle(page);
    page.on('pageerror',error=>errors.push(error.message));
    const library=page.getByRole('dialog',{name:'Library',exact:true});await library.getByRole('heading',{name:'Welcome to TabPlayer',exact:true}).waitFor();await library.getByRole('button',{name:'Close',exact:true}).click();await library.waitFor({state:'hidden'});
  };
  const idle=async()=>{await waitForWorkspaceIdle(page);assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);};
  const button=async name=>{await clickWorkstationButton(page,name,{waitForIdle:false});await idle();};
  const details=name=>page.locator('summary').filter({hasText:new RegExp(`^${name}$`)}).first().evaluate(node=>{node.parentElement.open=true;});
  const snapshot=()=>readActiveDocument(page);
  const status=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('audio_status'));
  const waitStatus=async predicate=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await status();if(predicate(value))return value;await sleep(25);}throw new Error(`Audio status timeout: ${JSON.stringify(await status())}`);};
  const poll=async(read,predicate,label,timeout=30000)=>{const until=Date.now()+timeout;let value;do{value=await read();if(predicate(value))return value;await sleep(100);}while(Date.now()<until);throw new Error(`Timed out: ${label}: ${JSON.stringify(value)}`);};
  const choose=(name,option)=>page.getByRole('combobox',{name:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\s|$)`)}).selectOption(option);
  const percent=async(label,value)=>{const input=page.getByLabel(label,{exact:true});await input.fill(String(value));await input.press('Enter');};
  const openPanels=async()=>{await button('Presentation');for(const name of ['Engraving','Typography','Saved styles'])await details(name);};
  const generations=[];
  const generation=async label=>{const value=(await status()).generation;generations.push({label,generation:value});return value;};
  const edits=async()=>(await snapshot()).project.edits;
  const lastFonts=project=>{const last=[...project.edits].reverse().find(edit=>edit.type==='setEngraving');return last?.engraving?.fonts;};

  // PDF: every font the writer embedded, as its name (subset prefix removed; a composite font appears twice, the Type0 wrapper adding -Identity-H).
  const pdfFonts=()=>{const text=readFileSync(pdf).toString('latin1');return [...new Set([...text.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/[\]<>()]+)/g)].map(match=>match[1].replace(/-Identity-H$/,'')))].sort();};
  const exportPdf=async()=>{
    if(existsSync(pdf))rmSync(pdf);
    await clickWorkstationButton(page,'Export score',{waitForIdle:false});const dialog=page.getByRole('dialog',{name:'Export score'});await dialog.getByLabel('Export format').selectOption('pdf');
    await dialog.getByRole('button',{name:'Export',exact:true}).click();
    await Promise.race([dialog.waitFor({state:'hidden',timeout:60000}),dialog.getByRole('alert').waitFor({timeout:60000}).then(async()=>{throw new Error(await dialog.getByRole('alert').textContent());})]);await dialog.waitFor({state:'hidden',timeout:60000});await idle();
    assert.equal(readFileSync(pdf).subarray(0,5).toString(),'%PDF-');
    return pdfFonts();
  };
  // The page SVGs handed to the PDF writer for the last export: the music CSS they carry, text past the page edge, and the size a notehead is drawn at.
  const exportedPages=()=>page.evaluate(()=>{
    const pages=window.__tabplayerTestExportPages.at(-1),host=document.createElement('div');host.style.cssText='position:absolute;left:-100000px;top:0';document.body.append(host);
    try{
      return pages.map(sheet=>{
        host.innerHTML=sheet.svg;const svg=host.querySelector('svg'),frame=svg.getBoundingClientRect(),style=svg.querySelector('style')?.textContent??'';
        const texts=[...svg.querySelectorAll('text')].filter(text=>text.textContent.trim());
        const spill=texts.filter(text=>{const box=text.getBoundingClientRect();return box.width>0&&(box.left<frame.left-2||box.right>frame.right+2||box.top<frame.top-2||box.bottom>frame.bottom+2);}).map(text=>text.textContent.trim());
        const notehead=[...svg.querySelectorAll('text')].find(text=>text.textContent.trim()==='');
        const header=texts.find(text=>text.parentNode===svg);
        return {musicCss:/\.at\{[^}]*\}/.exec(style)?.[0]??null,width:frame.width,height:frame.height,texts:texts.length,spill,notehead:notehead?getComputedStyle(notehead).fontSize:null,header:header?{content:header.textContent,family:header.getAttribute('font-family'),size:header.getAttribute('font-size')}:null};
      });
    }finally{host.remove();}
  });
  // What the screen draws: families, styles and sizes of the lyric, the marker, the page header and the notation glyphs. In the page layouts alphaTab renders
  // into a hidden staging surface ([aria-label="Music notation"]) and the person sees the chunks copied into .score-pages, so both are measured: `visible` is
  // what is on the page, the top level what alphaTab drew.
  const drawn=()=>page.evaluate(()=>{
    const style=text=>{if(!text)return null;const css=getComputedStyle(text);return {content:text.textContent.trim(),family:css.fontFamily,style:css.fontStyle,weight:css.fontWeight,size:css.fontSize};};
    const measure=selector=>{
      const texts=[...document.querySelectorAll(selector)].flatMap(svg=>[...svg.querySelectorAll('text')].filter(text=>text.textContent.trim()));
      const glyphs=texts.filter(text=>text.parentNode.classList?.contains('at')),glyph=glyphs.find(text=>text.textContent.trim()==='\uE0A4')??glyphs[0];
      return {lyric:style(texts.find(text=>text.textContent.trim()==='Lyriq')),marker:style(texts.find(text=>text.textContent.includes('Verseq'))),chord:style(texts.find(text=>text.textContent.includes('Cmaj7'))),
        glyph:style(glyph),glyphFamilies:[...new Set(glyphs.map(text=>getComputedStyle(text).fontFamily))],glyphCount:glyphs.length};
    };
    const header=document.querySelector('.score-page-text text');
    return {...measure('[aria-label="Music notation"] svg'),visible:measure('.score-pages .score-svg-chunk svg'),
      header:header?{...style(header),attrSize:header.getAttribute('font-size'),attrFamily:header.getAttribute('font-family')}:null,
      faces:[...document.fonts].filter(face=>face.status==='loaded').map(face=>`${face.family}|${face.weight}|${face.style}`)};
  });
  const alias=(family,name)=>typeof family==='string'&&family.replaceAll('"','').split(',')[0].trim()===name;
  const savedStyles=()=>JSON.parse(readFileSync(libraryPath,'utf8'));

  await attach();
  await button('Open');await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  let baselineGeneration=await generation('opened');assert.ok(Number.isInteger(baselineGeneration));
  await button('Presentation');await details('Page layout');await page.getByLabel('Width (mm)',{exact:true}).fill('210');await page.getByLabel('Height (mm)',{exact:true}).fill('297');await button('Apply page layout');
  await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');
  await page.locator('.score-page-text text').first().waitFor();
  const baseProject=(await snapshot()).project;

  // ---- A default document ----
  const plain=await poll(drawn,value=>value.lyric&&value.marker&&value.header&&value.glyph&&value.glyphCount>0&&value.visible.glyph&&value.visible.lyric&&value.visible.marker,'the default score is drawn');
  const plainPdf=await exportPdf(),plainPages=await exportedPages();
  await check('default: no role or music font is chosen and the screen draws system fonts, not the aliases',async()=>{
    assert.equal(lastFonts(baseProject),undefined);
    for(const key of ['lyric','marker','chord','header'])assert.ok(!/TabPlayer (Sans|Serif|Mono)/.test(plain[key].family),`${key} family ${plain[key].family}`);
    for(const key of ['lyric','marker','chord'])assert.ok(!/TabPlayer (Sans|Serif|Mono)/.test(plain.visible[key].family),`visible ${key} family ${plain.visible[key].family}`);
    assert.ok(plain.visible.glyphCount>0&&!/Petaluma|Leland/.test(plain.visible.glyph.family),'the visible page draws Bravura');
    assert.ok(!/Petaluma|Leland/.test(plain.glyph.family),plain.glyph.family);
    return JSON.stringify({lyric:plain.lyric.family,marker:plain.marker.family,glyph:plain.glyph.family});
  });
  await check('default: the PDF embeds only the faces exports always used (Noto Sans, CJK where used, Bravura), none of the D12 faces',async()=>{
    const allowed=new Set(['NotoSans-Regular','NotoSansCJKjp-Regular','NotoEmoji','Bravura']);
    assert.ok(plainPdf.length>0,'the PDF embeds fonts');
    assert.deepEqual(plainPdf.filter(name=>!allowed.has(name)),[],'only pre-D12 faces');
    assert.ok(plainPdf.includes('NotoSans-Regular'),'Noto Sans is embedded');
    result.defaultPdfFonts=plainPdf;return JSON.stringify(plainPdf);
  });
  await check('34/36: export draws music glyphs at the size the screen does (36 px)',async()=>{
    for(const sheet of plainPages)assert.equal(sheet.musicCss,'.at{font-family:Bravura;font-size:36px}');
    const exportNotehead=plainPages.map(sheet=>sheet.notehead).find(Boolean);
    assert.equal(parseFloat(plain.glyph.size),36,`screen notehead size ${plain.glyph.size}`);
    assert.equal(parseFloat(exportNotehead),36,`export notehead size ${exportNotehead}`);
    result.musicSize={screen:plain.glyph.size,exportNotehead,exportCss:plainPages[0].musicCss};
    return `screen ${plain.glyph.size}, export ${exportNotehead}, css ${plainPages[0].musicCss}`;
  });

  // ---- A style without fonts keeps the library at version 1 ----
  await openPanels();
  await page.getByLabel('Style name',{exact:true}).fill('Plain house');await page.getByRole('button',{name:'Save current style',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved Plain house.'}).waitFor();
  await check('a saved style without fonts keeps the style library at version 1',async()=>{const library=savedStyles();assert.equal(library.version,1);assert.deepEqual(library.entries.map(entry=>entry.name),['Plain house']);});

  // ---- The one edit ----
  const historyBefore=(await edits()).length;
  await choose('Lyrics font','notoSerif');await choose('Lyrics italic','on');
  await choose('Markers font','notoSansMono');await choose('Markers bold','on');
  await choose('Page header font','notoSerif');await percent('Page header size (%)',150);
  await choose('Music font','petaluma');
  await check('choosing fonts records nothing until Apply, and the lyric character Noto Serif lacks is warned about',async()=>{
    assert.equal((await edits()).length,historyBefore);
    const warning=page.getByRole('status').filter({hasText:'Noto Serif has no glyph for'});await warning.first().waitFor({timeout:10000});
    const text=await warning.first().innerText();assert.ok(text.includes('中')&&text.includes('Lyrics'),text);
    assert.ok(!text.includes('õ'),'õ is covered by Noto Serif and is not named');return text;
  });
  await button('Apply engraving');
  const applied=await snapshot();
  await check('Apply engraving is one setEngraving edit holding exactly the chosen fonts',async()=>{
    assert.equal(applied.project.edits.length,historyBefore+1);assert.equal(applied.project.edits.at(-1).type,'setEngraving');
    assert.deepEqual(lastFonts(applied.project),{music:'petaluma',roles:{lyrics:{font:'notoSerif',italic:true},markers:{font:'notoSansMono',bold:true},pageHeader:{font:'notoSerif',size:1.5}}});
  });
  await check('Apply engraving again with nothing changed records nothing',async()=>{await button('Apply engraving');assert.equal((await edits()).length,applied.project.edits.length);});
  const typed=await poll(drawn,value=>value.glyph&&/Petaluma/.test(value.glyph.family)&&value.lyric&&alias(value.lyric.family,'TabPlayer Serif')&&value.marker&&value.header&&value.visible.glyph&&/Petaluma/.test(value.visible.glyph.family)&&alias(value.visible.lyric?.family,'TabPlayer Serif'),'the chosen fonts are drawn');
  // Screenshots for a look by eye (not asserted): the page, and the fonts panel scrolled into view.
  await page.screenshot({path:resolve(evidenceDirectory,'font-roles-page.png')});await page.getByRole('combobox',{name:/^Music font/}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(evidenceDirectory,'font-roles-panel.png')});await page.getByRole('combobox',{name:/^Markers italic/}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(evidenceDirectory,'font-roles-roles.png')});
  await check('screen: lyrics use the Serif alias in italic, markers the Mono alias in bold, the header the Serif alias at 150%',async()=>{
    assert.ok(alias(typed.lyric.family,'TabPlayer Serif'),typed.lyric.family);assert.equal(typed.lyric.style,'italic');
    // The page the person sees (the copied chunks), not only alphaTab's hidden staging surface.
    assert.ok(alias(typed.visible.lyric.family,'TabPlayer Serif')&&typed.visible.lyric.style==='italic',JSON.stringify(typed.visible.lyric));
    assert.ok(alias(typed.visible.marker.family,'TabPlayer Mono')&&Number(typed.visible.marker.weight)>=700,JSON.stringify(typed.visible.marker));
    assert.ok(alias(typed.marker.family,'TabPlayer Mono'),typed.marker.family);assert.ok(Number(typed.marker.weight)>=700,`weight ${typed.marker.weight}`);
    assert.ok(alias(typed.header.family,'TabPlayer Serif'),typed.header.family);assert.equal(parseFloat(typed.header.attrSize),27,`header size ${typed.header.attrSize}`);
    assert.ok(alias(typed.chord.family,'TabPlayer Serif')===false&&!/TabPlayer/.test(typed.chord.family),'Chord names (no font chosen) keep the system font');
    const loaded=typed.faces;for(const face of ['TabPlayer Serif|400|italic','TabPlayer Mono|700|normal','TabPlayer Serif|400|normal'])assert.ok(loaded.some(entry=>entry.replaceAll('"','')===face),`${face} is loaded: ${JSON.stringify(loaded)}`);
    return JSON.stringify({lyric:typed.lyric,marker:typed.marker,header:typed.header});
  });
  await check('screen: music glyphs use Petaluma and the Petaluma face is loaded',async()=>{
    assert.ok(/^"?Petaluma"?/.test(typed.glyph.family.trim()),typed.glyph.family);
    assert.ok(typed.glyphFamilies.every(family=>/Petaluma/.test(family)),JSON.stringify(typed.glyphFamilies));
    assert.ok(typed.visible.glyphCount>0&&typed.visible.glyphFamilies.every(family=>/Petaluma/.test(family)),`visible page: ${JSON.stringify(typed.visible.glyphFamilies)}`);assert.equal(parseFloat(typed.visible.glyph.size),36);
    assert.ok(typed.faces.some(entry=>entry.startsWith('Petaluma|')),`loaded ${JSON.stringify(typed.faces)}`);
    assert.equal(parseFloat(typed.glyph.size),36);return typed.glyph.family;
  });
  const typedPdf=await exportPdf(),typedPages=await exportedPages();
  await check('PDF embeds NotoSerif-Italic, NotoSansMono-Bold, NotoSerif-Regular and Petaluma',async()=>{
    for(const name of ['NotoSerif-Italic','NotoSansMono-Bold','NotoSerif-Regular','Petaluma'])assert.ok(typedPdf.includes(name),`${name} in ${JSON.stringify(typedPdf)}`);
    result.typedPdfFonts=typedPdf;return JSON.stringify(typedPdf);
  });
  await check('export pages: Petaluma music CSS at 36 px, the header in the Serif alias at 27, and no text past the paper edge',async()=>{
    for(const sheet of typedPages){assert.equal(sheet.musicCss,'.at{font-family:Petaluma,Bravura;font-size:36px}');assert.deepEqual(sheet.spill,[],'text past the page');}
    const header=typedPages[0].header;assert.ok(header&&/TabPlayer Serif/.test(header.family),JSON.stringify(header));assert.equal(Number(header.size),27);
    return `${typedPages.length} page(s), ${typedPages.map(sheet=>sheet.texts).join('/')} text items`;
  });

  // ---- Undo, redo ----
  await button('Undo');
  await check('undo restores the record and the default drawing; redo restores the fonts',async()=>{
    assert.deepEqual((await snapshot()).project,baseProject);
    const back=await poll(drawn,value=>value.lyric&&!/TabPlayer/.test(value.lyric.family)&&value.glyph&&!/Petaluma/.test(value.glyph.family),'undo restores the drawing');
    assert.ok(!/TabPlayer/.test(back.marker.family)&&!/TabPlayer/.test(back.header.family));
    await button('Redo');assert.deepEqual((await snapshot()).project,applied.project);
    await poll(drawn,value=>value.glyph&&/Petaluma/.test(value.glyph.family)&&alias(value.lyric?.family,'TabPlayer Serif'),'redo restores the drawing');
  });

  // ---- A saved style with fonts makes the library version 3; deleting it brings version 1 back ----
  await page.getByLabel('Style name',{exact:true}).fill('Fonts house');await page.getByRole('button',{name:'Save current style',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved Fonts house.'}).waitFor();
  await check('a saved style with fonts makes the library version 3 and carries the fonts',async()=>{
    const library=savedStyles();assert.equal(library.version,3);assert.deepEqual(library.entries.map(entry=>entry.name),['Plain house','Fonts house']);
    assert.deepEqual(library.entries[1].engraving.fonts,lastFonts(applied.project));assert.equal(Object.hasOwn(library.entries[0].engraving,'fonts'),false,'the plain style carries no fonts');
  });
  await page.getByRole('combobox',{name:'Saved style',exact:true}).selectOption({label:'Fonts house'});await page.getByRole('button',{name:'Delete saved style',exact:true}).click();await page.getByRole('status').filter({hasText:'Deleted Fonts house.'}).waitFor();
  await check('removing the style with fonts brings the library back to version 1',async()=>{const library=savedStyles();assert.equal(library.version,1);assert.deepEqual(library.entries.map(entry=>entry.name),['Plain house']);});

  await button('Save');const stored=await snapshot();
  await check('save leaves the document clean with the fonts in it',async()=>{assert.equal(stored.dirty,false);assert.deepEqual(lastFonts(stored.project),lastFonts(applied.project));});
  await check('native playback generation is unchanged across the font edit, undo, redo and saves',async()=>{
    const final=await generation('after the font edit');assert.equal(final,baselineGeneration,`generation went from ${baselineGeneration} to ${final}`);
    const live=await status();assert.equal(live.playing,false);return `generation ${final}`;
  });
  await browser.close();browser=null;stop(id);

  // ---- Reopen, then Leland, then Bravura ----
  id=launch({TABPLAYER_TEST_OPEN:saved,TABPLAYER_TEST_SAVE:resolve(runDirectory,'second.tabplayer'),TABPLAYER_TEST_EXPORT:exported,TABPLAYER_TEST_APP_DATA_DIR:appData});
  await attach();await button('Open');await waitStatus(value=>value.ready&&!value.error);await page.locator('[aria-label="Music notation"] svg').first().waitFor();
  baselineGeneration=await generation('reopened');
  await button('Presentation');await page.getByRole('combobox',{name:'Display mode',exact:true}).selectOption('verticalPage');await page.locator('.score-page-text text').first().waitFor();
  await check('reopen: the project (history and fonts) is identical and the fonts are drawn again',async()=>{
    assert.deepEqual((await snapshot()).project,stored.project);
    const again=await poll(drawn,value=>value.glyph&&/Petaluma/.test(value.glyph.family)&&alias(value.lyric?.family,'TabPlayer Serif')&&alias(value.marker?.family,'TabPlayer Mono')&&alias(value.header?.family,'TabPlayer Serif'),'the reopened score draws the fonts');
    return again.lyric.family;
  });
  const reopenedPdf=await exportPdf();
  await check('reopen: the PDF again embeds the chosen faces',async()=>{for(const name of ['NotoSerif-Italic','NotoSansMono-Bold','NotoSerif-Regular','Petaluma'])assert.ok(reopenedPdf.includes(name),`${name} in ${JSON.stringify(reopenedPdf)}`);});
  await openPanels();
  const beforeLeland=(await edits()).length;
  await choose('Music font','leland');
  await check('switching to Leland is one more edit; glyphs and the PDF use Leland and no longer Petaluma',async()=>{
    assert.equal((await edits()).length,beforeLeland);await button('Apply engraving');
    const after=await snapshot();assert.equal(after.project.edits.length,beforeLeland+1);assert.deepEqual(lastFonts(after.project),{...lastFonts(stored.project),music:'leland'});
    const now=await poll(drawn,value=>value.glyph&&/Leland/.test(value.glyph.family),'Leland glyphs are drawn');assert.ok(now.glyphFamilies.every(family=>/Leland/.test(family)),JSON.stringify(now.glyphFamilies));assert.ok(now.visible.glyphCount>0&&now.visible.glyphFamilies.every(family=>/Leland/.test(family)),`visible page: ${JSON.stringify(now.visible.glyphFamilies)}`);
    assert.ok(alias(now.lyric.family,'TabPlayer Serif'),'text roles are unchanged');
    const fonts=await exportPdf();assert.ok(fonts.includes('Leland')&&!fonts.includes('Petaluma'),JSON.stringify(fonts));
    const pages=await exportedPages();for(const sheet of pages){assert.equal(sheet.musicCss,'.at{font-family:Leland,Bravura;font-size:36px}');assert.deepEqual(sheet.spill,[]);}
    return JSON.stringify(fonts);
  });
  await choose('Music font','bravura');await button('Apply engraving');
  await check('switching back to Bravura omits music from the fonts, draws Bravura and no D12 music face is embedded',async()=>{
    const after=await snapshot();assert.deepEqual(lastFonts(after.project),{roles:lastFonts(stored.project).roles},'music is omitted at its default');
    const now=await poll(drawn,value=>value.glyph&&!/Petaluma|Leland/.test(value.glyph.family),'Bravura glyphs are drawn');assert.ok(now.glyphFamilies.every(family=>!/Petaluma|Leland/.test(family)),JSON.stringify(now.glyphFamilies));assert.ok(now.visible.glyphCount>0&&now.visible.glyphFamilies.every(family=>!/Petaluma|Leland/.test(family)),`visible page: ${JSON.stringify(now.visible.glyphFamilies)}`);
    const fonts=await exportPdf();assert.ok(fonts.includes('Bravura')&&!fonts.includes('Petaluma')&&!fonts.includes('Leland'),JSON.stringify(fonts));
    assert.ok(fonts.includes('NotoSerif-Italic'),'role faces remain');
    const pages=await exportedPages();for(const sheet of pages)assert.equal(sheet.musicCss,'.at{font-family:Bravura;font-size:36px}');
    return JSON.stringify(fonts);
  });
  await check('native playback generation is unchanged across Leland and Bravura',async()=>{const final=await generation('after Leland and Bravura');assert.equal(final,baselineGeneration);});
  await check('no page errors',async()=>{assert.deepEqual(errors,[]);});
  await check('the real user style library was not touched',async()=>{assert.equal(hashOf(realLibrary),realBefore);});
  result.generations=generations;
}catch(error){
  const message=error instanceof Error?error.message:String(error);console.log(`FAIL driver - ${message.split('\n')[0]}`);failures.push('driver');result.checks.push({name:'driver',pass:false,detail:message});
  if(page)await page.screenshot({path:resolve(evidenceDirectory,'font-roles-failure.png')}).catch(()=>{});
}finally{
  if(browser)await browser.close().catch(()=>{});try{stop(id);}catch{}
  result.failures=failures;result.passed=result.checks.filter(item=>item.pass).length;
  writeFileSync(resolve(evidenceDirectory,'font-roles-result.json'),JSON.stringify(result,null,2));
  console.log(`font-roles: ${result.passed} passed, ${failures.length} failed${failures.length?` (${failures.join('; ')})`:''}.`);
  if(failures.length)process.exitCode=1;
}
