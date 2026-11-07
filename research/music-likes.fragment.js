// Qishui likes: isLiked is read-only; like writes only when the host calls it
// in response to the listener pressing the heart or its keyboard shortcut.
// Source: Soda Music 3.7.0 app.asar main.js.map collect.ts and contract/me.ts.
// Assisted-by: Cindy (https://cindy.app)
// Integrate with createLikesService({api:(...a)=>musicApi(...a),
//   contextKey:()=>musicContext().key, onChanged:invalidateLikedCaches, failure}).
// Export service.isLiked and service.like. No read path invokes service.like.
function createLikesService(deps) {
  const {api,contextKey}=deps;
  const fail=deps.failure||((message,code)=>Object.assign(new Error(message),code?{code}:{}));
  const pause=deps.pause||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let current;
  function identity(value) {
    if(typeof value!=='string')throw fail('歌曲标识无效。','unavailable');
    const match=/^(?:(ugc_clip):)?([1-9]\d{0,31})$/.exec(value);
    if(!match)throw fail('这类作品暂不支持修改喜欢状态。','unsupported');
    return{hostId:value,id:match[2],type:match[1]||'track'};
  }
  function context() {
    const key=contextKey(); // Throws if the account is no longer signed in.
    if(!current||current.key!==key)current={key,writes:new Map(),revisions:new Map()};
    return current;
  }
  function assertCurrent(ctx) {
    if(current!==ctx||contextKey()!==ctx.key)throw fail('账号已变化，请重新查看喜欢状态。');
  }
  function checkResponse(response,requireAck=false) {
    if(!response||typeof response!=='object'||Array.isArray(response))throw fail('汽水未返回有效的喜欢状态。');
    const values=[response.status_code,response.status_info?.code,response.status_info?.status_code]
      .filter(v=>v!==undefined&&v!==null&&v!=='');
    const bad=values.find(v=>!Number.isFinite(Number(v))||Number(v)!==0);
    if(bad!==undefined) {
      const code=/^\d{1,9}$/.test(String(bad))?String(Number(bad)):'unknown';
      // Official 1000057 is a temporary optimistic display, not confirmed success.
      throw fail('汽水未确认此喜欢操作（'+code+'），请稍后重试。',code==='1000016'?'signIn':undefined);
    }
    if(requireAck&&!values.length&&!(typeof response.status_info?.log_id==='string'&&response.status_info.log_id)
        &&!Array.isArray(response.collected_media)&&!Array.isArray(response.deleted_media))
      throw fail('汽水未确认喜欢操作，请稍后刷新状态。');
  }
  function revision(ctx,id) {return ctx.revisions.get(id)||0;}
  async function readState(ctx,media) {
    const result={};
    for(let offset=0;offset<media.length;offset+=50) {
      const batch=media.slice(offset,offset+50);
      assertCurrent(ctx);
      const response=await api('/luna/media',{},{scene:'playlist',media:batch.map(({id,type})=>({id,type}))});
      assertCurrent(ctx);
      checkResponse(response);
      if(!Array.isArray(response.media))throw fail('汽水未返回有效的歌曲喜欢状态。');
      const requested=new Map(batch.map(item=>[item.type+':'+item.id,item.hostId]));
      for(const item of response.media) {
        const raw=item?.entity?.track_wrapper?.track||item?.entity?.track;
        if(!raw||typeof raw.id!=='string'||!raw.state||typeof raw.state!=='object'||Array.isArray(raw.state))continue;
        const collected=raw.state.is_collected;
        if(collected!==undefined&&collected!==null&&typeof collected!=='boolean')continue;
        const type=typeof raw.media_type==='string'?raw.media_type:item.type;
        const hostId=requested.get(type+':'+raw.id);
        // The server emits state:{} for an unliked track. The official PC
        // queue and bottom player both use state?.is_collected ?? false.
        if(hostId)result[hostId]=collected??false;
      }
      if(batch.some(item=>!Object.prototype.hasOwnProperty.call(result,item.hostId)))
        throw fail('汽水未确认部分歌曲的喜欢状态，请稍后重试。');
    }
    return result;
  }
  async function isLiked({ids}={}) {
    if(!Array.isArray(ids)||ids.length>200)throw fail('需要查询的歌曲数量无效。');
    const media=[...new Set(ids)].map(identity);
    const ctx=context();
    if(!media.length)return{};
    // A concurrent click must not be overwritten by an earlier read response.
    for(let attempt=0;attempt<2;attempt++) {
      const pending=media.map(item=>ctx.writes.get(item.hostId)).filter(Boolean);
      if(pending.length)await Promise.allSettled(pending);
      assertCurrent(ctx);
      const versions=media.map(item=>revision(ctx,item.hostId));
      const result=await readState(ctx,media);
      assertCurrent(ctx);
      if(media.every((item,index)=>revision(ctx,item.hostId)===versions[index]))return result;
    }
    throw fail('喜欢状态正在更新，请稍后重试。');
  }
  async function like({id,on}={}) {
    if(typeof on!=='boolean')throw fail('喜欢操作必须明确指定添加或取消。');
    const media=identity(id),ctx=context();
    const previous=ctx.writes.get(id);
    ctx.revisions.set(id,revision(ctx,id)+1);
    const work=Promise.resolve(previous).catch(()=>{}).then(async()=>{
      assertCurrent(ctx);
      const route=on?'/luna/pc/me/collection/media':'/luna/pc/me/collection/media/delete';
      const body={media:[{id:media.id,type:media.type}]};
      if(on)body.scene=''; // Exact current official PC service request shape.
      const response=await api(route,{},body);
      assertCurrent(ctx);
      checkResponse(response,true);
      let confirmed=false;
      for(let attempt=0;attempt<2;attempt++) {
        try {
          const state=await readState(ctx,[media]);
          confirmed=state[id]===on;
        } catch (_) {assertCurrent(ctx);}
        if(confirmed)break;
        if(attempt===0){await pause(250);assertCurrent(ctx);}
      }
      assertCurrent(ctx);
      if(!confirmed)throw fail('汽水暂未确认喜欢状态已更新，请稍后刷新。');
      // Synchronous cache invalidation only; no automatic follow-up writes.
      if(typeof deps.onChanged==='function')deps.onChanged();
    });
    ctx.writes.set(id,work);
    try {await work} finally {
      if(ctx.writes.get(id)===work)ctx.writes.delete(id);
      // Bound bookkeeping for long sessions without discarding an active write.
      if(ctx.revisions.size>1000)for(const key of ctx.revisions.keys()) {
        if(ctx.revisions.size<=1000)break;
        if(!ctx.writes.has(key))ctx.revisions.delete(key);
      }
    }
  }
  return{isLiked,like};
}
