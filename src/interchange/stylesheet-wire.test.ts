import { describe,expect,it } from 'vitest';
import { readGpStylesheetSymbol,writeGpStylesheetSymbol } from './stylesheet-wire';

const hex=(value:string)=>Uint8Array.from(value.replace(/\s/g,'').match(/../g)?.map(byte=>parseInt(byte,16))??[]);
function join(...parts:Uint8Array[]){
  const result=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
function length(value:number){
  const result:number[]=[];do{const byte=value%128;value=Math.floor(value/128);result.push(byte+(value?128:0));}while(value);return Uint8Array.from(result);
}
const message=(tag:number,body:Uint8Array)=>join(Uint8Array.of(tag),length(body.length),body);
const records=(count:number)=>hex('1000'.repeat(count));
const equalBytes=(actual:Uint8Array,expected:Uint8Array)=>expect(Buffer.compare(Buffer.from(actual),Buffer.from(expected))).toBe(0);
const prefix=/^Unsupported GP common\/cut stylesheet:/;
function reject(bytes:Uint8Array){
  const before=bytes.slice();
  expect(()=>readGpStylesheetSymbol(bytes)).toThrow(prefix);
  for(const value of [false,true])expect(()=>writeGpStylesheetSymbol(bytes,value)).toThrow(prefix);
  equalBytes(bytes,before);
}

describe('bounded current GP stylesheet wire adapter',()=>{
  it('reads_literal_optional_bool_presence',()=>{
    for(const [literal,value]of [['',null],['5a00',null],['5a022a00',false],['5a042a020800',false],['5a042a020801',true]]as const){
      const bytes=hex(literal),before=bytes.slice();expect(readGpStylesheetSymbol(bytes)).toBe(value);equalBytes(bytes,before);
    }
    // The wire layer has no meter or public-model input: eligibility belongs to its caller.
    expect(readGpStylesheetSymbol(hex('1203ffffff'))).toBeNull();
  });

  it('creates_only_the_missing_target_path',()=>{
    for(const [source,enabled,expected]of [
      ['',true,'5a042a020801'],['',false,'5a042a020800'],
      ['10005a001001',true,'10005a042a0208011001'],
      ['10005a0210001001',false,'10005a0610002a0208001001'],
      ['10005a062a02100010011002',true,'10005a082a041000080110011002'],
      ['5a022a00',false,'5a022a00'],['5a042a020800',true,'5a042a020801'],
      ['5a042a020801',false,'5a042a020800'],
    ]as const){
      const input=hex(source),before=input.slice(),out=writeGpStylesheetSymbol(input,enabled);
      equalBytes(out,hex(expected));equalBytes(input,before);expect(out).not.toBe(input);expect(out.buffer).not.toBe(input.buffer);
      const twice=writeGpStylesheetSymbol(out,enabled);equalBytes(twice,out);expect(twice.buffer).not.toBe(out.buffer);
    }
  });

  it('detaches_unchanged_output_from_uint8array_subclasses_and_offset_views',()=>{
    for(const input of [Buffer.from(hex('5a042a020801')),hex('ff5a042a020801ff').subarray(1,7)]){
      const before=Uint8Array.from(input),output=writeGpStylesheetSymbol(input,true);
      equalBytes(output,before);expect(output.buffer).not.toBe(input.buffer);
      output[0]=0;equalBytes(input,before);
    }
  });

  it('preserves_opaque_records_at_every_target_level',()=>{
    // Every level has wire 0 (including nonminimal encoding), 1, 2 and 5, with duplicate unrelated fields.
    const before=hex('1081001900010203040506072203ff008035010203041000');
    const after=hex('10021908070605040302012202008035050403021003');
    const input=join(before,message(0x5a,join(before,message(0x2a,join(before,hex('0800'),after)),after)),after);
    const expected=join(before,message(0x5a,join(before,message(0x2a,join(before,hex('0801'),after)),after)),after);
    const original=input.slice();expect(readGpStylesheetSymbol(input)).toBe(false);
    equalBytes(writeGpStylesheetSymbol(input,true),expected);equalBytes(input,original);
    // Target tags may also use a bounded nonminimal encoding; only changed values/lengths are replaced.
    equalBytes(writeGpStylesheetSymbol(hex('da008700aa008300880000'),true),hex('da0006aa0003880001'));
    equalBytes(writeGpStylesheetSymbol(hex('5a052a03088100'),true),hex('5a052a03088100'));
  });

  it('updates_containing_lengths_across_127_128_without_changing_opaque_records',()=>{
    const opaque=join(hex('127d'),new Uint8Array(125)); // One literal 127-byte record.
    const input=join(hex('5a7f2a7d'),hex('127b'),new Uint8Array(123));
    const expected=join(hex('5a81012a7f127b'),new Uint8Array(123),hex('0801'));
    equalBytes(writeGpStylesheetSymbol(input,true),expected);
    const parent=join(hex('5a7f'),opaque);
    equalBytes(writeGpStylesheetSymbol(parent,true),join(hex('5a8301'),opaque,hex('2a020801')));
  });

  const invalid:[string,string][]=[
    ['wrong root target wire','5800'],['wrong bar target wire','5a022800'],['wrong wrapper target wire','5a042a020a00'],
    ['duplicate root target','5a005a00'],['duplicate bar target','5a042a002a00'],['duplicate scalar target','5a062a0408000801'],
    ['bool 2','5a042a020802'],['field zero','0000'],['field 536870912','808080801000'],
    ['truncated tag','80'],['overflow tag','ffffffffffffffffff02'],['eleven-byte tag','8080808080808080808000'],
    ['truncated value','1080'],['overflow value','10ffffffffffffffffff02'],['eleven-byte value','108080808080808080808000'],
    ['truncated length','1280'],['overflow length','12ffffffffffffffffff02'],['eleven-byte length','128080808080808080808000'],
    ['length exceeds remainder','120200'],['uint64 length exceeds remainder','12ffffffffffffffffff01'],
    ['truncated fixed32','15000000'],['truncated fixed64','1900000000000000'],
    ['wire 3','13'],['wire 4','14'],['wire 6','16'],['wire 7','17'],
    ['nested field zero','5a020000'],['nested unsupported wire','5a032a0013'],
    ['wrapper truncated value','5a032a0108'],
  ];
  it.each(invalid)('rejects_outside_bounded_wire_contract: %s',(_name,literal)=>reject(hex(literal)));

  it('reads_maximum_field_and_uint64_values_without_number_precision_loss',()=>{
    const bytes=hex('f8ffffff0fffffffffffffffffff01108100');
    expect(readGpStylesheetSymbol(bytes)).toBeNull();
    equalBytes(writeGpStylesheetSymbol(bytes,false),join(bytes,hex('5a042a020800')));
  });

  it('bounds_aggregate_records_across_all_three_visited_messages',()=>{
    const valid=join(records(2730),message(0x5a,join(records(2730),message(0x2a,records(2730)))));
    expect(readGpStylesheetSymbol(valid)).toBe(false);equalBytes(writeGpStylesheetSymbol(valid,false),valid);
    reject(join(records(2730),message(0x5a,join(records(2730),message(0x2a,records(2731))))));
    // Opaque length-delimited bytes are not recursively counted or validated.
    expect(readGpStylesheetSymbol(message(0x12,records(8193)))).toBeNull();
  });

  it.each([
    ['root',(count:number)=>records(count),8189,8190],
    ['bar',(count:number)=>join(records(count),hex('5a00')),8189,8190],
    ['wrapper',(count:number)=>join(records(count),hex('5a022a00')),8189,8190],
  ]as const)('preflights_missing_%s_records_before_publication',(_name,source,accepted,rejected)=>{
    const input=source(accepted),before=input.slice(),output=writeGpStylesheetSymbol(input,true);
    equalBytes(output,join(records(accepted),hex('5a042a020801')));equalBytes(input,before);
    const full=source(rejected),original=full.slice();expect(()=>writeGpStylesheetSymbol(full,true)).toThrow(prefix);equalBytes(full,original);
    expect(readGpStylesheetSymbol(full)).toBe(_name==='wrapper'?false:null);
  });

  it('enforces_input_and_proposed_output_byte_budgets_inclusively',()=>{
    const max=1_048_576;
    const opaque=(total:number)=>join(hex('12'),length(total-4),new Uint8Array(total-4));
    const exact=join(opaque(max-6),hex('5a042a020801')),before=exact.slice();
    expect(exact.length).toBe(max);expect(readGpStylesheetSymbol(exact)).toBe(true);
    equalBytes(writeGpStylesheetSymbol(exact,true),exact);
    equalBytes(writeGpStylesheetSymbol(exact,false),join(opaque(max-6),hex('5a042a020800')));equalBytes(exact,before);
    const insert=opaque(max-6);expect(writeGpStylesheetSymbol(insert,true).length).toBe(max);
    for(const size of [max-5,max]){
      const tooFull=opaque(size);expect(readGpStylesheetSymbol(tooFull)).toBeNull();
      const original=tooFull.slice();expect(()=>writeGpStylesheetSymbol(tooFull,true)).toThrow(prefix);equalBytes(tooFull,original);
    }
    reject(opaque(max+1));
  });
});
