// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { buildScore,previewEdit,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { exportMidi } from '../export/midi';
import { buildPlaybackPlan,buildPlaybackPlanFromJson } from '../audio/plan';
import { exportGpInterchange,loadInterchangeScore } from './gp';
import { applyMusicXmlDirectionMix } from './musicxml-direction-mix';

const settings=new Settings();
const volume=(value:string,id=' id="P1-I1"')=>`<direction><direction-type><words>mix</words></direction-type><sound><midi-instrument${id}><volume>${value}</volume></midi-instrument></sound></direction>`;
const pan=(value:string)=>`<direction><direction-type><words>mix</words></direction-type><sound><midi-instrument id="P1-I1"><pan>${value}</pan></midi-instrument></sound></direction>`;
const panAttribute=(value:string)=>`<direction><direction-type><words>mix</words></direction-type><sound pan="${value}"/></direction>`;
// Authored one-bar piano part: volume 55.5% before the second quarter, pan −45°
// before the third and the deprecated pan attribute 90° before the fourth.
const authored=[volume('55.5'),pan('-45'),panAttribute('90')];
type Options={directions?:string[];instruments?:string;tail?:string;beats?:number};
function musicXml(d:number,{directions=authored,instruments='<score-instrument id="P1-I1"><instrument-name>Piano</instrument-name></score-instrument>',tail='',beats=4}:Options={}){
  const quarter=(step:string)=>`<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${d}</duration><voice>1</voice><type>quarter</type></note>`;
  const notes=['C','D','E','F'].slice(0,beats).map((step,index)=>(index>0?directions[index-1]??'':'')+quarter(step)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>Mix study</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name>${instruments}<midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program><volume>75</volume><pan>0</pan></midi-instrument></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>${d}</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><words>Moderato</words></direction-type><sound tempo="120"/></direction>${notes}${tail}</measure></part></score-partwise>`;
}
const container=`<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="scores/main.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`;
const mxl=(main:string,d:number)=>zipSync({
  'mimetype':strToU8('application/vnd.recordare.musicxml'),
  // An earlier, musically distinct XML member must not be selected.
  'decoy.xml':strToU8(musicXml(d,{directions:[volume('10'),volume('20'),volume('30')]})),
  'META-INF/container.xml':strToU8(container),
  'scores/main.musicxml':strToU8(main),
  'media/opaque.bin':new Uint8Array([0,255,1,254,80,75,3,4]),
});
const encode=(kind:'xml'|'mxl',d:number,options?:Options)=>kind==='xml'?strToU8(musicXml(d,options)):mxl(musicXml(d,options),d);
function project(bytes:Uint8Array,kind:string){
  const base={kind:'file' as const,filename:`mix.${kind}`,bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  return {...blankProject(),base};
}
// Independent Standard MIDI byte decoder: unique (tick, controller, value) for CC7/CC10.
function smfMix(bytes:Uint8Array){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let p=0;
  const ascii=(n:number)=>String.fromCharCode(...bytes.slice(p,p+=n));
  const u32=()=>{const n=view.getUint32(p);p+=4;return n;},u16=()=>{const n=view.getUint16(p);p+=2;return n;};
  const variable=()=>{let v=0,n=0;do{n=bytes[p++];v=v*128+(n&127);}while(n&128);return v;};
  expect(ascii(4)).toBe('MThd');expect(u32()).toBe(6);u16();const tracks=u16();expect(u16()).toBe(960);
  const events=new Set<string>();
  for(let track=0;track<tracks;track++){
    expect(ascii(4)).toBe('MTrk');const stop=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<stop){tick+=variable();let type=bytes[p++];if(type<128){p--;type=status;}else if(type<240)status=type;
      if(type===255){p++;const length=variable();p+=length;}
      else if(type===240||type===247){const length=variable();p+=length;}
      else{const kind=type&240,n=kind===192||kind===208?1:2,data=bytes.slice(p,p+=n);if(kind===176&&(data[0]===7||data[0]===10))events.add(JSON.stringify([tick,data[0],data[1]]));}
    }
  }
  expect(p).toBe(bytes.length);return [...events].map(event=>JSON.parse(event) as number[]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
}
const planMix=(plan:ReturnType<typeof buildPlaybackPlan>)=>[...new Set(plan.midi.flatMap(event=>event.type==='controller'&&event.tick>0&&(event.controller===7||event.controller===10)?[JSON.stringify([event.tick,event.controller,event.value])]:[]))].map(event=>JSON.parse(event) as number[]);
const automations=(score:model.Score)=>score.tracks[0].staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.automations.filter(a=>a.type===model.AutomationType.Volume||a.type===model.AutomationType.Balance).map(a=>[a.type,Number(a.value.toFixed(6)),a.ratioPosition,a.isLinear])))));
const expectedAutomations=[[model.AutomationType.Volume,8.88,.25,false],[model.AutomationType.Balance,4,.5,false],[model.AutomationType.Balance,16,.75,false]];
const expectedMix=[[960,7,71],[1920,10,32],[2880,10,127]];
function gpifMix(bytes:Uint8Array){
  const doc=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['Content/score.gpif']),'application/xml');
  return [...doc.querySelectorAll('Track > RSE > ChannelStrip > Automations > Automation')].map(node=>['Type','Bar','Position','Value'].map(name=>node.querySelector(`:scope > ${name}`)?.textContent));
}

