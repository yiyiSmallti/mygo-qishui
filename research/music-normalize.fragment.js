// Pure Qishui -> MyGo normalization. Assisted-by: Cindy (https://cindy.app)
// IDs are never coerced from objects or unsafe IEEE-754 numbers.
function safeId(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function qnText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function qnFirstId(...values) {
  for (const value of values) { const id = safeId(value); if (id) return id; }
  return '';
}

function qnNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function qnHttps(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

function imageURL(value) {
  if (typeof value === 'string') return qnHttps(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const candidates = Array.isArray(value.urls) ? value.urls : Array.isArray(value.url_list) ? value.url_list : [];
  let base = '';
  for (const candidate of candidates) {
    base = qnHttps(candidate);
    if (base) break;
  }
  if (!base) return qnHttps(value.url) || qnHttps(value.imageUrl);
  const uri = qnText(value.uri);
  if (!uri || value.need_complete_url === true) return base;
  const url = new URL(base);
  // Official URL prefixes end in '/'. A complete image URL must not have
  // uri appended a second time, including extensionless signed images.
  if (!url.pathname.endsWith('/') || url.search || url.hash) return base;
  if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//') || /[\\\u0000-\u001f\u007f?#]/.test(uri)) return '';
  const parts = uri.replace(/^\/+/, '').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) return '';
  const prefix = qnText(value.template_prefix);
  if (prefix && !/^[a-z\d_:.-]+$/i.test(prefix)) return '';
  const suffix = prefix ? prefix + '-crop-center:400:400.jpg' : 'c5_400x400.jpg';
  url.pathname += parts.join('/') + '~' + suffix;
  return url.href;
}

function mapArtist(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const info = record.user_info && typeof record.user_info === 'object' ? record.user_info : record;
  const artistId = qnFirstId(record.id, record.artist_id, info.artist_id);
  const userId = record.user_info ? safeId(info.id) : '';
  // A track's UGC uploader is a user, not an artist. Keep that distinction
  // so the detail route requests /users/{id}, never /artists/{userId}.
  const id = artistId || (userId ? 'user:' + userId : '');
  const name = artistId
    ? qnText(record.name) || qnText(info.nickname) || qnText(info.name)
    : qnText(info.nickname) || qnText(info.name) || qnText(record.name);
  if (!id || !name) return null;
  const artist = { id, name };
  const image = imageURL(info.medium_avatar_url) || imageURL(info.thumb_avatar_url) || imageURL(info.url_avatar) || imageURL(info.imageUrl);
  if (image) artist.imageUrl = image;
  if (record.following === true || record.state?.is_following === true) artist.following = true;
  return artist;
}

function mapAlbum(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record.album && typeof record.album === 'object' ? record.album : record;
  const id = qnFirstId(raw.id, raw.album_id);
  const name = qnText(raw.name) || qnText(raw.title);
  if (!id || !name) return null;
  const album = { id, name };
  const image = imageURL(raw.url_cover) || imageURL(raw.imageUrl) || imageURL(raw.cover);
  if (image) album.imageUrl = image;
  if (Array.isArray(raw.artists)) {
    const artists = raw.artists.map(mapArtist).filter(Boolean);
    if (artists.length) album.artists = artists;
  }
  const released = qnText(raw.release_date) || qnText(raw.released);
  if (released) album.released = released;
  if (raw.saved === true || raw.state?.is_collected === true) album.saved = true;
  return album;
}

function mapTrack(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.entity && record.type && record.type !== 'track') return null;
  const raw = record.entity?.track_wrapper?.track || record.entity?.track || record.track_wrapper?.track || record.track || record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = qnFirstId(raw.id, raw.track_id);
  const name = qnText(raw.name) || qnText(raw.title);
  if (!id || !name) return null;
  const duration = qnNumber(raw.duration) ?? qnNumber(raw.duration_ms) ?? 0;
  const rawAlbum = raw.album && typeof raw.album === 'object' && !Array.isArray(raw.album) ? raw.album : null;
  const album = mapAlbum(rawAlbum) || { id: '', name: qnText(rawAlbum?.name) || qnText(rawAlbum?.title) };
  if (!album.imageUrl) {
    // UGC can have artwork and a title without a real album ID. MyGo displays
    // this metadata without making the empty-ID album a navigation target.
    const image = imageURL(rawAlbum?.url_cover) || imageURL(rawAlbum?.imageUrl) || imageURL(rawAlbum?.cover)
      || imageURL(raw.url_cover) || imageURL(raw.imageUrl);
    if (image) album.imageUrl = image;
  }
  const track = {
    id: ['ugc_clip', 'ugc_video'].includes(raw.media_type) ? raw.media_type + ':' + id : id,
    name, album, duration,
    artists: Array.isArray(raw.artists) ? raw.artists.map(mapArtist).filter(Boolean) : [],
  };
  const shareURL = qnHttps(raw.share_url) || qnHttps(raw.url);
  if (shareURL) track.url = shareURL;
  if (raw.unavailable === true) track.unavailable = true;
  return track;
}

function mapPlaylist(record, mine) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const raw = record.playlist || record.entity?.playlist || record;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = qnFirstId(raw.id, raw.playlist_id);
  const name = qnText(raw.title) || qnText(raw.name);
  if (!id || !name) return null;
  const playlist = { id, name, mine: typeof mine === 'boolean' ? mine : raw.mine === true };
  const image = imageURL(raw.url_cover) || imageURL(raw.imageUrl) || imageURL(raw.cover);
  if (image) playlist.imageUrl = image;
  const description = qnText(raw.description) || qnText(raw.desc);
  if (description) playlist.description = description;
  const owner = qnText(raw.owner?.nickname) || qnText(raw.owner?.name) || qnText(raw.owner);
  if (owner) playlist.owner = owner;
  const count = qnNumber(raw.count_tracks) ?? qnNumber(raw.trackCount) ?? qnNumber(raw.stats?.count_visible);
  if (count !== null) playlist.trackCount = count;
  if (raw.saved === true || raw.state?.is_collected === true) playlist.saved = true;
  if (Array.isArray(raw.tracks)) {
    playlist.tracks = raw.tracks.map(mapTrack).filter(Boolean);
    // A remote count can be stale; keep it unless the caller knows it has
    // fetched every page. Callers own that completeness decision.
  }
  return playlist;
}

function parseQishuiLyrics(content) {
  const lines = [];
  if (typeof content !== 'string') return { lines };
  for (const source of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*\[(\d+),(\d+)\](.*)$/.exec(source);
    if (!match) continue;
    const start = qnNumber(match[1]), duration = qnNumber(match[2]);
    if (start === null || duration === null || !Number.isSafeInteger(start + duration)) continue;
    const end = start + duration, body = match[3];
    const tags = [...body.matchAll(/<([^>]*)>/g)];
    const text = body.replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    const words = [];
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i], fields = /^(\d+),(\d+),[^,]*$/.exec(tag[1]);
      if (!fields) continue;
      const offset = qnNumber(fields[1]), length = qnNumber(fields[2]);
      const wordText = body.slice(tag.index + tag[0].length, i + 1 < tags.length ? tags[i + 1].index : body.length);
      if (offset === null || length === null || !wordText || offset > duration || !Number.isSafeInteger(start + offset + length)) continue;
      words.push({ start: start + offset, end: Math.min(end, start + offset + length), text: wordText });
    }
    const line = { start, end, text };
    if (words.length) line.words = words;
    lines.push(line);
  }
  lines.sort((a, b) => a.start - b.start);
  return { lines };
}
