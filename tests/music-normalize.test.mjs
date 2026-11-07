import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../research/music-normalize.fragment.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source + '\nthis.normalizers={safeId,imageURL,mapArtist,mapAlbum,mapTrack,mapPlaylist,parseQishuiLyrics};', context);
const { safeId, imageURL, mapArtist, mapAlbum, mapTrack, mapPlaylist, parseQishuiLyrics } = context.normalizers;
const plain = value => JSON.parse(JSON.stringify(value));

test('large source IDs keep exact digits and unsafe numeric IDs are rejected', () => {
  const id = '7631943856258566161';
  assert.equal(safeId(id), id);
  assert.equal(safeId(42), '42');
  for (const bad of [Number(id), Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, [], true, null, undefined, '  ']) assert.equal(safeId(bad), '');
  assert.equal(mapTrack({ id: Number(id), name: 'song' }), null);
  assert.equal(mapPlaylist({ title: 'missing ID' }, true), null);
});

test('cover prefixes follow the verified official transform without duplicating complete URLs', () => {
  assert.equal(imageURL({ urls: ['https://p3-luna.douyinpic.com/img/'], uri: 'tos-cn-v-2774c002/cover', template_prefix: 'tplv-b829550vbb' }),
    'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/cover~tplv-b829550vbb-crop-center:400:400.jpg');
  assert.equal(imageURL({ urls: ['https://p3-luna.douyinpic.com/img/'], uri: 'avatar' }), 'https://p3-luna.douyinpic.com/img/avatar~c5_400x400.jpg');
  const full = 'https://p3-luna.douyinpic.com/img/cover~small.jpg';
  assert.equal(imageURL({ urls: [full], uri: 'cover', template_prefix: 'tplv-other' }), full);
  assert.equal(imageURL({ urls: [full], uri: 'cover', need_complete_url: true }), full);
  assert.equal(imageURL({ url_list: [full] }), full);
  assert.equal(imageURL({ urls: ['http://bad.example/image', full] }), full);
});

test('unsafe image schemes and embedded credentials are not handed to the native loader', () => {
  for (const value of ['http://example.com/image', 'javascript:alert(1)', 'file:///C:/private', 'https://user:pass@example.com/image', {}, null]) assert.equal(imageURL(value), '');
  for (const uri of ['https://other.example/path', '//other.example/path', '../outside', 'path\\file']) {
    assert.equal(imageURL({ urls: ['https://p3-luna.douyinpic.com/img/'], uri }), '');
  }
});

test('real PC track wrappers preserve artist credits, album artwork, and millisecond duration', () => {
  const track = mapTrack({ id: 'resource', type: 'track', entity: { track_wrapper: { track: {
    id: '7631943856258566161', name: '曲目', duration: 193600,
    artists: [{ state: { blocked_by_me: false }, user_info: { id: '7631943856258566162', nickname: '演唱者', medium_avatar_url: { url_list: ['https://p3-luna.douyinpic.com/artist.jpg'] } } }],
    album: { id: '7631943856258566163', name: '专辑', release_date: '2024-03-01', url_cover: { urls: ['https://p3-luna.douyinpic.com/cover.jpg'] } },
  } } } });
  assert.deepEqual(plain(track), {
    id: '7631943856258566161', name: '曲目', duration: 193600,
    artists: [{ id: 'user:7631943856258566162', name: '演唱者', imageUrl: 'https://p3-luna.douyinpic.com/artist.jpg' }],
    album: { id: '7631943856258566163', name: '专辑', released: '2024-03-01', imageUrl: 'https://p3-luna.douyinpic.com/cover.jpg' },
  });
  assert.equal(mapTrack({ type: 'video', entity: { track: { id: 'id', name: 'not music' } } }), null);
});

