import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

// Exercise the complete assembled index, including musicApi/request and account().
// Only fetch is replaced; the endpoint, JSON body, query and cookie code are real.
const source=await readFile(new URL('../qishui-account/index.js',import.meta.url),'utf8');
const plain=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const SESSION='qishui-session-v1';
const track=id=>({id,name:'歌曲 '+id,duration:180000,media_type:'track',album:{id:'album',name:'专辑'}});
const feedTrack=id=>({type:'track',entity:{track_wrapper:{track:track(id)}}});
const playlist=(id,type=2)=>({id,title:'歌单 '+id,type,owner:{id:'account-a',nickname:'测试账号'},count_tracks:1});
const modeResponse={status_code:0,feed_mode_block:[{feed_mode:[
  {type:'scene_mode',text:'放松',entity:{feed_scene_mode:{scene_mode_id:3}}},
]}]};
const discoverResponse={status_code:0,blocks:[{type:'discover_playlist_mix',title:'发现电台',inner_block:[{resources:[
  {type:'radio',resource_id:'station-a',style:{title:'电台 A',link:'luna://music/play_source?flow_type=1'}},
]}]}]};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function defaultReply(call){
  switch(call.route){
    case '/luna/pc/me':return{status_code:0,my_info:{id:'account-a',nickname:'测试账号'}};
    case '/luna/pc/me/playlist':return{status_code:0,playlists:[playlist('liked',1),playlist('owned')],has_more:false};
    case '/luna/pc/me/collection/mixed':return{status_code:0,mixed_collections:[],has_more:false};
    case '/luna/pc/playlist/detail':return{status_code:0,playlist:playlist(call.query.playlist_id,1),media_resources:[track('favorite')],has_more:false};
    case '/luna/pc/feed/mode':return modeResponse;
    case '/luna/pc/discover':return discoverResponse;
    case '/luna/pc/feed/song-tab':return{status_code:0,items:[feedTrack('recommend-'+call.body.feed_counts.mix_session_count)],has_more:true};
    case '/luna/pc/feed/radio/tracks':return{status_code:0,items:[feedTrack(call.body.cursor?'radio-second':'radio-first')],next_cursor:'page-'+(call.body.cursor?'2':'1'),has_more:true};
    default:throw new Error('Unexpected test route: '+call.route);
  }
}
function setup(reply=defaultReply){
  const storage=new Map([[SESSION,{
    account:{id:'account-a',name:'测试账号'},
    device:{did:'71234567890123456',iid:'71234567890123457'},
    jar:{'sessionid|/':{name:'sessionid',value:'test-cookie-only',path:'/',expires:0}},
  }]]);
  const calls=[];
  const context=vm.createContext({URL,AbortController,TypeError,setTimeout,clearTimeout,
    host:{platform:'windows',dir:fileURLToPath(new URL('../qishui-account/',import.meta.url)),storage:{get:key=>plain(storage.get(key)),set:(key,value)=>storage.set(key,plain(value)),remove:key=>storage.delete(key)}},
    fetch:async(url,options)=>{
      const parsed=new URL(url);
      assert.equal(parsed.origin,'https://api.qishui.com');
      const call={route:parsed.pathname,query:Object.fromEntries(parsed.searchParams),method:options.method,
        headers:plain(options.headers),body:options.body===undefined?undefined:JSON.parse(options.body)};
      calls.push(call);
      const result=await reply(call,calls);
      return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
    },
  });
  vm.runInContext(source.replace(/^export\s+/gm,'')+'\nthis.plugin={home,browse,stations,stationNext,signOut,isLiked,like,liked};',context);
  return{plugin:context.plugin,calls,storage};
}

test('assembled home keeps recommendations, continuous listening and the user library together',async()=>{
  const h=setup();
  const home=plain(await h.plugin.home());
  assert.equal(home.sections.find(s=>s.title==='为你推荐').tracks[0].id,'recommend-0');
  assert.deepEqual(home.sections.find(s=>s.title==='连续听歌').stations.map(s=>s.id),['recommend','familiar','fresh']);
  assert.equal(home.sections.find(s=>s.title==='按场景听歌').stations[0].id,'scene:3');
  assert.equal(home.sections.find(s=>s.title==='发现电台').stations[0].id,'radio:station-a');
  assert.equal(home.sections.find(s=>s.title==='我的歌单').playlists[0].id,'owned');
  assert.equal(home.sections.find(s=>s.title==='喜欢的音乐').tracks[0].id,'favorite');
  assert.ok(home.sections.find(s=>s.title==='我的汽水音乐').links.some(l=>l.page==='library'));
  assert.ok(!home.sections.flatMap(s=>s.playlists||[]).some(p=>p.id==='liked'));
});