describe('MusicXML direction volume and pan',()=>{
  describe.each([1,4])('divisions %i',d=>{
    it.each(['xml','mxl'] as const)('restores direction mix points in %s',kind=>{
      const bytes=encode(kind,d),copy=bytes.slice(),value=project(bytes,kind),base=structuredClone(value.base),score=buildScore(value);
      expect(automations(score)).toEqual(expectedAutomations);
      expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],...expectedMix]);
      expect(planMix(buildPlaybackPlan(score,1))).toEqual(expectedMix);
      expect(planMix(buildPlaybackPlanFromJson(model.JsonConverter.scoreToJson(score),score.tracks.map(trackIdentity),1))).toEqual(expectedMix);
      const gp=exportGpInterchange(score,settings);
      expect(gpifMix(gp).map(([type,bar,position,level])=>[type,bar,Number(position),Number(Number(level).toFixed(6))])).toEqual([['DSPParam_12','0',.25,.555],['DSPParam_11','0',.5,.25],['DSPParam_11','0',.75,1]]);
      expect(automations(loadInterchangeScore(gp,settings))).toEqual(expectedAutomations);
      // Source bytes stay authoritative; edits replay from them without duplicating points.
      expect(bytes).toEqual(copy);expect(value.base).toEqual(base);
      expect(createHash('sha256').update(Buffer.from(value.base.bytesBase64,'base64')).digest('hex')).toBe(base.sha256);
      const changed=previewEdit(value,{type:'setPitchedNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},noteIndex:0,pitch:62});
      expect(changed.project.base).toEqual(base);
      const replayed=buildScore(JSON.parse(JSON.stringify(changed.project)));
      expect(replayed.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].realValue).toBe(62);
      expect(automations(replayed)).toEqual(expectedAutomations);
      expect(smfMix(exportMidi(replayed,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],...expectedMix]);
    });
  });

  it.each([1,4])('places offset directions by their playback flag with divisions %i',d=>{
    const offset=(value:number,flag='')=>`<offset${flag}>${value*d}</offset>`;
    // Volume keeps the cursor (offset without playback), pan moves one quarter later.
    const directions=[volume('55.5').replace('</direction-type>',`</direction-type>${offset(3)}`)+pan('-45').replace('</direction-type>',`</direction-type>${offset(1,' sound="yes"')}`),panAttribute('90').replace('</direction-type>',`</direction-type>${offset(1,' sound="yes"')}`)];
    const score=loadInterchangeScore(strToU8(musicXml(d,{directions})),settings);
    expect(automations(score)).toEqual(expectedAutomations);
    expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],...expectedMix]);
  });

  it('applies a negative playback offset within the bar',()=>{
    const score=loadInterchangeScore(strToU8(musicXml(1,{directions:['',volume('25').replace('</direction-type>','</direction-type><offset sound="yes">-1</offset>')]})),settings);
    expect(automations(score)).toEqual([[model.AutomationType.Volume,4,.25,false]]);
  });

  // Stock alphaTab reads measure-level sounds but truncates to whole sixteenths
  // (55.5% → 8, −50° → 3); the exact values are 8.88 and 3.5556.
  const measureVolume=(value:string)=>`<sound><midi-instrument id="P1-I1"><volume>${value}</volume></midi-instrument></sound>`;
  it('replaces truncated measure-level sound values with exact points',()=>{
    const score=loadInterchangeScore(strToU8(musicXml(1,{directions:[measureVolume('55.5'),'<sound pan="-50"/>']})),settings);
    expect(automations(score)).toEqual([[model.AutomationType.Volume,8.88,.25,false],[model.AutomationType.Balance,3.555556,.5,false]]);
    expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],[960,7,71],[1920,10,28]]);
  });

  it('keeps one balance point when a sound has both pan forms',()=>{
    const score=loadInterchangeScore(strToU8(musicXml(1,{directions:['<sound pan="90"><midi-instrument id="P1-I1"><pan>-45</pan></midi-instrument></sound>']})),settings);
    expect(automations(score)).toEqual([[model.AutomationType.Balance,4,.25,false]]);
  });

  it('combines measure-level and direction-level points in source order',()=>{
    const score=loadInterchangeScore(strToU8(musicXml(1,{directions:[measureVolume('55.5'),pan('-45'),panAttribute('90')]})),settings);
    expect(automations(score)).toEqual(expectedAutomations);
    expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],...expectedMix]);
  });

  it.each([
    // A doubtful measure-level pan keeps the stock balance; the direction volume is still added.
    ['at the bar end',musicXml(1,{directions:[volume('55.5')],tail:'<sound pan="40"/>'})],
    ['with an offset',musicXml(1,{directions:[volume('55.5'),'<sound pan="40"><offset>1</offset></sound>']})],
  ])('keeps stock measure-level points but adds direction points for a sound %s',(_name,text)=>{
    const xml=strToU8(text),stockScore=importer.ScoreLoader.loadScoreFromBytes(xml,settings),score=loadInterchangeScore(xml,settings);
    const byPosition=(points:unknown[][])=>[...points].sort((a,b)=>Number(a[2])-Number(b[2]));
    expect(byPosition(automations(score))).toEqual(byPosition([...automations(stockScore),[model.AutomationType.Volume,8.88,.25,false]]));
  });

  it('adds no fallback direction point of a type a measure-level sound also sets',()=>{
    // Volume 80 then 30 at the same tick; the doubtful pan 135 forces the fallback.
    const text=musicXml(1,{directions:[measureVolume('80')+volume('30'),'<sound pan="135"/>']});
    const xml=strToU8(text);
    expect(model.JsonConverter.scoreToJson(loadInterchangeScore(xml,settings))).toEqual(model.JsonConverter.scoreToJson(importer.ScoreLoader.loadScoreFromBytes(xml,settings)));
  });

  it('finds a mix after many self-closing sounds without closing tags',()=>{
    const dynamics='<direction><direction-type><dynamics><p/></dynamics></direction-type><sound dynamics="54"/></direction>';
    const text=musicXml(1,{directions:[dynamics+volume('55.5')]}).replace('<work>',`<!--${'<sound dynamics="54"/>'.repeat(2000)}--><work>`);
    expect(automations(loadInterchangeScore(strToU8(text),settings))).toEqual([[model.AutomationType.Volume,8.88,.25,false]]);
  });

  it('tracks the cursor through backup into a second voice',()=>{
    const tail=`<backup><duration>4</duration></backup><note><rest/><duration>2</duration><voice>2</voice><type>half</type></note>${volume('25')}<note><rest/><duration>2</duration><voice>2</voice><type>half</type></note>`;
    const score=loadInterchangeScore(strToU8(musicXml(1,{directions:[],tail})),settings);
    expect(automations(score)).toEqual([[model.AutomationType.Volume,4,.5,false]]);
    expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64],[1920,7,32]]);
  });

  it('keeps points when voice 2 ends early behind a trailing forward',()=>{
    const tail=`<backup><duration>4</duration></backup><note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>half</type></note><forward><duration>2</duration><voice>2</voice></forward>`;
    const score=loadInterchangeScore(strToU8(musicXml(1,{tail})),settings);
    expect(score.tracks[0].staves[0].bars[0].voices.length).toBe(2);
    expect(automations(score)).toEqual(expectedAutomations);
  });

  it('keeps points when another part has a shorter voice',()=>{
    const other=`<score-part id="P2"><part-name>Bass</part-name></score-part>`,body=`<part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note><backup><duration>4</duration></backup><note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><voice>2</voice><type>quarter</type></note></measure></part>`;
    const xml=musicXml(1).replace('</part-list>',`${other}</part-list>`).replace('</score-partwise>',`${body}</score-partwise>`);
    expect(automations(loadInterchangeScore(strToU8(xml),settings))).toEqual(expectedAutomations);
  });

  it('reproduces the stock loss as the negative control',()=>{
    const score=importer.ScoreLoader.loadScoreFromBytes(encode('xml',4),settings);
    expect(automations(score)).toEqual([]);
    expect(smfMix(exportMidi(score,{tracks:[0],range:null}))).toEqual([[0,7,96],[0,10,64]]);
  });

  const offset='<offset sound="yes">1</offset>';
  const twoInstruments='<score-instrument id="P1-I1"><instrument-name>A</instrument-name></score-instrument><score-instrument id="P1-I2"><instrument-name>B</instrument-name></score-instrument>';
  // Each doubtful direction follows a valid one, so partial application would fail.
  const paired=(bad:string)=>musicXml(1,{directions:[volume('55.5'),bad]});
  const twoParts=(xml:string)=>xml.replace('</score-part>','</score-part><score-part id="P1"><part-name>Copy</part-name></score-part>').replace('</part></score-partwise>',`</part>${/<part id="P1">[\s\S]*<\/part>/.exec(xml)![0].replace(/<direction><direction-type><words>mix[\s\S]*?<\/direction>/g,'')}</score-partwise>`);
  const variants:[string,string][]=[
    ['a playback offset beyond the bar',paired(volume('50').replace('</direction-type>','</direction-type><offset sound="yes">2</offset>'))],
    ['a playback offset before the bar',paired(volume('50').replace('</direction-type>','</direction-type><offset sound="yes">-3</offset>'))],
    ['a playback offset rounding onto the bar end',musicXml(1,{directions:[volume('55.5'),'',volume('50').replace('</direction-type>','</direction-type><offset sound="yes">0.9999</offset>')]})],
    ['a non-decimal offset',paired(volume('50').replace('</direction-type>','</direction-type><offset>soon</offset>'))],
    ['an unknown offset flag',paired(volume('50').replace('</direction-type>',`</direction-type>${offset.replace('yes','maybe')}`))],
    ['two direction offsets',paired(volume('50').replace('</direction-type>','</direction-type><offset>1</offset><offset>1</offset>'))],
    ['a sound offset',paired(volume('50').replace('</midi-instrument>','</midi-instrument><offset>1</offset>'))],
    ['two midi instruments',paired(volume('50').replace('</midi-instrument>','</midi-instrument><midi-instrument id="P1-I1"><volume>60</volume></midi-instrument>'))],
    ['two sounds in one direction',paired(volume('50').replace('</sound>','</sound><sound><midi-instrument id="P1-I1"><volume>60</volume></midi-instrument></sound>'))],
    ['an out-of-range volume',paired(volume('120'))],
    ['a pan behind the listener',paired(pan('135'))],
    ['a non-decimal volume',paired(volume('loud'))],
    ['a foreign instrument id',paired(volume('50',' id="P9-I9"'))],
    ['a repeat-pass sound',paired(volume('50').replace('<sound>','<sound time-only="2">'))],
    ['two score instruments with an id-less pan',musicXml(1,{instruments:twoInstruments,directions:[panAttribute('-45')]})],
    ['two score instruments with an id-less volume',musicXml(1,{instruments:twoInstruments,directions:[volume('50','')]})],
    ['an incomplete bar',musicXml(1,{beats:3,directions:[volume('55.5')]})],
    ['a cue note',musicXml(1,{directions:[volume('55.5'),volume('50')]}).replace('<note><pitch><step>D','<note><cue/><pitch><step>D')],
    ['a chord rest',musicXml(1,{directions:[volume('55.5')]}).replace('<step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>','<step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note><note><chord/><rest/><duration>1</duration><voice>1</voice><type>quarter</type></note>')],
    ['a chord on the first note',musicXml(1,{directions:[volume('55.5')]}).replace('<note><pitch><step>C','<note><chord/><pitch><step>C')],
    ['a backup before the first note',musicXml(1,{directions:[volume('55.5')]}).replace('<note><pitch><step>C','<forward><duration>4</duration><voice>1</voice></forward><backup><duration>4</duration></backup><note><pitch><step>C')],
    ['duplicate part ids',twoParts(musicXml(1,{directions:[volume('55.5')]}))],
    // The DOM reads the first duration and alphaTab the last; the bar totals still agree.
    ['repeated note durations',musicXml(1,{beats:3,directions:[volume('55.5')]}).replace('<duration>1</duration><voice>','<duration>1</duration><duration>2</duration><voice>').replace('<duration>1</duration><voice>','<duration>2</duration><duration>1</duration><voice>')],
    ['a pickup measure',musicXml(1,{beats:2,directions:[volume('55.5')]}).replace('<measure number="1">','<measure number="0" implicit="yes">')],
  ];
  it.each(variants)('keeps the stock import for %s',(_name,text)=>{
    const xml=strToU8(text);
    expect(model.JsonConverter.scoreToJson(loadInterchangeScore(xml,settings))).toEqual(model.JsonConverter.scoreToJson(importer.ScoreLoader.loadScoreFromBytes(xml,settings)));
  });

  it('does not parse documents whose only volume and pan are part defaults',()=>{
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    try{
      const score=new model.Score();
      expect(applyMusicXmlDirectionMix(score,strToU8(musicXml(1,{directions:[]})),settings)).toBe(score);
      expect(parse).not.toHaveBeenCalled();
    }finally{parse.mockRestore();}
  });

  it('returns the same score untouched for unrelated inputs',()=>{
    for(const bytes of [strToU8(musicXml(1,{directions:[]})),new Uint8Array([1,2,3]),zipSync({'Content/score.gpif':strToU8('<GPIF/>')}),encode('xml',1)]){
      const score=new model.Score();
      expect(applyMusicXmlDirectionMix(score,bytes,settings)).toBe(score);
      expect(score.tracks).toEqual([]);
    }
  });
});
