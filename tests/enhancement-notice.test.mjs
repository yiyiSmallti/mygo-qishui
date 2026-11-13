import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../qishui-account/index.js',import.meta.url),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function setup(statuses=['update-available'], platform='windows') {
  const requests=[];let launches=0,closes=0;
  const context=vm.createContext({URL,AbortController,TypeError,setTimeout,clearTimeout,host:{
    platform,arch:platform==='windows'?'amd64':'arm64',setting:()=>'',
    storage:{get:()=>undefined,set:()=>{throw new Error('unexpected storage write');},remove:()=>{throw new Error('unexpected removal');}},
    spawn(command,args){
      launches++;assert.deepEqual(Array.from(args),['./style-helper.cjs']);
      const status=statuses.shift();
      return {write:text=>requests.push(JSON.parse(text)),closeStdin:()=>{closes++;},kill(){},
        readLine:async()=>{if(status instanceof Error)throw status;return status==='malformed'?'not json':JSON.stringify({type:'status',status});}};
    }
  },fetch:()=>{throw new Error('unexpected network request');}});
  vm.runInContext(source.replace(/^export\s+/gm,'')+'\nthis.plugin={home,browse};',context);
  return {plugin:context.plugin,requests,get launches(){return launches;},get closes(){return closes;},context};
}
test('home shows an actionable enhancement update even before login, without opening installer',async()=>{
  const h=setup(),home=plain(await h.plugin.home());
  const notice=home.sections.find(s=>s.title==='界面增强有更新');
  assert.equal(notice.links[0].page,'appearance/open/update');
  assert.match(notice.links[0].subtitle,/确认更新并重启/);
  assert.deepEqual(h.requests,[{type:'check-layout-status'}]);
  assert.ok(h.closes>0);
});
test('status checks are shared until a deliberate refresh and notice clears after updating',async()=>{
  const h=setup(['update-available','installed']);
  await Promise.all([h.plugin.home(),h.plugin.home()]);
  assert.equal(h.launches,1);
  const page=plain(await h.plugin.browse({page:'appearance'}));
  assert.match(page.description,/已是当前插件提供的版本/);
  const home=plain(await h.plugin.home());
  assert.ok(!home.sections.some(s=>s.title==='界面增强有更新'));
  assert.equal(h.launches,2);
});
test('installed, optional, unknown or unsupported builds do not claim an update is available',async()=>{
  for(const status of ['installed','not-installed','unsupported','unknown','malformed',new Error('permission denied')]){
    const h=setup([status]),home=plain(await h.plugin.home());
    assert.ok(!home.sections.some(s=>s.title==='界面增强有更新'));
    assert.ok(home.sections.some(s=>s.title==='账号连接'));
  }
});
test('Mac browsing never starts the Windows checker',async()=>{
  const h=setup([],'darwin');await h.plugin.home();await h.plugin.browse({page:'appearance'});
  assert.equal(h.launches,0);
});
test('listening page keeps mode cards and adds the same update reminder',async()=>{
  const h=setup();
  vm.runInContext(`musicContext=()=>({});musicCurrent=()=>{};
    recommendationService.catalog=async()=>({primary:[{id:'familiar',name:'熟悉模式'}],scenes:[],radios:[]});`,h.context);
  const page=plain(await h.plugin.browse({page:'listening'}));
  assert.equal(page.sections[0].title,'界面增强有更新');
  assert.equal(page.sections[1].stations[0].id,'familiar');
  assert.deepEqual(h.requests,[{type:'check-layout-status'}]);
});
