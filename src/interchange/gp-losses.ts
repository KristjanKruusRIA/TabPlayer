import { model } from '@coderline/alphatab';
import { planCurves,wherever } from './curves';
import { sourceViewsRebuilt } from './gp';

/** alphaTab's GPIF reader looks at most this many bars back for the origin of a tie (`Note._maxOffsetForSameLineSearch`); gp-link-reach.test.ts pins it. */
const maxTieReach=3;
interface Tally {count:number;first:string}
const tally=(into:Tally|undefined,where:()=>string):Tally=>{if(into){into.count++;return into;}return {count:1,first:where()};};
/** One line per kind: the count, the verb agreeing with it, and where the first one is. */
const line=(item:Tally|undefined,one:string,many:string)=>item?[`${item.count} ${item.count===1?one:many} (first at ${item.first})`]:[];
const distance=(from:model.Note,to:model.Note|null)=>to?(to.beat?.voice?.bar?.index??Infinity)-(from.beat?.voice?.bar?.index??0):0;

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
const onString=(beat:model.Beat,string:number)=>beat.notes.find(note=>note.string===string)??null;
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
        if(distance(note,note.tieDestination)>maxTieReach)ties=tally(ties,where);
        if(note.isHammerPullOrigin&&note.hammerPullDestination&&readerHammerDestination(note)!==note.hammerPullDestination)hammers=tally(hammers,where);
        if(note.slideTarget&&((note.slideOutType!==model.SlideOutType.Shift&&note.slideOutType!==model.SlideOutType.Legato)||readerSlideTarget(note)!==note.slideTarget))slides=tally(slides,where);
        if(note.durationPercent!==1){if(restorableLength(note.durationPercent))lengths=tally(lengths,where);else badLengths=tally(badLengths,where);}
        if(!note.isVisible)hidden=tally(hidden,where);
      }
    }
  }
  return [
    ...plan.losses,
    ...line(ties,'tie reaches further than a Guitar Pro file can link and will not be read back as tied','ties reach further than a Guitar Pro file can link and will not be read back as tied'),
    ...line(hammers,'hammer-on or pull-off cannot be linked again from a Guitar Pro file and will not be read back as linked','hammer-ons or pull-offs cannot be linked again from a Guitar Pro file and will not be read back as linked'),
    ...line(slides,'slide cannot be linked again from a Guitar Pro file and will not be read back as linked','slides cannot be linked again from a Guitar Pro file and will not be read back as linked'),
    ...line(slurs,'slur is written only for TabPlayer','slurs are written only for TabPlayer'),
    ...line(long,'bend or whammy bar has more than four points and is written only for TabPlayer','bends or whammy bars have more than four points and are written only for TabPlayer'),
    ...line(styled,'bend or whammy bar has a style that is written only for TabPlayer','bends or whammy bars have a style that is written only for TabPlayer'),
    ...line(lengths,'note has a sounding length that is written only for TabPlayer','notes have a sounding length that is written only for TabPlayer'),
    ...line(badLengths,'note has a sounding length outside 0 to 16 that will not be read back','notes have a sounding length outside 0 to 16 that will not be read back'),
    ...line(hidden,'hidden note is written as hidden only for TabPlayer','hidden notes are written as hidden only for TabPlayer'),
    ...line(carriers,'empty beat that only carries a chord diagram is written as a quarter rest','empty beats that only carry a chord diagram are written as quarter rests'),
    ...sourceViewsRebuilt(score)?["the source file's part, layout and score views were rebuilt because tracks were added, left out or reordered"]:[],
  ];
}