test('artist IDs and UGC user IDs route separately without losing display names', () => {
  assert.deepEqual(plain(mapArtist({ user_info: { id: '7631943856258566162', nickname: '上传者昵称' } })),
    { id: 'user:7631943856258566162', name: '上传者昵称' });
  assert.deepEqual(plain(mapArtist({ id: 'artist-id', name: '歌手姓名', user_info: { id: 'uploader-id', nickname: '用户昵称' } })),
    { id: 'artist-id', name: '歌手姓名' });
  assert.deepEqual(plain(mapArtist({ artist_id: 'artist-id', user_info: { id: 'uploader-id', nickname: '歌手昵称' } })),
    { id: 'artist-id', name: '歌手昵称' });
  assert.deepEqual(plain(mapArtist({ user_info: { id: 'uploader-id', artist_id: 'real-artist', nickname: '歌手昵称' } })),
    { id: 'real-artist', name: '歌手昵称' });
});

test('UGC media type survives the host track contract through a stable namespaced ID', () => {
  for (const type of ['ugc_clip', 'ugc_video']) {
    assert.equal(mapTrack({ id: '7631943856258566161', name: '上传作品', media_type: type }).id, type + ':7631943856258566161');
  }
  assert.equal(mapTrack({ id: '7631943856258566161', name: '歌曲', media_type: 'track' }).id, '7631943856258566161');
});

test('missing optional album metadata does not invent an album ID or discard the track', () => {
  assert.deepEqual(plain(mapTrack({ id: 'id', name: 'song', duration: '120000' })), { id: 'id', name: 'song', duration: 120000, artists: [], album: { id: '', name: '' } });
  assert.equal(mapArtist({ user_info: { nickname: 'name' } }), null);
  assert.equal(mapAlbum({ name: 'album' }), null);
});

test('UGC without an album ID retains its available cover and non-clickable album title', () => {
  const mapped = mapTrack({ id: 'ugc-track', name: '上传作品', album: {
    id: '', name: '作品合集', url_cover: { urls: ['https://p3-luna.douyinpic.com/ugc-cover.jpg'] },
  } });
  assert.deepEqual(plain(mapped.album), { id: '', name: '作品合集', imageUrl: 'https://p3-luna.douyinpic.com/ugc-cover.jpg' });
});

test('playlist ownership is caller supplied and remote counts are not falsely treated as completeness', () => {
  const mapped = mapPlaylist({ item_type: 'playlist', playlist: {
    id: '7123456789012345678', title: '歌单', count_tracks: 1,
    owner: { id: 'owner-id', nickname: '创建者' }, url_cover: { urls: ['https://p3-luna.douyinpic.com/playlist.jpg'] },
    tracks: [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }],
  } }, true);
  assert.equal(mapped.mine, true);
  assert.equal(mapped.owner, '创建者');
  assert.equal(mapped.trackCount, 1);
  assert.equal(mapped.tracks.length, 2);
  assert.equal(mapPlaylist({ id: 'public', title: 'public' }, false).saved, undefined);
});

test('word lyric offsets become absolute timestamps while preserving text and punctuation', () => {
  const parsed = parseQishuiLyrics('[32570,1100]<0,370,0>听<440,370,0>说，<810,290,0>你\r\n[35000,1000]没有逐字时间');
  assert.deepEqual(plain(parsed), { lines: [
    { start: 32570, end: 33670, text: '听说，你', words: [
      { start: 32570, end: 32940, text: '听' }, { start: 33010, end: 33380, text: '说，' }, { start: 33380, end: 33670, text: '你' },
    ] },
    { start: 35000, end: 36000, text: '没有逐字时间' },
  ] });
});

test('metadata, malformed and unsafe lyric timing do not create NaN or invented timestamps', () => {
  const parsed = parseQishuiLyrics('[ar:演唱者]\n[9007199254740991,10]overflow\n[4000,500]<0,900,0>A<800,20,0>B\n[1000,200]先前的一行\n[xx,200]bad\n[8000,200]<oops>text');
  assert.deepEqual(plain(parsed), { lines: [
    { start: 1000, end: 1200, text: '先前的一行' },
    { start: 4000, end: 4500, text: 'AB', words: [{ start: 4000, end: 4500, text: 'A' }] },
    { start: 8000, end: 8200, text: 'text' },
  ] });
  assert.deepEqual(plain(parseQishuiLyrics(null)), { lines: [] });
});
