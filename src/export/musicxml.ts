import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { getLyricsSource } from '../editor/lyrics-source';
import { selectScore } from './selection';
import type { ExportSelection } from './types';

// An owned MusicXML 4.0 score-partwise writer. Durations use 960 divisions per
// quarter, TabPlayer's tick unit. Anything this writer cannot express faithfully
// throws instead of being dropped; later slices widen the supported set.
const divisions=960;
const unsupported=(feature:string):never=>{throw new Error(`MusicXML export does not support ${feature} yet.`);};
const escape=(text:string)=>{
  // XML 1.0 cannot carry these characters at all, even escaped.
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(text))unsupported('control characters in text');
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};
const element=(name:string,content:string|number,attributes='')=>`<${name}${attributes}>${content}</${name}>`;
const number=(value:number)=>String(Number(value.toFixed(6)));

// Key-aware spelling: scale degrees take the key's letter (E♯ in F♯ major, C♭ in
// G♭ major); other pitches use sharps in sharp keys and flats in flat keys.
const naturals:[string,number][]=[['C',0],['D',2],['E',4],['F',5],['G',7],['A',9],['B',11]];
const sharpSteps:[string,number][]=[['C',0],['C',1],['D',0],['D',1],['E',0],['F',0],['F',1],['G',0],['G',1],['A',0],['A',1],['B',0]];
const flatSteps:[string,number][]=[['C',0],['D',-1],['D',0],['E',-1],['E',0],['F',0],['G',-1],['G',0],['A',-1],['A',0],['B',-1],['B',0]];
function spelling(value:number,fifths:number):[string,number] {
  const altered=fifths>0?'FCGDAEB'.slice(0,fifths):'BEADGCF'.slice(0,-fifths);
  for(const [step,natural] of naturals){
    const alter=altered.includes(step)?Math.sign(fifths):0;
    if(((natural+alter)%12+12)%12===value%12)return [step,alter];
  }
  return (fifths<0?flatSteps:sharpSteps)[value%12];
}
function pitch(value:number,fifths:number){
  if(!Number.isInteger(value)||value<0||value>127)unsupported('a pitch outside octaves 0–9');
  const [step,alter]=spelling(value,fifths),octave=Math.floor((value-alter)/12)-1;
  if(octave<0||octave>9)unsupported('a pitch outside octaves 0–9');
  return element('pitch',element('step',step)+(alter?element('alter',alter):'')+element('octave',octave));
}
function tuningStep(value:number){
  if(!Number.isInteger(value)||value<12||value>127)unsupported('a tuning outside octaves 0–9');
  const [step,alter]=sharpSteps[value%12];
  return element('tuning-step',step)+(alter?element('tuning-alter',alter):'')+element('tuning-octave',Math.floor(value/12)-1);
}

const typeNames=new Map<number,string>([[-4,'long'],[-2,'breve'],[1,'whole'],[2,'half'],[4,'quarter'],[8,'eighth'],[16,'16th'],[32,'32nd'],[64,'64th'],[128,'128th'],[256,'256th']]);
function beatTicks(beat:model.Beat){
  const duration=beat.duration as number,base=duration>0?divisions*4/duration:divisions*4*-duration;
  let value=base*(2-1/2**beat.dots);
  if(beat.hasTuplet)value=value*beat.tupletDenominator/beat.tupletNumerator;
  if(!typeNames.has(duration)||!Number.isInteger(value))unsupported('this rhythm');
  return value;
}

