import type {EditCommand} from '../edit-types';
import {planMeasureMap} from './measures';
import type {BarIndexMap} from './measures-types';

const attempt=(barCount:number,command:Parameters<typeof planMeasureMap>[1]):BarIndexMap|null=>{try{return planMeasureMap(barCount,command);}catch{return null;}};

/** Where each bar went when `edit` was applied to a score of `barCount` bars; null when the edit moves no bar, or moves them in a way this cannot trace (a paste that adds bars, say). */
export function barMapOfEdit(edit:EditCommand,barCount:number):BarIndexMap|null {
  switch(edit.type) {
    case 'insertMeasures': case 'removeMeasures': return attempt(barCount,edit);
    case 'appendMeasure': return {oldToNew:Array.from({length:barCount},(_,bar)=>bar),inserted:[barCount]};
    case 'removeMeasure': return edit.bar>=0&&edit.bar<barCount&&barCount>1?{oldToNew:Array.from({length:barCount},(_,bar)=>bar<edit.bar?bar:bar===edit.bar?null:bar-1),inserted:[]}:null;
    default: return null;
  }
}

/** Where each bar went when `edit` was undone, with `barCount` bars at the moment of the undo: the inverse of `barMapOfEdit`. A redo is `barMapOfEdit` again. */
export function barMapOfUndo(edit:EditCommand,barCount:number):BarIndexMap|null {
  switch(edit.type) {
    case 'insertMeasures': return attempt(barCount,{type:'removeMeasures',firstBar:edit.beforeBar,lastBar:edit.beforeBar+edit.count-1});
    case 'removeMeasures': return attempt(barCount,{type:'insertMeasures',beforeBar:edit.firstBar,count:edit.lastBar-edit.firstBar+1});
    case 'appendMeasure': return attempt(barCount,{type:'removeMeasures',firstBar:barCount-1,lastBar:barCount-1});
    case 'removeMeasure': return attempt(barCount,{type:'insertMeasures',beforeBar:edit.bar,count:1});
    default: return null;
  }
}
