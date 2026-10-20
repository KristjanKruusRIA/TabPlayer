import { model,Settings } from '@coderline/alphatab';
import { strToU8 } from 'fflate';
import { getLyricsSource } from '../editor/lyrics-source';
import { trackMixAutomations } from '../interchange/automation';
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
// A forced accidental takes the enharmonic spelling with that offset, as alphaTab's
// resolveSpelling does; <accidental> reads back as the same mode.
const forced=new Map<model.NoteAccidentalMode,[number,string]>([[model.NoteAccidentalMode.ForceNatural,[0,'natural']],[model.NoteAccidentalMode.ForceSharp,[1,'sharp']],[model.NoteAccidentalMode.ForceFlat,[-1,'flat']],[model.NoteAccidentalMode.ForceDoubleSharp,[2,'double-sharp']],[model.NoteAccidentalMode.ForceDoubleFlat,[-2,'flat-flat']]]);
function pitch(value:number,fifths:number,mode:model.NoteAccidentalMode=model.NoteAccidentalMode.Default){
  if(!Number.isInteger(value)||value<0||value>127)unsupported('a pitch outside octaves 0–9');
  let [step,alter]=spelling(value,fifths),accidental='';
  if(mode!==model.NoteAccidentalMode.Default){
    const rule=forced.get(mode)??unsupported('this accidental mode'),[offset,name]=rule;
    const match=naturals.find(([,natural])=>((natural+offset)%12+12)%12===value%12)??unsupported('a forced accidental this pitch cannot take');
    [step,alter,accidental]=[match[0],offset,element('accidental',name)];
  }
  const octave=Math.floor((value-alter)/12)-1;
  if(octave<0||octave>9)unsupported('a pitch outside octaves 0–9');
  return {pitch:element('pitch',element('step',step)+(alter?element('alter',alter):'')+element('octave',octave)),accidental};
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
  // Presentation is not written: colours (style) and every stylesheet display choice.
  score:new Set(['title','artist','words','copyright','masterbars','tracks','stylesheet','style','defaultsystemslayout','systemslayout']),
  // Beaming rules are display grouping.
  master:new Set(['isrepeatstart','repeatcount','timesignaturenumerator','timesignaturedenominator','timesignaturecommon','tempoautomations','start','displayscale','displaywidth','beamingrules']),
  track:new Set(['staves','playbackinfo','name','shortname','color','defaultsystemslayout','systemslayout','isvisibleonmultitrack']),
  // Mute and solo are player state and the port is MIDI routing, not notation.
  playback:new Set(['program','primarychannel','secondarychannel','volume','balance','ismute','issolo','port']),
  staff:new Set(['bars','stringtuning','displaytranspositionpitch','showtablature','showstandardnotation','standardnotationlinecount']),
  bar:new Set(['id','clef','clefottava','voices','keysignature','keysignaturetype','displayscale','displaywidth']),
  voice:new Set(['id','beats']),
  // Stem direction is display; dynamics are written as directions.
  beat:new Set(['id','notes','isempty','duration','dots','tupletnumerator','tupletdenominator','automations','displaystart','playbackstart','displayduration','playbackduration','overridedisplayduration','preferredbeamdirection','dynamics']),
  // Bend points are written as <bend> elements (their type is derived from them).
  note:new Set(['id','fret','string','octave','tone','istiedestination','tiedestinationnoteid','tieoriginnoteid','accidentalmode','dynamics','bendtype','bendpoints','iscontinuedbend']),
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
  pristine={score:json,master:(json.masterbars as Json[])[0],track:tracks[0],playback:tracks[0].playbackinfo as Json,staff:staves[0],bar:bars[0],voice:voices[0],beat:beats[0],note:(beats[0].notes as Json[])[0]};
  return pristine;
}
function check(kind:keyof typeof written,value:Json){
  const base=defaults()[kind];
  for(const key of new Set([...Object.keys(base),...Object.keys(value)])){
    if(written[kind].has(key))continue;
    if(JSON.stringify(value[key]??null)!==JSON.stringify(base[key]??null))unsupported(`${kind} ${key}`);
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
  if(change.isLinear)unsupported('gradual tempo changes');
  const tick=Number((change.ratioPosition*master.calculateDuration()).toFixed(6));
  if(!Number.isInteger(tick))unsupported('a tempo change between ticks');
  // A hidden tempo keeps its label hidden too.
  return element('direction',(change.text&&change.isVisible?element('direction-type',element('words',escape(change.text))):'')+element('direction-type',element('metronome',element('beat-unit','quarter')+element('per-minute',number(change.value)),change.isVisible?'':' print-object="no"'))
    +(tick?element('offset',tick,' sound="yes"'):'')+`<sound tempo="${number(change.value)}"/>`,' placement="above"');
}

// A bend curve (offsets 0–60, values in quarter tones) as one <bend> per value change:
// bend-alter in semitones relative to the previous value, negative for pre-bends and
// releases, with first-beat/last-beat as percentages of the note's duration.
function bends(note:model.Note){
  const points=[...note.bendPoints??[]].sort((a,b)=>a.offset-b.offset);
  if(!points.length)return '';
  const percent=(offset:number)=>number(offset*100/model.BendPoint.MaxPosition);
  // A bend continued over a tie starts at the pitch its tie carries: changes are written
  // relative to it (a hold writes nothing), never as a pre-bend.
  // A curve tied into a note without its own bend plays stretched over the tie; MusicXML
  // times each bend within its note, so that timing cannot be written.
  if(note.tieDestination&&!note.tieDestination.hasBend&&points.some(point=>point.value!==points[0].value))unsupported('a bend that continues into a tied note without its own bend');
  if(note.isContinuedBend){
    const carried=[...note.tieOrigin?.bendPoints??[]].sort((a,b)=>a.offset-b.offset).pop()?.value;
    if(carried!==points[0].value)unsupported('a continued bend that does not start at the bent pitch');
    // alphaTab's import starts a tie destination's curve at 0 unless it opens with a release,
    // so a bent continuation reads back at the right pitch only if it first releases fully.
    if(points[0].value&&(points.find(point=>point.value!==points[0].value)?.value??0)!==0)unsupported('a continued bend that does not first release fully');
    // Two changes import as four points, whose middle Note.finish drops on a bent continuation.
    if(points[0].value&&points.filter((point,index)=>index&&point.value!==points[index-1].value).length===2)unsupported('a continued bend with exactly two changes');
  }
  let result=points[0].value&&!note.isContinuedBend?element('bend',element('bend-alter',number(-points[0].value/2))+'<pre-bend/>'):'';
  for(let index=1;index<points.length;index++){
    const from=points[index-1],to=points[index];if(to.value===from.value)continue;
    result+=element('bend',element('bend-alter',number((to.value-from.value)/2))+(to.value<from.value?'<release/>':''),` first-beat="${percent(from.offset)}" last-beat="${percent(to.offset)}"`);
  }
  return result;
}

// TabPlayer's track-mix scale is 0–16; MusicXML volume is a percentage and pan is in degrees.
function mixDirection(change:model.Automation,master:model.MasterBar,instrument:string,staff:string){
  if(change.isLinear)unsupported('gradual mix changes');
  if(change.text)unsupported('mix text');
  const tick=Number((change.ratioPosition*master.calculateDuration()).toFixed(6));
  if(!Number.isInteger(tick))unsupported('a mix change between ticks');
  const value=change.type===model.AutomationType.Volume?element('volume',number(change.value*100/16)):element('pan',number(change.value*180/16-90));
  return element('direction',element('direction-type','<words/>')+(tick?element('offset',tick,' sound="yes"'):'')+staff+element('sound',element('midi-instrument',value,` id="${instrument}"`)));
}

function writePart(track:model.Track,score:model.Score,json:Json,scoreJson:Json,first:boolean,instrument:string,state:{dynamic:model.DynamicValue;started:boolean}){
  state.started=false;
  const mix=trackMixAutomations(track);
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
    content+=mix.filter(point=>point.bar===index).map(point=>mixDirection(point.automation,master,instrument,layouts[0].staff?element('staff',layouts[0].staff):'')).join('');
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
        // Volume/Balance points are written as mix directions from the track's mix stream.
        if(beat.automations.some(change=>change.type!==model.AutomationType.Volume&&change.type!==model.AutomationType.Balance&&!(start&&change.type===model.AutomationType.Instrument&&change.value===track.playbackInfo.program)))unsupported('beat automations');
        // An empty voice can still carry (for example invisible) notes alphaTab does not draw.
        if(voice.isEmpty){if(beat.notes.length)unsupported('notes in an empty voice');continue;}
        if(beat.isEmpty)unsupported('an empty beat inside a voice');
        const voiceNumber=(layout:typeof layouts[number])=>element('voice',voice.index+1+layout.voices);
        if(beat.notes.some(note=>note.dynamics!==beat.dynamics))unsupported('note dynamics differing from their beat');
        // alphaTab imports dynamics as one running state for the whole file (from F),
        // but in MusicXML each part's dynamics are its own, so every part states its start.
        const opening=!state.started;state.started=true;
        if(beat.dynamics!==state.dynamic||(opening&&beat.dynamics!==model.DynamicValue.F)){
          const name=(model.DynamicValue[beat.dynamics]??unsupported('this dynamic')).toLowerCase();
          notes[0]+=element('direction',element('direction-type',element('dynamics',`<${name}/>`))+staffOf(layouts[0]),' placement="below"');state.dynamic=beat.dynamics;
        }
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
          const written=pitch(note.calculateRealValue(false,false)-transpose,bar.keySignature,note.accidentalMode);
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
            // Bends sound on every copy; string/fret belongs to the TAB copy.
            const fingering=layout.technical&&note.isStringed?element('string',strings.length-note.string+1)+element('fret',note.fret):'',bent=bends(note);
            const technical=fingering||bent?element('technical',bent+fingering):'';
            const tied=links.map(([type,level])=>`<tied type="${type}" number="${level}"/>`).join('');
            const timing=rhythm(layout).replace('</duration>',`</duration>${links.map(([type])=>`<tie type="${type}"/>`).join('')}`),cut=timing.search(/<time-modification>|<staff>/);
            notes[at]+=element('note',(noteIndex?'<chord/>':'')+written.pitch+(cut<0?timing+written.accidental:timing.slice(0,cut)+written.accidental+timing.slice(cut))
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

// An excerpt drops ties that cross its edges. A bend tied into or out of an unbent note
// then loses the pitch its tie carries, so such cuts are refused on the source score.
function checkCutBends(score:model.Score,selection:ExportSelection){
  const range=selection.range;if(!range)return;
  const changes=(note:model.Note)=>(note.bendPoints??[]).some(point=>point.value!==note.bendPoints![0].value);
  // The nearest bent note an unbent tie chain carries its pitch from.
  const bentOrigin=(note:model.Note)=>{let origin=note.isTieDestination?note.tieOrigin:null;while(origin&&!origin.hasBend)origin=origin.isTieDestination?origin.tieOrigin:null;return origin;};
  for(const index of selection.tracks)for(const [position,staff] of score.tracks[index].staves.entries()){
    if(selection.staves?.[index]&&!selection.staves[index].includes(position))continue;
    for(const bar of staff.bars.slice(range.first,range.last+1))for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes){
      const destination=note.tieDestination,origin=note.hasBend?null:bentOrigin(note);
      if(destination&&destination.beat.voice.bar.index>range.last&&!destination.hasBend&&changes(note))unsupported('a range that cuts a bend from its tied note');
      if(origin&&origin.beat.voice.bar.index<range.first)unsupported('a range that cuts a tied note from its bend');
    }
  }
}

export function exportMusicXml(score:model.Score,selection:ExportSelection):Uint8Array {
  checkCutBends(score,selection);
  // Lyrics (including hidden ones) live in TabPlayer's own sources, outside the model data.
  if(selection.tracks.some(index=>getLyricsSource(score.tracks[index])?.value.lines.some(line=>line.text.trim())))unsupported('lyrics');
  const copy=selectScore(score,selection),json=toJson(copy);check('score',json);
  if(copy.tracks.some(track=>track.staves.some(staff=>staff.transpositionPitch!==0)))unsupported('sounding transposition');
  // alphaTab's import keeps one running dynamic across all parts in document order.
  const state={dynamic:model.DynamicValue.F,started:false};
  const parts=copy.tracks.map((track,index)=>{
    const info=track.playbackInfo,id=`P${index+1}`;
    if(info.primaryChannel<0||info.primaryChannel>15)unsupported('MIDI channels above 16');
    return {
      list:element('score-part',element('part-name',escape(track.name))+(track.shortName?element('part-abbreviation',escape(track.shortName)):'')+element('score-instrument',element('instrument-name',escape(track.name)),` id="${id}-I1"`)
        +element('midi-instrument',element('midi-channel',info.primaryChannel+1)+element('midi-program',info.program+1)+element('volume',number(info.volume*100/16))+element('pan',number(info.balance*180/16-90)),` id="${id}-I1"`),` id="${id}"`),
      body:element('part',writePart(track,copy,(json.tracks as Json[])[index],json,index===0,`${id}-I1`,state),` id="${id}"`),
    };
  });
  const identification=[copy.artist?element('creator',escape(copy.artist),' type="composer"'):'',copy.words?element('creator',escape(copy.words),' type="lyricist"'):'',copy.copyright?element('rights',escape(copy.copyright)):''].join('');
  const xml='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    +element('score-partwise',(copy.title?element('work',element('work-title',escape(copy.title))):'')+(identification?element('identification',identification):'')
      +element('part-list',parts.map(part=>part.list).join(''))+parts.map(part=>part.body).join(''),' version="4.0"');
  return strToU8(xml);
}