// Fields this slice writes, or derived/layout fields; every other field must keep
// the default of a pristine model object so nothing is silently lost.
const written={
  score:new Set(['title','artist','words','copyright','masterbars','tracks','stylesheet','defaultsystemslayout','systemslayout']),
  // No dynamics are written: alphaTab's importer hides them for files without any,
  // and note dynamics are checked per note.
  stylesheet:new Set(['hidedynamics']),
  master:new Set(['isrepeatstart','repeatcount','timesignaturenumerator','timesignaturedenominator','timesignaturecommon','tempoautomations','start','displayscale','displaywidth']),
  track:new Set(['staves','playbackinfo','name','shortname','color','defaultsystemslayout','systemslayout','isvisibleonmultitrack']),
  // Mute and solo are player state, not notation.
  playback:new Set(['program','primarychannel','secondarychannel','volume','balance','ismute','issolo']),
  staff:new Set(['bars','stringtuning','displaytranspositionpitch','showtablature','showstandardnotation','standardnotationlinecount']),
  bar:new Set(['id','clef','clefottava','voices','keysignature','keysignaturetype','displayscale','displaywidth']),
  voice:new Set(['id','beats']),
  beat:new Set(['id','notes','isempty','duration','dots','tupletnumerator','tupletdenominator','automations','displaystart','playbackstart','displayduration','playbackduration','overridedisplayduration']),
  note:new Set(['id','fret','string','octave','tone','istiedestination','tiedestinationnoteid','tieoriginnoteid']),
};
type Json=Record<string,unknown>;
const toJson=(score:model.Score):Json=>{const value:unknown=model.JsonConverter.scoreToJson(score);return (typeof value==='string'?JSON.parse(value):value) as Json;};
let pristine:Record<keyof typeof written,Json>|null=null;
function defaults(){
  if(pristine)return pristine;
  const score=new model.Score(),track=new model.Track();score.addTrack(track);track.ensureStaveCount(1);
  const master=new model.MasterBar();score.addMasterBar(master);
  const bar=new model.Bar();track.staves[0].addBar(bar);const voice=new model.Voice();bar.addVoice(voice);
  const beat=new model.Beat();voice.addBeat(beat);const note=new model.Note();note.octave=4;beat.addNote(note);
  score.finish(new Settings());
  const json=toJson(score),tracks=json.tracks as Json[],staves=tracks[0].staves as Json[],bars=staves[0].bars as Json[],voices=bars[0].voices as Json[],beats=voices[0].beats as Json[];
  pristine={score:json,stylesheet:json.stylesheet as Json,master:(json.masterbars as Json[])[0],track:tracks[0],playback:tracks[0].playbackinfo as Json,staff:staves[0],bar:bars[0],voice:voices[0],beat:beats[0],note:(beats[0].notes as Json[])[0]};
  return pristine;
}
// An excerpt keeps the stylesheet's per-track maps and sets, emptied for unexported
// tracks; alphaTab reads an empty one exactly like none.
const normalized=(kind:string,key:string,value:unknown)=>JSON.stringify(kind==='stylesheet'&&key.startsWith('pertrack')&&value&&typeof value==='object'&&!Object.keys(value).length?null:value??null);
function check(kind:keyof typeof written,value:Json){
  const base=defaults()[kind];
  for(const key of new Set([...Object.keys(base),...Object.keys(value)])){
    if(written[kind].has(key))continue;
    if(normalized(kind,key,value[key])!==normalized(kind,key,base[key]))unsupported(`${kind} ${key}`);
  }
}

