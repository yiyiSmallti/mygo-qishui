import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
const source=fs.readFileSync(new URL('../qishui-account/index.js',import.meta.url),'utf8');
const KEY='qishui-playback-errors-v1';
const plain=x=>JSON.parse(JSON.stringify(x));
function setup({saved=new Map(),reply,writeFails=false}={}){
  saved.set('qishui-session-v1',{account:{id:'private-account'},device:{did:'private-device'},
    jar:{'sessionid|/':{name:'sessionid',value:'private-cookie',path:'/',expires:0}}});
  const context=vm.createContext({URL,AbortController,TypeError,setTimeout,clearTimeout,host:{
    platform:'windows',arch:'amd64',dataDir:'C:\\Music\\MyGo Music\\plugin-data\\qishui-account',setting:()=>'',
    storage:{get:k=>saved.get(k),set:(k,v)=>{if(writeFails)throw new Error('disk full');saved.set(k,plain(v));},remove:k=>saved.delete(k)},
    spawn(){return{write(){},closeStdin(){},readLine:async()=>JSON.stringify(reply??{ok:false,code:'unavailable',
      message:'读取音频失败（ECONNRESET），请稍后重试。',diagnostic:{stage:'download',networkCode:'ECONNRESET',httpStatus:403}})};},
  }});
  vm.runInContext(source.replace(/^export\s+/gm,'')+'\nthis.api={stream,playbackError,browse};',context);
  return {api:context.api,saved,entries:()=>saved.get(KEY)||[]};
}
test('audio failures persist a bounded safe diagnostic with no credentials or raw responses',async()=>{
  const h=setup({reply:{ok:false,code:'unavailable',message:'音频文件不完整 https://private.invalid/?token=secret cookie=private-cookie',
    diagnostic:{stage:'decrypt',networkCode:'PRIVATE_TOKEN',httpStatus:200,serviceStatus:1000016,parserLine:134,headers:{Cookie:'private-cookie'},key:'secret-key'}}});
  await assert.rejects(h.api.stream({id:'123',quality:'high'}),e=>e.code==='unavailable');
  const log=plain(h.entries());assert.equal(log.length,1);
  assert.equal(log[0].id,'123');assert.equal(log[0].quality,'high');assert.equal(log[0].stage,'decrypt');
  assert.equal(log[0].httpStatus,200);assert.equal(log[0].parserLine,134);assert.ok(!log[0].skipped);
  assert.equal(log[0].serviceStatus,1000016);
  assert.match(log[0].reason,/结构或缓存校验/);assert.ok(Number.isFinite(Date.parse(log[0].time)));
  for(const secret of ['private-cookie','private-account','private-device','private.invalid','PRIVATE_TOKEN','secret-key'])assert.ok(!JSON.stringify(log).includes(secret));
});
test('player confirmation enriches the request record and captures decoder-only failures',async()=>{
  const h=setup();await assert.rejects(h.api.stream({id:'123'}));
  h.api.playbackError({id:'123',name:'歌曲 A',artists:'歌手 A',quality:'standard',code:'unavailable',rawError:'secret'});
  assert.equal(h.entries().length,1);assert.equal(h.entries()[0].name,'歌曲 A');assert.equal(h.entries()[0].skipped,true);
  assert.equal(h.entries()[0].networkCode,'ECONNRESET');
  h.api.playbackError({id:'456',name:'歌曲 B',quality:'lossless',code:'unknown',url:'https://secret.invalid'});
  assert.equal(h.entries()[1].stage,'player');assert.match(h.entries()[1].reason,/加载或解码/);
  assert.ok(!JSON.stringify(h.entries()).includes('secret'));
});
test('only the newest 50 records survive a plugin reload and clearing preserves login',async()=>{
  const h=setup();
  for(let i=0;i<65;i++)h.api.playbackError({id:String(i+1),name:'歌 '+i,quality:'high'});
  assert.equal(h.entries().length,50);assert.equal(h.entries()[0].id,'16');
  const next=setup({saved:h.saved});
  const page=plain(await next.api.browse({page:'playback-diagnostics'}));assert.match(page.description,/歌 64/);
  assert.match(page.description,/最近 50/);
  await next.api.browse({page:'playback-diagnostics/clear'});assert.equal(next.entries().length,0);
  assert.ok(next.saved.has('qishui-session-v1'));
});
test('diagnostic persistence errors never mask the original playback error',async()=>{
  const h=setup({writeFails:true});
  await assert.rejects(h.api.stream({id:'123'}),e=>e.code==='unavailable'&&e.message.includes('读取音频失败'));
  assert.doesNotThrow(()=>h.api.playbackError({id:'123'}));
});
test('public metadata is sanitized and unknown diagnostic fields never persist',()=>{
  const h=setup();h.api.playbackError({id:'token=secret',name:'title\nhttps://secret.invalid/?key=abc',artists:'cookie=secret',
    quality:'private-key',code:'private-token',rawError:'secret'});
  const log=JSON.stringify(h.entries());assert.ok(!log.includes('secret'));assert.ok(!log.includes('private-'));
  assert.equal(h.entries()[0].id,'');assert.equal(h.entries()[0].quality,'unknown');
});
test('successful validated playback creates no failure record',async()=>{
  const h=setup({reply:{ok:true,value:{url:'file:///C:/Music/MyGo%20Music/plugin-data/qishui-account/media-cache/'+ 'a'.repeat(64)+'.m4a',type:'m4a'}}});
  await h.api.stream({id:'123'});assert.equal(h.entries().length,0);
});

test('metadata failures retain only a known network code, never the private cause',async()=>{
  const require=createRequire(import.meta.url);
  const requestSource=fs.readFileSync(new URL('../qishui-account/media-request.cjs',import.meta.url),'utf8');
  for(const code of ['ECONNRESET','PRIVATE_TOKEN']){
    const context=vm.createContext({Buffer,URL,AbortController,setTimeout,clearTimeout,Intl,module:{exports:{}},
      require:name=>require(name==='./local-env.cjs'?'../qishui-account/local-env.cjs':name),
      fetch:async()=>{throw Object.assign(new Error('https://private.invalid/?token=secret'),{cause:{code}});},
    });
    vm.runInContext(requestSource+`\ngetSigner=()=>({version:'3.7.0',signer:{generateHttpSignatureHeaders:()=> 'x-test\\r\\ntest\\r\\n'}});this.request=requestMetadata;`,context);
    await assert.rejects(context.request({route:'/luna/pc/track_v2',label:'音乐',
      device:{aid:386088,did:'123',iid:'456',identityType:'fresh-plugin-pseudonymous',channel:'mygo'},
      jar:{'sessionid|/':{name:'sessionid',value:'private-cookie',path:'/',expires:0}},
      soda:{asar:path.resolve('fake.asar'),unpacked:path.resolve('.')},
    }),e=>e.code==='network'&&e.networkCode===(code==='ECONNRESET'?code:undefined)
      &&!e.message.includes('secret')&&!e.cause);
  }
});
