// Visual QA of static artifacts with an owned headless browser. No app runtime is loaded.
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {Buffer} from 'node:buffer';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,dirname,resolve,extname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout,clearTimeout} from 'node:timers';
import {setTimeout as delay} from 'node:timers/promises';
const root=dirname(fileURLToPath(import.meta.url)),shots=join(root,'screenshots');mkdirSync(shots,{recursive:true});
const names=['still','folio','signal','lens','current'];
const server=createServer((req,res)=>{const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));if(!path.startsWith(root+sep)&&path!==root){res.writeHead(403);res.end();return;}const file=path===root?join(root,'index.html'):path;if(!existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.ttf':'font/ttf','.png':'image/png','.md':'text/plain'}[extname(file)]||'text/plain'));res.end(readFileSync(file));});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port,profile=mkdtempSync(join(tmpdir(),'rke-design-browser-'));
const child=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;const pending=new Map();let sequence=0;
try{
 let endpoint;for(let i=0;i<100;i++){try{const [port,path]=readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);endpoint='ws://127.0.0.1:'+port+path;break;}catch{await delay(100);}}
 assert.ok(endpoint,'owned browser starts');socket=new WebSocket(endpoint);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
 const errors=[],external=[],failed=[];
 socket.addEventListener('message',event=>{const row=JSON.parse(event.data);if(row.id){const entry=pending.get(row.id);if(entry){clearTimeout(entry.timer);pending.delete(row.id);if(row.error)entry.reject(Error(row.error.message));else entry.done(row.result);}}if(row.method==='Runtime.exceptionThrown')errors.push(row.params.exceptionDetails);if(row.method==='Network.requestWillBeSent'&&/^https?:/.test(row.params.request.url)&&!row.params.request.url.startsWith(base))external.push(row.params.request.url);if(row.method==='Network.responseReceived'&&row.params.response.status>=400)failed.push(row.params.response.url);});
 const send=(method,params={},sessionId)=>new Promise((done,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{done,reject,timer});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 for(const method of ['Runtime.enable','Network.enable','Page.enable'])await send(method,{},sessionId);
 const evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);assert.ok(!value.exceptionDetails,JSON.stringify(value.exceptionDetails));return value.result.value;};
 const load=async name=>{await send('Page.navigate',{url:base+'/'+name},sessionId);for(let i=0;i<100;i++){if(await evaluate('location.pathname.endsWith('+JSON.stringify(name)+')&&document.readyState==="complete"'))break;await delay(100);}await evaluate('document.fonts.ready.then(()=>true)');await delay(800);};
 const shot=async name=>{const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);writeFileSync(join(shots,name+'.png'),Buffer.from(data,'base64'));};
 const results=[];
 for(const name of names)for(const page of ['kanban','reader']){
  for(const width of [1440,1024,390]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:width===390?844:1000,deviceScaleFactor:1,mobile:width===390},sessionId);
   await load(name+'-'+page+'.html');
   const dimensions=await evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,font:document.fonts.status})');
   assert.ok(dimensions.scroll<=dimensions.client,name+' '+page+' overflow at '+width+': '+JSON.stringify(dimensions));
   if(width===1440||width===390)await shot(name+'-'+page+(width===390?'-mobile':''));
   if(width===1440){
    if(page==='kanban'){
     assert.equal(await evaluate('document.querySelectorAll(".task").length'),11);
     await evaluate('document.querySelector(".task").click()');assert.equal(await evaluate('document.getElementById("task-dialog").open'),true);await evaluate('document.getElementById("demo-move").click()');assert.match(await evaluate('document.getElementById("dialog-state").textContent'),/preview/);await evaluate('document.getElementById("dialog-close").click()');
     await evaluate('(()=>{const input=document.getElementById("search-tasks");input.value="zzzz-no-match";input.dispatchEvent(new Event("input"));})()');assert.equal(await evaluate('document.getElementById("empty-filter").hidden'),false);
     await evaluate('(()=>{const input=document.getElementById("search-tasks");input.value="Preserve reader";input.dispatchEvent(new Event("input"));})()');assert.equal(await evaluate('[...document.querySelectorAll(".task-shell")].filter(n=>!n.hidden).length'),1);
    }else{
     await evaluate('document.getElementById("focus-toggle").click()');assert.equal(await evaluate('getComputedStyle(document.querySelector(".outline")).display'),'none');
     await evaluate('document.getElementById("compare").click()');assert.equal(await evaluate('document.getElementById("comparison").hidden'),false);
     const before=await evaluate('getComputedStyle(document.querySelector(".article p:not(.lede)")).fontSize');await evaluate('document.getElementById("text-size").click()');const after=await evaluate('getComputedStyle(document.querySelector(".article p:not(.lede)")).fontSize');assert.ok(parseFloat(after)>parseFloat(before),name+' text size increases');
    }
    if(name==='current'){await evaluate('document.getElementById("replay").click();document.getElementById("pause-motion").click()');assert.equal(await evaluate('document.body.classList.contains("motion-paused")'),true);}
   }
   results.push({design:name,page,width,...dimensions});
  }
 }
 // Reduced-motion entry must leave content fully visible.
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);await load('current-kanban.html');assert.equal(await evaluate('getComputedStyle(document.querySelector(".task-shell")).animationName'),'none');
 await send('Emulation.setEmulatedMedia',{features:[]},sessionId);
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);await load('index.html');await shot('index');
 assert.equal(await evaluate('document.querySelectorAll(".screenshots img").length'),10);await evaluate('Promise.all([...document.querySelectorAll(".screenshots img")].map(img=>{img.loading="eager";return img.decode();}))');assert.ok(await evaluate('[...document.querySelectorAll(".screenshots img")].every(img=>img.complete&&img.naturalWidth>0)'));
 await evaluate('document.getElementById("preview-design").value="folio";document.getElementById("preview-design").dispatchEvent(new Event("change"))');assert.match(await evaluate('document.getElementById("preview").getAttribute("src")'),/folio-kanban/);
 await send('Page.navigate',{url:pathToFileURL(join(root,'still-kanban.html')).href},sessionId);for(let i=0;i<100;i++){if(await evaluate('location.protocol==="file:"&&document.readyState==="complete"'))break;await delay(100);}await evaluate('document.fonts.ready.then(()=>true)');assert.equal(await evaluate('document.querySelectorAll(".task").length'),11,'direct-file opening works');assert.equal(await evaluate('[...document.fonts].find(font=>font.family==="Geist").status'),'loaded','offline local font loads');
 assert.deepEqual(errors,[],'no uncaught browser exceptions');assert.deepEqual(external,[],'no external requests');assert.deepEqual(failed,[],'no broken local resources');
 writeFileSync(join(root,'verification.json'),JSON.stringify({result:'passed',checks:['30 desktop/tablet/mobile layouts','all ten page screenshots','task preview','state preview','task search and empty results','focus mode','wording comparison','text size','motion pause/replay','reduced motion','index screenshots and preview','no external requests','no runtime exceptions'],layouts:results},null,2));
 console.log(JSON.stringify({result:'passed',layouts:results.length,screenshots:shots,externalRequests:external.length,errors:errors.length}));
 await send('Browser.close');
}finally{socket?.close();if(child.exitCode===null)child.kill();server.closeAllConnections();server.close();}
