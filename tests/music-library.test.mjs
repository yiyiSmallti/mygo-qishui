import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the assembled plugin, so a stale merged fragment cannot pass alone.
const source = await readFile(new URL('../qishui-account/index.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const track = id => ({ id: String(id), name: 'song ' + id, duration: 1000 });
const tracks = (start, count) => Array.from({ length: count }, (_, i) => track(start + i));
const list = (id, type = 2, owner = 'account-a') => ({ id, title: 'list ' + id, type, owner: { id: owner, nickname: owner }, count_tracks: 1 });
const emptyMixed = { mixed_collections: [], has_more: false };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(api) {
  const storage = new Map();
  const calls = [];
  const setSession = id => {
    if (!id) storage.delete('qishui-session-v1');
    else storage.set('qishui-session-v1', { account: { id, name: id }, jar: { 'sessionid|/': { name: 'sessionid', value: 'fixture-session', path: '/', expires: 0 } } });
  };
  setSession('account-a');
  const context = vm.createContext({
    URL, setTimeout, clearTimeout,
    host: { storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) } },
    testApi: async (route, params) => {
      const call = { route, params: plain(params), account: storage.get('qishui-session-v1')?.account.id };
      calls.push(call);
      return api(call, calls);
    },
  });
  vm.runInContext(source.replace(/^export\s+/gm, '') + `
    musicApi = testApi;
    account = async () => readStored()?.account || null;
    this.plugin = { playlists, playlist, liked, savedAlbums, home, browse, search, signOut };
    this.changeGeneration = () => { generation++; };
  `, context);
  return {
    plugin: context.plugin, calls,
    changeAccount(id) { setSession(id); context.changeGeneration(); },
  };
}

test('playlist discovery follows all cursors and keeps owned and saved lists distinct', async () => {
  const { plugin, calls } = setup(({ route, params }) => {
    if (route.endsWith('/me/playlist')) return params.cursor === ''
      ? { playlists: [list('owned'), list('liked', 1), list('douyin', 4)], has_more: true, next_cursor: 'own-next' }
      : { playlists: [list('owned'), list('second')], has_more: false };
    if (route.endsWith('/collection/mixed')) return params.cursor === ''
      ? { mixed_collections: [{ item_type: 'playlist', playlist: list('owned') }, { item_type: 'playlist', playlist: list('liked') }, { item_type: 'album', album: { id: 'album', name: 'album' } }], has_more: true, next_cursor: 'mixed-next' }
      : { mixed_collections: [{ item_type: 'playlist', playlist: list('saved', 2, 'someone-else') }], has_more: false };
    throw new Error('unexpected route ' + route);
  });
  const result = plain(await plugin.playlists());
  assert.deepEqual(result.map(item => [item.id, item.mine, item.saved === true]), [
    ['owned', true, false], ['douyin', true, false], ['second', true, false], ['saved', false, true],
  ]);
  assert.deepEqual(calls.filter(call => call.route.endsWith('/me/playlist')).map(call => call.params.cursor), ['', 'own-next']);
  assert.deepEqual(calls.filter(call => call.route.endsWith('/collection/mixed')).map(call => call.params.cursor), ['', 'mixed-next']);
});

