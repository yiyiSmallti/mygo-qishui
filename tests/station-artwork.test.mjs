import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the packaged helper and its real recommendation-service wiring.
const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const directory = 'C:\\Users\\测试 用户\\MyGo #1\\plugins\\汽水%20';
const prefix = 'file:///C:/Users/%E6%B5%8B%E8%AF%95%20%E7%94%A8%E6%88%B7/MyGo%20%231/plugins/%E6%B1%BD%E6%B0%B4%2520/assets/stations/';
function setup(dir = directory, {noHost = false, missingDir = false} = {}) {
  const storage = new Map([['qishui-session-v1', {
    account: {id:'account-a', name:'测试账号'},
    device: {did:'71234567890123456', iid:'71234567890123457'},
    jar: {'sessionid|/':{name:'sessionid', value:'test-cookie-only', path:'/', expires:0}},
  }]]);
  const calls = [];
  const globals = {URL, AbortController, TypeError, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.qishui.com');
      assert.equal(options.method, 'POST');
      calls.push(parsed.pathname);
      let result;
      switch (parsed.pathname) {
        case '/luna/pc/feed/mode':
          result = {status_code:0, feed_mode_block:[{feed_mode:[
            {type:'scene_mode', text:'放松', entity:{feed_scene_mode:{scene_mode_id:3}}, url_info:'https://cdn.example/white.jpg'},
            {type:'scene_mode', text:'新场景', entity:{feed_scene_mode:{scene_mode_id:999999}}, url_info:'https://cdn.example/new.jpg'},
          ]}]};
          break;
        case '/luna/pc/discover':
          result = {status_code:0, blocks:[{type:'discover_playlist_mix', inner_block:[{resources:[
            {type:'radio', resource_id:'station-a', style:{title:'电台 A', cover_url_list:['https://cdn.example/radio.jpg']}},
            {type:'radio', resource_id:'unsafe-art', style:{title:'无效封面', cover_url_list:['file:///C:/other.png']}},
          ]}]}]};
          break;
        default: throw new Error('Unexpected artwork test route: ' + parsed.pathname);
      }
      return new Response(JSON.stringify(result), {status:200, headers:{'Content-Type':'application/json'}});
    },
  };
  if (!noHost) {
    globals.host = {platform:'windows', storage:{
      get:key => plain(storage.get(key)),
      set:(key,value) => storage.set(key,plain(value)),
      remove:key => storage.delete(key),
    }};
    if (!missingDir) globals.host.dir = dir;
  }
  const context = vm.createContext(globals);
  vm.runInContext(source.replace(/^export\s+/gm, '') + '\nthis.plugin={stationArtwork,imageURL,stations};', context);
  return {plugin:context.plugin, calls};
}

test('local artwork encodes spaces, Chinese, hashes and literal percent without changing the drive', () => {
  const h = setup();
  for (const id of ['recommend', 'familiar', 'fresh']) {
    assert.equal(h.plugin.stationArtwork(id), prefix + id + '.png');
  }
  assert.equal(setup(directory + '\\').plugin.stationArtwork('recommend'), prefix + 'recommend.png');
  assert.equal(setup('C:\\').plugin.stationArtwork('fresh'), 'file:///C:/assets/stations/fresh.png');
  assert.equal(setup('/tmp/汽水 #1/').plugin.stationArtwork('fresh'), 'file:///tmp/%E6%B1%BD%E6%B0%B4%20%231/assets/stations/fresh.png');
  assert.equal(h.calls.length, 0);
});

test('known scene IDs select packaged PNGs and canonical unknown scene IDs use the fallback', () => {
  const {plugin} = setup();
  assert.equal(plugin.stationArtwork('scene:3'), prefix + 'scene-3.png');
  assert.equal(plugin.stationArtwork('scene:48'), prefix + 'scene-48.png');
  for (const id of ['scene:0', 'scene:42', 'scene:999999', 'scene:9007199254740991']) {
    assert.equal(plugin.stationArtwork(id), prefix + 'scene-default.png', id);
  }
});

test('artwork accepts no arbitrary filename, noncanonical scene number or radio ID', () => {
  const {plugin} = setup();
  for (const id of [undefined, null, 3, {}, '', 'radio:3', 'other', 'Recommend', '../recommend',
    'scene:', 'scene:-1', 'scene:+1', 'scene:01', 'scene:1.0', 'scene:1e2', 'scene:0x3',
    'scene:9007199254740992', ' scene:3', 'scene:3 ', 'scene:3/../fresh', 'scene:3?x', 'scene:3#x']) {
    assert.equal(plugin.stationArtwork(id), '', String(id));
  }
  assert.equal(plugin.imageURL('file:///C:/other.png'), '');
  assert.equal(plugin.imageURL('data:image/png;base64,AAAA'), '');
});

test('missing or nonlocal host directories do not generate file URLs', () => {
  assert.equal(setup(undefined, {noHost:true}).plugin.stationArtwork('recommend'), '');
  assert.equal(setup(undefined, {missingDir:true}).plugin.stationArtwork('recommend'), '');
  for (const dir of [null, 42, '', 'plugins/qishui', 'C:plugins', 'https://example.com/plugin',
    'file:///C:/plugin', '\\\\server\\share', 'C:\\plugin\\..\\outside', 'C:\\plugin\\.\\inside', 'C:\\bad\u0000dir']) {
    assert.equal(setup(dir).plugin.stationArtwork('recommend'), '', String(dir));
  }
});

test('assembled station catalog uses local primary and scene covers while keeping radio covers remote', async () => {
  const h = setup();
  const byId = new Map(plain(await h.plugin.stations()).map(station => [station.id, station]));
  for (const id of ['recommend', 'familiar', 'fresh']) {
    assert.equal(byId.get(id).imageUrl, prefix + id + '.png');
  }
  assert.equal(byId.get('scene:3').imageUrl, prefix + 'scene-3.png');
  assert.equal(byId.get('scene:999999').imageUrl, prefix + 'scene-default.png');
  assert.equal(byId.get('radio:station-a').imageUrl, 'https://cdn.example/radio.jpg');
  assert.equal(byId.get('radio:unsafe-art').imageUrl, undefined);
  assert.deepEqual(h.calls.sort(), ['/luna/pc/discover', '/luna/pc/feed/mode']);
});

test('assembled stations retain HTTPS fallback when the host has no plugin directory', async () => {
  const h = setup(undefined, {missingDir:true});
  const byId = new Map(plain(await h.plugin.stations()).map(station => [station.id, station]));
  assert.equal(byId.get('recommend').imageUrl, undefined);
  assert.equal(byId.get('scene:3').imageUrl, 'https://cdn.example/white.jpg');
  assert.equal(byId.get('scene:999999').imageUrl, 'https://cdn.example/new.jpg');
  assert.equal(byId.get('radio:station-a').imageUrl, 'https://cdn.example/radio.jpg');
});