function clef(bar:model.Bar,tab:boolean,number=''){
  if(tab)return element('clef',element('sign','TAB')+element('line',5),number);
  const signs:Partial<Record<model.Clef,[string,number]>>={[model.Clef.G2]:['G',2],[model.Clef.F4]:['F',4],[model.Clef.C3]:['C',3],[model.Clef.C4]:['C',4]};
  const sign=signs[bar.clef]??unsupported('this clef');
  const change=bar.clefOttava===model.Ottavia._8vb?-1:bar.clefOttava===model.Ottavia._8va?1:bar.clefOttava===model.Ottavia.Regular?0:unsupported('this clef ottava');
  return element('clef',element('sign',sign[0])+element('line',sign[1])+(change?element('clef-octave-change',change):''),number);
}
function time(master:model.MasterBar){
  const symbol=!master.timeSignatureCommon?'':master.timeSignatureNumerator===4&&master.timeSignatureDenominator===4?' symbol="common"':master.timeSignatureNumerator===2&&master.timeSignatureDenominator===2?' symbol="cut"':unsupported('a common-time symbol on this meter');
  return element('time',element('beats',master.timeSignatureNumerator)+element('beat-type',master.timeSignatureDenominator),symbol);
}
function tempoDirection(change:model.Automation,master:model.MasterBar){
  if(change.text)unsupported('tempo text');
  if(change.isLinear)unsupported('gradual tempo changes');
  const tick=Number((change.ratioPosition*master.calculateDuration()).toFixed(6));
  if(!Number.isInteger(tick))unsupported('a tempo change between ticks');
  return element('direction',element('direction-type',element('metronome',element('beat-unit','quarter')+element('per-minute',number(change.value)),change.isVisible?'':' print-object="no"'))
    +(tick?element('offset',tick,' sound="yes"'):'')+`<sound tempo="${number(change.value)}"/>`,' placement="above"');
}

