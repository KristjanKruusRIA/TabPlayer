import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music,target } from './fixtures';
import { searchCommands,type PaletteContext,type PaletteMatch } from './command-palette';
import { getMessage,SUPPORTED_LANGUAGES,type MessageKey,type SupportedLanguage } from '../i18n';

// THE-203: command titles, hints and errors come from the catalog; search matches the current-language title and the
// English title and words as aliases. The English order itself is pinned in command-palette-order.test.ts.

/** A translator bound to one language, as useI18n builds it. */
const translator=(lang:SupportedLanguage)=>(key:MessageKey,params?:Record<string,string|number>)=>getMessage(lang,key,params);
const context=(patch:Partial<PaletteContext>={}):PaletteContext=>({score:music(),target,string:6,canUndo:true,canRedo:false,...patch});
const search=(lang:SupportedLanguage,query:string,patch?:Partial<PaletteContext>):PaletteMatch[]=>searchCommands(query,context(patch),translator(lang));
const ids=(lang:SupportedLanguage,query:string)=>search(lang,query).map(match=>match.id);

const commandIds=['measure','track','fret','duration','tempo','insertBeat','deleteBeat','rest','appendMeasure','removeMeasure','undo','redo','play','loop','slower','faster','new','open','importAscii','save','saveAs','help','about','export'];
const titles:Record<SupportedLanguage,string[]>={
  en:['Go to measure','Go to track','Set fret','Set duration','Set initial tempo','Insert beat','Delete beat','Make rest','Append measure','Remove measure','Undo','Redo','Play or pause','Loop','Slower','Faster','New score','Open score','Import ASCII tab','Save','Save As','Help topics','About and updates','Export score'],
  et:['Vali takt','Vali rada','Määra astmetraat','Määra kestus','Määra algne tempo','Lisa löök','Kustuta löök','Muuda pausiks','Lisa takt lõppu','Eemalda takt','Võta tagasi','Tee uuesti','Esita või pane pausile','Kordus','Aeglasemalt','Kiiremini','Uus pala','Ava pala','Impordi ASCII tabulatuur','Salvesta','Salvesta nimega','Abiteemad','Teave ja uuendused','Ekspordi partituur'],
  de:['Gehe zu Takt','Gehe zu Spur','Bund setzen','Notenwert setzen','Anfangstempo setzen','Beat einfügen','Beat löschen','Zur Pause machen','Takt anhängen','Takt entfernen','Rückgängig','Wiederholen','Abspielen oder anhalten','Schleife','Langsamer','Schneller','Neue Partitur','Partitur öffnen','ASCII-Tabulatur importieren','Speichern','Speichern unter','Hilfethemen','Über & Updates','Partitur exportieren'],
};
const hints:Record<SupportedLanguage,string[]>={
  en:['measure 12','track 2','fret 5','duration 8 or 1/8','tempo 96'],
  et:['takt 12','rada 2','astmetraat 5','kestus 8 või 1/8','tempo 96'],
  de:['Takt 12','Spur 2','Bund 5','Notenwert 8 oder 1/8','Anfangstempo 96'],
};

describe('titles and hints come from the catalog',()=>{
  for(const lang of SUPPORTED_LANGUAGES)it(`lists the ${lang} titles and hints in command order`,()=>{
    const all=search(lang,'');
    expect(all.map(match=>match.id)).toEqual(commandIds);
    expect(all.map(match=>match.title)).toEqual(titles[lang]);
    expect(all.filter(match=>match.hint).map(match=>match.hint)).toEqual(hints[lang]);
  });
  it('defines a title for every command in every language',()=>{
    for(const id of commandIds)for(const lang of SUPPORTED_LANGUAGES)expect(getMessage(lang,`palette.command_${id}` as MessageKey),`${lang} ${id}`).not.toBe('');
  });
});

