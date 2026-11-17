import type { model } from '@coderline/alphatab';
import { resolvePercussionArticulation } from '../editor/percussion-catalog';
import { ownerOf } from '../instruments/drum-kit';
import { mapArticulationId } from '../audio/drum-map';

/**
 * Drum tablature, drawn by alphaTab 1.8.4, which cannot draw percussion as tab. Nothing here touches the source score: the converter
 * rewrites the display copy's JSON that `projectEngraving` makes, so that a percussion staff becomes (or is joined by) an ordinary six-line
 * tab staff whose "fret" is the written articulation number. alphaTab 1.9 draws drum tab natively; this module is meant to be replaced by it.
 */

/** The six tab lines, top to bottom. */
export const DRUM_TAB_LINES=6;
/** Ids of the six tuning entries; only their count matters, the pitches are never sounded (the display copy is rendered, never played). */
export const DRUM_TAB_TUNING:readonly number[]=[64,59,55,50,45,40];

/** Kit pieces (ids of `drumPieces` and `percussionInstruments`) by the line they are written on. Everything else, and any unknown piece, is line 2. */
const lineOfPiece:Readonly<Record<string,number>>={
  // 1: crashes, china, splash, reverse cymbal, clash cymbals
  splash:1,crash:1,'crash-2':1,reverse:1,china:1,piatti:1,
  // 3: the hi-hat family (42, 44, 46, 92)
  'hi-hat':3,
  // 4: all toms
  'high-tom':4,'hi-mid-tom':4,'low-mid-tom':4,'low-tom':4,'high-floor-tom':4,'floor-tom':4,
  // 5: the snare family (38, 37, 91, 40, 39, 31)
  snare:5,'electric-snare':5,'hand-clap':5,
  // 6: kicks (35, 36)
  kick:6,'kick-2':6,
};
/** The line for anything not named above: the ride, bells and other metal or percussion. */
export const DRUM_TAB_OTHER_LINE=2;

/** What a note needs to be written: its articulation index in the track's table, or the standard id. */
export interface DrumTabNoteLike {percussionArticulation:number}

/**
 * The number written for a note: the WRITTEN standard articulation id (the one the drum map resolves a note to), else the output MIDI
 * number of its articulation, else null (the articulation resolves to nothing). The track's drum map is ignored on purpose: it changes
 * what is sent to a plug-in or port, not what is written.
 */
export function drumTabNumber(track:model.Track,note:DrumTabNoteLike):number|null {
  const standard=mapArticulationId(track,note.percussionArticulation);
  if(standard!==undefined&&standard>=0&&standard<=127)return standard;
  const key=resolvePercussionArticulation(track,note.percussionArticulation)?.outputMidiNumber;
  return key!==undefined&&Number.isInteger(key)&&key>=0&&key<=127?key:null;
}
/** The tab line 1 (top) to 6 a note prefers, by its kit piece; null when the note has no number. */
export function drumTabLine(track:model.Track,note:DrumTabNoteLike):number|null {
  if(drumTabNumber(track,note)===null)return null;
  const piece=ownerOf(track,note.percussionArticulation);
  return piece?lineOfPiece[piece.id]??DRUM_TAB_OTHER_LINE:DRUM_TAB_OTHER_LINE;
}

export interface TabCandidate {/** Written number. */number:number;/** Preferred line 1-6. */line:number}
export interface TabAssignment {
  /** The line of each candidate, aligned to the input, or null when it is left off the tab (more than six hits in the beat). */
  lines:(number|null)[];
  /** How many candidates were left off. */
  surplus:number;
}
/**
 * Gives each hit of one beat a line of its own. Deterministic and independent of the order the notes are stored in (ties on both line and
 * number fall back to input order, and equal candidates are interchangeable). Hits are taken from the bottom line up (kick, snare,
 * hi-hat, toms...), lower numbers first among equals; each takes its own line if free. A hit whose line is taken then goes to the
 * nearest free line, trying the one above first and then the one below, at each distance. Only six lines exist: a hit that finds none is left off and counted.
 */
