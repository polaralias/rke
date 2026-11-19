// Exercise the final single HTML file, including its isolated srcdoc documents.
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {Buffer} from 'node:buffer';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout,clearTimeout} from 'node:timers';
import {setTimeout as delay} from 'node:timers/promises';
const root=dirname(fileURLToPath(import.meta.url)),file=join(root,'../rke-ui-review-all.html'),shots=join(root,'screenshots');mkdirSync(shots,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'rke-all-designs-')),browser=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;const pending=new Map(),contexts=new Map();let seq=0;
try{
 let endpoint;for(let i=0;i<100;i++){try{const [port,path]=readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);endpoint='ws://127.0.0.1:'+port+path;break;}catch{await delay(100);}}assert.ok(endpoint,'owned browser starts');
 socket=new WebSocket(endpoint);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
 const errors=[],requests=[],failed=[];
 socket.addEventListener('message',event=>{const row=JSON.parse(event.data);if(row.id){const item=pending.get(row.id);if(item){clearTimeout(item.timer);pending.delete(row.id);if(row.error)item.reject(Error(row.error.message));else item.done(row.result);}return;}if(row.method==='Target.attachedToTarget'){const targetSession=row.params.sessionId;for(const method of ['Runtime.enable','Network.enable'])void send(method,{},targetSession).catch(()=>{});void send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},targetSession).catch(()=>{});}if(row.method==='Runtime.executionContextCreated'){const c=row.params.context;if(c.auxData?.isDefault)contexts.set(c.auxData.frameId,{id:c.id,sessionId:row.sessionId});}if(row.method==='Runtime.executionContextDestroyed')for(const[id,c]of contexts)if(c.id===row.params.executionContextId&&c.sessionId===row.sessionId)contexts.delete(id);if(row.method==='Runtime.exceptionThrown')errors.push(row.params.exceptionDetails);if(row.method==='Network.requestWillBeSent'){const url=row.params.request.url;if(/^https?:/.test(url)||url.startsWith('file:')&&url!==pathToFileURL(file).href)requests.push(url);}if(row.method==='Network.loadingFailed'&&!row.params.canceled)failed.push(row.params.errorText);});
 const send=(method,params={},sessionId)=>new Promise((done,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{done,reject,timer});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 for(const method of ['Runtime.enable','Network.enable','Page.enable'])await send(method,{},sessionId);
 await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId);
 const evaluate=async(expression,context)=>{const row=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...context?{contextId:context.id}:{}},context?.sessionId||sessionId);assert.ok(!row.exceptionDetails,JSON.stringify(row.exceptionDetails));return row.result.value;};
 const wait=async(expression,contextId)=>{for(let i=0;i<100;i++){try{if(await evaluate(expression,contextId))return;}catch{/* a previous srcdoc context can disappear during route changes */}await delay(60);}throw Error('UI did not settle: '+expression);};
 const frameContext=async(name='primary-preview')=>{for(let i=0;i<100;i++){for(const context of contexts.values())try{if(await evaluate('window.name',context)===name)return context;}catch{/* old isolated frame contexts are discarded during navigation */}await delay(60);}throw Error('No default execution context for '+name);};
 const shot=async name=>{const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);writeFileSync(join(shots,name+'.png'),Buffer.from(data,'base64'));};
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);await send('Page.navigate',{url:pathToFileURL(file).href},sessionId);await wait('document.querySelectorAll(".design-card").length===10');await shot('overview');
 const names=['still','folio','signal','lens','current','atlas','prism','cabinet','studio','console'],results=[];
 async function route(name,view){await evaluate(`document.querySelector('[data-design="${name}"]').click();document.querySelector('[data-view="${view}"]').click()`);await wait(`document.getElementById('primary-preview').dataset.key==='${name}-${view}'&&document.getElementById('primary-preview').dataset.ready==='true'`);let context;for(let i=0;i<100;i++){context=await frameContext();try{const active=await evaluate(`document.body.classList.contains('${name}')&&Boolean(document.getElementById('${view==='graph'?'graph-data':'prototype-data'}'))`,context);if(active)break;}catch{/* srcdoc navigation replaces its context */}await delay(60);}await evaluate('document.fonts.ready.then(()=>true)',context);await delay(160);return context;}
 for(const width of [1440,1024,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390},sessionId);
  for(const name of names)for(const view of ['kanban','reader','graph']){
   const context=await route(name,view);
   const parent=await evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})'),inner=await evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,fonts:[...document.fonts].filter(f=>f.status==="loaded").length})',context);
   assert.ok(parent.scroll<=parent.client,name+' '+view+' parent overflow '+width);assert.ok(inner.scroll<=inner.client,name+' '+view+' frame overflow '+width+': '+JSON.stringify(inner));assert.ok(inner.fonts>0,name+' '+view+' embedded fonts loaded');
   if(view==='graph'){
    await wait('Boolean(document.querySelector("#graph-inspector h2"))',context);
    if(width===1440||width===390)await shot(name+'-graph'+(width===390?'-mobile':''));
    if(width===1440){
     assert.match(await evaluate('document.getElementById("graph-summary").textContent',context),/14 records \/ 20 relationships \/ 14 matched/);
     const initial=await evaluate('document.querySelector("#graph-inspector h2").textContent',context);await evaluate('document.querySelector("#graph-inspector .graph-related").click()',context);assert.notEqual(await evaluate('document.querySelector("#graph-inspector h2").textContent',context),initial);
     await evaluate('document.getElementById("graph-reset").click();document.getElementById("graph-focus").click()',context);const focused=await evaluate('document.getElementById("graph-summary").textContent',context);assert.ok(!focused.endsWith('14 matched'),'focus reduces matched neighbourhood');
     await evaluate('document.getElementById("graph-reset").click();document.getElementById("graph-kind").value="Source";document.getElementById("graph-kind").dispatchEvent(new Event("change"))',context);assert.match(await evaluate('document.getElementById("graph-summary").textContent',context),/3 matched/);
     await evaluate('document.getElementById("graph-reset").click();document.getElementById("graph-search").value="no-such-record-zzz";document.getElementById("graph-search").dispatchEvent(new Event("input"))',context);assert.equal(await evaluate('document.getElementById("graph-empty").hidden',context),false);
     await evaluate('document.getElementById("graph-reset").click();document.getElementById("graph-search").value="Shared operations";document.getElementById("graph-search").dispatchEvent(new Event("input"))',context);assert.match(await evaluate('document.getElementById("graph-summary").textContent',context),/1 matched/);await evaluate('document.getElementById("graph-reset").click()',context);
     if(name==='signal')assert.equal(await evaluate('document.querySelectorAll(".matrix-link").length',context),20);
     else if(name==='lens')assert.equal(await evaluate('document.querySelectorAll(".neighbour-column").length',context),3);
     else if(name==='cabinet')assert.equal(await evaluate('document.querySelectorAll(".graph-record").length',context),14);
     else if(name==='console')assert.equal(await evaluate('document.querySelectorAll(".terminal-record").length',context),14);
     else{assert.equal(await evaluate('document.querySelectorAll(".graph-node").length',context),14);const before=await evaluate('document.querySelector(".graph-svg g[transform]").getAttribute("transform")',context);await evaluate('document.getElementById("graph-in").click()',context);assert.notEqual(await evaluate('document.querySelector(".graph-svg g[transform]").getAttribute("transform")',context),before);}
     // View navigation stays inside the packaged file.
     await evaluate('document.querySelector("#graph-inspector .button").click()',context);await wait(`document.getElementById('primary-preview').dataset.key==='${name}-reader'`);
    }
   }else if(width===1440){
    if(view==='kanban'){assert.equal(await evaluate('document.querySelectorAll(".task").length',context),11);await evaluate('document.getElementById("search-tasks").value="no-match-zzz";document.getElementById("search-tasks").dispatchEvent(new Event("input"))',context);assert.equal(await evaluate('document.getElementById("empty-filter").hidden',context),false);}
    else{await evaluate('document.getElementById("compare").click()',context);assert.equal(await evaluate('document.getElementById("comparison").hidden',context),false);}
   }
   results.push({design:name,view,width,parent,inner});
  }
 }
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);await route('current','graph');await evaluate('document.getElementById("compare-toggle").click();document.getElementById("comparison-design").value="signal";document.getElementById("comparison-design").dispatchEvent(new Event("change"))');await wait('document.getElementById("comparison-preview").dataset.ready==="true"');const secondary=await frameContext('comparison-preview');assert.equal(await evaluate('document.body.classList.contains("signal")',secondary),true);await wait('document.body.getBoundingClientRect().width>0&&document.body.getBoundingClientRect().height>0',secondary);await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))',secondary);await delay(1000);await shot('comparison');
 await evaluate('document.getElementById("viewport").value="390";document.getElementById("viewport").dispatchEvent(new Event("change"))');assert.equal(await evaluate('document.querySelector(".frame-surface").dataset.width'),'390');await evaluate('document.getElementById("compare-toggle").click();document.getElementById("viewport").value="auto";document.getElementById("viewport").dispatchEvent(new Event("change"));document.getElementById("about-open").click()');assert.equal(await evaluate('document.getElementById("about").open'),true);assert.equal(await evaluate('document.querySelectorAll("#license-list details").length'),8);await evaluate('document.getElementById("about-close").click()');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);const reduced=await route('current','graph');await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},reduced.sessionId||sessionId);await wait('matchMedia("(prefers-reduced-motion: reduce)").matches',reduced);await evaluate('document.getElementById("replay").click()',reduced);assert.equal(await evaluate('document.getAnimations().length',reduced),0);await send('Emulation.setEmulatedMedia',{features:[]},sessionId);
 assert.deepEqual(errors,[],'no uncaught browser exceptions');assert.deepEqual(requests,[],'single file requests no HTTP resources or neighbouring files');assert.deepEqual(failed,[],'no blocked or failed resources');
 writeFileSync(join(root,'verification.json'),JSON.stringify({result:'passed',file:'docs/rke-ui-review-all.html',layoutCases:results.length,graphViews:10,recordsPerGraph:14,relationshipsPerGraph:20,checks:['90 design/view/viewport combinations','embedded fonts','node and relationship selection','type filters','search and empty results','focus neighbours','graph zoom','graph-to-reader routing','original task search and wording comparison','comparison panes','viewport control','font licenses','reduced motion','direct file opening','zero external or neighbouring-file requests','zero runtime exceptions'],layouts:results},null,2));console.log(JSON.stringify({result:'passed',layouts:results.length,graphs:10,requests:requests.length,errors:errors.length}));await send('Browser.close');
}finally{socket?.close();if(child.exitCode===null)child.kill();}
