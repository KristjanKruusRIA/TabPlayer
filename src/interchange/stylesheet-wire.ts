const maxBytes=1_048_576,maxRecords=8_192;
const fields=[11n,5n,1n],tags=[0x5a,0x2a,0x08];
type Target={start:number;tagEnd:number;end:number;child?:Message;value?:boolean};
type Message={start:number;end:number;target?:Target};
const empty:Message={start:0,end:0};

function unsupported(reason:string):never{throw new Error(`Unsupported GP common/cut stylesheet: ${reason}`);}

function parse(bytes:Uint8Array){
  if(bytes.length>maxBytes)unsupported('input exceeds byte limit');
  let records=0;
  function message(start:number,end:number,level:number):Message{
    const result:Message={start,end};let position=start;
    function varint():bigint{
      let value=0n;
      for(let index=0;index<10;index++){
        if(position>=end)unsupported('truncated varint');
        const byte=bytes[position++];
        if(index===9&&byte>1)unsupported('uint64 varint overflow');
        value|=BigInt(byte&127)<<BigInt(index*7);
        if(!(byte&128))return value;
      }
      return unsupported('varint exceeds ten bytes');
    }
    while(position<end){
      if(++records>maxRecords)unsupported('input exceeds record limit');
      const recordStart=position,tag=varint(),tagEnd=position,field=tag>>3n,wire=Number(tag&7n);
      if(field<1n||field>536_870_911n)unsupported('field number outside supported range');
      const target=field===fields[level];
      if(target&&(result.target||wire!==(level===2?0:2)))unsupported('duplicate target or wrong target wire');
      let child:Message|undefined,value:boolean|undefined;
      if(wire===0){
        const scalar=varint();
        if(target){if(scalar>1n)unsupported('target bool outside 0/1');value=scalar===1n;}
      }else if(wire===2){
        const size=varint();
        if(size>BigInt(end-position))unsupported('length exceeds remaining bytes');
        // Conversion is safe only after bounding this uint64 by the remaining input.
        const payloadEnd=position+Number(size);
        if(target)child=message(position,payloadEnd,level+1);
        position=payloadEnd;
      }else if(wire===1||wire===5){
        const size=wire===1?8:4;
        if(size>end-position)unsupported('truncated fixed-width value');
        position+=size;
      }else unsupported('unsupported wire type');
      if(target)result.target={start:recordStart,tagEnd,end:position,child,value};
    }
    return result;
  }
  return {root:message(0,bytes.length,0),records};
}

function symbol(root:Message):boolean|null{
  const wrapper=root.target?.child?.target;
  return wrapper?wrapper.child!.target?.value??false:null;
}

function varintLength(value:number){let count=1;while(value>=128){value=Math.floor(value/128);count++;}return count;}

function changedLength(message:Message,level:number):number{
  const target=message.target,tagLength=target?target.tagEnd-target.start:1;
  const childLength=level===2?0:changedLength(target?.child??empty,level+1);
  const replacement=tagLength+(level===2?1:varintLength(childLength)+childLength);
  return message.end-message.start-(target?target.end-target.start:0)+replacement;
}

export function readGpStylesheetSymbol(bytes:Uint8Array):boolean|null{return symbol(parse(bytes).root);}

export function writeGpStylesheetSymbol(bytes:Uint8Array,enabled:boolean):Uint8Array{
  const {root,records}=parse(bytes);
  if(symbol(root)===enabled)return new Uint8Array(bytes);
  let present=0,current:Message|undefined=root;
  while(current?.target){present++;current=current.target.child;}
  if(records+3-present>maxRecords)unsupported('output exceeds record limit');
  const outputLength=changedLength(root,0);
  if(outputLength>maxBytes)unsupported('output exceeds byte limit');
  const output=new Uint8Array(outputLength);let position=0;
  function copy(start:number,end:number){output.set(bytes.subarray(start,end),position);position+=end-start;}
  function writeVarint(value:number){
    do{const byte=value%128;value=Math.floor(value/128);output[position++]=byte+(value?128:0);}while(value);
  }
  function write(message:Message,level:number){
    const target=message.target;
    copy(message.start,target?.start??message.end);
    if(target)copy(target.start,target.tagEnd);else output[position++]=tags[level];
    if(level===2)output[position++]=enabled?1:0;
    else{
      const child=target?.child??empty;writeVarint(changedLength(child,level+1));write(child,level+1);
    }
    if(target)copy(target.end,message.end);
  }
  write(root,0);return output;
}
