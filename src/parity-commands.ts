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
  eraseSelection:['selection'],transposeSelection:['selection','semitones'],moveSelectionStrings:['selection','direction'],
  refingerSelection:['selection','maxFret'],setSelectionSustain:['selection','strings','kind','enabled'],
  insertMeasures:['beforeBar','count'],removeMeasures:['firstBar','lastBar'],
  pasteMusic:['clip','options'],
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
function nonempty(value:unknown):unknown[] {
  if(!Array.isArray(value)||!value.length)throw new Error('Select some music.');return value;
}
function unique(keys:unknown[]) {if(new Set(keys).size!==keys.length)throw new Error('Duplicate selection.');}
export function validateMusicClipEnvelope(value:unknown):void {
  const clip=exact(value,['format','version','engineVersion','mode','kind','scoreJson','links']);
  if(clip.format!=='TabPlayerClip'||clip.version!==1||clip.engineVersion!=='1.8.4'||!['singleTrack','multiTrack'].includes(clip.mode as string)||!['phrase','bars'].includes(clip.kind as string))throw new Error('Unsupported musical clipboard.');
  if(typeof clip.scoreJson!=='string'||new TextEncoder().encode(clip.scoreJson).byteLength>128000000)throw new Error('Invalid clipboard model size.');
  const json:unknown=JSON.parse(clip.scoreJson,(_key,value:unknown)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid clipboard number.');return value;});object(json);
  if(!Array.isArray(clip.links))throw new Error('Invalid clipboard links.');
  unique(Array.from(clip.links,value=>{
    const link=exact(value,['from','to','kind','slideOutType']);integer(link.from);integer(link.to);
    if(!['tie','slur','slide','hammerPull'].includes(link.kind as string)||(link.kind==='slide'?![1,2].includes(link.slideOutType as number):link.slideOutType!==null))throw new Error('Invalid clipboard relationship.');
    return [link.from,link.to,link.kind,link.slideOutType].join('/');
  }));
}
function pasteOptions(value:unknown) {
  const options=exact(value,['target','destinations','count','placement','filters']);target(options.target);integer(options.count,1000);
  if(options.count===0||!['currentBar','beforeBar'].includes(options.placement as string))throw new Error('Invalid paste placement or count.');
  const filters=exact(options.filters,['diagrams','texts','timers','trackAutomations','masterAutomations','sections']);Object.values(filters).forEach(flag);
  const destinations=Array.from(nonempty(options.destinations),value=>{
    const destination=exact(value,['sourceTrack','track','staffMap']);integer(destination.sourceTrack);integer(destination.track);
    const staves=nonempty(destination.staffMap);for(const staff of staves)integer(staff);unique(staves);return destination;
  });
  unique(destinations.map(value=>value.sourceTrack));unique(destinations.map(value=>value.track));
}
function musicSelection(value:unknown) {
  const selection=object(value);
  if(selection.kind==='notes'){
    exact(value,['kind','notes']);
    unique(nonempty(selection.notes).map(note=>{const location=indexed(note);return [...['track','staff','bar','voice','beat'].map(key=>location[key]),object(note).noteIndex].join('/');}));
  }else if(selection.kind==='bars'){
    exact(value,['kind','tracks','firstBar','lastBar']);integer(selection.firstBar);integer(selection.lastBar);
    if(Number(selection.firstBar)>Number(selection.lastBar))throw new Error('Invalid measure range.');
    const tracks=nonempty(selection.tracks);tracks.forEach(value=>integer(value));unique(tracks);
  }else if(selection.kind==='range'){
    exact(value,['kind','range']);const range=exact(selection.range,['start','end','lanes']);
    const start=exact(range.start,['bar','tick']),end=exact(range.end,['bar','tick']);
    Object.values(start).forEach(value=>integer(value));Object.values(end).forEach(value=>integer(value));
    if(Number(end.bar)<Number(start.bar)||(end.bar===start.bar&&Number(end.tick)<=Number(start.tick)))throw new Error('Invalid music range.');
    unique(nonempty(range.lanes).map(value=>{const lane=exact(value,['track','staff','voice']);Object.values(lane).forEach(value=>integer(value));return [lane.track,lane.staff,lane.voice].join('/');}));
  }else throw new Error('Invalid music selection.');
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
  if('selection'in edit)musicSelection(edit.selection);
  if(type==='transposeSelection'&&(typeof edit.semitones!=='number'||!Number.isInteger(edit.semitones)||edit.semitones===0||Math.abs(edit.semitones)>127))throw new Error('Choose a nonzero semitone shift from -127 to 127.');
  if(type==='moveSelectionStrings'&&!['higher','lower'].includes(edit.direction as string))throw new Error('Invalid string direction.');
  if(type==='refingerSelection'){integer(edit.maxFret,127);if(edit.maxFret===0)throw new Error('Invalid maximum fret.');}
  if(type==='setSelectionSustain'){
    flag(edit.enabled);if(!['letRing','palmMute'].includes(edit.kind as string))throw new Error('Invalid sustain technique.');
    const strings=nonempty(edit.strings);for(const string of strings){integer(string);if(string===0)throw new Error('Invalid string.');}unique(strings);
  }
  if(type==='insertMeasures'){integer(edit.beforeBar);integer(edit.count,1000);if(edit.count===0)throw new Error('Insert at least one measure.');}
  if(type==='removeMeasures'){integer(edit.firstBar);integer(edit.lastBar);if(Number(edit.firstBar)>Number(edit.lastBar))throw new Error('Invalid measure range.');}
  if(type==='pasteMusic'){validateMusicClipEnvelope(edit.clip);pasteOptions(edit.options);}
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