test('liked navigation replaces its duplicate playlist cards without removing songs or real collections', async () => {
  const { plugin } = setup(({ route, params }) => {
    if (route.endsWith('/me/playlist')) return { playlists: [list('liked', '1'), list('douyin', 4), list('owned')], has_more: false };
    if (route.endsWith('/collection/mixed')) return { mixed_collections: [
      { item_type: 'playlist', playlist: list('liked') },
      { item_type: 'playlist', playlist: list('saved', 2, 'someone-else') },
      { item_type: 'album', album: { id: 'saved-album', name: '收藏专辑' } },
    ], has_more: false };
    if (route.endsWith('/playlist/detail')) return { playlist: list(params.playlist_id, params.playlist_id === 'liked' ? 1 : 4),
      media_resources: [track('shared-song')], has_more: false };
    throw new Error('unexpected route ' + route);
  });
  const sidebar = await plugin.playlists(), home = await plugin.home(), library = await plugin.browse({ page: 'library' });
  for (const cards of [sidebar, home.sections.flatMap(section => section.playlists || []), library.sections.flatMap(section => section.playlists || [])]) {
    assert.deepEqual(plain(cards).map(item => item.id), ['douyin', 'owned', 'saved']);
  }
  assert.equal(home.sections.find(section => section.title === '喜欢的音乐').tracks[0].id, 'shared-song');
  assert.equal(library.sections.find(section => section.title === '喜欢的音乐').tracks[0].id, 'shared-song');
  assert.equal(library.sections.find(section => section.title === '抖音收藏').tracks[0].id, 'shared-song');
  assert.equal(library.sections.find(section => section.title === '收藏的专辑').albums[0].id, 'saved-album');
  assert.equal((await plugin.savedAlbums()).albums[0].id, 'saved-album');
  assert.equal((await plugin.liked()).tracks[0].id, 'shared-song');
});

test('a library containing only liked songs is not mislabeled empty after hiding the liked playlist card', async () => {
  const { plugin } = setup(({ route }) => {
    if (route.endsWith('/me/playlist')) return { playlists: [list('liked', 1)], has_more: false };
    if (route.endsWith('/collection/mixed')) return emptyMixed;
    return { playlist: list('liked', 1), media_resources: [track('favorite')], has_more: false };
  });
  assert.deepEqual(plain(await plugin.playlists()), []);
  const library = await plugin.browse({ page: 'library' });
  assert.equal(library.subtitle, '当前账号的歌单、喜欢和收藏');
  assert.equal(library.sections.find(section => section.title === '喜欢的音乐').tracks[0].id, 'favorite');
});

test('concurrent library consumers share each pending page instead of skipping or fetching it twice', async () => {
  const own = deferred(), mixed = deferred();
  const { plugin, calls } = setup(({ route }) => route.endsWith('/me/playlist') ? own.promise : mixed.promise);
  const first = plugin.playlists(), second = plugin.playlists();
  assert.equal(calls.length, 2);
  own.resolve({ playlists: [list('owned')], has_more: false });
  mixed.resolve(emptyMixed);
  const results = await Promise.all([first, second]);
  assert.deepEqual(plain(results[0]), plain(results[1]));
  assert.equal(calls.length, 2);
});

test('liked uses displayed offsets across API cursor pages and ignores stale remote counts', async () => {
  const { plugin, calls } = setup(({ route, params }) => {
    if (route.endsWith('/me/playlist')) return { playlists: [list('liked', 1)], has_more: false };
    if (route.endsWith('/playlist/detail')) return params.cursor === ''
      ? { playlist: list('liked', 1), media_resources: tracks(0, 100), has_more: true, next_cursor: 'last' }
      : { playlist: list('liked', 1), media_resources: tracks(100, 23), has_more: false };
    throw new Error('unexpected route ' + route);
  });
  const first = await plugin.liked({ offset: 0 });
  const middle = await plugin.liked({ offset: 50 });
  const last = await plugin.liked({ offset: 100 });
  assert.deepEqual(plain(first.tracks).map(item => item.id), tracks(0, 50).map(item => item.id));
  assert.deepEqual(plain(middle.tracks).map(item => item.id), tracks(50, 50).map(item => item.id));
  assert.deepEqual(plain(last.tracks).map(item => item.id), tracks(100, 23).map(item => item.id));
  assert.deepEqual([first.more, middle.more, last.more], [true, true, false]);
  assert.equal(calls.filter(call => call.route.endsWith('/playlist/detail')).length, 2);
});