describe('search matches the title in the current language',()=>{
  it('finds Estonian commands by their title words in any order',()=>{
    expect(ids('et','takt')).toEqual(['measure','appendMeasure','removeMeasure']);
    expect(ids('et','kustuta')).toEqual(['deleteBeat']);
    expect(ids('et','salvesta')).toEqual(['save','saveAs']);
    expect(ids('et','löök lisa')).toEqual(['insertBeat']);
    expect(ids('et','takt lõppu')).toEqual(['appendMeasure']);
    expect(ids('et','tagasi')).toEqual(['undo']);
  });
  it('finds German commands by their title words in any order',()=>{
    expect(ids('de','takt')).toEqual(['measure','appendMeasure','removeMeasure']);
    expect(ids('de','speichern')).toEqual(['save','saveAs']);
    expect(ids('de','speichern unter')).toEqual(['saveAs']);
    expect(ids('de','beat löschen')).toEqual(['deleteBeat']);
    expect(ids('de','partitur')).toEqual(['new','open','export']);
    expect(ids('de','schleife')).toEqual(['loop']);
  });
  it('matches without diacritics, as a keyboard without them types',()=>{
    expect(ids('de','ruckgangig')).toEqual(['undo']);
    expect(ids('de','uber')).toEqual(['about']);
    expect(ids('de','loschen')).toEqual(['deleteBeat']);
    expect(ids('et','maara')).toEqual(['fret','duration','tempo']);
    expect(ids('et','vota')).toEqual(['undo']);
  });
  it('shows each hint as an example that runs',()=>{
    for(const lang of SUPPORTED_LANGUAGES)for(const entry of search(lang,'').filter(match=>match.hint)){
      const query=`${entry.hint.split(' ')[0]} 1`,found=search(lang,query)[0];
      expect(found,`${lang} ${query}`).toMatchObject({id:entry.id});
      expect(found.action,`${lang} ${query}`).toBeDefined();
    }
  });
  it('builds the same actions from translated words as from English ones',()=>{
    expect(search('et','takt 3')[0]).toMatchObject({id:'measure',action:{kind:'select',target:{...target,bar:2}}});
    expect(search('de','Takt 3')[0]).toMatchObject({id:'measure',action:{kind:'select',target:{...target,bar:2}}});
    expect(search('de','bund 7')[0]).toMatchObject({id:'fret',action:{kind:'edit',command:{type:'setNote',fret:7}}});
    expect(search('et','kestus 1/8')[0]).toMatchObject({id:'duration',action:{kind:'edit',command:{type:'setBeatRhythm',duration:8}}});
    expect(search('de','anfangstempo 96')[0]).toMatchObject({id:'tempo',action:{kind:'edit',command:{type:'setScoreInfo',tempo:96}}});
  });
});

describe('English still works as an alias in every language',()=>{
  const english:ReadonlyArray<readonly [string,string]>=[['go to measure 3','measure'],['measure 3','measure'],['track 1','track'],['fret 5','fret'],['set fret 5','fret'],['duration 8','duration'],['tempo 96','tempo'],['set initial tempo 96','tempo'],['insert beat','insertBeat'],['delete beat','deleteBeat'],['make rest','rest'],['append measure','appendMeasure'],['remove measure','removeMeasure'],['undo','undo'],['redo','redo'],['play','play'],['loop','loop'],['slower','slower'],['faster','faster'],['new score','new'],['open score','open'],['import ascii tab','importAscii'],['save','save'],['save as','saveAs'],['help topics','help'],['about and updates','about'],['export score','export']];
  for(const lang of ['et','de'] as const)it(`finds every English title typed in ${lang}`,()=>{
    for(const [query,id] of english)expect(search(lang,query).find(match=>match.id===id),`${lang} ${query}`).toBeDefined();
    // What the desktop drivers type: the first match is the command itself, ready to run.
    expect(search(lang,'fret 7')[0]).toMatchObject({id:'fret',action:{kind:'edit',command:{type:'setNote',fret:7}}});
    expect(search(lang,'duration 8')[0]).toMatchObject({id:'duration',action:{kind:'edit',command:{type:'setBeatRhythm',duration:8}}});
    expect(search(lang,'go to measure 3')[0]).toMatchObject({id:'measure',action:{kind:'select',target:{...target,bar:2}}});
    expect(search(lang,'tempo 90')[0]).toMatchObject({id:'tempo',action:{kind:'edit',command:{type:'setScoreInfo',tempo:90}}});
    expect(search(lang,'undo')[0]).toMatchObject({id:'undo',action:{kind:'app',name:'undo'}});
    expect(search(lang,'save')[0]).toMatchObject({id:'save'});
  });
  it('shows the current-language title when only the English word matched',()=>{
    expect(search('de','delete beat').map(match=>match.title)).toEqual(['Beat löschen']);
    expect(search('et','undo').map(match=>match.title)).toEqual(['Võta tagasi']);
  });
});

