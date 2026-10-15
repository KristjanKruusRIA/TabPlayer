export interface RatioTempoPoint {bar:number;ratio:number;bpm:number;linear:boolean}
export interface ReplaceTempoAutomations {type:'replaceTempoAutomations';points:RatioTempoPoint[]}

export function validateRatioTempoPoints(value:unknown):asserts value is RatioTempoPoint[] {
  if(!Array.isArray(value)||!value.length)throw new Error('Provide an initial score tempo.');
  let previous:RatioTempoPoint|null=null;
  for(const point of value) {
    if(!point||typeof point!=='object'||Array.isArray(point)||Object.keys(point).length!==4||!['bar','ratio','bpm','linear'].every(key=>Object.hasOwn(point,key))||!Number.isInteger(point.bar)||point.bar<0||point.bar>0xffffffff||!Number.isFinite(point.ratio)||point.ratio<0||point.ratio>1||!Number.isFinite(point.bpm)||point.bpm<=0||typeof point.linear!=='boolean')throw new Error('Invalid score tempo point.');
    if(previous?(point.bar<previous.bar||point.bar===previous.bar&&point.ratio<=previous.ratio):(point.bar!==0||point.ratio!==0))throw new Error('Score tempo points must start at bar zero and increase in score order.');
    previous=point;
  }
}