export function assignDrumTabLines(candidates:readonly TabCandidate[]):TabAssignment {
  const order=candidates.map((_,index)=>index).sort((a,b)=>candidates[b].line-candidates[a].line||candidates[a].number-candidates[b].number||a-b);
  const taken=new Array<boolean>(DRUM_TAB_LINES+1).fill(false),lines=new Array<number|null>(candidates.length).fill(null),wanted=(index:number)=>Math.min(DRUM_TAB_LINES,Math.max(1,candidates[index].line));
  // First every line goes to the hit that wants it most, so a displaced hit never takes the line another hit prefers.
  const displaced:number[]=[];
  for(const index of order){const line=wanted(index);if(taken[line])displaced.push(index);else{taken[line]=true;lines[index]=line;}}
  let surplus=0;
  for(const index of displaced){
    let found:number|null=null;
    for(let distance=1;distance<DRUM_TAB_LINES&&found===null;distance++)for(const line of [wanted(index)-distance,wanted(index)+distance]){if(line>=1&&line<=DRUM_TAB_LINES&&!taken[line]){found=line;break;}}
    if(found===null){surplus++;continue;}
    taken[found]=true;lines[index]=found;
  }
  return {lines,surplus};
}

export type DrumTabMode='tab'|'both';
type Json=Record<string,unknown>;
export interface DrumTabReport {
  /** Rendered note id to the source note id it shows, for every note drawn on a tab staff, in both modes (in 'tab' mode the ids are unchanged, so each maps to itself). */
  notes:Map<number,number>;
  /** Rendered beat id to source beat id, for every beat of a tab staff. */
  beats:Map<number,number>;
  /** Source note ids left off the tab: more than six hits in one beat. */
  surplusNotes:number[];
  /** Source note ids left off the tab because their articulation resolves to nothing. */
  unresolvedNotes:number[];
  /** The ties the tab keeps, as pairs of rendered note ids (origin to destination): both ends are written, with the same number on the same line. */
  ties:Array<{from:number;to:number}>;
  /** Track indexes whose per-track tuning label was hidden in the JSON stylesheet. */
  hiddenTuningTracks:number[];
  /** The highest bar, voice, beat and note id the converted JSON uses (the fresh ids of 'both' mode included), so the caller can keep alphaTab's id counters above them. */
  highestIds:{note:number;beat:number;voice:number;bar:number};
}

/** Defaults every effect field of a tab note takes; only what tab can show survives (see `tabNote`). */
const noteDefaults:Json={accentuated:0,bendtype:0,bendstyle:0,iscontinuedbend:false,showstringnumber:false,octave:-1,tone:-1,isvisible:true,islefthandtapped:false,ishammerpullorigin:false,isslurdestination:false,harmonictype:0,harmonicvalue:0,isletring:false,ispalmmute:false,isdead:false,isstaccato:false,slideintype:0,slideouttype:0,vibrato:0,lefthandfinger:-2,righthandfinger:-2,trillvalue:-1,trillspeed:32,durationpercent:1,accidentalmode:0,ornament:0};
/** Beat effects of the drum staff that tab would draw wrongly (or twice): back to their defaults on the copy. */
const beatDefaults:Json={whammystyle:0,islegatoorigin:false,pop:false,slap:false,tap:false,slashed:false,deadslapped:false,brushtype:0,brushduration:0,iscontinuedwhammy:false,whammybartype:0,vibrato:0,pickstroke:0,golpe:0,wahpedal:0,barrefret:-1,barreshape:0,rasgueado:0,showtimer:false,timer:null};
/** The JSON keys that name another note by id. A tab note starts without them: the ties it keeps are listed in the report, by the ids the tab notes got; the other links mean nothing on a drum hit. */
const noteLinkKeys=['tiedestinationnoteid','tieoriginnoteid','slurdestinationnoteid','sluroriginnoteid','hammerpulldestinationnoteid','hammerpulloriginnoteid','slidetargetnoteid','slideoriginnoteid'];
/** Things printed once per beat that the second staff of a track must not repeat. */
const beatRepeats:Json={text:null,lyrics:null,chordid:null,crescendo:0};

/**
 * What the tab staff does with each thing a drum note can carry:
 * - rhythm (duration, dots, tuplets, grace notes), rests, positions: kept as they are;
 * - ties: kept between two hits written alike, same number on the same line (the tab draws the destination in parentheses at the start of a bar); a tie between hits written differently is dropped, because alphaTab would show the destination as the origin's number or draw a slanted arc;
 * - ghost notes: kept (tab shows them in parentheses, as it does for a ghost on a string);
 * - accents: kept on the note;
 * - dead notes, staccato, palm mute, let ring, bends, slides, harmonics, vibrato, fingering, trills, ornaments: dropped (the drum staff has no use for them and tab would draw them as "x", slides, and the like);
 * - beat techniques (slap, pop, tap, brush, pick stroke, golpe, wah, rasgueado, whammy, timer): dropped;
 * - dynamics (the number only): kept so that nothing about the velocity changes; a tab staff draws no dynamics sign;
 * - tremolo picking and the beat's own automations: kept as is (tab draws neither);
 * - text, lyrics, chord diagrams, crescendo wedges and sustain pedal marks: kept in 'tab' mode and left off the second staff in 'both' mode, where the percussion staff already shows them.
 */
