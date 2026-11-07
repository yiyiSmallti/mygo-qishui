import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./music-likes.fragment.js',import.meta.url),'utf8');
const create=runInNewContext(source+'\ncreateLikesService',{Map,Set,Promise,Number,Error});
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const entry=(id,type='track',liked=true)=>({type,entity:{track_wrapper:{track:{id,media_type:type,state:{is_collected:liked}}}}});
function setup(handle){
  let key='account-a:1',changes=0;
  const calls=[],states=new Map();
  const service=create({contextKey:()=>key,onChanged:()=>changes++,pause:async()=>{},api:async(route,params,body)=>{
    calls.push({route,params:plain(params),body:plain(body)});
    const response=handle?await handle(route,body):undefined;
    if(route==='/luna/media')return response===undefined?{media:body.media.map(m=>entry(m.id,m.type,states.get(m.type+':'+m.id)||false))}:response;
    if(response===undefined||response?.status_code===0)for(const m of body.media)states.set(m.type+':'+m.id,!route.endsWith('/delete'));
    return response===undefined?{status_code:0}:response;
  }});
  return{service,calls,changes:()=>changes,setKey:value=>key=value};
}

test('isLiked reads typed media states, returns the original host IDs and performs no writes',async()=>{
  const h=setup(()=>({status_code:0,media:[entry('1','track',false),entry('2','ugc_clip',true)]}));
  const result=await h.service.isLiked({ids:['1','ugc_clip:2','1']});
  assert.deepEqual(plain(result),{'1':false,'ugc_clip:2':true});
  assert.deepEqual(h.calls,[{route:'/luna/media',params:{},body:{scene:'playlist',media:[{id:'1',type:'track'},{id:'2',type:'ugc_clip'}]}}]);
  assert.equal(h.changes(),0);
});

test('only the explicit like call sends the official add or delete body and retains ugc_clip',async()=>{
  const h=setup();
  assert.equal(h.calls.length,0);
  await h.service.like({id:'ugc_clip:2',on:true});
  await h.service.like({id:'ugc_clip:2',on:false});
  assert.deepEqual(h.calls.filter(c=>c.route!=='/luna/media'),[
    {route:'/luna/pc/me/collection/media',params:{},body:{media:[{id:'2',type:'ugc_clip'}],scene:''}},
    {route:'/luna/pc/me/collection/media/delete',params:{},body:{media:[{id:'2',type:'ugc_clip'}]}},
  ]);
  assert.equal(h.calls.filter(c=>c.route==='/luna/media').length,2);
  assert.equal(h.changes(),2);
});

test('missing boolean and unsupported or malformed IDs cannot become a write',async()=>{
  const h=setup();
  for(const args of [{id:'1'},{id:'1',on:1},{id:'ugc_video:2',on:true},{id:'https://bad.invalid',on:false},{id:1,on:true}])
    await assert.rejects(h.service.like(args));
  assert.equal(h.calls.length,0);
  assert.equal(h.changes(),0);
});

test('rejected and silence responses do not invalidate caches or claim a confirmed like',async()=>{
  for(const response of [{status_code:1000057},{status_code:0,status_info:{code:1000005}},{status_info:{status_code:1000016}},null,{}]){
    const h=setup(()=>response);
    await assert.rejects(h.service.like({id:'1',on:true}));
    assert.equal(h.changes(),0);
  }
});

test('success after an account change cannot invalidate the new account cache',async()=>{
  const gate=deferred();
  const h=setup(async()=>{await gate.promise;return{status_code:0}});
  const pending=h.service.like({id:'1',on:true});
  const rejected=assert.rejects(pending,/账号已变化/);
  await new Promise(resolve=>setImmediate(resolve));
  h.setKey('account-b:2');
  gate.resolve();
  await rejected;
  assert.equal(h.changes(),0);
});

test('rapid opposite clicks on one song preserve request order',async()=>{
  const first=deferred();
  const h=setup(async(route)=>{if(route==='/luna/media')return;if(!route.endsWith('/delete'))await first.promise;return{status_code:0}});
  const liked=h.service.like({id:'1',on:true});
  const unliked=h.service.like({id:'1',on:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,1);
  first.resolve();
  await Promise.all([liked,unliked]);
  assert.deepEqual(h.calls.filter(c=>c.route!=='/luna/media').map(c=>c.route),['/luna/pc/me/collection/media','/luna/pc/me/collection/media/delete']);
});

test('read started before an unlike retries rather than returning stale liked=true',async()=>{
  const firstRead=deferred(),readStarted=deferred();let reads=0;
  const h=setup(async(route)=>{
    if(route==='/luna/media'){
      if(reads++===0){readStarted.resolve();await firstRead.promise;return{media:[entry('1','track',true)]}}
      return{media:[entry('1','track',false)]};
    }
    return{status_code:0};
  });
  const pending=h.service.isLiked({ids:['1']});
  await readStarted.promise;
  await h.service.like({id:'1',on:false});
  firstRead.resolve();
  assert.deepEqual(plain(await pending),{'1':false});
  assert.equal(reads,3); // Old read, mutation confirmation, then stale-read retry.
});

test('missing state, wrong media type and unrelated IDs never become false answers',async()=>{
  for(const media of [[],[entry('2')],[entry('1','ugc_clip')],[{type:'track',entity:{track_wrapper:{track:{id:'1'}}}}]]){
    const h=setup(()=>({media}));
    await assert.rejects(h.service.isLiked({ids:['1']}),/未确认部分歌曲/);
  }
});

test('the observed empty state object means unliked, while a missing media entry is never a false success',async()=>{
  const h=setup(()=>({media:[{type:'track',entity:{track_wrapper:{track:{id:'1',media_type:'track',state:{}}}}}]}));
  assert.deepEqual(plain(await h.service.isLiked({ids:['1']})),{'1':false});
});

test('a write is confirmed by a matching read; delayed state gets one read retry and no second write',async()=>{
  let reads=0;
  const h=setup(route=>route==='/luna/media'?{media:[entry('1','track',++reads>1)]}:{status_code:0});
  await h.service.like({id:'1',on:true});
  assert.equal(h.calls.filter(c=>c.route==='/luna/pc/me/collection/media').length,1);
  assert.equal(reads,2);
  assert.equal(h.changes(),1);
});

test('a write whose state never changes stays unconfirmed and leaves caches intact',async()=>{
  const h=setup(route=>route==='/luna/media'?{media:[entry('1','track',false)]}:{status_code:0});
  await assert.rejects(h.service.like({id:'1',on:true}),/暂未确认喜欢状态已更新/);
  assert.equal(h.calls.filter(c=>c.route==='/luna/pc/me/collection/media').length,1);
  assert.equal(h.calls.filter(c=>c.route==='/luna/media').length,2);
  assert.equal(h.changes(),0);
});

test('an account switch discards pending read results',async()=>{
  const gate=deferred();
  const h=setup(async()=>{await gate.promise;return{media:[entry('1')]}});
  const pending=h.service.isLiked({ids:['1']});
  const rejected=assert.rejects(pending,/账号已变化/);
  await new Promise(resolve=>setImmediate(resolve));
  h.setKey('account-b:2');gate.resolve();
  await rejected;
});