// The mode entries were blank and scene glyphs became white JPEGs. Every
// displayed mode must now resolve to a real, bundled, decodable PNG file.
test('home and stations provide packaged artwork without replacing radio covers',async()=>{
  const h=setup(call=>call.route==='/luna/pc/discover'?{
    status_code:0,blocks:[{type:'discover_playlist_mix',inner_block:[{resources:[
      {type:'radio',resource_id:'station-a',style:{title:'电台 A',cover_url_list:['https://p3-luna.douyinpic.com/radio.jpg']}},
    ]}]}],
  }:defaultReply(call));
  const home=plain(await h.plugin.home());
  const modes=home.sections.filter(s=>s.title==='连续听歌'||s.title==='按场景听歌').flatMap(s=>s.stations);
  assert.equal(modes.length,4);
  for(const mode of modes){
    const url=new URL(mode.imageUrl);
    assert.equal(url.protocol,'file:');
    const bytes=await readFile(url);
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16),400);
    assert.equal(bytes.readUInt32BE(20),400);
  }
  const all=plain(await h.plugin.stations());
  assert.equal(all.find(s=>s.id==='radio:station-a').imageUrl,'https://p3-luna.douyinpic.com/radio.jpg');
  for(const mode of modes)assert.equal(all.find(s=>s.id===mode.id).imageUrl,mode.imageUrl);
});

test('recommendation API failures keep existing account library and expose a retry link',async()=>{
  const h=setup(call=>call.route.includes('/feed/')||call.route==='/luna/pc/discover'
    ? {status_code:1000005}:defaultReply(call));
  const home=plain(await h.plugin.home());
  assert.equal(home.sections.find(s=>s.title==='我的歌单').playlists[0].id,'owned');
  assert.equal(home.sections.find(s=>s.title==='喜欢的音乐').tracks[0].id,'favorite');
  assert.ok(!home.sections.some(s=>s.title==='为你推荐'));
  const retry=home.sections.flatMap(s=>s.links||[]).find(l=>l.title==='重试推荐');
  assert.match(retry.page,/^recommend\/refresh\/\d+$/);
  assert.equal(retry.reload,true);
});

test('failed recommendation catalog does not discard a successful song preview or library',async()=>{
  const h=setup(call=>call.route==='/luna/pc/feed/mode'?{status_info:{code:1000005}}:defaultReply(call));
  const home=plain(await h.plugin.home());
  assert.equal(home.sections.find(s=>s.title==='为你推荐').tracks[0].id,'recommend-0');
  assert.equal(home.sections.find(s=>s.title==='我的歌单').playlists[0].id,'owned');
  assert.ok(home.sections.flatMap(s=>s.links||[]).some(l=>l.title==='重试推荐'));
});

test('sign-out while home waits for recommendations rejects already loaded private library',async()=>{
  const recommendationGate=deferred(),libraryLoaded=deferred();
  const h=setup(async call=>{
    if(call.route==='/luna/pc/feed/song-tab')await recommendationGate.promise;
    if(call.route==='/luna/pc/playlist/detail')libraryLoaded.resolve();
    return defaultReply(call);
  });
  const pending=h.plugin.home();
  const rejected=assert.rejects(pending,/账号已变化|账号已切换|请先登录/);
  await libraryLoaded.promise;
  await new Promise(resolve=>setImmediate(resolve));
  h.plugin.signOut();
  recommendationGate.resolve();
  await rejected;
  assert.equal(h.storage.has(SESSION),false);
  const signedOut=plain(await h.plugin.home());
  assert.equal(signedOut.title,'汽水音乐');
  assert.ok(!signedOut.sections.some(s=>s.playlists?.length||s.tracks?.length));
});

