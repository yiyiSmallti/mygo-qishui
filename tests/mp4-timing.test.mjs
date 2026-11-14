import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createCipheriv} from 'node:crypto';
const {inspectFile,decryptFile}=createRequire(import.meta.url)('../qishui-account/mp4-cenc.cjs');
const u32=(...values)=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;};
const box=(type,...parts)=>{const data=Buffer.concat(parts);return Buffer.concat([u32(data.length+8),Buffer.from(type),data]);};
function fixture({padding=2048,count=130,tableCount=count,delta=1024,extras=[],textFirst=false,encrypted=false}={}) {
  const timescale=44100,ticks=count*delta,duration=ticks-padding;
  const ftyp=box('ftyp',Buffer.from('M4A '),u32(0));
  const ivs=Array.from({length:count},(_,i)=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(i+1));return b;});
  const packets=ivs.map(iv=>{if(!encrypted)return Buffer.alloc(4);const cipher=createCipheriv('aes-128-ctr',Buffer.alloc(16),Buffer.concat([iv,Buffer.alloc(8)]));return Buffer.concat([cipher.update(Buffer.alloc(4)),cipher.final()]);});
  const mdat=box('mdat',...packets);
  const mdhd=box('mdhd',u32(0,0,0,timescale,duration,0));
  const hdlr=box('hdlr',u32(0,0),Buffer.from('soun'));
  const tenc=Buffer.alloc(24);tenc[6]=1;tenc[7]=8;
  const protection=encrypted?[box('sinf',box('frma',Buffer.from('mp4a')),box('schm',u32(0),Buffer.from('cenc'),u32(65536)),box('schi',box('tenc',tenc)))]:[];
  const entry=box(encrypted?'enca':'mp4a',Buffer.alloc(28),box('esds',u32(0),Buffer.from([5,2,0x12,0x10])),...protection);
  const stbl=box('stbl',box('stsd',u32(0,1),entry),box('stsz',u32(0,4,count)),
    box('stsc',u32(0,1,1,count,1)),box('stco',u32(0,1,ftyp.length+8)),
    box('stts',u32(0,1,tableCount,delta)),...(encrypted?[box('senc',u32(0,count),...ivs)]:[]));
  const audio=box('trak',box('mdia',mdhd,hdlr,box('minf',stbl)));
  const others=extras.map(kind=>kind==='soun'?audio:box('trak',box('mdia',box('hdlr',u32(0,0),Buffer.from(kind)))));
  return {bytes:Buffer.concat([ftyp,mdat,box('moov',...(textFirst?[...others,audio]:[audio,...others]))]),
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

test('auxiliary text tracks are discarded without changing audio bytes or offsets',async()=>{
  for(const textFirst of [false,true]){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qishui-text-track-'));
    try{
      const value=fixture({extras:['text'],textFirst}),file=path.join(dir,'song.m4a');fs.writeFileSync(file,value.bytes);
      const options={expectedCodec:'aac',expectedMs:value.expectedMs,key:Buffer.alloc(0)};
      const info=await decryptFile(file,options),output=fs.readFileSync(file);
      assert.equal(info.samples,130);assert.equal(info.encrypted,false);assert.equal(output.length,value.bytes.length);
      assert.deepEqual(output.subarray(0,544),value.bytes.subarray(0,544),'ftyp and mdat including every audio byte must stay unchanged');
      assert.equal(output.toString('ascii').split('trak').length-1,1);
      await inspectFile(file,options);
      const before=Buffer.from(output);await decryptFile(file,options);assert.deepEqual(fs.readFileSync(file),before);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});
test('multiple audio tracks and video or unknown auxiliary tracks still fail before mutation',async()=>{
  for(const kind of ['soun','vide','meta']){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qishui-reject-track-'));
    try{
      const value=fixture({extras:[kind]}),file=path.join(dir,'song.m4a');fs.writeFileSync(file,value.bytes);
      await assert.rejects(decryptFile(file,{expectedCodec:'aac',expectedMs:value.expectedMs,key:Buffer.alloc(0)}),e=>e.code==='unsupported');
      assert.deepEqual(fs.readFileSync(file),value.bytes);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('encrypted audio with a text track decrypts only audio and retains sample offsets',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qishui-cenc-text-'));
  try{
    const value=fixture({extras:['text'],textFirst:true,encrypted:true}),file=path.join(dir,'song.m4a');fs.writeFileSync(file,value.bytes);
    const options={expectedCodec:'aac',expectedMs:value.expectedMs,key:Buffer.alloc(16)};
    const info=await decryptFile(file,options),output=fs.readFileSync(file);
    assert.equal(info.encrypted,false);assert.equal(info.samples,130);assert.equal(output.length,value.bytes.length);
    assert.deepEqual(output.subarray(24,544),Buffer.alloc(520),'every audio packet must decrypt at its original offset');
    assert.equal(output.toString('ascii').split('trak').length-1,1);
    assert.equal(output.toString('ascii').includes('enca'),false);
    await inspectFile(file,options);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
