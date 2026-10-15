const shapes:Record<string,readonly string[]>={
  setScoreMetadata:['fields'],setDirections:['bar','directions'],setNoteSpelling:['target','noteIndex','accidentalMode'],
  addPitchedTrack:['name','program'],addPercussionTrack:['name','program'],
  addPitchedNote:['target','pitch'],setPitchedNote:['target','noteIndex','pitch'],
  addPercussionNote:['target','articulation'],setPercussionNote:['target','noteIndex','articulation'],
  removeNoteByIndex:['target','noteIndex'],setNoteTechniquesByIndex:['target','noteIndex','patch'],
  setNoteLinkByIndex:['from','to','kind'],
  setTrackLyrics:['track','visible','lines'],setBeatGestures:['target','patch'],setOttava:['from','to','ottava'],
  setCrescendo:['from','to','crescendo','targetDynamics'],setFermata:['target','fermata'],
  setBarGestures:['track','staff','bar','clefOttava'],setMasterBarGestures:['bar','commonTime','doubleBar','tripletFeel','beaming'],
  setSimile:['track','staff','bar','kind'],
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
function flag(value:unknown) {if(typeof value!=='boolean')throw new Error('Invalid edit flag.');}
function range(from:unknown,to:unknown) {
  const a=target(from),b=target(to);
  if(a.track!==b.track||a.staff!==b.staff||a.voice!==b.voice||Number(b.bar)<Number(a.bar)||(a.bar===b.bar&&Number(b.beat)<Number(a.beat)))throw new Error('Select a forward range in one voice.');
}
function gestureShape(value:unknown) {
  const patch=object(value),flags=['tap','slap','pop','deadSlapped','slashed','showTimer'];
  const enums:Record<string,number>={golpe:2,rasgueado:18,fade:3,vibrato:2,beamingMode:3};
  if(!Object.keys(patch).length)throw new Error('Choose a beat gesture.');
  for(const [key,field]of Object.entries(patch)) {
    if(flags.includes(key))flag(field);
    else if(Object.hasOwn(enums,key))integer(field,enums[key]);
    else if(key==='stem') {if(!['auto','inverted','up','down'].includes(field as string))throw new Error('Invalid stem choice.');}
    else if(key==='barre') {
      if(field===null)continue;
      const barre=exact(field,['fret','shape']);integer(barre.fret,127);integer(barre.shape,2);
      if(barre.fret===0||barre.shape===0)throw new Error('Invalid barre.');
    }else throw new Error('Unknown beat gesture.');
  }
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
  for(const key of ['noteIndex','bar','track','staff'])if(key in edit)integer(edit[key]);
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
  if(type==='setTrackLyrics') {
    flag(edit.visible);
    if(!Array.isArray(edit.lines)||edit.lines.length>5)throw new Error('Use at most five lyric lines.');
    for(const line of edit.lines) {
      const item=exact(line,['startBar','text']);integer(item.startBar);if(typeof item.text!=='string')throw new Error('Invalid lyrics.');
    }
  }
  if(type==='setBeatGestures')gestureShape(edit.patch);
  if(type==='setOttava'||type==='setCrescendo')range(edit.from,edit.to);
  if(type==='setOttava')integer(edit.ottava,4);
  if(type==='setCrescendo') {
    integer(edit.crescendo,2);
    if(edit.crescendo===0) {if(edit.targetDynamics!==null)throw new Error('Clearing a hairpin retains dynamics.');}
    else integer(edit.targetDynamics,7);
  }
  if(type==='setFermata'&&edit.fermata!==null) {
    const fermata=exact(edit.fermata,['type','length']);integer(fermata.type,2);
    if(typeof fermata.length!=='number'||!Number.isFinite(fermata.length)||fermata.length<=0)throw new Error('Invalid fermata length.');
  }
  if(type==='setBarGestures')integer(edit.clefOttava,4);
  if(type==='setMasterBarGestures') {
    flag(edit.commonTime);flag(edit.doubleBar);integer(edit.tripletFeel,6);
    if(edit.beaming!==null) {
      const rule=exact(edit.beaming,['unit','groups']);
      if(![8,16,32].includes(rule.unit as number)||!Array.isArray(rule.groups)||!rule.groups.length)throw new Error('Invalid beaming groups.');
      for(const group of rule.groups)if(typeof group!=='number'||!Number.isSafeInteger(group)||group<=0)throw new Error('Invalid beaming group.');
    }
  }
  if(type==='setSimile'&&!['none','single','double'].includes(edit.kind as string))throw new Error('Invalid simile.');
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
