/** What a Standard MIDI File holds that a score import needs, with all timing in the file's own ticks. */
export interface MidiNote {key:number;velocity:number;channel:number;start:number;end:number}
export interface MidiPart {index:number;name:string;notes:MidiNote[]}
export interface MidiProgram {tick:number;channel:number;program:number}
export interface MidiSong {
  format:0|1;
  /** Ticks per quarter note. */
  division:number;
  title:string;
  tempos:{tick:number;microsPerQuarter:number}[];
  meters:{tick:number;numerator:number;denominator:number}[];
  keys:{tick:number;sharps:number;minor:boolean}[];
  /** Program changes from every track, in tick order; a channel's program may be set in any track. */
  programs:MidiProgram[];
  /** Only the file's tracks that hold notes. */
  parts:MidiPart[];
  endTick:number;
}

export const MIDI_FILE_LIMIT=8*1024*1024;
/** Notes a file may hold. Import and Guitar Pro export of larger files take too long or run out of memory. */
export const MIDI_NOTE_LIMIT=60_000;
const EVENT_LIMIT=2_000_000;
const fail=(message:string):never=>{throw new Error(message);};
const malformed=(detail:string)=>fail(`This is not a valid MIDI file: ${detail}.`);

interface Reader {bytes:Uint8Array;at:number}
const u16=(bytes:Uint8Array,at:number)=>bytes[at]<<8|bytes[at+1];
const u32=(bytes:Uint8Array,at:number)=>(bytes[at]*0x1000000)+(bytes[at+1]<<16|bytes[at+2]<<8|bytes[at+3]);
const tag=(bytes:Uint8Array,at:number)=>String.fromCharCode(bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]);
/** Removes every ]]> , which would end the CDATA section a name is written in. */
export function stripCdataEnd(text:string):string {
  let result=text;
  while(result.includes(']]>'))result=result.replaceAll(']]>','');
  return result;
}
const clean=(bytes:Uint8Array)=>stripCdataEnd(new TextDecoder('utf-8').decode(bytes).replace(/\p{Cc}+/gu,' ')).trim().slice(0,80);

function variable(reader:Reader,end:number):number {
  let value=0;
  for(let count=0;count<4;count++){
    if(reader.at>=end)return malformed('an event is cut off');
    const byte=reader.bytes[reader.at++];value=value*128+(byte&0x7f);
    if(!(byte&0x80))return value;
  }
  return malformed('an event time is longer than four bytes');
}

interface TrackRead {name:string;notes:MidiNote[];programs:MidiProgram[];tempos:MidiSong['tempos'];meters:MidiSong['meters'];keys:MidiSong['keys'];end:number;events:number}

function readTrack(bytes:Uint8Array,from:number,to:number,budget:number):TrackRead {
  const reader:Reader={bytes,at:from},result:TrackRead={name:'',notes:[],programs:[],tempos:[],meters:[],keys:[],end:0,events:0};
  const open=new Map<number,MidiNote[]>();
  let tick=0,status=-1,named=false;
  const close=(key:number,channel:number,at:number)=>{
    const list=open.get(channel<<8|key);const note=list?.shift();
    if(note)note.end=Math.max(at,note.start);
  };
  while(reader.at<to){
    if(++result.events>budget)fail('This MIDI file has too many events to import.');
    tick+=variable(reader,to);
    if(reader.at>=to)malformed('an event is cut off');
    let first=bytes[reader.at];
    if(first&0x80){reader.at++;status=first;}
    else if(status<0)malformed('an event has no status byte');
    else first=status;
    if(first===0xff){
      if(reader.at>=to)malformed('a meta event is cut off');
      const type=bytes[reader.at++],length=variable(reader,to);
      if(reader.at+length>to)malformed('a meta event is cut off');
      const data=bytes.subarray(reader.at,reader.at+length);reader.at+=length;status=-1;
      if(type===0x2f){result.end=tick;return finish(result,tick);}
      if(type===0x03&&!named){named=true;result.name=clean(data);}
      else if(type===0x51){if(length!==3)malformed('a tempo event has the wrong size');const micros=data[0]<<16|data[1]<<8|data[2];if(micros>0)result.tempos.push({tick,microsPerQuarter:micros});}
      else if(type===0x58){
        if(length<2)malformed('a time signature event is too short');
        result.meters.push({tick,numerator:data[0],denominator:2**data[1]});
      }else if(type===0x59){if(length<2)malformed('a key signature event is too short');result.keys.push({tick,sharps:data[0]>127?data[0]-256:data[0],minor:data[1]===1});}
      continue;
    }
    if(first===0xf0||first===0xf7){
      const length=variable(reader,to);if(reader.at+length>to)malformed('a system exclusive event is cut off');
      reader.at+=length;status=-1;continue;
    }
    if(first>=0xf1)malformed('it holds a system event that does not belong in a file');
    const kind=first&0xf0,channel=first&0x0f,count=kind===0xc0||kind===0xd0?1:2;
    if(reader.at+count>to)malformed('a channel event is cut off');
    const one=bytes[reader.at++],two=count===2?bytes[reader.at++]:0;
    if(one&0x80||two&0x80)malformed('an event has a data byte above 127');
    if(kind===0x90&&two>0){
      const note:MidiNote={key:one,velocity:two,channel,start:tick,end:-1},id=channel<<8|one;
      const list=open.get(id);if(list)list.push(note);else open.set(id,[note]);
      result.notes.push(note);
    }else if(kind===0x80||kind===0x90)close(one,channel,tick);
    else if(kind===0xc0)result.programs.push({tick,channel,program:one});
  }
  result.end=tick;
  return finish(result,tick);
}

