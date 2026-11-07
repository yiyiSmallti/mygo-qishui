// Read-only Qishui recommendations for MyGo stations()/stationNext({id}).
// Source: Soda Music 3.7.0 public source maps, feed.ts/feedmode.ts/radio.ts.
// Assisted-by: Cindy (https://cindy.app)
// Integration: createRecommendationService({api:musicApi, mapTrack, mapPlaylist,
//   imageURL, contextKey:()=>musicContext().key, failure}).
// Export service.stations / service.stationNext; use service.catalog for home.
function createRecommendationService(deps) {
  const { api, mapTrack, imageURL, contextKey } = deps;
  const now = deps.now || (() => Date.now());
  const fail = deps.failure || (message => new Error(message));
  const CACHE_MS = 10 * 60 * 1000;
  const MAX_SEEN = 1000;
  let current;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const idString = value => typeof value === 'string' ? value.trim()
    : Number.isSafeInteger(value) ? String(value) : '';

  function context() {
    const key = contextKey(); // Must reject if not signed in.
    if (!current || current.key !== key) current = {
      key, catalog: null, catalogAt: 0, loading: null, discovered: false,
      descriptors: new Map(), states: new Map(),
    };
    return current;
  }
  function assertCurrent(ctx) {
    if (current !== ctx || contextKey() !== ctx.key)
      throw fail('账号已变化，请重新打开推荐。');
  }
  function card(id, name, description, artwork) {
    const result = {id, name};
    if (description) result.description = description;
    // Scene URLInfo is a small white UI glyph, not an album cover. A JPEG
    // crop from that endpoint is solid white; use bundled, opaque cards.
    const cover = deps.stationArtwork?.(id) || imageURL(artwork);
    if (cover) result.imageUrl = cover;
    return result;
  }
  function register(ctx, descriptor, target, seen) {
    if (!descriptor?.card?.id || !descriptor.card.name || seen.has(descriptor.card.id)) return;
    seen.add(descriptor.card.id);
    ctx.descriptors.set(descriptor.card.id, descriptor);
    target.push(descriptor.card);
  }
  function copyCatalog(value) {
    return {title:value.title, primary:value.primary.map(v=>({...v})), scenes:value.scenes.map(v=>({...v})),
      radios:value.radios.map(v=>({...v})), playlists:value.playlists.map(v=>({...v}))};
  }
  function baseCatalog(ctx) {
    const result = {title:'为你推荐', primary:[], scenes:[], radios:[], playlists:[]};
    const seen = new Set();
    for (const [id, name, description, preference] of [
      ['recommend', '个性推荐', '懂你口味，连续推荐', null],
      ['familiar', '熟悉模式', '重逢熟悉的好音乐', {preference_mode:'familiar'}],
      ['fresh', '新鲜模式', '发现没听过的好歌', {preference_mode:'fresh'}],
    ]) register(ctx, {kind:'feed', preference, card:card(id,name,description)}, result.primary, seen);
    return {result, seen};
  }
  async function loadCatalog(ctx) {
    if (ctx.catalog && now() - ctx.catalogAt < CACHE_MS) return ctx.catalog;
    if (ctx.loading) return ctx.loading;
    const load = (async () => {
      const [modes, discover] = await Promise.all([
        api('/luna/pc/feed/mode', {}, {}),
        api('/luna/pc/discover', {}, {first_request:!ctx.discovered,pc_new_discover_request:true}),
      ]);
      assertCurrent(ctx);
      if (!Array.isArray(modes?.feed_mode_block) || !Array.isArray(discover?.blocks))
        throw fail('汽水返回的听歌模式格式无效，请稍后刷新。');
      const {result, seen} = baseCatalog(ctx);
      for (const block of modes.feed_mode_block) {
        for (const mode of Array.isArray(block?.feed_mode) ? block.feed_mode : []) {
          const scene = mode?.entity?.feed_scene_mode;
          if (mode?.type !== 'scene_mode' || !Number.isSafeInteger(scene?.scene_mode_id) || scene.scene_mode_id < 0) continue;
          const id = 'scene:' + scene.scene_mode_id;
          register(ctx, {kind:'feed', preference:{scene_mode_id:scene.scene_mode_id},
            card:card(id,text(mode.text),'',mode.url_info)}, result.scenes, seen);
        }
      }
      for (const block of discover.blocks) {
        if (block?.type !== 'discover_playlist_mix' && block?.type !== 'discover_feed_playlist') continue;
        if (text(block.title)) result.title = text(block.title);
        for (const inner of Array.isArray(block.inner_block) ? block.inner_block : []) {
          for (const resource of Array.isArray(inner?.resources) ? inner.resources : []) {
            if (resource?.type === 'playlist') {
              const style = resource.style || {};
              const raw = resource.entity?.playlist || {id:resource.resource_id,title:style.title,
                description:style.desc,url_cover:style.cover_url_list?.[0]};
              const playlist = deps.mapPlaylist?.(raw, false);
              if (playlist && !seen.has('playlist:' + playlist.id)) {
                seen.add('playlist:' + playlist.id);
                result.playlists.push(playlist);
              }
              continue;
            }
            if (resource?.type !== 'radio') continue;
            const radioId = idString(resource.resource_id);
            if (!radioId || radioId.length > 256 || /[\u0000-\u001f\u007f]/.test(radioId)) continue;
            const style = resource.style || {};
            // Read parameters from a first-party internal link; never navigate it.
            let flowType = 2, triggerInfo = '';
            try {
              const link = new URL(style.link);
              if (link.protocol === 'luna:') {
                const rawFlow = link.searchParams.get('flow_type');
                if (rawFlow && /^\d{1,2}$/.test(rawFlow)) flowType = Number(rawFlow);
                triggerInfo = (link.searchParams.get('trigger_info') || '').slice(0,2048);
              }
            } catch (_) {}
            register(ctx, {kind:'radio', radioId, flowType, triggerInfo,
              card:card('radio:' + radioId,text(style.title)||text(inner.title),text(style.desc),style.cover_url_list?.[0])}, result.radios, seen);
          }
        }
      }
      // Keep descriptors used by an active queue even if a refreshed catalog changes.
      for (const id of ctx.descriptors.keys()) {
        if (ctx.descriptors.size <= 256) break;
        if (!seen.has(id) && !ctx.states.has(id)) ctx.descriptors.delete(id);
      }
      ctx.catalog = result;
      ctx.catalogAt = now();
      ctx.discovered = true;
      return result;
    })();
    ctx.loading = load;
    try {return await load} finally {if (ctx.loading === load) ctx.loading = null;}
  }
  async function catalog() {
    const ctx = context();
    const value = await loadCatalog(ctx);
    assertCurrent(ctx);
    return copyCatalog(value);
  }
  async function stations() {
    const value = await catalog();
    return [...value.primary, ...value.scenes, ...value.radios];
  }
  function stateFor(ctx, id) {
    let state = ctx.states.get(id);
    if (!state) {
      if (ctx.states.size >= 12) {
        const idle = [...ctx.states.entries()].filter(([,v])=>!v.pending).sort((a,b)=>a[1].at-b[1].at)[0];
        if (idle) ctx.states.delete(idle[0]);
      }
      state = {requests:0,cursor:'',done:false,seen:new Set(),pending:null,at:now()};
      ctx.states.set(id,state);
    }
    return state;
  }
  async function fetchNext(ctx, descriptor, state) {
    assertCurrent(ctx);
    if (state.done) return [];
    state.at = now();
    let body, route;
    if (descriptor.kind === 'radio') {
      route = '/luna/pc/feed/radio/tracks';
      body = {radio_id:descriptor.radioId,cursor:state.cursor,flow_type:descriptor.flowType,trigger_info:descriptor.triggerInfo};
    } else {
      route = '/luna/pc/feed/song-tab';
      body = {is_first_request:state.requests===0,is_did_first_request:false,feed_counts:{mix_session_count:state.requests}};
      if (descriptor.preference) body.feed_preference = {...descriptor.preference};
    }
    // No played_media, invented play counts, collection writes, or listening reports.
    const response = await api(route, {}, body);
    assertCurrent(ctx);
    if (!Array.isArray(response?.items)) throw fail('汽水返回的推荐歌曲格式无效，请稍后重试。');
    if (descriptor.kind === 'radio' && response.has_more === true
        && (typeof response.next_cursor !== 'string' || !response.next_cursor || response.next_cursor === state.cursor))
      throw fail('汽水电台的下一页信息无效，请重新打开电台。');
    const tracks = [];
    for (const item of response.items) {
      if (item?.type !== 'track') continue;
      const raw = item.entity?.track_wrapper?.track || item.entity?.track;
      if (!raw || (raw.media_type && !['track','ugc_clip'].includes(raw.media_type))) continue;
      const track = mapTrack(item);
      if (!track?.id || track.unavailable || state.seen.has(track.id)) continue;
      state.seen.add(track.id);
      tracks.push(track);
    }
    while (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value);
    if (descriptor.kind === 'radio' && typeof response.next_cursor === 'string') state.cursor = response.next_cursor;
    state.done = response.has_more === false;
    state.requests++;
    return tracks;
  }
  async function stationNext({id} = {}) {
    if (typeof id !== 'string' || !id) throw fail('请选择要播放的汽水电台。');
    const ctx = context();
    if (!ctx.descriptors.has('recommend')) baseCatalog(ctx);
    if (!ctx.descriptors.has(id)) await loadCatalog(ctx);
    assertCurrent(ctx);
    const descriptor = ctx.descriptors.get(id);
    if (!descriptor) throw fail('此汽水电台已更新，请重新打开听歌模式。');
    const state = stateFor(ctx,id);
    // Serialize same-station requests: simultaneous host calls must not repeat a batch.
    const load = Promise.resolve(state.pending).catch(()=>{}).then(()=>fetchNext(ctx,descriptor,state));
    state.pending = load;
    try {return await load} finally {if (state.pending === load) state.pending = null;}
  }
  return {catalog,stations,stationNext,reset(){current = null;}};
}