function tabNote(note:Json,line:number,number:number,id:number):Json {
  const copy={...note};for(const key of noteLinkKeys)delete copy[key];
  return {...copy,...noteDefaults,accentuated:note.accentuated,isvisible:note.isvisible,id,string:DRUM_TAB_LINES+1-line,fret:number,percussionarticulation:-1,isghost:note.isghost,istiedestination:false,dynamics:note.dynamics};
}

interface Ids {note:number;beat:number;voice:number;bar:number}
function maxIds(tracks:readonly Json[]):Ids {
  const ids:Ids={note:-1,beat:-1,voice:-1,bar:-1};
  const take=(key:keyof Ids,value:unknown)=>{if(typeof value==='number'&&value>ids[key])ids[key]=value;};
  for(const track of tracks)for(const staff of (track.staves as Json[]))for(const bar of (staff.bars as Json[])){take('bar',bar.id);for(const voice of (bar.voices as Json[])){take('voice',voice.id);for(const beat of (voice.beats as Json[])){take('beat',beat.id);for(const note of (beat.notes as Json[]))take('note',note.id);}}}
  return ids;
}

/**
 * Rewrites the display score JSON `json` (what `JSON.parse(model.JsonConverter.scoreToJson(copy))` gives, mutated in place) so each track in `modes`
 * shows its percussion staves as drum tab. `source` is the score the JSON was made from; only its tracks' articulation tables are read, by
 * position, and nothing in it is written. 'tab' replaces every percussion staff of the track by a six-line tab staff (ids kept); 'both' keeps
 * the percussion staff and appends the tab staff as its track's next staff, with fresh ids so alphaTab's per-id lookups (bounds) stay unique.
 *
 * The tab staff has six tuning entries, `ispercussion` off, tablature on and standard notation off, so alphaTab's own Staff.finish and tab
 * renderer take it for a stringed staff. Its six tuning labels ("= C") are hidden by `perTrackDisplayTuning` in the JSON stylesheet; because
 * `projectEngraving` clears that map when the engraving overrides the tuning display, call `hideDrumTabTuning` on the finished copy too.
 * Staves other than percussion ones are left alone.
 */
export function convertDrumTabJson(json:Json,source:model.Score,modes:ReadonlyMap<number,DrumTabMode>):DrumTabReport {
  const tracks=json.tracks as Json[],report:DrumTabReport={notes:new Map(),beats:new Map(),surplusNotes:[],unresolvedNotes:[],ties:[],hiddenTuningTracks:[],highestIds:{note:-1,beat:-1,voice:-1,bar:-1}};
  const next=maxIds(tracks);report.highestIds=next;
  const written:Array<{tab:Json;origin:Json}>=[];
  const fresh=(key:keyof Ids)=>++next[key];
  tracks.forEach((trackJson,trackIndex)=>{
    const mode=modes.get(trackIndex),track=source.tracks[trackIndex];
    if(!mode||!track)return;
    const staves=trackJson.staves as Json[],out:Json[]=[];let converted=false;
    for(const [staffIndex,staffJson] of staves.entries()){
      if(staffJson.ispercussion!==true){out.push(staffJson);continue;}
      converted=true;
      const both=mode==='both',tab=convertStaff(staffJson,track,track.staves[staffIndex],both,fresh,report,written);
      if(both){out.push(staffJson,tab);}else out.push(tab);
    }
    trackJson.staves=out;
    if(converted){
      const style=json.stylesheet as Json;
      const map=(style.pertrackdisplaytuning??(style.pertrackdisplaytuning={})) as Record<string,boolean>;
      map[String(trackIndex)]=false;report.hiddenTuningTracks.push(trackIndex);
    }
  });
  // A tie is kept between two hits that are both written and written alike (same number, same line): a tie from one number or line to another would
  // make alphaTab show the destination as the origin's number, or draw a slanted arc. The JSON carries no tie at all: `projectEngraving` hands the
  // kept ones back through `report.ties`, by the ids the tab notes got, so a note never names a partner that is not in the JSON.
  const tabOf=new Map(written.map(({tab,origin})=>[origin.id as number,tab]));
  for(const {origin} of written){
    const to=typeof origin.tiedestinationnoteid==='number'?tabOf.get(origin.tiedestinationnoteid):undefined,from=tabOf.get(origin.id as number)!;
    if(to&&to.fret===from.fret&&to.string===from.string)report.ties.push({from:from.id as number,to:to.id as number});
  }
  return report;
}

