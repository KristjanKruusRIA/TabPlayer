import { describe,expect,it } from 'vitest';
import { midi,model,Settings } from '@coderline/alphatab';
import { music,noteAt } from '../editor/fixtures';
import { gpControllerEvents,prepareGpMidiScore,type PerformedBar } from './automation';

const settings=new Settings();
function change(score:model.Score,bar:number,type:model.AutomationType,value:number,ratioPosition:number,isLinear=false){
  noteAt(score,bar).beat.automations.push(Object.assign(new model.Automation(),{type,value,ratioPosition,isLinear}));
}
function channels(score:model.Score){score.tracks[0].playbackInfo.primaryChannel=2;score.tracks[0].playbackInfo.secondaryChannel=3;score.tracks[0].playbackInfo.volume=15;score.tracks[0].playbackInfo.balance=8;return score;}
function generate(score:model.Score){
  const file=new midi.MidiFile(),handler=new midi.AlphaSynthMidiFileHandler(file,true),generator=new midi.MidiFileGenerator(score,settings,handler);generator.generate();
  const bars=generator.tickLookup.masterBars.map(bar=>({bar:bar.masterBar.index,startTick:bar.start+file.tickShift,endTick:bar.end+file.tickShift}));
  for(const event of gpControllerEvents(score,bars))file.addEvent(new midi.ControlChangeEvent(event.track,event.tick,event.channel,event.controller,event.value));
  return {file,bars};
}
// Separate SMF decoder checks written bytes, never alphaTab event objects.
function controllers(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(length:number)=>String.fromCharCode(...bytes.slice(p,p+=length));
  const u32=()=>{const value=view.getUint32(p);p+=4;return value;};
  const u16=()=>{const value=view.getUint16(p);p+=2;return value;};
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=value*128+(byte&127);}while(byte&128);return value;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const count=u16();expect(u16()).toBe(960);
  const result:{tick:number;channel:number;controller:number;value:number}[]=[];
  for(let track=0;track<count;track++){
    expect(ascii(4)).toBe('MTrk');const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end){tick+=variable();let code=bytes[p++];if(code<128){p--;code=status;}else if(code<240)status=code;
      if(code===255){p++;const length=variable();p+=length;}
      else if(code===240||code===247){const length=variable();p+=length;}
      else {const kind=code&240,a=bytes[p++],b=kind===192||kind===208?undefined:bytes[p++];if(kind===176)result.push({tick,channel:code&15,controller:a,value:b!});}
    }
  }
  expect(p).toBe(bytes.length);return result;
}
describe('performed GP track controllers',()=>{
  it('places fractional points on every performed occurrence and restores inherited state at repeat jumps',()=>{
    const score=channels(music());change(score,0,model.AutomationType.Volume,9.28,.333333);change(score,1,model.AutomationType.Balance,4,.375);
    score.masterBars[0].isRepeatStart=true;score.masterBars[1].repeatCount=2;score.finish(settings);
    const prepared=prepareGpMidiScore(score,settings),{file,bars}=generate(prepared);
    expect(bars.map(b=>[b.bar,b.startTick,b.endTick])).toEqual([[0,0,3840],[1,3840,7680],[0,7680,11520],[1,11520,15360],[2,15360,19200],[3,19200,23040]]);
    expect(gpControllerEvents(prepared,bars).filter(e=>e.channel===2).map(({tick,controller,value})=>[tick,controller,value])).toEqual([[1280,7,74],[5280,10,32],[7680,7,120],[7680,10,64],[8960,7,74],[12960,10,32]]);
    expect(controllers(file.toBinary()).filter(e=>e.channel===2&&(e.tick===1280||e.tick===5280||e.tick===8960||e.tick===12960))).toEqual([
      {tick:1280,channel:2,controller:7,value:74},{tick:5280,channel:2,controller:10,value:32},{tick:8960,channel:2,controller:7,value:74},{tick:12960,channel:2,controller:10,value:32},
    ]);
  });
  it('strips only mix automation on a detached model while preserving initial controllers, fades, dynamics and links',()=>{
    const score=channels(music()),first=noteAt(score),last=noteAt(score,3);first.dynamics=3;first.slurDestination=last;last.slurOrigin=first;last.isSlurDestination=true;first.beat.fade=model.FadeType.FadeIn;
    change(score,0,model.AutomationType.Volume,3,.5);change(score,0,model.AutomationType.Balance,4,.375);change(score,0,model.AutomationType.Instrument,29,0);
    const before=model.JsonConverter.scoreToJson(score),prepared=prepareGpMidiScore(score,settings),beat=noteAt(prepared).beat;
    expect(prepared===score).toBe(false);expect(beat.automations.map(a=>[a.type,a.value])).toEqual([[model.AutomationType.Instrument,25],[model.AutomationType.Instrument,29]]);expect(noteAt(prepared).dynamics).toBe(3);expect(noteAt(prepared).slurDestination===noteAt(prepared,3)).toBe(true);expect(beat.fade).toBe(model.FadeType.FadeIn);
    const output=controllers(generate(prepared).file.toBinary()).filter(e=>e.channel===2&&e.controller===7).map(({tick,value})=>[tick,value]);
    expect(output).toEqual([[0,120],[0,0],[120,19],[240,38],[360,56],[480,75],[600,94],[768,120],[1920,24]]);
    expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('keeps same-position order and uses channels assigned after detached preparation',()=>{
    const score=channels(music());change(score,0,model.AutomationType.Volume,4,.5);change(score,0,model.AutomationType.Volume,8,.5);
    const prepared=prepareGpMidiScore(score,settings);prepared.tracks[0].playbackInfo.primaryChannel=4;prepared.tracks[0].playbackInfo.secondaryChannel=4;
    expect(gpControllerEvents(prepared,[{bar:0,startTick:100,endTick:3940}])).toEqual([{track:0,tick:2020,channel:4,controller:7,value:32},{track:0,tick:2020,channel:4,controller:7,value:64}]);
  });
  it('emits only stored linear breakpoints while native continuous ramp semantics remain open',()=>{
    const score=channels(music());change(score,0,model.AutomationType.Volume,4,.5,true);const bars:PerformedBar[]=[{bar:0,startTick:0,endTick:3840}];
    expect(gpControllerEvents(score,bars)).toEqual([{track:0,tick:1920,channel:2,controller:7,value:32},{track:0,tick:1920,channel:3,controller:7,value:32}]);
    expect(noteAt(score).beat.getAutomation(model.AutomationType.Volume)!.isLinear).toBe(true);
  });
});
