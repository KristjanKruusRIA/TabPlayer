import { expect, it } from 'vitest';
import { validateProject } from './engine';
import { blankProject } from './project';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const to={...target,bar:1};
const commands=[
  {type:'setTrackLyrics',track:0,visible:false,lines:[{startBar:0,text:'[VERSE]\nHel-lo  world+today'}]},
  {type:'setBeatGestures',target,patch:{slap:true,barre:{fret:3,shape:1},stem:'inverted',rasgueado:18}},
  {type:'setOttava',from:target,to,ottava:4},
  {type:'setCrescendo',from:target,to,crescendo:1,targetDynamics:7},
  {type:'setFermata',target,fermata:{type:2,length:1.5}},
  {type:'setBarGestures',track:0,staff:0,bar:0,clefOttava:1},
  {type:'setMasterBarGestures',bar:0,commonTime:true,doubleBar:false,tripletFeel:6,beaming:{unit:8,groups:[2,2,4]}},
  {type:'setSimile',track:0,staff:0,bar:1,kind:'single'},
];
const validate=(edit:unknown)=>validateProject({...blankProject(),edits:[edit]}).edits;

it('accepts eight exact lyric and notation command envelopes',()=>{
  for(const edit of commands)expect(validate(edit)).toEqual([edit]);
  for(const edit of [
    {...commands[0],lines:[]},{...commands[0],lines:Array.from({length:5},()=>({startBar:0,text:''}))},
    {type:'setBeatGestures',target,patch:{barre:null,slap:false}},
    {type:'setCrescendo',from:target,to,crescendo:0,targetDynamics:null},
    {type:'setFermata',target,fermata:null},
    {...commands[6],beaming:null},
  ])expect(validate(edit)).toEqual([edit]);
});
it.each(commands)('rejects unknown and omitted required fields for $type',edit=>{
  expect(()=>validate({...edit,unknown:true})).toThrow();
  for(const key of Object.keys(edit).filter(key=>key!=='type')){
    const incomplete:Record<string,unknown>={...edit};delete incomplete[key];expect(()=>validate(incomplete)).toThrow();
  }
});
it('rejects invalid nested lyrics and gestures before replay',()=>{
  const invalid=[
    {...commands[0],visible:0},{...commands[0],track:4294967296},
    {...commands[0],lines:Array.from({length:6},()=>({startBar:0,text:''}))},
    ...[{startBar:-1,text:''},{startBar:.5,text:''},{startBar:0,text:null},{startBar:0,text:'',unknown:0},{text:''}].map(line=>({...commands[0],lines:[line]})),
    ...[{}, {slap:null},{slap:1},{golpe:3},{rasgueado:19},{fade:4},{vibrato:-1},{beamingMode:4},{stem:'sideways'},
      {unknown:true},{barre:{fret:0,shape:1}},{barre:{fret:3,shape:0}},{barre:{fret:3,shape:1,extra:0}},
    ].map(patch=>({type:'setBeatGestures',target,patch})),
    {type:'setOttava',from:target,to,ottava:5},
    {type:'setOttava',from:target,to:{...to,voice:1},ottava:2},
    {type:'setOttava',from:to,to:target,ottava:2},
    {type:'setCrescendo',from:target,to,crescendo:0,targetDynamics:4},
    {type:'setCrescendo',from:target,to,crescendo:1,targetDynamics:null},
    {type:'setCrescendo',from:target,to,crescendo:2,targetDynamics:8},
    ...[{type:3,length:1},{type:0,length:0},{type:0,length:Infinity},{type:0,length:1,extra:0}].map(fermata=>({type:'setFermata',target,fermata})),
    {...commands[5],clefOttava:5},{...commands[6],tripletFeel:7},{...commands[6],doubleBar:0},
    ...[{unit:4,groups:[2]},{unit:8,groups:[]},{unit:8,groups:[0]},{unit:8,groups:[.5]},{unit:8,groups:[Number.MAX_SAFE_INTEGER+1]},{unit:8,groups:[2],extra:0}].map(beaming=>({...commands[6],beaming})),
    {...commands[7],kind:'second'},{...commands[7],staff:-1},
  ];
  for(const edit of invalid)expect(()=>validate(edit),JSON.stringify(edit)).toThrow();
});
