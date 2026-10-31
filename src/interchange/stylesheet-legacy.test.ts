import { describe,expect,it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readLegacyStylesheetSymbol,writeLegacyStylesheetSymbol } from './stylesheet-legacy';

const hex=(value:string)=>Uint8Array.from(value.replace(/\s/g,'').match(/../g)?.map(byte=>parseInt(byte,16))??[]);
const target=hex('18 53746166662f6472617754696d655369676e617475726543 00 01');
const prefix='Unsupported GP common/cut stylesheet:';
const equalBytes=(actual:Uint8Array,expected:Uint8Array)=>expect(Buffer.compare(actual,expected)).toBe(0);

function document(records:Uint8Array[]):Uint8Array{
  const bytes=new Uint8Array(4+records.reduce((sum,record)=>sum+record.length,0));
  new DataView(bytes.buffer).setInt32(0,records.length);let offset=4;
  for(const record of records){bytes.set(record,offset);offset+=record.length;}
  return bytes;
}

// Author large fixtures with opaque empty-key booleans and signed-int16 strings.
function sizedDocument(length:number,count:number,withTarget=false):Uint8Array{
  const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);view.setInt32(0,count);
  let offset=4,remaining=count;
  if(withTarget){bytes.set(target,offset);offset+=target.length;remaining--;}
  let extra=length-offset-remaining*3;
  if(extra<0)throw new Error('Fixture too small');
  while(remaining--){
    if(extra>0){
      const size=Math.min(32767,extra-1);bytes[offset+1]=3;view.setInt16(offset+2,size);
      bytes.fill(0xa5,offset+4,offset+4+size);offset+=4+size;extra-=1+size;
    }else{bytes[offset+1]=0;bytes[offset+2]=0x7f;offset+=3;}
  }
  if(offset!==length||extra!==0)throw new Error('Fixture size mismatch');
  return bytes;
}

function rejects(bytes:Uint8Array):void{
  const before=bytes.slice();
  expect(()=>readLegacyStylesheetSymbol(bytes)).toThrow(prefix);
  expect(()=>writeLegacyStylesheetSymbol(bytes,true)).toThrow(prefix);
  expect(()=>writeLegacyStylesheetSymbol(bytes,false)).toThrow(prefix);
  equalBytes(bytes,before);
}