test('invalid or duplicate track rows do not consume displayed pagination offsets', async () => {
  const { plugin } = setup(({ route, params }) => {
    if (route.endsWith('/me/playlist')) return { playlists: [list('liked', 1)], has_more: false };
    return params.cursor === ''
      ? { playlist: list('liked', 1), media_resources: [...tracks(0, 49), track(0), { name: 'missing ID' }], has_more: true, next_cursor: 'tail' }
      : { playlist: list('liked', 1), media_resources: [track(48), track(49), track(50)], has_more: false };
  });
  const first = await plugin.liked({ offset: 0 });
  const last = await plugin.liked({ offset: 50 });
  assert.equal(first.tracks.length, 50);
  assert.equal(first.tracks[49].id, '49');
  assert.equal(first.more, true);
  assert.deepEqual(plain(last.tracks).map(item => item.id), ['50']);
  assert.equal(last.more, false);
});

test('playlist recovery labels partial results and retries a failed cursor without losing songs', async () => {
  let secondPageAttempts = 0;
  const { plugin, calls } = setup(({ params }) => {
    if (params.cursor === '') return { playlist: list('songs'), media_resources: [track('a')], has_more: true, next_cursor: 'next' };
    secondPageAttempts++;
    if (secondPageAttempts === 1) return { playlist: list('songs'), media_resources: [track('not-committed')], has_more: true, next_cursor: 'next' };
    return { playlist: list('songs'), media_resources: [track('a'), track('b')], has_more: false };
  });
  const partial = await plugin.playlist({ id: 'songs' });
  assert.deepEqual(plain(partial.tracks).map(item => item.id), ['a']);
  assert.match(partial.description, /尚未完整载入/);
  assert.equal(partial.trackCount, 1);
  // A native consumer may modify its returned array; this must not alter the cache.
  partial.tracks.push(track('local-only'));
  const complete = await plugin.playlist({ id: 'songs' });
  assert.deepEqual(plain(complete.tracks).map(item => item.id), ['a', 'b']);
  assert.equal(complete.trackCount, 2);
  assert.equal(complete.description, undefined);
  assert.deepEqual(calls.map(call => call.params.cursor), ['', 'next', 'next']);
});

test('discovery rejects missing and repeated cursors instead of silently returning an incomplete list', async () => {
  for (const nextCursor of ['', 'first']) {
    const { plugin } = setup(({ route, params }) => {
      if (route.endsWith('/collection/mixed')) return emptyMixed;
      if (!params.cursor) return { playlists: [list('one')], has_more: true, next_cursor: 'first' };
      return { playlists: [list('two')], has_more: true, next_cursor: nextCursor };
    });
    await assert.rejects(plugin.playlists(), /重复或缺失的分页游标/);
  }
});

test('playlist details from a different ID are rejected before accepting their songs', async () => {
  const { plugin } = setup(() => ({ playlist: list('wrong-id'), media_resources: [track('a')], has_more: false }));
  await assert.rejects(plugin.playlist({ id: 'requested-id' }), /与请求不一致/);
});

test('switching accounts while pages are pending rejects old results and isolates the new cache', async () => {
  const oldOwn = deferred(), oldMixed = deferred();
  const { plugin, changeAccount, calls } = setup(({ route, account }) => {
    if (account === 'account-a') return route.endsWith('/me/playlist') ? oldOwn.promise : oldMixed.promise;
    return route.endsWith('/me/playlist') ? { playlists: [list('new-account-list', 2, account)], has_more: false } : emptyMixed;
  });
  const pending = plugin.playlists();
  const oldResult = assert.rejects(pending, /账号已变化/);
  changeAccount('account-b');
  const current = await plugin.playlists();
  oldOwn.resolve({ playlists: [list('private-old-list')], has_more: false });
  oldMixed.resolve(emptyMixed);
  await oldResult;
  assert.deepEqual(plain(current).map(item => item.id), ['new-account-list']);
  assert.deepEqual(plain(await plugin.playlists()).map(item => item.id), ['new-account-list']);
  assert.equal(calls.filter(call => call.account === 'account-b').length, 2);
});

test('signing out during loading rejects the pending read and requires login for the next read', async () => {
  const gate = deferred();
  const { plugin } = setup(({ route }) => route.endsWith('/me/playlist') ? gate.promise : emptyMixed);
  const pending = plugin.playlists();
  const oldResult = assert.rejects(pending, /账号已变化/);
  plugin.signOut();
  gate.resolve({ playlists: [list('private-old-list')], has_more: false });
  await oldResult;
  await assert.rejects(plugin.playlists(), error => error.code === 'signIn');
});

