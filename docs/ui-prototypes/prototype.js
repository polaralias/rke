/* Browser-only interactions on example data. No network, persistence or runtime API. */
(()=>{
 'use strict';
 const {tasks,states,design,page}=JSON.parse(document.getElementById('prototype-data').textContent),$=id=>document.getElementById(id);
 $('design-switch').addEventListener('change',event=>{location.href=event.target.value;});
 let timer,selected;
 const reduce=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 function tell(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('toast').hidden=true;},4500);}
 function entrance(){if(design!=='current'||reduce()||document.body.classList.contains('motion-paused'))return;document.querySelectorAll('.task-shell,.article,.evidence').forEach((node,index)=>{node.animate([{opacity:0,transform:'translateY(14px)'},{opacity:1,transform:'translateY(0)'}],{duration:550,delay:Math.min(index*45,320),easing:'cubic-bezier(.22,1,.36,1)'});});}
 $('replay')?.addEventListener('click',entrance);
 $('pause-motion')?.addEventListener('click',event=>{const paused=document.body.classList.toggle('motion-paused');event.target.textContent=paused?'Resume motion':'Pause motion';event.target.setAttribute('aria-pressed',String(paused));document.querySelectorAll('*').forEach(node=>node.getAnimations().forEach(animation=>animation.cancel()));});
 function openTask(id){selected=tasks.find(task=>task[0]===id);$('dialog-id').textContent=selected[0];$('dialog-title').textContent=selected[1];$('dialog-body').textContent=selected[2];$('dialog-state').textContent=states[selected[3]];$('dialog-meta').textContent=selected[5]+' / '+selected[6]+' / '+selected[7];$('task-dialog').showModal();if(design==='current'&&!reduce()&&!document.body.classList.contains('motion-paused'))$('task-dialog').animate([{opacity:0,transform:'translateY(18px) scale(.98)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:350,easing:'cubic-bezier(.22,1,.36,1)'});}
 document.querySelectorAll('[data-task]').forEach(button=>button.addEventListener('click',()=>openTask(button.dataset.task)));
 $('dialog-close').addEventListener('click',()=>{$('task-dialog').close();});
 $('task-dialog').addEventListener('click',event=>{if(event.target===$('task-dialog')){const r=$('task-dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('task-dialog').close();}});
 $('demo-move').addEventListener('click',()=>{if(!selected)return;const next=selected[3]===4?2:Math.min(selected[3]+1,4);$('dialog-state').textContent=states[next]+' (preview)';tell('Transition preview only. No task record was changed.');});
 document.querySelector('[data-new]')?.addEventListener('click',()=>{tell('This is a visual prototype. Creating repository tasks belongs to the live app.');});
 if(page==='kanban'){
  function filter(){let shown=0;const query=$('search-tasks').value.trim().toLowerCase(),owner=$('owner').value;document.querySelectorAll('[data-task]').forEach(button=>{const task=tasks.find(row=>row[0]===button.dataset.task),visible=(!query||task.join(' ').toLowerCase().includes(query))&&(owner==='all'||task[5]===owner);button.parentElement.hidden=!visible;if(visible)shown++;});document.querySelectorAll('.column').forEach(col=>{col.querySelector('.count').textContent=[...col.querySelectorAll('.task-shell')].filter(node=>!node.hidden).length;});$('empty-filter').hidden=shown>0;}
  $('search-tasks').addEventListener('input',filter);$('owner').addEventListener('change',filter);
  let hidden=design==='signal'||design==='still';$('toggle-meta').textContent=hidden?'Show descriptions':'Hide descriptions';$('toggle-meta').setAttribute('aria-pressed',String(!hidden));
  $('toggle-meta').addEventListener('click',()=>{hidden=!hidden;document.querySelectorAll('.task p').forEach(p=>{p.style.display=hidden?'none':'block';});$('toggle-meta').textContent=hidden?'Show descriptions':'Hide descriptions';$('toggle-meta').setAttribute('aria-pressed',String(!hidden));});
 }else{
  $('focus-toggle').addEventListener('click',()=>{const active=document.querySelector('.app-main').classList.toggle('focus-mode');$('focus-toggle').setAttribute('aria-pressed',String(active));$('focus-toggle').textContent=active?'Show context':'Focus mode';});
  $('text-size').addEventListener('click',()=>{const active=document.querySelector('.app-main').classList.toggle('text-large');$('text-size').setAttribute('aria-pressed',String(active));$('text-size').textContent=active?'Default text':'Larger text';});
  $('compare').addEventListener('click',()=>{const active=$('comparison').hidden;$('comparison').hidden=!active;$('compare').setAttribute('aria-pressed',String(active));$('compare').textContent=active?'Hide comparison':'Compare wording';});
  $('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);tell('Location copied.');}catch{tell('Copy this page address from the browser address bar.');}});
 }
 document.addEventListener('keydown',event=>{if(event.key==='/'&&$('search-tasks')&&!event.target.closest('input,select,textarea')){event.preventDefault();$('search-tasks').focus();}});
})();