/**
 * The line of each hit of one bar, found per moment across all its voices: hands in one voice and feet in another still have to be told apart on
 * one set of lines, because the tab lines up the beats of every voice by time. A moment is the source beats' display start; a grace beat is a moment
 * of its own. Candidates are taken voice by voice, in storage order, so the same bar always gets the same lines. A hit that finds no line is `null`.
 */
function assignBar(barJson:Json,sourceBar:model.Bar|undefined,track:model.Track,report:DrumTabReport):Map<Json,number|null> {
  const groups=new Map<string,Array<{note:Json;candidate:TabCandidate}>>(),lines=new Map<Json,number|null>();let alone=0;
  (barJson.voices as Json[]).forEach((voiceJson,voiceIndex)=>(voiceJson.beats as Json[]).forEach((beatJson,beatIndex)=>{
    const sourceBeat=sourceBar?.voices[voiceIndex]?.beats[beatIndex],grace=beatJson.gracetype!==undefined&&beatJson.gracetype!==0;
    const key=sourceBeat&&!grace?`at${sourceBeat.displayStart}`:`own${alone++}`,group=groups.get(key)??[];groups.set(key,group);
    for(const note of beatJson.notes as Json[]){
      const like={percussionArticulation:note.percussionarticulation as number},number=drumTabNumber(track,like);
      if(number===null){report.unresolvedNotes.push(note.id as number);continue;}
      group.push({note,candidate:{number,line:drumTabLine(track,like)!}});
    }
  }));
  for(const group of groups.values()){
    const {lines:given}=assignDrumTabLines(group.map(entry=>entry.candidate));
    group.forEach((entry,at)=>lines.set(entry.note,given[at]));
  }
  return lines;
}

function convertStaff(staff:Json,track:model.Track,sourceStaff:model.Staff|undefined,fresh_:boolean,fresh:(key:keyof Ids)=>number,report:DrumTabReport,written:Array<{tab:Json;origin:Json}>):Json {
  const copyIds=fresh_;
  const bars=(staff.bars as Json[]).map((barJson,barIndex)=>{
    const lineOf=assignBar(barJson,sourceStaff?.bars[barIndex],track,report);
    const bar:Json={...barJson,id:copyIds?fresh('bar'):barJson.id,...copyIds?{sustainpedals:[]}:{}};
    bar.voices=(barJson.voices as Json[]).map(voiceJson=>{
      const voice:Json={...voiceJson,id:copyIds?fresh('voice'):voiceJson.id};
      voice.beats=(voiceJson.beats as Json[]).map(beatJson=>{
        const beatId=copyIds?fresh('beat'):beatJson.id as number;
        const notes:Json[]=[];
        for(const note of beatJson.notes as Json[]){
          if(!lineOf.has(note))continue;
          const line=lineOf.get(note)!;
          if(line===null){report.surplusNotes.push(note.id as number);continue;}
          const id=copyIds?fresh('note'):note.id as number;
          const tab=tabNote(note,line,drumTabNumber(track,{percussionArticulation:note.percussionarticulation as number})!,id);notes.push(tab);written.push({tab,origin:note});report.notes.set(id,note.id as number);
        }
        report.beats.set(beatId,beatJson.id as number);
        // Notes are written top line first, as the renderer sorts them anyway; the order is fixed so the output is deterministic.
        notes.sort((a,b)=>(b.string as number)-(a.string as number)||(a.id as number)-(b.id as number));
        return {...beatJson,...beatDefaults,...copyIds?beatRepeats:{},id:beatId,notes};
      });
      return voice;
    });
    return bar;
  });
  return {...staff,bars,capo:0,transpositionpitch:0,displaytranspositionpitch:0,stringtuning:{isstandard:false,name:'',tunings:[...DRUM_TAB_TUNING]},showslash:false,shownumbered:false,showtablature:true,showstandardnotation:false,ispercussion:false,standardnotationlinecount:5};
}

/**
 * Hides the tuning label of the given tracks on the finished display copy. `projectEngraving` empties `perTrackDisplayTuning` when the
 * engraving sets its own tuning display, which would show "= C" and five more entries above a drum tab, so the caller runs this last.
 */
export function hideDrumTabTuning(score:model.Score,trackIndexes:readonly number[]):void {
  const style=score.stylesheet;
  if(!trackIndexes.length)return;
  style.perTrackDisplayTuning??=new Map();
  for(const index of trackIndexes)style.perTrackDisplayTuning.set(index,false);
}
