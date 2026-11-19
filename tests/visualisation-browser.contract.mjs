// Real-browser regression contract. Run after npm run build; uses an owned headless Chrome.
/* global WebSocket */
import process from 'node:process';
import console from 'node:console';
import {Buffer} from 'node:buffer';
import {setTimeout, clearTimeout} from 'node:timers';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {git} from '../dist/src/io.js';
import {invokeOperation} from '../dist/src/operations.js';
import {startVisualisation, exportVisualisation} from '../dist/src/visualisation.js';

const root=mkdtempSync(join(tmpdir(),'rke-ui-review-')),profile=mkdtempSync(join(tmpdir(),'rke-ui-chrome-'));
const shots=process.env.RKE_UI_SHOTS||join(root,'shots');mkdirSync(shots,{recursive:true});
git(root,'init','--quiet');
await invokeOperation(root,'task_init_bundle',{});
for(const [slug,title] of [['search','Search repository knowledge'],['reader','Improve document comparison'],['board','Make task transitions clear'],['unicode','Keep long identifiers and Unicode readable']]){
  await invokeOperation(root,'task_create',{slug,title,description:'Review the implementation, preserve repository boundaries and verify the complete user flow.'});
}
await invokeOperation(root,'task_set_status',{task:'reader',status:'ready'});
await invokeOperation(root,'task_set_status',{task:'board',status:'ready'});
await invokeOperation(root,'task_set_status',{task:'board',status:'in-progress'});
const exported=await exportVisualisation(root,{});
const staticServer=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(readFileSync(join(root,exported.output)));});
await new Promise(done=>staticServer.listen(0,'127.0.0.1',done));
const session=await startVisualisation(root,{}, {},(name,args)=>invokeOperation(root,name,args));
const browser=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;const pending=new Map();let seq=0;
try{
  let endpoint;for(let i=0;i<100;i++){try{const [port,path]=readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);endpoint='ws://127.0.0.1:'+port+path;break;}catch{await delay(100);}}
  assert.ok(endpoint,'browser starts');socket=new WebSocket(endpoint);await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
  const errors=[];socket.addEventListener('message',event=>{const row=JSON.parse(event.data);if(row.id){const item=pending.get(row.id);if(item){clearTimeout(item.timer);pending.delete(row.id);if(row.error)item.reject(Error(row.error.message));else item.done(row.result);}}if(row.method==='Runtime.exceptionThrown')errors.push(row.params.exceptionDetails);});
  const send=(method,params={},sessionId)=>new Promise((done,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('Timeout: '+method)),20000);pending.set(id,{done,reject,timer});socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);
  const evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);assert.ok(!value.exceptionDetails,JSON.stringify(value.exceptionDetails));return value.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100);}throw Error('UI did not settle: '+expression);};
  const shot=async name=>{await delay(200);const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);writeFileSync(join(shots,name+'.png'),Buffer.from(result.data,'base64'));};
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Page.navigate',{url:session.url},sessionId);await wait('document.querySelectorAll(".card").length===4');await shot('before-or-after-board');
  // Reproduce editor leakage when leaving the board.
  await evaluate('document.querySelector(".card").click();document.getElementById("tab-documents").click()');
  const leak=await evaluate('!document.getElementById("editor").hidden');
  if(process.argv.includes('--probe')){console.log(JSON.stringify({editorLeaksIntoDocuments:leak,shots}));await shot('before-documents');}
  else{
    assert.equal(leak,false,'task editor stays hidden in Documents');
    await wait('document.querySelector("#reader-host iframe")');await shot('documents');
    await evaluate('document.getElementById("tab-board").click();document.querySelector(".card").click()');
    await shot('editor');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
    await shot('editor-mobile');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false},sessionId);
    // Dirty drafts survive view search; navigation cannot silently discard them.
    await evaluate('(()=>{const input=document.querySelector(".editor input[name=title]");input.value="Unsaved task title";input.dispatchEvent(new Event("input"));document.getElementById("tab-documents").click();})()');
    assert.equal(await evaluate('document.querySelector(".editor input[name=title]").value'),'Unsaved task title');
    await evaluate('document.querySelector(".editor-top button").click();document.getElementById("new-task").click()');
    assert.equal(await evaluate('document.querySelector(".editor input[type=checkbox]").disabled'),true,'private storage stays unavailable until connected');
    await evaluate('(()=>{const form=document.querySelector(".editor form");for(const [key,value]of Object.entries({slug:"browser-created",title:"Created in the browser",description:"Validate the complete creation flow"})){const input=form.elements[key];input.value=value;input.dispatchEvent(new Event("input"));}form.requestSubmit();})()');
    await wait('Array.from(document.querySelectorAll(".card strong")).some(n=>n.textContent==="Created in the browser")');
    assert.match(readFileSync(join(root,'tasks/browser-created/task.md'),'utf8'),/Created in the browser/);
    // Persist an edit and move through the UI, using the current digest.
    await evaluate('(()=>{const input=document.querySelector(".editor input[name=title]");input.value="Edited in the browser";input.dispatchEvent(new Event("input"));document.querySelector(".editor form").requestSubmit();})()');
    await wait('Array.from(document.querySelectorAll(".card strong")).some(n=>n.textContent==="Edited in the browser")');
    await evaluate('Array.from(document.querySelectorAll(".editor button")).find(n=>n.textContent==="Ready").click()');
    await wait(`Boolean(document.querySelector('.column[data-status=ready] .card[data-path="tasks/browser-created/task.md"]'))`);
    // Arrow-key navigation on the tab list.
    await evaluate('document.getElementById("tab-board").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
    assert.equal(await evaluate('document.getElementById("tab-documents").getAttribute("aria-selected")'),'true');
    await evaluate('document.getElementById("tab-relationships").click()');await shot('relationships');
    await evaluate('document.getElementById("tab-board").click();document.querySelector(".editor-top button")?.click()');
    await evaluate('Array.from(document.querySelectorAll(".view-switch button")).find(n=>n.textContent==="List").click()');
    assert.equal(await evaluate('document.querySelectorAll(".task-table tr").length'),6);
    await shot('list');
    await evaluate('(()=>{const search=document.getElementById("search");search.value="Edited in the browser";search.dispatchEvent(new Event("input"));})()');
    assert.equal(await evaluate('document.querySelectorAll(".task-table tr").length'),2,'search filters the list');
    await evaluate('(()=>{const search=document.getElementById("search");search.value="";search.dispatchEvent(new Event("input"));Array.from(document.querySelectorAll(".view-switch button")).find(n=>n.textContent==="Board").click();})()');
    await evaluate('(()=>{const card=document.querySelector(".card"),transfer=new DataTransfer();card.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}));document.querySelector(".column").dispatchEvent(new DragEvent("dragover",{bubbles:true,dataTransfer:transfer}));card.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:transfer}));})()');
    assert.equal(await evaluate('document.querySelectorAll(".dragover").length'),0,'cancelled drags clear drop targets');
    for(const width of [1440,1024,820,768,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:width<600?844:900,deviceScaleFactor:1,mobile:width<600},sessionId);
      for(const dark of [false,true]){
        await evaluate('if(document.documentElement.dataset.theme!=='+JSON.stringify(dark?'dark':'light')+')document.getElementById("theme").click()');
        assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'no page overflow at '+width);
        await shot('board-'+width+(dark?'-dark':'-light'));
      }
    }
    // A stale save is refused while retaining the user's draft.
    await evaluate('document.querySelector(".card").click()');
    await evaluate('(()=>{const input=document.querySelector(".editor input[name=title]");input.value="Preserved stale draft";input.dispatchEvent(new Event("input"));})()');
    const selectedPath=await evaluate('document.querySelector(".card[aria-current=true]").dataset.path');
    await invokeOperation(root,'task_edit',{task:selectedPath.split('/')[1],title:'External edit'});
    await evaluate('document.querySelector(".editor form").requestSubmit()');await wait('!document.getElementById("error").hidden');
    assert.equal(await evaluate('document.querySelector(".editor input[name=title]").value'),'Preserved stale draft');
    assert.equal(await evaluate('!document.getElementById("editor-notice").hidden'),true,'conflict is visible inside the mobile editor');
    // Read-only exports must never expose an editable form after returning from Documents.
    await evaluate('document.querySelector(".editor-top button").click()');
    await send('Page.navigate',{url:'http://127.0.0.1:'+staticServer.address().port},sessionId);
    await wait('document.querySelectorAll(".card").length===4');
    await evaluate('document.querySelector(".card").click();document.getElementById("tab-board").click()');
    assert.equal(await evaluate('document.getElementById("editor").hidden'),true,'exports remain read-only on return to Board');
    assert.equal(await evaluate('document.getElementById("new-task").disabled'),true);
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log(JSON.stringify({result:'passed',widths:[1440,1024,820,768,390],themes:['light','dark'],flows:['documents','relationships','draft protection','create','edit','transition','keyboard tabs','list/search','drag cleanup','stale save'],shots,export:join(root,exported.output)}));
  }
  await send('Browser.close');
}finally{socket?.close();if(child.exitCode===null)child.kill();session.close();staticServer.closeAllConnections();staticServer.close();}
