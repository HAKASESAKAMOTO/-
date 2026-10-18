import { RotationLink } from './rotation-link.js';
export function relativeRadians(angle, zero=0, reverse=false){return (angle-zero)*Math.PI/180*(reverse?-1:1);}
export function createHardwareInput({onAngle,onMode}){
 const unified=new URLSearchParams(location.search).get('api')==='v1';
 const $=id=>document.getElementById(id);
 let enabled=false,connected=false,latest=null,visual=0,stream=null,lastMessage=0;
 const link=new RotationLink(1),label=$('hardwareStatus'),toggle=$('hardwareToggle');
 try{$('hardwareReverse').checked=localStorage.getItem('ecology.reverse')==='true';}catch(_){}
 link.setDirection($('hardwareReverse').checked?-1:1);
 function stale(){connected=false;link.rebase();$('hardwareZero').disabled=true;label.textContent='信号中断 · 保持视角';}
 function receive(event){
  if(!enabled)return;
  try{
   let data=JSON.parse(event.data);lastMessage=performance.now();
   if(unified){const state=data.data;data={connected:state.connected,port:state.port,age_ms:state.ageMs,latest:{boot_id:state.packet?.bootId,ms:state.packet?.uptimeMs},angle:state.rotation?{available:state.rotation.available,steps:state.rotation.steps,steps_per_turn:state.rotation.stepsPerTurn,sign:state.rotation.directionSign,total_angle:state.rotation.totalDegrees}:null};}
   const next=link.update(data,visual);
   if(next===null){stale();return;}
   connected=true;latest=data.angle.total_angle;visual=next;
   $('hardwareZero').disabled=false;$('hardwareAngle').textContent=visual.toFixed(1)+'°';
   label.textContent='实时跟随 · '+data.port;
   $('poster').dataset.hardwareTarget=String(visual);
   onAngle(visual*Math.PI/180);
  }catch(_){stale();}
 }
 function setEnabled(value){
  enabled=value;stream?.close();stream=null;link.rebase();
  toggle.setAttribute('aria-pressed',String(enabled));toggle.textContent=enabled?'停止硬件跟随':'开启硬件跟随';
  onMode(enabled);
  if(enabled){label.textContent='等待旋钮数据…';lastMessage=performance.now();stream=new EventSource(unified?'/api/v1/hardware/events':'/api/hardware-stream');stream.onmessage=receive;stream.onerror=stale;}
  else{connected=false;$('hardwareZero').disabled=true;label.textContent='手动模式';}
 }
 toggle.onclick=()=>setEnabled(!enabled);
 $('hardwareZero').onclick=()=>{if(connected){visual=0;link.rebase();onAngle(0);}};
 $('hardwareReverse').onchange=()=>{link.setDirection($('hardwareReverse').checked?-1:1);try{localStorage.setItem('ecology.reverse',String($('hardwareReverse').checked));}catch(_){}};
 const watchdog=setInterval(()=>{if(enabled&&performance.now()-lastMessage>1200)stale();},300);
 window.addEventListener('pagehide',()=>{stream?.close();clearInterval(watchdog);},{once:true});
 setEnabled(!unified);
 return {stop:()=>setEnabled(false),getState:()=>({enabled,connected,angle:latest,visual,reverse:$('hardwareReverse').checked})};
}
