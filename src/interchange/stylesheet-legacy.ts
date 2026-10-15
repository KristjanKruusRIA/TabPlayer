const maxBytes=1048576,maxRecords=8192;
const targetKey=Uint8Array.from('Staff/drawTimeSignatureC',character=>character.charCodeAt(0));
const payloadSizes=[1,4,4,0,8,8,16,4];

function unsupported(reason:string):never{
  throw new Error(`Unsupported GP common/cut stylesheet: ${reason}`);
}

function scan(bytes:Uint8Array):{count:number;valueOffset:number}{
  if(bytes.length>maxBytes)unsupported('legacy byte limit exceeded');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=0,valueOffset=-1;
  const requireBytes=(length:number)=>{
    if(length>bytes.length-offset)unsupported('truncated legacy record');
  };
  requireBytes(4);const count=view.getInt32(offset);offset+=4;
  if(count<0||count>maxRecords)unsupported('legacy record count out of bounds');
  for(let record=0;record<count;record++){
    requireBytes(1);const keyLength=bytes[offset++];requireBytes(keyLength);
    const isTarget=keyLength===targetKey.length&&targetKey.every((byte,index)=>bytes[offset+index]===byte);
    offset+=keyLength;requireBytes(1);const type=bytes[offset++];
    if(type>7)unsupported('unknown legacy record type');
    let length=payloadSizes[type];
    if(type===3){
      requireBytes(2);length=view.getInt16(offset);offset+=2;
      if(length<0)unsupported('negative legacy string length');
    }
    requireBytes(length);
    if(isTarget){
      if(valueOffset!==-1)unsupported('duplicate legacy common/cut key');
      if(type!==0)unsupported('legacy common/cut value is not boolean');
      if(bytes[offset]>1)unsupported('invalid legacy common/cut boolean');
      valueOffset=offset;
    }
    offset+=length;
  }
  if(offset!==bytes.length)unsupported('trailing legacy bytes');
  return {count,valueOffset};
}

export function readLegacyStylesheetSymbol(bytes:Uint8Array):boolean|null{
  const {valueOffset}=scan(bytes);
  return valueOffset===-1?null:bytes[valueOffset]===1;
}

export function writeLegacyStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array{
  const {count,valueOffset}=scan(bytes);
  if(valueOffset!==-1){
    const output=new Uint8Array(bytes);output[valueOffset]=enabled?1:0;return output;
  }
  const length=bytes.length+targetKey.length+3;
  if(count===maxRecords)unsupported('legacy output record limit exceeded');
  if(length>maxBytes)unsupported('legacy output byte limit exceeded');
  const output=new Uint8Array(length);output.set(bytes);
  new DataView(output.buffer).setInt32(0,count+1);
  let offset=bytes.length;output[offset++]=targetKey.length;output.set(targetKey,offset);offset+=targetKey.length;
  output[offset++]=0;output[offset]=enabled?1:0;
  return output;
}
