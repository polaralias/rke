// Optional real-browser contract for the installed packed-smoke two-root export.
/* global WebSocket */
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {setTimeout,clearTimeout} from 'node:timers';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const [browser,html,mode]=process.argv.slice(2);
if(!browser||!html||!isAbsolute(browser))throw Error('Usage: node tests/reader-browser.contract.mjs <absolute-browser-executable> <packed-workspace-reader.html> [mobile]');
const prefix=join(tmpdir(),'rke-owned-browser-'),profile=await mkdtemp(prefix);
const child=spawn(browser,['--headless=new','--disable-gpu','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const closed=new Promise(done=>child.once('close',done));let socket;
try{
  let endpoint;for(let i=0;i<100;i++){try{const [port,path]=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);endpoint='ws://127.0.0.1:'+port+path;break;}catch{await new Promise(done=>setTimeout(done,100));}}
  assert.ok(endpoint,'owned browser starts');socket=new WebSocket(endpoint);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
  const pending=new Map(),requests=[],errors=[];let sequence=0;
  const send=(method,params={},sessionId)=>new Promise((done,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{done,reject,timer});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});
  socket.addEventListener('message',event=>{const row=JSON.parse(event.data);if(row.id){const entry=pending.get(row.id);if(entry){clearTimeout(entry.timer);pending.delete(row.id);if(row.error){entry.reject(Error(row.error.message));}else{entry.done(row.result);}}return;}if(row.method==='Network.requestWillBeSent'&&/^https?:/.test(row.params.request.url))requests.push(row.params.request.url);if(row.method==='Runtime.exceptionThrown')errors.push(row.params.exceptionDetails.text);});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await Promise.all(['Runtime.enable','Network.enable','Page.enable'].map(method=>send(method,{},sessionId)));
  if(mode==='mobile')await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  const evaluate=async expression=>{const row=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);assert.ok(!row.exceptionDetails,JSON.stringify(row.exceptionDetails));return row.result.value;};
  await send('Page.navigate',{url:pathToFileURL(resolve(html)).href},sessionId);
  let ready=false;for(let i=0;i<100;i++){if(await evaluate('Boolean(document.querySelector("#primary-pane"))')){ready=true;break;}await new Promise(done=>setTimeout(done,100));}assert.ok(ready,'actual installed reader initializes');
  const initial=await evaluate(`(()=>({id:document.querySelector('#primary-pane').dataset.document,body:document.querySelector('#primary-pane').textContent,coverage:document.querySelector('#coverage').textContent,width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}))()`);
  assert.match(initial.body,/packagedRuntime/);assert.match(initial.coverage,/projection/);assert.ok(initial.scroll<=initial.client,'no page-wide overflow');if(mode==='mobile')assert.equal(initial.width,390);
  const linked=await evaluate(`(async()=>{document.querySelector('#primary-pane .line-number').click();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);if(!document.querySelector('#comparison-pane'))document.querySelector('#compare-toggle').click();await new Promise(requestAnimationFrame);return {hash:location.hash,primary:document.querySelector('#primary-pane').dataset.document,comparison:document.querySelector('#comparison-pane').dataset.document,focus:document.activeElement.dataset.anchor};})()`);
  assert.match(linked.hash,/anchor=L1/);assert.match(linked.hash,/snapshot=/);assert.match(linked.hash,/compare=/);assert.notEqual(linked.primary,linked.comparison);
  await send('Page.reload',{ignoreCache:true},sessionId);
  let restored;for(let i=0;i<100;i++){restored=await evaluate(`document.querySelector('#primary-pane')&&document.querySelector('#comparison-pane')?({primary:document.querySelector('#primary-pane').dataset.document,comparison:document.querySelector('#comparison-pane').dataset.document,located:Boolean(document.querySelector('.location-target'))}):null`);if(restored?.located)break;await new Promise(done=>setTimeout(done,100));}
  assert.deepEqual(restored,{primary:linked.primary,comparison:linked.comparison,located:true},'reload preserves snapshot-bound source location and comparison');
  const before=await evaluate(`(()=>{const button=document.querySelector('#navigation-toggle');button.focus();return{expanded:button.getAttribute('aria-expanded'),primary:document.querySelector('#primary-pane').dataset.document};})()`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'},sessionId);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  const after=await evaluate(`({expanded:document.querySelector('#navigation-toggle').getAttribute('aria-expanded'),primary:document.querySelector('#primary-pane').dataset.document})`);assert.notEqual(before.expanded,after.expanded);assert.equal(before.primary,after.primary);
  assert.deepEqual(requests,[],'offline page sends no HTTP requests');assert.deepEqual(errors,[],'no runtime source errors');
  console.log(JSON.stringify({result:'passed',scope:'installed static RKE reader, not human utility',mode:mode??'desktop',initial:{id:initial.id,coverage:initial.coverage,width:initial.width},linked,restored,keyboard:{before,after},httpRequests:requests.length,runtimeErrors:errors.length}));
  await send('Browser.close');socket.close();socket=undefined;await closed;
}finally{if(socket){try{socket.send(JSON.stringify({id:999999,method:'Browser.close'}));}catch{/* The owned browser may already be closed. */}socket.close();}if(child.exitCode===null&&!child.killed)child.kill();await closed;assert.ok(resolve(profile).startsWith(resolve(prefix)));await rm(profile,{recursive:true,force:true});}
