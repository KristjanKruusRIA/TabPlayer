import type { model } from '@coderline/alphatab';
import type { BarIndexMap } from './measures-types';
import { getLyricsSource,setLyricsSource } from './lyrics-source';

export function mapLyricsMeasures(score:model.Score,map:BarIndexMap):void {
  const count=map.oldToNew.filter(index=>index!==null).length+map.inserted.length;
  const changes=score.tracks.flatMap(track=>{
    const source=getLyricsSource(track);if(!source)return [];
    const lines=source.value.lines.map(line=>{
      const startBar=line.startBar>=map.oldToNew.length?line.startBar+count-map.oldToNew.length:
        map.oldToNew[line.startBar]??map.oldToNew.slice(line.startBar+1).find(index=>index!==null)??count-1;
      if(!Number.isInteger(startBar)||startBar<0||startBar>0xffffffff)throw new Error('Lyrics start exceeds the supported range.');
      return {...line,startBar};
    });
    return [{track,value:{...source.value,lines},managed:source.managed}];
  });
  for(const change of changes)setLyricsSource(change.track,change.value,change.managed);
}
