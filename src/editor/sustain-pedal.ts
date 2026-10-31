import { model } from '@coderline/alphatab';

export type SustainPedal='down'|'up'|'none';
type Mark={bar:number;ratio:number;down:boolean};

/** A staff's press/release marks in order, always alternating. alphaTab's derived hold markers
 * and redundant presses or releases (as some imports contain) are dropped. */
export function pedalMarks(staff:model.Staff):Mark[] {
  const marks:Mark[]=[];let down=false;
  for(const bar of staff.bars)for(const marker of [...bar.sustainPedals].sort((a,b)=>a.ratioPosition-b.ratioPosition)){
    const press=marker.pedalType!==model.SustainPedalMarkerType.Up;
    if(press===down)continue;
    down=press;marks.push({bar:bar.index,ratio:marker.ratioPosition,down});
  }
  return marks;
}

/** alphaTab's Bar.finish turns every press in a bar entered with the pedal held into a hold, which
 * drops a re-press after a release in that bar from print and GP export. Restores those presses. */
export function repairPedalPresses(score:model.Score):void {
  for(const track of score.tracks)for(const staff of track.staves){
    let down=false;
    for(const bar of staff.bars)for(const marker of bar.sustainPedals){
      if(marker.pedalType===model.SustainPedalMarkerType.Hold&&!down)marker.pedalType=model.SustainPedalMarkerType.Down;
      down=marker.pedalType!==model.SustainPedalMarkerType.Up;
    }
  }
}

/** One pedal lane for a track: a track's staves share its MIDI channels, so the pedal is down
 * while any staff holds it. */
export function trackPedalMarks(track:model.Track):Mark[] {
  const lanes=track.staves.map(pedalMarks).filter(marks=>marks.length);
  if(lanes.length<2)return lanes[0]??[];
  const points=[...new Map(lanes.flat().map(mark=>[`${mark.bar}/${mark.ratio}`,mark])).values()].sort((a,b)=>a.bar-b.bar||a.ratio-b.ratio);
  const state=(marks:Mark[],point:Mark)=>marks.filter(mark=>mark.bar<point.bar||(mark.bar===point.bar&&mark.ratio<=point.ratio)).at(-1)?.down??false;
  const merged:Mark[]=[];let down=false;
  for(const point of points){const now=lanes.some(marks=>state(marks,point));if(now!==down){down=now;merged.push({bar:point.bar,ratio:point.ratio,down});}}
  return merged;
}

/** Where a beat sits in its bar, as a sustain pedal marker's ratio position. */
export function beatPedalRatio(beat:model.Beat):number {
  return beat.playbackStart/beat.voice.bar.masterBar.calculateDuration();
}

/** The press or release written at this beat, if any. */
export function sustainPedalAt(beat:model.Beat):SustainPedal {
  const bar=beat.voice.bar.index,ratio=beatPedalRatio(beat);
  const mark=pedalMarks(beat.voice.bar.staff).find(mark=>mark.bar===bar&&mark.ratio===ratio);
  return mark?mark.down?'down':'up':'none';
}

/** Presses or releases the pedal at a beat, or clears its mark, keeping presses and releases
 * alternating: a press before a later press extends that span, a release before a later release
 * shortens it, and clearing a mark also removes the mark that answered it. */
export function applySustainPedal(beat:model.Beat,pedal:SustainPedal):void {
  if(!['down','up','none'].includes(pedal))throw new Error('Choose a sustain pedal press, release or no mark.');
  if(beat.graceType!==model.GraceType.None)throw new Error('Select a regular beat for the sustain pedal.');
  if(beat.voice.bar.staff.isPercussion)throw new Error('A percussion staff has no sustain pedal.');
  const staff=beat.voice.bar.staff,bar=beat.voice.bar.index,ratio=beatPedalRatio(beat);
  if(!Number.isFinite(ratio)||ratio<0||ratio>=1)throw new Error('Invalid sustain pedal position.');
  const marks=pedalMarks(staff),index=marks.findIndex(mark=>mark.bar===bar&&mark.ratio===ratio);
  if(pedal==='none'){
    if(index<0)throw new Error('This beat has no sustain pedal mark.');
    marks.splice(index,2);
  }else{
    const down=pedal==='down';
    if(index>=0)throw new Error(marks[index].down===down?`The sustain pedal is already ${down?'pressed':'released'} at this beat.`:'Clear this beat\'s sustain pedal mark first.');
    const at=marks.findIndex(mark=>mark.bar>bar||(mark.bar===bar&&mark.ratio>ratio)),position=at<0?marks.length:at;
    if((marks[position-1]?.down??false)===down)throw new Error(`The sustain pedal is already ${down?'pressed':'released'} here.`);
    marks.splice(position,marks[position]?.down===down?1:0,{bar,ratio,down});
  }
  for(const measure of staff.bars)measure.sustainPedals=[];
  for(const mark of marks){
    const measure=staff.bars[mark.bar];
    measure.sustainPedals.push(Object.assign(new model.SustainPedalMarker(),{bar:measure,ratioPosition:mark.ratio,pedalType:mark.down?model.SustainPedalMarkerType.Down:model.SustainPedalMarkerType.Up}));
  }
}
