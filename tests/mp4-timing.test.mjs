import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {inspectFile}=createRequire(import.meta.url)('../qishui-account/mp4-cenc.cjs');
const u32=(...values)=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;};
const box=(type,...parts)=>{const data=Buffer.concat(parts);return Buffer.concat([u32(data.length+8),Buffer.from(type),data]);};
function fixture({padding=2048,count=130,tableCount=count,delta=1024}={}) {
  const timescale=44100,ticks=count*delta,duration=ticks-padding;
  const ftyp=box('ftyp',Buffer.from('M4A '),u32(0));
  const mdat=box('mdat',Buffer.alloc(count*4));
  const mdhd=box('mdhd',u32(0,0,0,timescale,duration,0));
  const hdlr=box('hdlr',u32(0,0),Buffer.from('soun'));
  const entry=box('mp4a',Buffer.alloc(28),box('esds',u32(0),Buffer.from([5,2,0x12,0x10])));
  const stbl=box('stbl',box('stsd',u32(0,1),entry),box('stsz',u32(0,4,count)),
    box('stsc',u32(0,1,1,count,1)),box('stco',u32(0,1,ftyp.length+8)),
    box('stts',u32(0,1,tableCount,delta)));
  return {bytes:Buffer.concat([ftyp,mdat,box('moov',box('trak',box('mdia',mdhd,hdlr,box('minf',stbl))))]),
    expectedMs:duration*1000/timescale,ticksMs:ticks*1000/timescale};
}
async function inspect(options={},expectedOffset=0) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qishui-timing-'));
  try {
    const value=fixture(options),file=path.join(dir,'sample.m4a');fs.writeFileSync(file,value.bytes);
    const result=await inspectFile(file,{expectedCodec:'aac',expectedMs:value.expectedMs+expectedOffset});
    assert.deepEqual(fs.readFileSync(file),value.bytes,'inspection must not alter audio');
    return {result,value};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('AAC accepts two frames of encoder padding without changing sample duration',async()=>{
  for(const padding of [0,1,1024,2048]){
    const {result,value}=await inspect({padding});
    assert.equal(result.durationMs,value.ticksMs);
    assert.equal(result.samples,130);
  }
});
test('AAC still rejects mismatched sample counts and excessive or reversed padding',async()=>{
  for(const options of [{tableCount:129},{padding:2049},{padding:-2},
    {delta:10000,padding:5000}]) await assert.rejects(inspect(options),e=>e.code==='unavailable');
});
test('AAC padding does not permit a truncated song to match its authorized duration',async()=>{
  await assert.rejects(inspect({padding:2048},3000),e=>e.code==='unavailable');
});