function writePart(track:model.Track,score:model.Score,json:Json,scoreJson:Json,first:boolean){
  check('track',json);check('playback',json.playbackinfo as Json);
  if(track.staves.length!==1)unsupported('more than one staff per track');
  const staff=track.staves[0],staffJson=(json.staves as Json[])[0];check('staff',staffJson);
  if(staff.isPercussion)unsupported('percussion staves');
  const strings=staff.stringTuning.tunings,stringed=strings.length>0,tab=stringed&&staff.showTablature&&!staff.showStandardNotation;
  // alphaTab draws one stringed staff as notation and TAB; MusicXML writes that as
  // two staves (notation, then TAB with voices 5+), as Guitar Pro and MuseScore do.
  const both=stringed&&staff.showTablature&&staff.showStandardNotation;
  if(stringed&&!tab&&!both)unsupported('a stringed staff shown only as standard notation');
  const layouts=both?[{staff:'1',voices:0,technical:false},{staff:'2',voices:4,technical:true}]:[{staff:'',voices:0,technical:true}];
  const transpose=staff.displayTranspositionPitch,octaveChange=Math.trunc(transpose/12),chromatic=transpose-12*octaveChange;
  // Overlapping ties need distinct <tied number> levels across the whole part,
  // both staves included, to pair unambiguously.
  const ties=layouts.map(()=>new Map<model.Note,number>());
  let measures='',previous:model.Bar|null=null;
  for(const [index,bar] of staff.bars.entries()){
    const master=bar.masterBar,barJson=(staffJson.bars as Json[])[index];check('bar',barJson);check('master',(scoreJson.masterbars as Json[])[master.index]);
    const length=master.calculateDuration();let content='';
    const attributes:string[]=[];
    if(!previous)attributes.push(element('divisions',divisions));
    if(!previous||previous.keySignature!==bar.keySignature||previous.keySignatureType!==bar.keySignatureType)attributes.push(element('key',element('fifths',bar.keySignature)+element('mode',bar.keySignatureType===model.KeySignatureType.Minor?'minor':'major')));
    const previousMaster=previous?.masterBar;
    if(!previousMaster||previousMaster.timeSignatureNumerator!==master.timeSignatureNumerator||previousMaster.timeSignatureDenominator!==master.timeSignatureDenominator||previousMaster.timeSignatureCommon!==master.timeSignatureCommon)attributes.push(time(master));
    if(!previous&&both)attributes.push(element('staves',2));
    if(!previous||previous.clef!==bar.clef||previous.clefOttava!==bar.clefOttava)attributes.push(clef(bar,tab,both?' number="1"':''));
    if(!previous&&both)attributes.push(clef(bar,true,' number="2"'));
    // The TAB copy shows the same music: W3C's alternate staff type keeps it out of playback.
    if(!previous&&stringed)attributes.push(element('staff-details',(both?element('staff-type','alternate'):'')+element('staff-lines',strings.length)+strings.map((_,line)=>element('staff-tuning',tuningStep(strings[strings.length-1-line]),` line="${line+1}"`)).join(''),both?' number="2"':''));
    if(!previous&&transpose)attributes.push(element('transpose',element('chromatic',chromatic)+(octaveChange?element('octave-change',octaveChange):'')));
    if(attributes.length)content+=element('attributes',attributes.join(''));
    if(master.isRepeatStart)content+=element('barline',element('bar-style','heavy-light')+'<repeat direction="forward"/>',' location="left"');
    // Tempo is score-wide, so only the first part carries it.
    if(first){
      const tempos=[...master.tempoAutomations].sort((a,b)=>a.ratioPosition-b.ratioPosition);
      if(index===0&&!tempos.some(change=>change.ratioPosition===0))tempos.unshift(Object.assign(new model.Automation(),{type:model.AutomationType.Tempo,value:score.tempo,ratioPosition:0,isVisible:true}));
      content+=tempos.map(change=>tempoDirection(change,master)).join('');
    }
    // Every voice is checked, including empty ones, which can still hold beat state.
    const voices:{notes:string;total:number}[][]=layouts.map(()=>[]);
    const staffOf=(layout:typeof layouts[number])=>layout.staff?element('staff',layout.staff):'';
    for(const voice of bar.voices){
      const voiceJson=(barJson.voices as Json[])[voice.index];check('voice',voiceJson);
      // Staff 2 numbers its copies 5–8, so staff 1 can hold four voices.
      if(both&&voice.index>=4&&!voice.isEmpty)unsupported('more than four voices on a notation + TAB staff');
      const notes=layouts.map(()=>'');let total=0;
      for(const beat of voice.beats){
        const beatJson=(voiceJson.beats as Json[])[beat.index];check('beat',beatJson);
        if(beat.graceType!==model.GraceType.None)unsupported('grace notes');
        const start=index===0&&voice.index===0&&beat.index===0;
        if(beat.automations.some(change=>!(start&&change.type===model.AutomationType.Instrument&&change.value===track.playbackInfo.program)))unsupported('beat automations');
        // An empty voice can still carry (for example invisible) notes alphaTab does not draw.
        if(voice.isEmpty){if(beat.notes.length)unsupported('notes in an empty voice');continue;}
        if(beat.isEmpty)unsupported('an empty beat inside a voice');
        const voiceNumber=(layout:typeof layouts[number])=>element('voice',voice.index+1+layout.voices);
        // alphaTab stretches a lone whole rest over any meter: a measure rest.
        if(voice.beats.length===1&&!beat.notes.length&&beat.duration===model.Duration.Whole&&!beat.dots&&!beat.hasTuplet&&beat.displayDuration===length){
          layouts.forEach((layout,at)=>{notes[at]+=element('note','<rest measure="yes"/>'+element('duration',length)+voiceNumber(layout)+staffOf(layout));});total=length;continue;
        }
        const ticks=beatTicks(beat);
        if(beat.displayStart!==total||beat.displayDuration!==ticks)unsupported('a beat whose length differs from its note value');
        total+=ticks;
        const rhythm=(layout:typeof layouts[number])=>element('duration',ticks)+voiceNumber(layout)+element('type',typeNames.get(beat.duration as number)!)+'<dot/>'.repeat(beat.dots)
          +(beat.hasTuplet?element('time-modification',element('actual-notes',beat.tupletNumerator)+element('normal-notes',beat.tupletDenominator)):'')+staffOf(layout);
        if(!beat.notes.length){layouts.forEach((layout,at)=>{notes[at]+=element('note','<rest/>'+rhythm(layout));});continue;}
        const sorted=[...beat.notes].sort((a,b)=>a.realValue-b.realValue);
        for(const [noteIndex,note] of sorted.entries()){
          check('note',(beatJson.notes as Json[])[note.index]);
          const written=pitch(note.calculateRealValue(false,false)-transpose,bar.keySignature);
          layouts.forEach((layout,at)=>{
            const open=ties[at],links:[string,number][]=[];
            if(note.isTieDestination){
              const level=note.tieOrigin&&open.get(note.tieOrigin);if(!level)unsupported('a tie without its origin');
              open.delete(note.tieOrigin!);links.push(['stop',level!]);
            }
            if(note.tieDestination){
              const used=new Set(ties.flatMap(levels=>[...levels.values()]));let level=1;while(used.has(level))level++;
              if(level>16)unsupported('more than 16 simultaneous ties');open.set(note,level);links.push(['start',level]);
            }
            const technical=layout.technical&&note.isStringed?element('technical',element('string',strings.length-note.string+1)+element('fret',note.fret)):'';
            const tied=links.map(([type,level])=>`<tied type="${type}" number="${level}"/>`).join('');
            notes[at]+=element('note',(noteIndex?'<chord/>':'')+written+rhythm(layout).replace('</duration>',`</duration>${links.map(([type])=>`<tie type="${type}"/>`).join('')}`)
              +(tied||technical?element('notations',tied+technical):''));
          });
        }
      }
      layouts.forEach((_,at)=>{if(notes[at])voices[at].push({notes:notes[at],total});});
    }
    // Staff 1's voices, then staff 2's; each backup returns to the bar start.
    const entries=layouts.flatMap((layout,at)=>voices[at].length?voices[at]:[{notes:element('note','<rest measure="yes"/>'+element('duration',length)+element('voice',1+layout.voices)+staffOf(layout)),total:length}]);
    entries.forEach(({notes,total},at)=>{content+=notes+(at<entries.length-1?element('backup',element('duration',total)):'');});
    if(master.repeatCount>0)content+=element('barline',element('bar-style','light-heavy')+`<repeat direction="backward"${master.repeatCount===2?'':` times="${master.repeatCount}"`}/>`,' location="right"');
    measures+=element('measure',content,` number="${index+1}"`);previous=bar;
  }
  return measures;
}