/** A note still sounding when the track ends stops there; a note that never gets any length lasts a tick. */
function finish(result:TrackRead,end:number):TrackRead {
  for(const note of result.notes){if(note.end<0)note.end=Math.max(end,note.start);}
  return result;
}

/**
 * Reads format 0 and format 1 Standard MIDI Files. A file that is cut off, has a bad header or has events
 * that cannot be read is refused with a message; nothing is guessed.
 */
export function readMidiFile(bytes:Uint8Array):MidiSong {
  if(bytes.length>MIDI_FILE_LIMIT)fail('MIDI import is limited to files under 8 MB.');
  if(bytes.length>=4&&tag(bytes,0)==='RIFF')fail('RIFF-wrapped MIDI (.rmi) files are not supported. Save the file as a Standard MIDI File first.');
  if(bytes.length<14||tag(bytes,0)!=='MThd')fail('This is not a Standard MIDI File.');
  const headerLength=u32(bytes,4);
  if(headerLength<6||8+headerLength>bytes.length)malformed('the header is cut off');
  const format=u16(bytes,8),tracks=u16(bytes,10),division=u16(bytes,12);
  if(format===2)fail('Format 2 MIDI files (independent sequences) are not supported. Import format 0 or format 1 files.');
  if(format!==0&&format!==1)malformed(`format ${format} is unknown`);
  if(tracks<1||(format===0&&tracks!==1))malformed(format===0?'a format 0 file must hold exactly one track':'it holds no tracks');
  if(division&0x8000)fail('This MIDI file uses SMPTE timing, which is not supported. Only tempo-based (ticks per quarter note) files can be imported.');
  if(division<1)malformed('the time division is zero');
  const song:MidiSong={format:format as 0|1,division,title:'',tempos:[],meters:[],keys:[],programs:[],parts:[],endTick:0};
  let at=8+headerLength,read=0,budget=EVENT_LIMIT;const names:string[]=[];
  while(read<tracks){
    if(at+8>bytes.length)malformed(`${tracks-read} of ${tracks} tracks are missing`);
    const type=tag(bytes,at),length=u32(bytes,at+4),start=at+8;
    if(start+length>bytes.length)malformed(`track ${read+1} is cut off`);
    at=start+length;
    if(type!=='MTrk')continue;
    const track=readTrack(bytes,start,at,budget);budget-=track.events;
    for(const value of track.tempos)song.tempos.push(value);for(const value of track.meters)song.meters.push(value);for(const value of track.keys)song.keys.push(value);for(const value of track.programs)song.programs.push(value);
    song.endTick=Math.max(song.endTick,track.end);for(const note of track.notes)song.endTick=Math.max(song.endTick,note.end);
    names.push(track.name);
    if(track.notes.length)song.parts.push({index:read,name:track.name,notes:track.notes});
    read++;
  }
  const byTick=<T extends {tick:number}>(list:T[])=>{
    // Several events at one tick: the last one written wins.
    const sorted=list.map((value,order)=>({value,order})).sort((a,b)=>a.value.tick-b.value.tick||a.order-b.order);
    return sorted.filter((entry,index)=>sorted[index+1]?.value.tick!==entry.value.tick).map(entry=>entry.value);
  };
  song.tempos=byTick(song.tempos);song.meters=byTick(song.meters);song.keys=byTick(song.keys);
  song.programs.sort((a,b)=>a.tick-b.tick);
  const noteCount=song.parts.reduce((sum,part)=>sum+part.notes.length,0);
  if(!noteCount)fail('This MIDI file has no notes to import.');
  if(noteCount>MIDI_NOTE_LIMIT)fail(`This MIDI file has ${noteCount.toLocaleString('en-US')} notes. Import is limited to ${MIDI_NOTE_LIMIT.toLocaleString('en-US')} notes.`);
  // Format 1 keeps the title in its first, conductor track; format 0 in its only track.
  song.title=names[0]||'';
  return song;
}
