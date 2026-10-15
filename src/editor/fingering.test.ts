import { describe,expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { planFingering,type FingeringRequest } from './fingering';

const settings=new Settings();
function chord(tuning=[64,59,55,50,45,40],positions:Array<[number,number]>=[[1,5]]) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();
  score.addMasterBar(new model.MasterBar());score.addTrack(track);track.addStaff(staff);staff.stringTuning.tunings=tuning;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();staff.addBar(bar);bar.addVoice(voice);voice.addBeat(beat);beat.duration=model.Duration.Whole;beat.isEmpty=false;
  for(const [string,fret] of positions){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
  score.finish(settings);return {score,staff,notes:beat.notes};
}
const requests=(notes:model.Note[]):FingeringRequest[]=>notes.map(note=>({note,pitch:note.realValue,preferredString:note.string,fixedString:null}));
const positions=(placements:ReturnType<typeof planFingering>)=>placements.map(({string,fret})=>[string,fret]);

// Read the serialized SMF ourselves, without alphaTab's MIDI reader or event objects.
function midiKeys(score:model.Score) {
  const file=new midi.MidiFile(),generator=new midi.MidiFileGenerator(score,settings,new midi.AlphaSynthMidiFileHandler(file,true));generator.applyTranspositionPitches=true;generator.generate();
  const bytes=file.toBinary(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n)),u16=()=>{const n=view.getUint16(p);p+=2;return n;},u32=()=>{const n=view.getUint32(p);p+=4;return n;};
  const variable=()=>{let n=0,b;do{b=bytes[p++];n=n*128+(b&127);}while(b&128);return n;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();u16();const keys:number[]=[];
  for(let t=0;t<tracks;t++){expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let status=0;
    while(p<end){variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}else if(code===240||code===247){const length=variable();p+=length;}else{const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===144&&b)keys.push(a);}
    }
  }
  expect(p).toBe(bytes.length);return keys;
}
function apply(placements:ReturnType<typeof planFingering>) {for(const {note,string,fret} of placements){note.string=string;note.fret=fret;}}

