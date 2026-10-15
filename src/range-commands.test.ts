import { expect,it } from 'vitest';
import { validateProject } from './engine';
import { blankProject } from './project';
import shared from '../tests/protocol.json';

const target={track:0,staff:0,bar:0,voice:0,beat:0};
const point={bar:0,tick:0},end={bar:1,tick:960},lane={track:0,staff:0,voice:0};
const range={kind:'range',range:{start:point,end,lanes:[lane]}};
const notes={kind:'notes',notes:[{target,noteIndex:0}]};
const bars={kind:'bars',tracks:[0],firstBar:0,lastBar:0};
const commands=[
  {type:'eraseSelection',selection:notes},
  {type:'transposeSelection',selection:range,semitones:1},
  {type:'moveSelectionStrings',selection:bars,direction:'higher'},
  {type:'refingerSelection',selection:notes,maxFret:24},
  {type:'setSelectionSustain',selection:bars,strings:[1,2],kind:'palmMute',enabled:true},
  {type:'insertMeasures',beforeBar:0,count:2},
  {type:'removeMeasures',firstBar:0,lastBar:1},
];
const validate=(edit:unknown)=>validateProject({...blankProject(),edits:[edit]}).edits;
it('accepts the seven range/measure commands and every selection variant',()=>{
  expect(shared.slice(51)).toEqual(commands);
  for(const command of commands)expect(validate(command)).toEqual([command]);
  for(const selection of [notes,range,bars])expect(validate({type:'eraseSelection',selection})).toEqual([{type:'eraseSelection',selection}]);
});
it.each(commands)('rejects extra and missing envelope fields in $type',command=>{
  expect(()=>validate({...command,unknown:0})).toThrow();
  for(const key of Object.keys(command).filter(key=>key!=='type')) {
    const missing:Record<string,unknown>={...command};delete missing[key];expect(()=>validate(missing)).toThrow();
  }
});
it('rejects malformed, duplicate, empty or reversed selections atomically',()=>{
  const invalid=[
    {kind:'all'}, {...notes,extra:0},{kind:'notes',notes:[]}, {kind:'notes',notes:[notes.notes[0],notes.notes[0]]},
    {kind:'notes',notes:[{target,noteIndex:-1}]},{kind:'notes',notes:[{target:{...target,voice:.5},noteIndex:0}]},
    {kind:'notes',notes:[{target,noteIndex:0,unknown:0}]},
    {...bars,tracks:[]},{...bars,tracks:[0,0]},{...bars,tracks:[4294967296]},{...bars,firstBar:1,lastBar:0},
    ...[
      {...range.range,start:{...point,tick:-1}}, {...range.range,end:{...end,tick:.5}},
      {...range.range,start:end,end:point},{...range.range,start:point,end:point},{...range.range,lanes:[]},
      {...range.range,lanes:[lane,lane]},{...range.range,lanes:[{...lane,unknown:0}]},
      {...range.range,start:{...point,unknown:0}},{...range.range,unknown:0},
    ].map(value=>({kind:'range',range:value})),
  ];
  for(const selection of invalid)expect(()=>validate({type:'eraseSelection',selection}),JSON.stringify(selection)).toThrow();
});
it('rejects invalid command domains while accepting their exact bounds',()=>{
  const invalid=[
    ...[0,-128,128,NaN,.5].map(semitones=>({...commands[1],semitones})),
    {...commands[2],direction:'up'}, ...[0,128,1.5].map(maxFret=>({...commands[3],maxFret})),
    {...commands[4],enabled:null},{...commands[4],kind:'slur'},
    ...[[],[0],[1,1],[-1],[1.5]].map(strings=>({...commands[4],strings})),
    ...[0,1001,1.5].map(count=>({...commands[5],count})),{...commands[5],beforeBar:-1},
    {...commands[6],firstBar:2,lastBar:1},{...commands[6],lastBar:4294967296},
  ];
  for(const command of invalid)expect(()=>validate(command),JSON.stringify(command)).toThrow();
  for(const semitones of [-127,127])expect(validate({...commands[1],semitones})).toHaveLength(1);
  for(const maxFret of [1,127])expect(validate({...commands[3],maxFret})).toHaveLength(1);
  for(const count of [1,1000])expect(validate({...commands[5],count})).toHaveLength(1);
});