export function exportMusicXml(score:model.Score,selection:ExportSelection):Uint8Array {
  // Lyrics (including hidden ones) live in TabPlayer's own sources, outside the model data.
  if(selection.tracks.some(index=>getLyricsSource(score.tracks[index])?.value.lines.some(line=>line.text.trim())))unsupported('lyrics');
  const copy=selectScore(score,selection),json=toJson(copy);check('score',json);check('stylesheet',json.stylesheet as Json);
  if(copy.tracks.some(track=>track.staves.some(staff=>staff.transpositionPitch!==0)))unsupported('sounding transposition');
  const parts=copy.tracks.map((track,index)=>{
    const info=track.playbackInfo,id=`P${index+1}`;
    if(info.primaryChannel<0||info.primaryChannel>15)unsupported('MIDI channels above 16');
    return {
      list:element('score-part',element('part-name',escape(track.name))+(track.shortName?element('part-abbreviation',escape(track.shortName)):'')+element('score-instrument',element('instrument-name',escape(track.name)),` id="${id}-I1"`)
        +element('midi-instrument',element('midi-channel',info.primaryChannel+1)+element('midi-program',info.program+1)+element('volume',number(info.volume*100/16))+element('pan',number(info.balance*180/16-90)),` id="${id}-I1"`),` id="${id}"`),
      body:element('part',writePart(track,copy,(json.tracks as Json[])[index],json,index===0),` id="${id}"`),
    };
  });
  const identification=[copy.artist?element('creator',escape(copy.artist),' type="composer"'):'',copy.words?element('creator',escape(copy.words),' type="lyricist"'):'',copy.copyright?element('rights',escape(copy.copyright)):''].join('');
  const xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    +element('score-partwise',(copy.title?element('work',element('work-title',escape(copy.title))):'')+(identification?element('identification',identification):'')
      +element('part-list',parts.map(part=>part.list).join(''))+parts.map(part=>part.body).join(''),' version="4.0"');
  return strToU8(xml);
}