test('stations and stationNext use the real JSON musicApi contract and isolate mode counters',async()=>{
  const h=setup();
  const stations=plain(await h.plugin.stations());
  assert.deepEqual(stations.map(s=>s.id),['recommend','familiar','fresh','scene:3','radio:station-a']);
  assert.deepEqual(plain(await h.plugin.stationNext({id:'recommend'})).map(t=>t.id),['recommend-0']);
  assert.deepEqual(plain(await h.plugin.stationNext({id:'recommend'})).map(t=>t.id),['recommend-1']);
  await h.plugin.stationNext({id:'familiar'});
  await h.plugin.stationNext({id:'scene:3'});
  await h.plugin.stationNext({id:'radio:station-a'});
  await h.plugin.stationNext({id:'radio:station-a'});
  const feeds=h.calls.filter(c=>c.route==='/luna/pc/feed/song-tab');
  assert.deepEqual(feeds.map(c=>c.body),[
    {is_first_request:true,is_did_first_request:false,feed_counts:{mix_session_count:0}},
    {is_first_request:false,is_did_first_request:false,feed_counts:{mix_session_count:1}},
    {is_first_request:true,is_did_first_request:false,feed_counts:{mix_session_count:0},feed_preference:{preference_mode:'familiar'}},
    {is_first_request:true,is_did_first_request:false,feed_counts:{mix_session_count:0},feed_preference:{scene_mode_id:3}},
  ]);
  assert.deepEqual(h.calls.filter(c=>c.route.endsWith('/radio/tracks')).map(c=>c.body),[
    {radio_id:'station-a',cursor:'',flow_type:1,trigger_info:''},
    {radio_id:'station-a',cursor:'page-1',flow_type:1,trigger_info:''},
  ]);
  for(const call of h.calls){
    assert.equal(call.method,'POST');
    assert.equal(call.headers['Content-Type'],'application/json');
    assert.equal(call.headers.Cookie,'sessionid=test-cookie-only');
    assert.equal(call.query.aid,'386088');
    assert.equal(call.query.device_id,'71234567890123456');
    assert.equal(call.query.iid,'71234567890123457');
    assert.ok(!('played_media'in call.body)&&!('played_tracks'in call.body));
  }
});

test('recommend refresh requests a new preview while normal browse reuses it',async()=>{
  const h=setup();
  const first=plain(await h.plugin.browse({page:'recommend'}));
  const cached=plain(await h.plugin.browse({page:'recommend'}));
  const refreshed=plain(await h.plugin.browse({page:'recommend/refresh/123'}));
  assert.equal(first.sections.find(s=>s.title==='为你推荐').tracks[0].id,'recommend-0');
  assert.equal(cached.sections.find(s=>s.title==='为你推荐').tracks[0].id,'recommend-0');
  assert.equal(refreshed.sections.find(s=>s.title==='为你推荐').tracks[0].id,'recommend-1');
  assert.equal(h.calls.filter(c=>c.route==='/luna/pc/feed/song-tab').length,2);
  assert.equal(h.calls.filter(c=>c.route==='/luna/pc/feed/mode').length,1);
});

// Refresh used to expand the entire scene/radio catalog. Keep the same
// short discovery page and make all omitted entries reachable via See All.
test('refresh keeps bounded previews and full collections remain reachable',async()=>{
  const h=setup(call=>{
    if(call.route==='/luna/pc/feed/mode')return{status_code:0,feed_mode_block:[{feed_mode:
      Array.from({length:12},(_,i)=>({type:'scene_mode',text:'场景 '+i,entity:{feed_scene_mode:{scene_mode_id:i+1}}})),
    }]};
    if(call.route==='/luna/pc/discover')return{status_code:0,blocks:[{type:'discover_playlist_mix',inner_block:[{resources:[
      ...Array.from({length:9},(_,i)=>({type:'radio',resource_id:'radio-'+i,style:{title:'电台 '+i}})),
      ...Array.from({length:7},(_,i)=>({type:'playlist',entity:{playlist:playlist('public-'+i)}})),
    ]}]}]};
    return defaultReply(call);
  });
  for(const page of ['recommend','recommend/refresh/123']){
    const view=plain(await h.plugin.browse({page}));
    const songs=view.sections.find(s=>s.tracks);
    assert.ok(songs.tracks.length>0);
    assert.equal(songs.links.length,1);
    assert.equal(songs.links[0].reload,true);
    assert.match(songs.links[0].page,/^recommend\/refresh\/\d+$/);
    assert.equal(songs.links[0].imageUrl,undefined);
    for(const [route,field,total] of [['recommend/scenes','stations',12],['recommend/radios','stations',9],['recommend/playlists','playlists',7]]){
      const section=view.sections.find(s=>s.morePage===route);
      assert.equal(section[field].length,4);
      const all=plain(await h.plugin.browse({page:section.morePage}));
      assert.equal(all.sections[0][field].length,total);
      assert.deepEqual(all.sections[0][field].slice(0,4).map(x=>x.id),section[field].map(x=>x.id));
    }
  }
  assert.equal(h.calls.filter(c=>c.route==='/luna/pc/feed/song-tab').length,2);
});

