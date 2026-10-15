const shapes:Record<string,readonly string[]>={
  setScoreMetadata:['fields'],setDirections:['bar','directions'],setNoteSpelling:['target','noteIndex','accidentalMode'],
  addPitchedTrack:['name','program'],addPercussionTrack:['name','program'],
  addPitchedNote:['target','pitch'],setPitchedNote:['target','noteIndex','pitch'],
  addPercussionNote:['target','articulation'],setPercussionNote:['target','noteIndex','articulation'],
  removeNoteByIndex:['target','noteIndex'],setNoteTechniquesByIndex:['target','noteIndex','patch'],
  setNoteLinkByIndex:['from','to','kind'],
};
const metadata=['subTitle','album','words','music','copyright','tab','notices','instructions'];
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid edit object.');
  return value as Record<string,unknown>;
}
function exact(value:unknown,keys:readonly string[]) {
  const result=object(value);
  if(Object.keys(result).length!==keys.length||keys.some(key=>!Object.hasOwn(result,key)))throw new Error('Invalid edit fields.');
  return result;
}
function integer(value:unknown,max=0xffffffff) {
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>max)throw new Error('Invalid edit integer.');
}
function target(value:unknown) {
  const result=exact(value,['track','staff','bar','voice','beat']);Object.values(result).forEach(value=>integer(value));return result;
}
function indexed(value:unknown) {
  const result=exact(value,['target','noteIndex']);integer(result.noteIndex);return target(result.target);
}
function techniqueShape(value:unknown) {
  const patch=object(value),flags=['letRing','palmMute','dead','ghost','staccato','leftHandTapped'];
  const enums=['accent','dynamics','leftFinger','rightFinger','slideIn','slideOut','vibrato','ornament'];
  for(const [key,field]of Object.entries(patch)) {
    if(flags.includes(key)){if(typeof field!=='boolean')throw new Error('Invalid technique flag.');}
    else if(enums.includes(key)){if(typeof field!=='number'||!Number.isInteger(field))throw new Error('Invalid technique value.');}
    else if(['bend','harmonic','trill'].includes(key)) {
      if(field===null)continue;
      const item=exact(field,key==='bend'?['type','style','points']:key==='harmonic'?['type','value']:['pitch','speed']);
      for(const [name,number]of Object.entries(item))if(name!=='points'&&(typeof number!=='number'||!Number.isFinite(number)))throw new Error('Invalid technique parameter.');
      if(key==='bend') {
        if(!Array.isArray(item.points))throw new Error('Invalid bend points.');
        for(const point of item.points)if(Object.values(exact(point,['offset','value'])).some(number=>typeof number!=='number'||!Number.isFinite(number)))throw new Error('Invalid bend point.');
      }
    }else throw new Error('Unknown note technique.');
  }
}

/** Exact new command envelopes; score-dependent note/technique validation stays in the editor. */
export function validateParityCommand(value:unknown):void {
  const candidate=object(value),type=candidate.type;
  if(typeof type!=='string'||!Object.hasOwn(shapes,type))return;
  const edit=exact(value,['type',...shapes[type]]);
  if('target'in edit)target(edit.target);
  for(const key of ['noteIndex','bar'])if(key in edit)integer(edit[key]);
  for(const key of ['pitch','program'])if(key in edit)integer(edit[key],127);
  if('articulation'in edit)integer(edit.articulation,0x7fffffff);
  if('name'in edit&&typeof edit.name!=='string')throw new Error('Invalid track name.');
  if(type==='setScoreMetadata') {
    const fields=exact(edit.fields,metadata);if(Object.values(fields).some(value=>typeof value!=='string'))throw new Error('Invalid score metadata.');
  }
  if(type==='setDirections') {
    if(!Array.isArray(edit.directions))throw new Error('Invalid directions.');edit.directions.forEach(value=>integer(value,18));
  }
  if(type==='setNoteSpelling')integer(edit.accidentalMode,6);
  if(type==='setNoteTechniquesByIndex')techniqueShape(edit.patch);
  if(type==='setNoteLinkByIndex') {
    const from=indexed(edit.from);
    if(!['tie','hammerPull','slur'].includes(edit.kind as string))throw new Error('Invalid note relationship.');
    if(edit.to!==null) {
      const to=indexed(edit.to);
      if(from.track!==to.track||from.staff!==to.staff||from.voice!==to.voice||Number(to.bar)<Number(from.bar)||(to.bar===from.bar&&Number(to.beat)<=Number(from.beat)))throw new Error('Link notes forward in the same staff and voice.');
    }
  }
}
