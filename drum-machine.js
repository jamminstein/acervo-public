import {getMixer} from './drum-audio.js?v=pen-player-1';
export function chooseKit(manifest,previous={},rng=Math.random){return Object.fromEntries(['kick','snare','hat'].map(kind=>{const pool=manifest[kind].filter(url=>url!==previous[kind]);const choices=pool.length?pool:manifest[kind];return [kind,choices[Math.floor(rng()*choices.length)]]}))}
const padKeys={j:'kick',k:'snare',l:'hat'},pads=[...document.querySelectorAll('.drum-pad')],active=new Set();let lastHat=null,currentKit={},data=null;
const machine=document.querySelector('#drumMachine'),refresh=document.querySelector('#drumRefresh');
const LOAD_TIMEOUT=12000,HIT_LIFETIME=300;
let manifest=null,loading=null;
function abortError(){return new DOMException('Drum kit request superseded','AbortError')}
function checkRequest(request){if(loading!==request||request.controller.signal.aborted)throw request.controller.signal.reason||abortError()}
async function getManifest(request){
 if(manifest)return manifest;
 const response=await fetch('drum-samples.json?v=drums-1',{signal:request.controller.signal});
 if(!response.ok)throw Error('Missing drum manifest');
 const next=await response.json();checkRequest(request);
 if(!['kick','snare','hat'].every(kind=>Array.isArray(next[kind])&&next[kind].length&&next[kind].every(url=>typeof url==='string'&&url.length)))throw Error('Invalid drum manifest');
 manifest=next;return manifest;
}
async function decodeKit(kit,mix){
 if(!kit.decoding)kit.decoding=Promise.all(Object.entries(kit.blobs).map(async([kind,blob])=>{kit.buffers[kind]=await mix.context.decodeAudioData(blob.slice(0))})).catch(error=>{kit.decoding=null;throw error});
 await kit.decoding;
}
async function loadKit(request,mix){
 const collection=await getManifest(request);checkRequest(request);let previous=currentKit;
 if(!Object.keys(previous).length)try{previous=JSON.parse(sessionStorage.getItem('last-drum-kit')||'{}')}catch{}
 const chosen=chooseKit(collection,previous),next={blobs:{},buffers:{},decoding:null};
 await Promise.all(Object.entries(chosen).map(async([kind,url])=>{const r=await fetch(url,{signal:request.controller.signal});if(!r.ok)throw Error('Missing drum hit');next.blobs[kind]=await r.arrayBuffer()}));
 checkRequest(request);
 if(mix)await decodeKit(next,mix);
 checkRequest(request);
 // Swap all three together; pads keep the previous kit until the replacement is ready.
 currentKit=chosen;data=next;machine.dataset.ready='true';
 try{sessionStorage.setItem('last-drum-kit',JSON.stringify(chosen))}catch{}
}
function startKitLoad(mix){
 loading?.controller.abort(abortError());
 const request={controller:new AbortController(),ready:null};loading=request;
 const aborted=new Promise((_,reject)=>request.controller.signal.addEventListener('abort',()=>reject(request.controller.signal.reason||abortError()),{once:true}));
 const deadline=setTimeout(()=>request.controller.abort(new DOMException('Drum kit loading timed out','TimeoutError')),LOAD_TIMEOUT);
 // The race also releases callers if a stalled body/decoder ignores abort.
 request.ready=Promise.race([loadKit(request,mix),aborted]).catch(error=>{
  if(loading===request&&!data)machine.dataset.ready='false';
  request.controller.abort(error);throw error;
 }).finally(()=>{clearTimeout(deadline);if(loading===request)loading=null});
 return request.ready;
}
startKitLoad().catch(()=>{});
async function prepare(){
 const mix=getMixer(),kit=data;if(!mix||!kit)return null;
 await Promise.all([mix.context.resume(),decodeKit(kit,mix)]);return {mix,kit};
}
function prepareHit(){
 let timer;
 return Promise.race([prepare(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),HIT_LIFETIME)})]).finally(()=>clearTimeout(timer));
}
export async function refreshKit(){
 if(refresh.disabled)return;
 refresh.classList.remove('spinning');void refresh.offsetWidth;refresh.classList.add('spinning');
 setTimeout(()=>refresh.classList.remove('spinning'),650);
 refresh.disabled=true;refresh.setAttribute('aria-busy','true');
 try{const mix=getMixer();mix?.context.resume().catch(()=>{});await startKitLoad(mix)}
 catch(error){console.warn('New drum samples unavailable; retaining current kit',error)}
 finally{refresh.disabled=false;refresh.removeAttribute('aria-busy')}
}
refresh.addEventListener('click',e=>{e.stopPropagation();refreshKit()});
function flash(kind){const pad=document.querySelector(`[data-drum="${kind}"]`);pad.classList.remove('hit');void pad.offsetWidth;pad.classList.add('hit');setTimeout(()=>pad.classList.remove('hit'),120)}
export async function triggerDrum(kind){flash(kind);const requested=performance.now();try{const ready=await prepareHit();if(!ready||ready.kit!==data||performance.now()-requested>HIT_LIFETIME||ready.mix.context.state!=='running')return;const {mix,kit}=ready,{context,drumGain}=mix,now=context.currentTime;const source=context.createBufferSource(),gain=context.createGain();source.buffer=kit.buffers[kind];gain.gain.value=.92;source.connect(gain);gain.connect(drumGain);
 if(kind==='hat'&&lastHat){lastHat.gain.gain.cancelScheduledValues(now);lastHat.gain.gain.setTargetAtTime(0,now,.004);try{lastHat.source.stop(now+.025)}catch{}}
 const voice={source,gain};if(kind==='hat')lastHat=voice;active.add(voice);source.onended=()=>{source.disconnect();gain.disconnect();active.delete(voice)};source.start(now);window.dispatchEvent(new Event('site-drum-hit'));
 if(active.size>24){const oldest=active.values().next().value;oldest.gain.gain.setTargetAtTime(0,now,.003);try{oldest.source.stop(now+.02)}catch{}}
 }catch(error){console.warn('Drum hit unavailable',error)}}
for(const pad of pads){
 let pointer=null,key=null;
 pad.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();pointer=e.pointerId;triggerDrum(pad.dataset.drum)});
 pad.addEventListener('keydown',e=>{if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||(e.key!=='Enter'&&e.key!==' '))return;e.preventDefault();e.stopPropagation();key=e.key;if(!e.repeat)triggerDrum(pad.dataset.drum)});
 // Native pointer/key activations already sound on press. Click-only activation
 // (including assistive technology) still needs an independent path.
 pad.addEventListener('click',e=>{if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey||e.detail!==0||pointer!==null||key!==null)return;triggerDrum(pad.dataset.drum)});
 const releasePointer=e=>{if(pointer===e.pointerId)setTimeout(()=>{if(pointer===e.pointerId)pointer=null},0)};
 for(const event of ['pointerup','pointercancel'])window.addEventListener(event,releasePointer);
 window.addEventListener('keyup',e=>{if(key===e.key)setTimeout(()=>{if(key===e.key)key=null},0)});
 pad.addEventListener('blur',()=>{key=null});
 window.addEventListener('blur',()=>{pointer=null;key=null});
}
window.addEventListener('keydown',e=>{const kind=padKeys[e.key.toLowerCase()];if(!kind||e.defaultPrevented||e.repeat||e.metaKey||e.ctrlKey||e.altKey||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;e.preventDefault();triggerDrum(kind)});
// Decode after the first gesture, before the first intentional drum hit when possible.
window.addEventListener('pointerdown',()=>prepare().catch(()=>{}),{once:true});