// A refresh is an operation even after returning to a cached page; opening
// the library normally must remain a navigation operation with its cache.
test('library actions distinguish explicit reload from ordinary navigation',async()=>{
  const h=setup();
  const home=plain(await h.plugin.home());
  const actions=home.sections.flatMap(s=>s.links||[]);
  const library=actions.find(l=>l.page==='library');
  const refresh=actions.find(l=>l.page==='library-refresh');
  assert.ok(library);
  assert.equal(library.reload,undefined);
  assert.equal(library.imageUrl,undefined);
  assert.equal(refresh.reload,true);
  const full=plain(await h.plugin.browse({page:library.page}));
  assert.equal(full.sections.flatMap(s=>s.links||[]).find(l=>l.page==='library-refresh').reload,true);
});

test('separate scene and radio browse pages retain station identities',async()=>{
  const h=setup();
  const scenes=plain(await h.plugin.browse({page:'recommend/scenes'}));
  const radios=plain(await h.plugin.browse({page:'recommend/radios'}));
  assert.deepEqual(scenes.sections[0].stations.map(s=>s.id),['scene:3']);
  assert.deepEqual(radios.sections[0].stations.map(s=>s.id),['radio:station-a']);
  assert.equal(h.calls.length,2);
});

// The listening layout groups known modes without inventing unavailable
// scenes or losing less common modes and their continuous playback IDs.
test('listening navigation keeps every returned station reachable with usable artwork',async()=>{
  const h=setup(call=>{
    if(call.route==='/luna/pc/feed/mode')return{status_code:0,feed_mode_block:[{feed_mode:
      [3,5,2,40,21,18,48,999].map(id=>({type:'scene_mode',text:'场景 '+id,entity:{feed_scene_mode:{scene_mode_id:id}}})),
    }]};
    if(call.route==='/luna/pc/discover')return{status_code:0,blocks:[{type:'discover_playlist_mix',inner_block:[{resources:[
      {type:'radio',resource_id:'station-a',style:{title:'探索电台',desc:'电台简介',cover_url_list:['https://cdn.example/radio.jpg']}},
    ]}]}]};
    return defaultReply(call);
  });
  const manifest=JSON.parse(await readFile(new URL('../qishui-account/plugin.json',import.meta.url),'utf8'));
  const entry=manifest.navigation.find(item=>item.page==='listening');
  assert.ok(entry,'the sidebar must open the new browse page');
  const view=plain(await h.plugin.browse({page:entry.page}));
  const all=plain(await h.plugin.stations());
  const shown=view.sections.flatMap(section=>section.stations);
  assert.deepEqual(shown.map(station=>station.id).sort(),all.map(station=>station.id).sort());
  assert.equal(new Set(shown.map(station=>station.id)).size,shown.length);
  const common=view.sections[0];
  assert.equal(common.layout,'mode-buttons');
  assert.equal(common.stations.length,8);
  const original=new Map(all.map(station=>[station.id,station]));
  for(const station of common.stations){
    assert.equal(station.imageUrl,original.get(station.id).imageUrl,'keep the opaque cover for older hosts');
    const bytes=await readFile(new URL(station.iconUrl));
    assert.ok(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'||
      (bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'));
  }
  const radio=view.sections.find(section=>section.layout==='mode-covers').stations[0];
  assert.deepEqual(radio,original.get('radio:station-a'));
  assert.equal(radio.description,'电台简介');
  assert.equal(radio.imageUrl,'https://cdn.example/radio.jpg');
  const future=shown.find(station=>station.id==='scene:999');
  assert.equal(future.iconUrl,'');
  assert.match(future.imageUrl,/scene-default\.png$/);
  await h.plugin.stationNext({id:common.stations.find(station=>station.id==='scene:40').id});
  await h.plugin.stationNext({id:radio.id});
  assert.deepEqual(h.calls.find(call=>call.route==='/luna/pc/feed/song-tab').body.feed_preference,{scene_mode_id:40});
  assert.equal(h.calls.find(call=>call.route==='/luna/pc/feed/radio/tracks').body.radio_id,'station-a');
});

// Server-side mode removal must not leave buttons that request missing IDs.
test('listening page omits absent common modes without duplicating or hiding the remaining catalog',async()=>{
  const h=setup();
  const view=plain(await h.plugin.browse({page:'listening'}));
  const available=plain(await h.plugin.stations()).map(station=>station.id).sort();
  const shown=view.sections.flatMap(section=>section.stations).map(station=>station.id);
  assert.deepEqual([...shown].sort(),available);
  assert.equal(new Set(shown).size,shown.length);
  assert.ok(!shown.includes('scene:40'));
  assert.equal(h.calls.filter(call=>call.route==='/luna/pc/feed/mode').length,1);
});

// The heart must use authenticated musicApi JSON calls and preserve UGC identity.
test('assembled like/isLiked exports use official read and write routes only when called',async()=>{
  const states=new Map([['track:1',false],['ugc_clip:2',true]]);
  const h=setup(call=>{
    if(call.route==='/luna/media')return{media:call.body.media.map(media=>({type:media.type,entity:{track_wrapper:{track:{...track(media.id),media_type:media.type,state:{is_collected:states.get(media.type+':'+media.id)||false}}}}}))};
    if(call.route.includes('/collection/media')){
      for(const media of call.body.media)states.set(media.type+':'+media.id,!call.route.endsWith('/delete'));
      return{status_code:0};
    }
    return defaultReply(call);
  });
  assert.deepEqual(plain(await h.plugin.isLiked({ids:['1','ugc_clip:2']})),{'1':false,'ugc_clip:2':true});
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].route,'/luna/media');
  await h.plugin.like({id:'ugc_clip:2',on:true});
  await h.plugin.like({id:'ugc_clip:2',on:false});
  assert.deepEqual(h.calls.filter((call,index)=>index===0||call.route.includes('/collection/media')).map(call=>[call.route,call.body]),[
    ['/luna/media',{scene:'playlist',media:[{id:'1',type:'track'},{id:'2',type:'ugc_clip'}]}],
    ['/luna/pc/me/collection/media',{media:[{id:'2',type:'ugc_clip'}],scene:''}],
    ['/luna/pc/me/collection/media/delete',{media:[{id:'2',type:'ugc_clip'}]}],
  ]);
  assert.equal(h.calls.filter(call=>call.route==='/luna/media').length,3);
  for(const call of h.calls){
    assert.equal(call.method,'POST');
    assert.equal(call.headers['Content-Type'],'application/json');
    assert.equal(call.headers.Cookie,'sessionid=test-cookie-only');
    assert.equal(call.query.aid,'386088');
    assert.equal(call.query.device_id,'71234567890123456');
  }
});