/** How many typed words a match's own (current-language) title holds as word prefixes. */
const titleHits=(match:PaletteMatch,query:string)=>{
  const fold=(text:string)=>text.toLowerCase().normalize('NFD').replace(/\p{M}/gu,''),words=fold(match.title).split(/\s+/);
  return query.trim().split(/\s+/).filter(word=>words.some(candidate=>candidate.startsWith(fold(word)))).length;
};

describe('an English alias never outranks an equally good current-language match',()=>{
  it('lists matches on the current title before matches only the English alias found',()=>{
    for(const lang of ['et','de'] as const)for(const query of ['a','e','i','o','p','s','t','k','l','m','n','r','set','go','file','score','bar','beat','speed','practice','delete','save','tak','tem']){
      // Commands the expression rule lifts to the front are exempt, and so are those with the expression in the way.
      const english=ids('en',query),lifted=new Set(english.slice(0,Math.max(english.indexOf('expression'),0)));
      const hits=search(lang,query).filter(match=>match.id!=='expression'&&!lifted.has(match.id)).map(match=>titleHits(match,query));
      expect(hits,`${lang} ${query}`).toEqual([...hits].sort((a,b)=>b-a));
    }
  });
  it('lists the German title matches before the alias-only matches for p',()=>{
    // Partitur and Pause start with p; loop, slower and faster match through the English word practice only, and play through the expression rule.
    expect(ids('de','p')).toEqual(['play','expression','rest','new','open','export','loop','slower','faster']);
  });
});

describe('expressions read the same text in every language',()=>{
  const queries=['ff','f','p','mf','C','D','A','B','E','F','G','Am7','Bb','Bm','Dm','Em7','Gmaj7','C/G','3/4','6/8','bass','treble','alto','fine','coda','segno','[Verse]','[Chorus]','G major','Eb minor','D.S. al Coda','D.C.','To Coda'];
  const before=(lang:SupportedLanguage,query:string)=>{const list=ids(lang,query),at=list.indexOf('expression');return at<0?null:list.slice(0,at);};
  it('puts the expression after exactly the commands English puts before it (their own order follows the current titles)',()=>{
    for(const query of queries){
      const english=before('en',query);
      expect(english,`en ${query}`).not.toBeNull();
      for(const lang of ['et','de'] as const)expect(before(lang,query)?.sort(),`${lang} ${query}`).toEqual([...english!].sort());
    }
  });
  it('puts the expression first where no English title holds the typed words, even if a translated title does',()=>{
    // German Bund, Beat and Estonian Kordus, Kustuta, Määra, Muuda start with letters that are chord roots or dynamics.
    for(const lang of SUPPORTED_LANGUAGES)for(const query of ['ff','mf','Am7','Bb','Bm','Dm','Em7','Gmaj7','C','3/4','bass','[Verse]','G major','D.S. al Coda','fine','coda'])expect(ids(lang,query)[0],`${lang} ${query}`).toBe('expression');
  });
  it('gives the same expression, worded the same, in every language',()=>{
    for(const lang of SUPPORTED_LANGUAGES){
      expect(search(lang,'3/4').find(match=>match.id==='expression')!.title).toBe('Time signature 3/4 for measure 1');
      expect(search(lang,'[Verse]')[0].title).toBe('Section “Verse” at measure 1');
      expect(search(lang,'Am7')[0].title).toBe('Chord Am7 on the beat');
    }
  });
});

