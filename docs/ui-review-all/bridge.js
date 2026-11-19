// Navigation bridge for a sandboxed static view. The parent validates the sender and route.
(()=>{
 const design=__DESIGN__,view=__VIEW__;
 const send=(type,value={})=>window.parent.postMessage({type,...value},'*');
 document.addEventListener('click',event=>{
  const copy=event.target.closest('#copy-link');if(copy){event.preventDefault();event.stopImmediatePropagation();send('rke-review-copy',{design,view});return;}
  const link=event.target.closest('a[href]');if(!link)return;const href=link.getAttribute('href');if(!href||href.startsWith('#'))return;
  event.preventDefault();event.stopImmediatePropagation();const route=/^([a-z]+)-(kanban|reader|graph)\.html(?:#.*)?$/.exec(href);
  if(route)send('rke-review-route',{design:route[1],view:route[2]});else send('rke-review-home');
 },true);
 document.addEventListener('change',event=>{if(event.target.id!=='design-switch')return;event.stopImmediatePropagation();const match=/^([a-z]+)-(kanban|reader|graph)\.html$/.exec(event.target.value);if(match)send('rke-review-route',{design:match[1],view:match[2]});},true);
 window.addEventListener('DOMContentLoaded',()=>send('rke-review-ready',{design,view}));
})();
