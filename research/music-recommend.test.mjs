import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./music-recommend.fragment.js',import.meta.url),'utf8');
const create = runInNewContext(source+'\ncreateRecommendationService', {URL,Map,Set,Promise,Date,Error,Number});
const plain = value => JSON.parse(JSON.stringify(value));
const track = (id,extra={}) => ({type:'track',entity:{track_wrapper:{track:{id,name:'歌曲'+id,media_type:'track',...extra}}}});
const modes = {feed_mode_block:[{feed_mode:[
  {type:'scene_mode',text:'放松',entity:{feed_scene_mode:{scene_mode_id:3}},url_info:'https://example.invalid/cover'},
  {type:'scene_mode',text:'重复场景',entity:{feed_scene_mode:{scene_mode_id:3}}},
  {type:'scene_mode',text:'坏场景',entity:{feed_scene_mode:{scene_mode_id:-1}}},
]}]};
const discover = {blocks:[{type:'discover_playlist_mix',title:'发现电台',inner_block:[{resources:[
  {type:'radio',resource_id:'r1',style:{title:'电台一',desc:'介绍',link:'luna://music/play_source?flow_type=1&trigger_info=firstparty',cover_url_list:['https://example.invalid/radio']}},
  {type:'playlist',resource_id:'p1',style:{title:'歌单一'}},
]}]}]};
function setup(handle=()=>({items:[],has_more:true})) {
  let key = 'account-a:1', time = 1;
  const calls=[];
  const service=create({contextKey:()=>key,now:()=>time, imageURL:v=>typeof v==='string'?v:'',
    mapTrack:v=>v.entity.track_wrapper.track,mapPlaylist:(v,mine)=>({id:v.id,name:v.title,mine}),
    api:async(route,params,body)=>{
      calls.push({route,params,body:plain(body)});
      if(route==='/luna/pc/feed/mode')return modes;
      if(route==='/luna/pc/discover')return discover;
      return handle(route,body);
    }});
  return {service,calls,setKey:v=>key=v,setTime:v=>time=v};
}
test('catalog preserves genuine station types, normalizes playlists, deduplicates scene IDs',async()=>{
  const {service,calls}=setup();
  const result=await service.catalog();
  assert.deepEqual(plain(result.primary.map(v=>v.id)),['recommend','familiar','fresh']);
  assert.deepEqual(plain(result.scenes.map(v=>v.id)),['scene:3']);
  assert.equal(result.radios[0].id,'radio:r1');
  assert.equal(result.playlists[0].mine,false);
  assert.equal((await service.stations()).length,5);
  assert.equal(calls.length,2);
  result.primary[0].name='mutated';
  assert.equal((await service.catalog()).primary[0].name,'个性推荐');
});
test('personalized batches serialize, increment request counters, and deduplicate without fabricated play events',async()=>{
  const {service,calls}=setup((route,body)=>({items:body.is_first_request?[track('1'),track('2')]:[track('2'),track('3')],has_more:true}));
  const [first,second]=await Promise.all([service.stationNext({id:'recommend'}),service.stationNext({id:'recommend'})]);
  assert.deepEqual(plain(first.map(v=>v.id)),['1','2']);
  assert.deepEqual(plain(second.map(v=>v.id)),['3']);
  assert.deepEqual(calls.map(v=>v.body),[
    {is_first_request:true,is_did_first_request:false,feed_counts:{mix_session_count:0}},
    {is_first_request:false,is_did_first_request:false,feed_counts:{mix_session_count:1}},
  ]);
  assert.ok(calls.every(v=>!('played_media'in v.body)&&!('played_tracks'in v.body)));
});
test('familiar/fresh and dynamic scenes use their distinct official preference fields',async()=>{
  const {service,calls}=setup(()=>({items:[track('1')],has_more:true}));
  for(const id of ['familiar','fresh','scene:3'])await service.stationNext({id});
  const feeds=calls.filter(v=>v.route==='/luna/pc/feed/song-tab');
  assert.deepEqual(feeds.map(v=>v.body.feed_preference),[
    {preference_mode:'familiar'},{preference_mode:'fresh'},{scene_mode_id:3},
  ]);
  assert.ok(feeds.every(v=>v.body.is_first_request));
});
test('radio uses server cursors and stops on explicit end without another request',async()=>{
  const {service,calls}=setup((route,body)=>({items:[track(body.cursor?'2':'1')],next_cursor:body.cursor?'done':'next',has_more:!body.cursor}));
  const first=await service.stationNext({id:'radio:r1'});
  const second=await service.stationNext({id:'radio:r1'});
  const ended=await service.stationNext({id:'radio:r1'});
  assert.deepEqual(plain([...first,...second].map(v=>v.id)),['1','2']);
  assert.deepEqual(plain(ended),[]);
  const radioCalls=calls.filter(v=>v.route.endsWith('/radio/tracks'));
  assert.equal(radioCalls.length,2);
  assert.deepEqual(radioCalls.map(v=>v.body),[
    {radio_id:'r1',cursor:'',flow_type:1,trigger_info:'firstparty'},
    {radio_id:'r1',cursor:'next',flow_type:1,trigger_info:'firstparty'},
  ]);
});
test('unsupported videos, unavailable tracks and duplicates do not enter the queue',async()=>{
  const {service}=setup(()=>({items:[track('1'),track('1'),track('2',{unavailable:true}),track('3',{media_type:'ugc_video'}),track('4',{media_type:'ugc_clip'}),{type:'video_track_mix',entity:{video:{id:'5'}}}],has_more:true}));
  assert.deepEqual(plain((await service.stationNext({id:'recommend'})).map(v=>v.id)),['1','4']);
});
test('account changes invalidate pending results and start fresh counters and seen sets',async()=>{
  let resolve;
  const gate=new Promise(r=>resolve=r);
  let wait=true;
  const {service,setKey,calls}=setup(async()=>{if(wait)await gate;return{items:[track('1')],has_more:true}});
  const pending=service.stationNext({id:'recommend'});
  await new Promise(r=>setImmediate(r));
  setKey('account-b:2');
  resolve();
  await assert.rejects(pending,/账号已变化/);
  wait=false;
  assert.deepEqual(plain((await service.stationNext({id:'recommend'})).map(v=>v.id)),['1']);
  assert.equal(calls.at(-1).body.feed_counts.mix_session_count,0);
});
test('failed calls do not poison future calls or advance the request count',async()=>{
  let count=0;
  const {service,calls}=setup(()=>{if(count++===0)throw new Error('模拟网络错误');return{items:[track('1')],has_more:true}});
  await assert.rejects(service.stationNext({id:'recommend'}),/模拟网络错误/);
  assert.equal((await service.stationNext({id:'recommend'})).length,1);
  assert.deepEqual(calls.map(v=>v.body.feed_counts.mix_session_count),[0,0]);
});
test('invalid radio cursor is rejected before items enter seen state',async()=>{
  const {service,calls}=setup(()=>({items:[track('1')],has_more:true}));
  await assert.rejects(service.stationNext({id:'radio:r1'}),/下一页信息无效/);
  assert.equal(calls.at(-1).body.cursor,'');
});
test('cache refresh preserves active radio state while reset clears it',async()=>{
  const {service,setTime,calls}=setup((route,body)=>({items:[track(body.cursor?'2':'1')],next_cursor:body.cursor?'third':'second',has_more:true}));
  await service.stationNext({id:'radio:r1'});
  setTime(700000);
  await service.catalog();
  await service.stationNext({id:'radio:r1'});
  assert.equal(calls.at(-1).body.cursor,'second');
  const discoverCalls=calls.filter(v=>v.route==='/luna/pc/discover');
  assert.deepEqual(discoverCalls.map(v=>v.body.first_request),[true,false]);
  service.reset();
  await service.stationNext({id:'radio:r1'});
  assert.equal(calls.at(-1).body.cursor,'');
});