describe('errors come from the catalog',()=>{
  const drums=()=>{const score=music();score.tracks[0].staves[0].isPercussion=true;score.finish(new Settings());return score;};
  const oneMeasure=()=>{const score=music();score.masterBars.splice(1);for(const staff of score.tracks[0].staves)staff.bars.splice(1);return score;};
  const empty=()=>{const score=music(),voice=score.tracks[0].staves[0].bars[0].voices[0];voice.beats.splice(0);const placeholder=new model.Beat();placeholder.isEmpty=true;voice.addBeat(placeholder);score.finish(new Settings());return score;};
  const errors=(lang:SupportedLanguage)=>({
    measure:search(lang,'measure 9')[0].error,track:search(lang,'track 2')[0].error,fret:search(lang,'fret 100')[0].error,pitch:search(lang,'fret 64')[0].error,
    unfretted:search(lang,'fret 3',{score:drums()})[0].error,duration:search(lang,'duration 3')[0].error,tempo:search(lang,'tempo 0')[0].error,beat:search(lang,'delete beat',{score:empty()})[0].error,
    last:search(lang,'remove measure',{score:oneMeasure()})[0].error,undo:search(lang,'undo',{canUndo:false})[0].error,redo:search(lang,'redo')[0].error,single:search(lang,'measure 1 2')[0].error,
  });
  it('keeps the English texts exactly',()=>{
    expect(errors('en')).toEqual({measure:'Type a measure number from 1 to 4.',track:'Type a track number from 1 to 1.',fret:'Type a fret from 0 to 99.',pitch:'That fret would sound above the highest MIDI pitch.',unfretted:'Frets apply to fretted tracks.',duration:'Type a duration: 1, 2, 4, 8, 16, 32 or 64 (or 1/8).',tempo:'Type a tempo from 1 to 999 BPM.',beat:'Select an existing beat.',last:'A score needs at least one measure.',undo:'Nothing to undo.',redo:'Nothing to redo.',single:'Type a single value after the command.'});
  });
  it('writes the Estonian errors in Estonian, with the numbers filled in',()=>{
    expect(errors('et')).toEqual({measure:'Sisesta takti number vahemikus 1 kuni 4.',track:'Sisesta raja number vahemikus 1 kuni 1.',fret:'Sisesta astmetraat vahemikus 0 kuni 99.',pitch:'See astmetraat kõlaks kõrgemalt kui MIDI kõrgeim helikõrgus.',unfretted:'Astmetraadi saab määrata ainult astmetraatidega radadel.',duration:'Sisesta kestus: 1, 2, 4, 8, 16, 32 või 64 (või 1/8).',tempo:'Sisesta tempo vahemikus 1 kuni 999 BPM.',beat:'Vali olemasolev löök.',last:'Partituuris peab olema vähemalt üks takt.',undo:'Pole midagi tagasi võtta.',redo:'Pole midagi uuesti teha.',single:'Sisesta pärast käsku üks väärtus.'});
  });
  it('writes the German errors in German, with the numbers filled in',()=>{
    expect(errors('de')).toEqual({measure:'Geben Sie eine Taktnummer von 1 bis 4 ein.',track:'Geben Sie eine Spurnummer von 1 bis 1 ein.',fret:'Geben Sie einen Bund von 0 bis 99 ein.',pitch:'Dieser Bund würde über der höchsten MIDI-Tonhöhe klingen.',unfretted:'Bünde gibt es nur auf Spuren mit Bünden.',duration:'Geben Sie einen Notenwert ein: 1, 2, 4, 8, 16, 32 oder 64 (oder 1/8).',tempo:'Geben Sie ein Tempo von 1 bis 999 BPM ein.',beat:'Wählen Sie einen vorhandenen Beat aus.',last:'Eine Partitur braucht mindestens einen Takt.',undo:'Nichts zum Rückgängigmachen.',redo:'Nichts zum Wiederholen.',single:'Geben Sie nach dem Befehl nur einen Wert ein.'});
  });
});
