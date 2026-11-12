import { model } from '@coderline/alphatab';
import { planCurves,wherever } from './curves';
import { harmonyCarrierRefusal,sourceViewsRebuilt } from './gp';
import { planTimeSignatureExport } from '../editor/time-signature-source';

/** alphaTab's GPIF reader looks at most this many bars back for the origin of a tie (`Note._maxOffsetForSameLineSearch`); gp-link-reach.test.ts pins it. The destination's search itself is pinned in gp-link-search.test.ts. */
const maxTieReach=3;
interface Tally {count:number;first:string}
const tally=(into:Tally|undefined,where:()=>string):Tally=>{if(into){into.count++;return into;}return {count:1,first:where()};};
/** One line per kind: the count, the verb agreeing with it, and where the first one is. */
const line=(item:Tally|undefined,one:string,many:string)=>item?[`${item.count} ${item.count===1?one:many} (first at ${item.first})`]:[];

/**
 * The beats the reader can see when it looks for the destination of a hammer-on or slide while finishing a note
 * (gp-link-search.test.ts pins this). Bars are finished one after another, so only the origin's own bar is chained to
 * its own beats, plus the link from its last beat to the next bar's first beat. The next bar's later beats are not yet
 * linked to each other. So: the later beats of the origin's bar, then the first beat of the next bar of the same voice.
 */
function* readerBeats(note:model.Note):Generator<model.Beat> {
  const beat=note.beat,voice=beat?.voice,bar=voice?.bar;if(!voice||!bar)return;
  for(let index=beat.index+1;index<voice.beats.length;index++)yield voice.beats[index];
  const next=bar.staff?.bars[bar.index+1]?.voices[voice.index]?.beats[0];if(next)yield next;
}
/** `Beat.getNoteOnString`: only stringed notes are indexed, and a later note on the same string replaces an earlier one. */
const onString=(beat:model.Beat,string:number)=>{
  let found:model.Note|null=null;
  if(string>=0)for(const note of beat.notes)if(note.string===string)found=note;
  return found;
};
/** The beats the reader sees going back from a tie destination: earlier beats of its bar, then the bars before it, at most three back (all already chained). */
function* readerBeatsBack(note:model.Note):Generator<model.Beat> {
  const beat=note.beat,voice=beat?.voice,bar=voice?.bar;if(!voice||!bar)return;
  for(let index=beat.index-1;index>=0;index--)yield voice.beats[index];
  for(let at=bar.index-1;at>=bar.index-maxTieReach;at--){
    const earlier=bar.staff?.bars[at]?.voices[voice.index];if(!earlier||!earlier.beats.length)return;
    for(let index=earlier.beats.length-1;index>=0;index--)yield earlier.beats[index];
  }
}
/** `Note.findTieOrigin`: the first earlier note on the same string whatever it is; without strings, the note at the same index or with the same pitch. */
function readerTieOrigin(note:model.Note):model.Note|null {
  for(const beat of readerBeatsBack(note)){
    if(note.string>=0){const found=onString(beat,note.string);if(found)return found;}
    else if(note.octave===-1&&note.tone===-1){if(note.index<beat.notes.length)return beat.notes[note.index];}
    else{let found:model.Note|null=null;for(const other of beat.notes)if(other.realValue===note.realValue)found=other;if(found)return found;}
  }
  return null;
}
/** `Note.nextNoteOnSameLine`: the first note on the same string. */
function readerSlideTarget(note:model.Note):model.Note|null {
  for(const beat of readerBeats(note)){const found=onString(beat,note.string);if(found)return found;}
  return null;
}
/** `Note.findHammerPullDestination`: the first note on the same string, or the nearest note on either side of it when that one is left-hand tapped. */
function readerHammerDestination(note:model.Note):model.Note|null {
  const strings=note.beat.voice.bar.staff?.stringTuning?.tunings?.length??0;
  for(const beat of readerBeats(note)){
    const same=onString(beat,note.string);if(same)return same;
    for(let string=note.string;string>0;string--){const found=onString(beat,string);if(found){if(found.isLeftHandTapped)return found;break;}}
    for(let string=note.string;string<=strings;string++){const found=onString(beat,string);if(found){if(found.isLeftHandTapped)return found;break;}}
  }
  return null;
}
/** A length the private property restores: `readGpifCurves` refuses anything not above 0 and up to 16. */
const restorableLength=(value:number)=>Number.isFinite(value)&&value>0&&value<=16;

/**
 * Everything a Guitar Pro 7/8 export of this score cannot keep: the curve losses `planCurves` finds, then what the writer
 * leaves to the private TabPlayer property or changes on the way. Every export path asks this one function, so the
 * warning and the writer agree. One pass over the score; a line is aggregated per kind, with the first position.
 * What is established is alphaTab's reader and the fields the file holds; nothing here tests Guitar Pro itself.
 */