test('cached reads recheck the account after asynchronous boundaries before returning private data', async () => {
  for (const action of [plugin => plugin.liked(), plugin => plugin.savedAlbums(), plugin => plugin.browse({ page: 'library/playlists' })]) {
    const { plugin } = setup(({ route }) => {
      if (route.endsWith('/me/playlist')) return { playlists: [list('liked', 1)], has_more: false };
      if (route.endsWith('/collection/mixed')) return { mixed_collections: [{ item_type: 'album', album: { id: 'private-album', name: 'private' } }], has_more: false };
      return { playlist: list('liked', 1), media_resources: [track('private-song')], has_more: false };
    });
    await action(plugin);
    const pending = action(plugin);
    plugin.signOut();
    await assert.rejects(pending, /账号已变化/);
  }
});

test('saved albums page after mixed collection filtering, not raw API row positions', async () => {
  const entries = Array.from({ length: 61 }, (_, i) => ({ item_type: 'album', album: { id: 'album-' + i, name: 'album ' + i } }));
  const { plugin, calls } = setup(({ params }) => params.cursor === ''
    ? { mixed_collections: [{ item_type: 'playlist', playlist: list('not-an-album') }, ...entries.slice(0, 40)], has_more: true, next_cursor: 'next' }
    : { mixed_collections: [...entries.slice(40), entries[0]], has_more: false });
  const first = await plugin.savedAlbums({ offset: 0 });
  const last = await plugin.savedAlbums({ offset: 50 });
  assert.equal(first.albums.length, 50);
  assert.equal(last.albums.length, 11);
  assert.equal(last.albums[0].id, 'album-50');
  assert.equal(first.more, true);
  assert.equal(last.more, false);
  assert.ok([...first.albums, ...last.albums].every(item => item.saved === true));
  assert.equal(calls.length, 2);
});

test('invalid offsets are rejected before any private library request', async () => {
  const { plugin, calls } = setup(() => { throw new Error('must not request'); });
  for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
    await assert.rejects(plugin.liked({ offset }), /分页参数无效/);
    await assert.rejects(plugin.savedAlbums({ offset }), /分页参数无效/);
  }
  assert.equal(calls.length, 0);
});

test('concurrent equal searches share a pending page while different queries can run independently', async () => {
  const firstGate = deferred(), secondGate = deferred();
  const { plugin, calls } = setup(({ params }) => params.q === 'first' ? firstGate.promise : secondGate.promise);
  const one = plugin.search({ query: 'first' });
  const duplicate = plugin.search({ query: 'first' });
  const another = plugin.search({ query: 'second' });
  const callCounts = { first: calls.filter(call => call.params.q === 'first').length, second: calls.filter(call => call.params.q === 'second').length };
  firstGate.resolve({ result_groups: [{ id: 'tracks', data: [track('first-result')], has_more: false }] });
  secondGate.resolve({ result_groups: [{ id: 'tracks', data: [track('second-result')], has_more: false }] });
  const values = await Promise.all([one, duplicate, another]);
  assert.deepEqual(callCounts, { first: 1, second: 1 });
  assert.deepEqual(plain(values).map(result => result.tracks.map(item => item.id)), [['first-result'], ['first-result'], ['second-result']]);
});

test('search does not cache a page with an invalid cursor and can retry it', async () => {
  let attempts = 0;
  const { plugin, calls } = setup(() => {
    attempts++;
    return attempts === 1
      ? { result_groups: [{ id: 'tracks', data: [track('must-not-commit')], has_more: true, next_cursor: '0' }] }
      : { result_groups: [{ id: 'tracks', data: [track('valid-result')], has_more: false }] };
  });
  await assert.rejects(plugin.search({ query: 'term' }), /游标/);
  const result = await plugin.search({ query: 'term' });
  assert.deepEqual(plain(result.tracks).map(item => item.id), ['valid-result']);
  assert.equal(calls.length, 2);
});
