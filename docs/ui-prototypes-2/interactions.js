(()=>{
 'use strict';
 const {tasks,states,design,page}=JSON.parse(document.getElementById('prototype-data').textContent),$=id=>document.getElementById(id);
 if(['prism','console'].includes(design)&&page==='kanban'){
  document.addEventListener('click',event=>{const button=event.target.closest('[data-task]');if(!button)return;event.stopImmediatePropagation();const task=tasks.find(t=>t[0]===button.dataset.task);$('selection-title').textContent=task[1];$('selection-body').textContent=task[2];$('selection-state').textContent=states[task[3]];$('selection-id').textContent=task[0];$('selection-owner').textContent=task[5];$('selection-estimate').textContent=task[6];document.querySelectorAll('.task').forEach(node=>{node.classList.toggle('is-selected',node===button);node.setAttribute('aria-pressed',String(node===button));});},true);
 }
 if(design==='prism'&&page==='kanban'){
  let lane='2';
  const apply=()=>{const searching=$('search-tasks').value.trim()!=='';document.querySelectorAll('.column').forEach(col=>{col.hidden=!searching&&col.dataset.state!==lane;});document.querySelectorAll('[data-lane]').forEach(button=>button.setAttribute('aria-pressed',String(!searching&&button.dataset.lane===lane)));};
  document.querySelectorAll('[data-lane]').forEach(button=>button.addEventListener('click',()=>{lane=button.dataset.lane;$('search-tasks').value='';$('search-tasks').dispatchEvent(new Event('input'));apply();}));
  $('search-tasks').addEventListener('input',apply);$('owner').addEventListener('change',apply);apply();
 }
 if(design==='atlas'&&page==='reader')$('map-size').addEventListener('click',()=>{const active=document.querySelector('.app-main').classList.toggle('map-expanded');$('map-size').setAttribute('aria-pressed',String(active));$('map-size').textContent=active?'Default map':'Expand map';});
 if(design==='prism'&&page==='reader')document.querySelectorAll('[data-source]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-source]').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));$('source-bindings').hidden=button.dataset.source!=='bindings';$('source-wording').hidden=button.dataset.source!=='wording';}));
 if(design==='studio'&&page==='reader'){
  $('expand-chapters').addEventListener('click',()=>{const active=$('expand-chapters').getAttribute('aria-pressed')!=='true';document.querySelectorAll('.chapter').forEach(node=>{node.open=active;});$('expand-chapters').setAttribute('aria-pressed',String(active));$('expand-chapters').textContent=active?'Collapse chapters':'Expand chapters';});
  const openHash=()=>{const id=location.hash.slice(1);if(!id)return;const target=document.getElementById(id);if(target?.closest('.chapter'))target.closest('.chapter').open=true;};window.addEventListener('hashchange',openHash);openHash();
 }
 if(design==='console'){
  $('console-form').addEventListener('submit',event=>{event.preventDefault();const command=$('command-line').value.trim().toLowerCase();if(command==='focus'&&page==='reader')$('focus-toggle').click();else if(command.startsWith('find ')&&page==='kanban'){$('search-tasks').value=command.slice(5);$('search-tasks').dispatchEvent(new Event('input'));}else{document.getElementById('toast').hidden=false;document.getElementById('toast').textContent=page==='reader'?'Available command: focus. Use section links to navigate.':'Available command: find <task text>. No shell commands are executed.';}$('command-line').value='';});
  document.addEventListener('keydown',event=>{if(event.key===':'&&!event.target.closest('input,select,textarea')){event.preventDefault();$('command-line').focus();}});
 }
})();
