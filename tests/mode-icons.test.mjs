import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Decode the alpha channel of our 8-bit PNG glyphs, including PNG row filters.
// Checking the real pixels catches opaque black backgrounds and empty icons.
function pngAlpha(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'glyph must be PNG');
  let header, transparency;
  const chunks=[];
  for(let at=8;at+12<=bytes.length;){
    const length=bytes.readUInt32BE(at);
    assert.ok(at+12+length<=bytes.length,'truncated PNG chunk');
    const name=bytes.toString('ascii',at+4,at+8);
    const data=bytes.subarray(at+8,at+8+length);
    if(name==='IHDR')header=data;
    if(name==='tRNS')transparency=data;
    if(name==='IDAT')chunks.push(data);
    at+=12+length;
    if(name==='IEND')break;
  }
  assert.ok(header?.length===13,'missing PNG header');
  const width=header.readUInt32BE(0),height=header.readUInt32BE(4),type=header[9];
  assert.ok(width>0 && height>0 && width<=96 && height<=96,
    `glyph ${width}x${height} would trigger the host JPEG thumbnail path`);
  assert.equal(header[8],8,'expected 8-bit PNG glyph');
  assert.equal(header[12],0,'expected non-interlaced PNG glyph');
  const channels={3:1,4:2,6:4}[type];
  assert.ok(channels,'glyph must carry alpha pixels or palette transparency');
  const rowBytes=width*channels;
  const packed=inflateSync(Buffer.concat(chunks),{maxOutputLength:(rowBytes+1)*height});
  assert.equal(packed.length,(rowBytes+1)*height,'incomplete PNG pixels');
  const pixels=Buffer.alloc(rowBytes*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){
    const filter=packed[y*(rowBytes+1)];
    assert.ok(filter<=4,'unknown PNG row filter');
    for(let x=0;x<rowBytes;x++){
      const at=y*rowBytes+x,a=x>=channels?pixels[at-channels]:0,b=y?pixels[at-rowBytes]:0,c=y&&x>=channels?pixels[at-rowBytes-channels]:0;
      const predictor=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];
      pixels[at]=(packed[y*(rowBytes+1)+x+1]+predictor)&255;
    }
  }
  let clear=0,visible=0;
  for(let i=0;i<width*height;i++){
    const alpha=type===3?(transparency?.[pixels[i]]??255):pixels[i*channels+channels-1];
    if(alpha===0)clear++;
    if(alpha>0)visible++;
  }
  return {clear,visible};
}

// Oversized 400px transparent scene glyphs became black JPEG thumbnails in
// production, while fixture bitmaps bypassed that path. Check the packaged
// files selected by the actual URL helper, including every bundled scene.
test('mode glyph URLs resolve to small PNGs with real transparent and visible pixels',async()=>{
  const pluginDir=new URL('../qishui-account/',import.meta.url);
  const source=await readFile(new URL('index.js',pluginDir),'utf8');
  const context=vm.createContext({URL,host:{dir:fileURLToPath(pluginDir)}});
  vm.runInContext(source.replace(/^export\s+/gm,'')+'\nthis.artwork=stationArtwork;',context);
  const sceneFiles=(await readdir(new URL('assets/stations/',pluginDir))).filter(name=>/^scene-\d+\.png$/.test(name));
  assert.ok(sceneFiles.length>0,'bundled scene covers are missing');
  const ids=['familiar','fresh',...sceneFiles.map(name=>'scene:'+name.slice(6,-4))];
  for(const id of ids){
    const url=new URL(context.artwork(id,true));
    assert.equal(url.protocol,'file:');
    assert.ok(url.pathname.endsWith('.png'),`${id} should use its small transparent PNG`);
    const {clear,visible}=pngAlpha(await readFile(url));
    assert.ok(clear>0,`${id} lost its transparent background`);
    assert.ok(visible>0,`${id} is entirely transparent`);
  }
});