export function gpLosses(score:model.Score):string[] {
  const plan=planCurves(score);
  let ties:Tally|undefined,hammers:Tally|undefined,slides:Tally|undefined,slurs:Tally|undefined,long:Tally|undefined,styled:Tally|undefined,lengths:Tally|undefined,badLengths:Tally|undefined,hidden:Tally|undefined,carriers:Tally|undefined;
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices){
    if(voice.isEmpty){
      // `prepareHarmonyGpCarriers`: an empty voice whose beat only carries a chord diagram is written as a real quarter rest.
      if(voice.beats.some(beat=>beat.hasChord))carriers=tally(carriers,()=>wherever(voice.beats[0]));
      continue;
    }
    // The writer (`writeGpifCurves`) skips an empty voice and visits every note of any other, so this does the same.
    for(const beat of voice.beats){
      const where=()=>wherever(beat);
      if(plan.carriedBeats.has(beat)&&beat.hasWhammyBar){
        if((beat.whammyBarPoints?.length??0)>4)long=tally(long,where);
        if(beat.whammyStyle!==model.BendStyle.Default)styled=tally(styled,where);
      }
      for(const note of beat.notes){
        if(plan.carriedNotes.has(note)&&note.hasBend){
          if((note.bendPoints?.length??0)>4)long=tally(long,where);
          if(note.bendStyle!==model.BendStyle.Default)styled=tally(styled,where);
        }
        if(plan.carriedSlurs.has(note))slurs=tally(slurs,where);
        if(note.tieDestination&&readerTieOrigin(note.tieDestination)!==note)ties=tally(ties,where);
        if(note.isHammerPullOrigin&&note.hammerPullDestination&&readerHammerDestination(note)!==note.hammerPullDestination)hammers=tally(hammers,where);
        if(note.slideTarget&&((note.slideOutType!==model.SlideOutType.Shift&&note.slideOutType!==model.SlideOutType.Legato)||readerSlideTarget(note)!==note.slideTarget))slides=tally(slides,where);
        if(note.durationPercent!==1){if(restorableLength(note.durationPercent))lengths=tally(lengths,where);else badLengths=tally(badLengths,where);}
        if(!note.isVisible)hidden=tally(hidden,where);
      }
    }
  }
  // One choice for the whole score is written; `planTimeSignatureExport` is what the stylesheet writer uses too.
  const time=planTimeSignatureExport(score),barOf=(index:number)=>`bar ${(((score.tracks[0]?.staves[0]?.bars[index]) as {sourceIndex?:number}|undefined)?.sourceIndex??index)+1}`;
  const differing=time.differing.length?{count:time.differing.length,first:barOf(time.differing[0])}:undefined,inherited=time.inherited.length?{count:time.inherited.length,first:barOf(time.inherited[0])}:undefined;
  // The differing bars all chose the opposite of what the file ends up showing.
  const showsSymbol=time.differing.length>0&&score.masterBars[time.differing[0]]?.timeSignatureCommon===false;
  // A carrier the export refuses is not written as a rest at all: the refusal says so instead.
  if(carriers&&harmonyCarrierRefusal(score))carriers=undefined;
  // The aggregates come first: a dialog shows five lines and a batch report three, and a long per-item list must not push them all under "and N more".
  return [
    ...line(ties,'tie will not be linked to the same notes when this file is opened again','ties will not be linked to the same notes when this file is opened again'),
    ...line(hammers,'hammer-on or pull-off will not be linked to the same notes when this file is opened again','hammer-ons or pull-offs will not be linked to the same notes when this file is opened again'),
    ...line(slides,'slide will not be linked to the same notes when this file is opened again','slides will not be linked to the same notes when this file is opened again'),
    ...line(slurs,'slur is written only for TabPlayer','slurs are written only for TabPlayer'),
    ...line(long,'bend or whammy bar has more than four points and is written only for TabPlayer','bends or whammy bars have more than four points and are written only for TabPlayer'),
    ...line(styled,'bend or whammy bar has a style that is written only for TabPlayer','bends or whammy bars have a style that is written only for TabPlayer'),
    ...line(lengths,'note has a sounding length that is written only for TabPlayer','notes have a sounding length that is written only for TabPlayer'),
    ...line(badLengths,'note has a sounding length outside 0 to 16 that will not be read back','notes have a sounding length outside 0 to 16 that will not be read back'),
    ...line(hidden,'hidden note is written as hidden only for TabPlayer','hidden notes are written as hidden only for TabPlayer'),
    ...line(carriers,'empty beat that only carries a chord diagram is written as a quarter rest','empty beats that only carry a chord diagram are written as quarter rests'),
    ...differing?line(differing,'bar set to '+(showsSymbol?'numbers will show the common/cut symbol':'the common/cut symbol will show numbers')+', because the Guitar Pro file holds one choice for the whole score','bars set to '+(showsSymbol?'numbers will show the common/cut symbol':'the common/cut symbol will show numbers')+', because the Guitar Pro file holds one choice for the whole score'):[],
    ...line(inherited,'bar with no common/cut choice of its own now follows the whole-score choice of '+(time.value?'the common/cut symbol':'numbers'),'bars with no common/cut choice of their own now follow the whole-score choice of '+(time.value?'the common/cut symbol':'numbers')),
    ...sourceViewsRebuilt(score)?["the source file's part, layout and score views were rebuilt because tracks were added, left out or reordered"]:[],
    ...plan.losses,
  ];
}

/**
 * The message the export would throw for this score, worked out without writing anything, or null. Asked before the
 * user confirms the warning, so a refusal is shown instead of a warning confirmed for nothing. It covers the refusal
 * that depends on the score alone: an empty chord carrier that is not one plain quarter. Mixed or inherited common/cut
 * time is not a refusal (it is written as one choice and reported by `gpLosses`). Refusals that depend on the bytes of
 * an imported file (its view styles) are still thrown by the export.
 */
export function gpExportRefusal(score:model.Score):string|null {
  return harmonyCarrierRefusal(score);
}