describe('legacy common/cut stylesheet',()=>{
  it('reads_and_patches_literal_legacy_boolean',()=>{
    const empty=hex('00000000');
    const yes=hex('00000001 18 53746166662f6472617754696d655369676e617475726543 00 01');
    const no=hex('00000001 18 53746166662f6472617754696d655369676e617475726543 00 00');
    expect(readLegacyStylesheetSymbol(empty)).toBeNull();
    expect(readLegacyStylesheetSymbol(yes)).toBe(true);
    expect(readLegacyStylesheetSymbol(no)).toBe(false);
    expect(writeLegacyStylesheetSymbol(empty,true)).toEqual(yes);
    expect(writeLegacyStylesheetSymbol(yes,false)).toEqual(no);
    expect(writeLegacyStylesheetSymbol(no,true)).toEqual(yes);
    expect(writeLegacyStylesheetSymbol(writeLegacyStylesheetSymbol(empty,true),true)).toEqual(yes);
    const equal=writeLegacyStylesheetSymbol(yes,true);
    expect(equal).not.toBe(yes);expect(equal.buffer).not.toBe(yes.buffer);expect(equal).toEqual(yes);
    const unrelated=hex('00000002 0141007f 01420112345678');
    expect(writeLegacyStylesheetSymbol(unrelated,false)).toEqual(hex('00000003 0141007f 01420112345678 18 53746166662f6472617754696d655369676e617475726543 00 00'));
    expect(empty).toEqual(hex('00000000'));expect(yes).toEqual(hex('00000001 18 53746166662f6472617754696d655369676e617475726543 00 01'));
    expect(no).toEqual(hex('00000001 18 53746166662f6472617754696d655369676e617475726543 00 00'));
    expect(unrelated).toEqual(hex('00000002 0141007f 01420112345678'));
  });

  it('preserves_every_unrelated_legacy_type',()=>{
    const before=hex(`0000000b
      0141 00 7f
      0142 01 89abcdef
      0143 02 7fc01234
      0144 03 0003 ff0080
      0145 04 0001020304050607
      0146 05 8899aabbccddeeff
      0147 06 000102030405060708090a0b0c0d0e0f
      0148 07 80818283
      0144 03 0000
      02c3a9 00 02
      0141 01 ffffffff`);
    const source=before.slice();
    expect(readLegacyStylesheetSymbol(source)).toBeNull();
    const appended=writeLegacyStylesheetSymbol(source,true);
    expect(appended.subarray(0,4)).toEqual(hex('0000000c'));
    expect(appended.subarray(4,before.length)).toEqual(before.subarray(4));
    expect(appended.subarray(before.length)).toEqual(target);
    // Put the target between opaque spans, then require only its value to move.
    const middle=before.length-7;
    const mixed=new Uint8Array(before.length+target.length);mixed.set(hex('0000000c'));
    mixed.set(before.subarray(4,middle),4);mixed.set(target,middle);mixed.set(before.subarray(middle),middle+target.length);
    const expected=mixed.slice();expected[middle+target.length-1]=0;
    expect(writeLegacyStylesheetSymbol(mixed,false)).toEqual(expected);
    expect(readLegacyStylesheetSymbol(mixed)).toBe(true);
    expect(source).toEqual(before);
    expect(mixed[middle+target.length-1]).toBe(1);
  });

  const malformed:[string,Uint8Array][]=[
    ['negative count',hex('ffffffff')],
    ['count 8193',hex('00002001')],
    ['missing header',hex('')],['short header',hex('000000')],
    ['missing key length',hex('00000001')],['truncated key',hex('00000001 02 41')],
    ['missing type',hex('00000001 01 41')],['unknown type 8',hex('00000001 00 08')],
    ['negative string length',hex('00000001 00 03 ffff')],
    ['string beyond buffer',hex('00000001 00 03 0002 ff')],
    ['trailing bytes',hex('00000000 00')],
    ['duplicate target',document([target,target])],
    ['target nonbool',document([hex('18 53746166662f6472617754696d655369676e617475726543 01 00000001')])],
    ['target bool 2',document([hex('18 53746166662f6472617754696d655369676e617475726543 00 02')])],
    ['oversized input',sizedDocument(1048577,8192,true)],
  ];
  for(const [type,payload]of [
    [0,''],[1,'000000'],[2,'000000'],[3,'00'],[4,'00010203040506'],
    [5,'00010203040506'],[6,'000102030405060708090a0b0c0d0e'],[7,'000102'],
  ] as const)malformed.push([`truncated type ${type}`,document([hex(`00 0${type} ${payload}`)])]);

  it.each(malformed)('rejects_unsupported_legacy_framing: %s',(_name,bytes)=>rejects(bytes));

  it('rejects_every_truncated_prefix_of_each_known_record_type',()=>{
    for(const record of [
      '0141 00 01','0141 01 01020304','0141 02 01020304','0141 03 0002 0102',
      '0141 04 0102030405060708','0141 05 0102030405060708',
      '0141 06 0102030405060708090a0b0c0d0e0f10','0141 07 01020304',
    ]){
      const complete=document([hex(record)]);
      expect(readLegacyStylesheetSymbol(complete)).toBeNull();
      for(let length=0;length<complete.length;length++)rejects(complete.subarray(0,length));
    }
  });

  it('matches_only_the_exact_target_key_bytes',()=>{
    const bytes=hex(`00000002
      18 73746166662f6472617754696d655369676e617475726543 00 02
      18 53746166662f6472617754696d655369676e617475726563 00 ff`),before=bytes.slice();
    expect(readLegacyStylesheetSymbol(bytes)).toBeNull();
    const output=writeLegacyStylesheetSymbol(bytes,true);
    expect(output.subarray(0,4)).toEqual(hex('00000003'));
    expect(output.subarray(4,bytes.length)).toEqual(before.subarray(4));
    expect(output.subarray(bytes.length)).toEqual(target);expect(bytes).toEqual(before);
  });

  it('enforces_input_and_output_record_budgets',()=>{
    const full=sizedDocument(4+8192*3,8192),before=full.slice();
    expect(readLegacyStylesheetSymbol(full)).toBeNull();
    expect(()=>writeLegacyStylesheetSymbol(full,true)).toThrow(prefix);
    expect(full).toEqual(before);
    const room=sizedDocument(4+8191*3,8191),appended=writeLegacyStylesheetSymbol(room,false);
    expect(appended.subarray(0,4)).toEqual(hex('00002000'));
    expect(appended.subarray(4,room.length)).toEqual(room.subarray(4));
    expect(appended.subarray(room.length)).toEqual(hex('18 53746166662f6472617754696d655369676e617475726543 00 00'));
    const existing=sizedDocument(4+target.length+8191*3,8192,true),changed=existing.slice();changed[4+target.length-1]=0;
    expect(writeLegacyStylesheetSymbol(existing,false)).toEqual(changed);
    const equal=writeLegacyStylesheetSymbol(existing,true);expect(equal).toEqual(existing);expect(equal.buffer).not.toBe(existing.buffer);
  });

  it('enforces_input_and_output_byte_budgets',()=>{
    const exact=sizedDocument(1048576,8192,true),before=exact.slice(),changed=exact.slice();changed[4+target.length-1]=0;
    expect(readLegacyStylesheetSymbol(exact)).toBe(true);
    equalBytes(writeLegacyStylesheetSymbol(exact,false),changed);
    const equal=writeLegacyStylesheetSymbol(exact,true);equalBytes(equal,exact);expect(equal.buffer).not.toBe(exact.buffer);
    equalBytes(exact,before);
    const room=sizedDocument(1048576-27,64),appended=writeLegacyStylesheetSymbol(room,true);
    expect(appended.length).toBe(1048576);expect(appended.subarray(0,4)).toEqual(hex('00000041'));
    equalBytes(appended.subarray(4,room.length),room.subarray(4));expect(appended.subarray(room.length)).toEqual(target);
    for(const length of [1048576-26,1048576]){
      const bytes=sizedDocument(length,64),original=bytes.slice();
      expect(readLegacyStylesheetSymbol(bytes)).toBeNull();
      expect(()=>writeLegacyStylesheetSymbol(bytes,true)).toThrow(prefix);equalBytes(bytes,original);
    }
  });

  it('uses_only_the_supplied_uint8array_span',()=>{
    const backing=hex('ff 00000001 18 53746166662f6472617754696d655369676e617475726543 00 01 ff');
    const bytes=backing.subarray(1,backing.length-1),before=backing.slice();
    expect(readLegacyStylesheetSymbol(bytes)).toBe(true);
    expect(writeLegacyStylesheetSymbol(bytes,false)).toEqual(hex('00000001 18 53746166662f6472617754696d655369676e617475726543 00 00'));
    expect(backing).toEqual(before);
    const buffer=Buffer.from(bytes),original=Buffer.from(buffer),output=writeLegacyStylesheetSymbol(buffer,true);
    output[0]=0xff;expect(buffer).toEqual(original);
  });
});