// An old heart request must not restore credentials after sign-out or overwrite a new login.
test('assembled heart request rejects an old account response and leaves the new session intact',async()=>{
  const gate=deferred(),started=deferred();
  const h=setup(async call=>{
    if(call.route.includes('/collection/media')){started.resolve();await gate.promise;return{status_code:0};}
    return defaultReply(call);
  });
  const saved=plain(h.storage.get(SESSION));
  const pending=h.plugin.like({id:'1',on:true});
  const rejected=assert.rejects(pending,/账号已切换|账号已变化/);
  await started.promise;
  h.plugin.signOut();
  await assert.rejects(h.plugin.isLiked({ids:['1']}),error=>error.code==='signIn');
  h.storage.set(SESSION,{...saved,account:{id:'account-b',name:'另一个账号'}});
  gate.resolve();
  await rejected;
  assert.equal(h.storage.get(SESSION).account.id,'account-b');
  assert.deepEqual(plain(await h.plugin.stationNext({id:'recommend'})).map(t=>t.id),['recommend-0']);
});

// A successful heart refreshes library contents without resetting or interrupting a station.
test('assembled like invalidates liked-list cache while preserving active recommendation and radio cursors',async()=>{
  const feedGate=deferred(),feedStarted=deferred();
  const h=setup(async call=>{
    if(call.route.includes('/collection/media'))return{status_code:0};
    if(call.route==='/luna/media')return{media:call.body.media.map(media=>({type:media.type,entity:{track_wrapper:{track:{...track(media.id),media_type:media.type,state:{is_collected:true}}}}}))};
    if(call.route==='/luna/pc/feed/song-tab'&&call.body.feed_counts.mix_session_count===1){feedStarted.resolve();await feedGate.promise;}
    return defaultReply(call);
  });
  await h.plugin.stationNext({id:'recommend'});
  await h.plugin.stationNext({id:'radio:station-a'});
  await h.plugin.liked({offset:0});
  const pending=h.plugin.stationNext({id:'recommend'});
  await feedStarted.promise;
  await h.plugin.like({id:'1',on:true});
  feedGate.resolve();
  assert.deepEqual(plain(await pending).map(t=>t.id),['recommend-1']);
  await h.plugin.stationNext({id:'recommend'});
  await h.plugin.stationNext({id:'radio:station-a'});
  await h.plugin.liked({offset:0});
  assert.deepEqual(h.calls.filter(call=>call.route==='/luna/pc/feed/song-tab').map(call=>call.body.feed_counts.mix_session_count),[0,1,2]);
  assert.deepEqual(h.calls.filter(call=>call.route.endsWith('/radio/tracks')).map(call=>call.body.cursor),['','page-1']);
  assert.equal(h.calls.filter(call=>call.route==='/luna/pc/me/playlist').length,2);
});