describe('pure chord fingering',()=>{
  it('finds a complete nongreedy assignment instead of stranding the second note',()=>{
    const {staff,notes}=chord(undefined,[[1,5],[1,0]]),input=requests(notes);
    expect(positions(planFingering(staff,[input[0]],5))).toEqual([[1,5]]);
    const result=planFingering(staff,input,5);expect(positions(result)).toEqual([[2,0],[1,0]]);expect(result.map(p=>p.note)).toEqual(notes);
    expect(notes.map(n=>[n.string,n.fret])).toEqual([[1,5],[1,0]]);
  });
  it('minimizes chord spread before preference distance',()=>{
    const {staff,notes}=chord([52,45,40],[[3,0],[3,5]]);
    expect(positions(planFingering(staff,requests(notes),12))).toEqual([[1,12],[2,12]]);
  });
  it('breaks equal objectives by lower center before lexicographic string vector',()=>{
    const {staff,notes}=chord(undefined,[[1,5]]),input=requests(notes);input[0].preferredString=null;
    expect(positions(planFingering(staff,input,5))).toEqual([[2,0]]);
    const unison=chord([60,60],[[2,0],[1,0]]),unisonRequests=requests(unison.notes);unisonRequests.forEach(r=>r.preferredString=null);
    expect(positions(planFingering(unison.staff,unisonRequests,24))).toEqual([[1,0],[2,0]]);
  });
  it('preserves fixed placements beyond the movable fret limit and reserves their strings',()=>{
    const {staff,notes}=chord(undefined,[[1,30],[2,0]]),input=requests(notes);input[0].fixedString=1;
    expect(positions(planFingering(staff,input,5))).toEqual([[1,30],[2,0]]);
    input[1].pitch=40;expect(()=>planFingering(staff,input,5)).toThrow(/playable|fingering|string/i);
    expect(notes.map(n=>[n.string,n.fret])).toEqual([[1,30],[2,0]]);
  });
  it.each([
    {label:'four-string bass',tuning:[43,38,33,28],start:[1,5],pitch:33,want:[2,0]},
    {label:'five-string bass',tuning:[43,38,33,28,23],start:[1,5],pitch:28,want:[2,0]},
    {label:'six-string bass',tuning:[48,43,38,33,28,23],start:[1,5],pitch:28,want:[2,0]},
    {label:'six-string guitar',tuning:[64,59,55,50,45,40],start:[1,5],pitch:45,want:[2,0]},
    {label:'nonmonotonic seven-string guitar',tuning:[64,59,55,50,45,35,40],start:[1,5],pitch:45,want:[3,0]},
    {label:'nonmonotonic eight-string guitar',tuning:[64,59,55,50,45,35,40,30],start:[1,15],pitch:45,want:[4,0]},
    {label:'nonmonotonic nine-string guitar',tuning:[64,59,55,50,45,35,40,30,25],start:[1,20],pitch:45,want:[5,0]},
  ])('preserves literal MIDI pitch on $label',({tuning,start,pitch,want})=>{
    const {score,staff,notes}=chord(tuning,[start as [number,number]]),input=requests(notes);input[0].preferredString=null;
    expect(midiKeys(score)).toEqual([pitch]);const result=planFingering(staff,input,24);expect(positions(result)).toEqual([want]);apply(result);expect(midiKeys(score)).toEqual([pitch]);
  });
  it('uses capo and sounding transposition, ignoring display transposition',()=>{
    const {score,staff,notes}=chord();staff.capo=2;staff.transpositionPitch=12;staff.displayTranspositionPitch=24;
    const input=requests(notes);input[0].preferredString=null;expect(midiKeys(score)).toEqual([35]);const result=planFingering(staff,input,5);expect(positions(result)).toEqual([[2,0]]);apply(result);expect(midiKeys(score)).toEqual([35]);
  });
  it('retains literal MIDI boundary pitches zero and127 without clamping',()=>{
    const {score,staff,notes}=chord([127,0],[[1,0],[2,0]]);expect(midiKeys(score)).toEqual([0,127]);const result=planFingering(staff,requests(notes),127);expect(positions(result)).toEqual([[1,0],[2,0]]);apply(result);expect(midiKeys(score)).toEqual([0,127]);
  });
  it('checks natural harmonic output instead of assuming fret plus harmonic interval',()=>{
    const {score,staff,notes}=chord(undefined,[[1,12]]),note=notes[0];note.harmonicType=model.HarmonicType.Natural;note.harmonicValue=12;
    expect(positions(planFingering(staff,[{...requests(notes)[0],fixedString:1}],5))).toEqual([[1,12]]);
    expect(midiKeys(score)).toEqual([52]);const result=planFingering(staff,requests(notes),24);expect(positions(result)).toEqual([[1,0]]);apply(result);expect(midiKeys(score)).toEqual([52]);
    expect(()=>planFingering(staff,[{...requests(notes)[0],pitch:54}],24)).toThrow(/playable|fingering/i);expect(note.harmonicType).toBe(model.HarmonicType.Natural);expect(note.harmonicValue).toBe(12);
  });
  it('rejects an out-of-range base pitch even when its natural harmonic sounds in MIDI range',()=>{
    const {staff,notes}=chord([0],[[1,0]]);staff.transpositionPitch=12;notes[0].harmonicType=model.HarmonicType.Natural;notes[0].harmonicValue=12;
    expect(notes[0].realValue).toBe(0);expect(()=>planFingering(staff,requests(notes),5)).toThrow(/playable|fingering/i);expect(notes[0].fret).toBe(0);
  });
  it('moves artificial harmonics using their actual pitch and leaves effects and source model intact',()=>{
    const {score,staff,notes}=chord(),note=notes[0];note.harmonicType=model.HarmonicType.Artificial;note.harmonicValue=12;note.isPalmMute=true;note.dynamics=3;note.leftHandFinger=model.Fingers.MiddleFinger;
    const before=model.JsonConverter.scoreToJson(score),id=note.id,input=requests(notes);input[0].preferredString=null;
    expect(midiKeys(score)).toEqual([57]);const result=planFingering(staff,input,5);expect(positions(result)).toEqual([[2,0]]);expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(note.id).toBe(id);
    apply(result);expect(midiKeys(score)).toEqual([57]);expect(note).toMatchObject({harmonicType:model.HarmonicType.Artificial,harmonicValue:12,isPalmMute:true,dynamics:3,leftHandFinger:model.Fingers.MiddleFinger});
  });
  it('uses the destination staff when a melodic clipboard note came from another staff',()=>{
    const source=chord([72],[[1,0]]),destination=chord([64,59,55,50,45,40]);source.notes[0].string=-1;source.notes[0].fret=-1;source.notes[0].octave=5;source.notes[0].tone=0;
    const input=[{note:source.notes[0],pitch:60,preferredString:9,fixedString:null}];expect(positions(planFingering(destination.staff,input,24))).toEqual([[5,1]]);expect(source.notes[0]).toMatchObject({string:-1,fret:-1,octave:5,tone:0});
  });
  it('keeps exact preference ordering when source string preferences are large safe integers',()=>{
    const {staff,notes}=chord([60,60,60,60],[[1,0],[2,0],[3,0]]),input=requests(notes);input.forEach(request=>request.preferredString=Number.MAX_SAFE_INTEGER);
    expect(positions(planFingering(staff,input,1))).toEqual([[2,0],[3,0],[4,0]]);
  });
  it('rejects an impossible final note or collision without mutating earlier requests',()=>{
    const {score,staff,notes}=chord(undefined,[[1,5],[2,0]]),before=model.JsonConverter.scoreToJson(score),input=requests(notes);input[1].pitch=0;
    expect(()=>planFingering(staff,input,24)).toThrow(/playable|fingering/i);expect(model.JsonConverter.scoreToJson(score)).toBe(before);
    input[1].pitch=45;input[0].fixedString=1;input[1].fixedString=1;expect(()=>planFingering(staff,input,24)).toThrow();expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('rejects malformed bounds, requests and unsupported destination staff without mutation',()=>{
    const {score,staff,notes}=chord(),input=requests(notes),before=model.JsonConverter.scoreToJson(score);
    for(const maxFret of [0,128,1.5,NaN])expect(()=>planFingering(staff,input,maxFret)).toThrow();
    for(const pitch of [-1,128,1.5,NaN])expect(()=>planFingering(staff,[{...input[0],pitch}],24)).toThrow();
    for(const fixedString of [0,7,1.5,2])expect(()=>planFingering(staff,[{...input[0],fixedString}],24)).toThrow();
    for(const preferredString of [0,-1,1.5,NaN])expect(()=>planFingering(staff,[{...input[0],preferredString}],24)).toThrow();
    expect(()=>planFingering(staff,[input[0],input[0]],24)).toThrow();expect(model.JsonConverter.scoreToJson(score)).toBe(before);
    staff.isPercussion=true;expect(()=>planFingering(staff,input,24)).toThrow();staff.isPercussion=false;staff.stringTuning.tunings=[];expect(()=>planFingering(staff,input,24)).toThrow();
    staff.stringTuning.tunings=Array(13).fill(40);expect(()=>planFingering(staff,input,24)).toThrow();
  });
  it('supports the existing twelve-string upper bound and has no state between calls',()=>{
    const {staff,notes}=chord(Array.from({length:12},(_,i)=>51-i),Array.from({length:12},(_,i)=>[i+1,0] as [number,number])),input=requests(notes);
    expect(positions(planFingering(staff,input,1))).toEqual([[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],[8,0],[9,0],[10,0],[11,0],[12,0]]);
    expect(planFingering(staff,[],24)).toEqual([]);expect(positions(planFingering(staff,input,1))).toEqual([[1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],[8,0],[9,0],[10,0],[11,0],[12,0]]);
  });
});
