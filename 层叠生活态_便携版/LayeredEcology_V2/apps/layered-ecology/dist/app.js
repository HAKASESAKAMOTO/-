import { RotationMotion } from './rotation-motion.js';
import { createLiveRoofQr } from './live-roof-qr.js';
import { createEmotionScene } from './emotion-scene.js';
import { createHardwareInput } from './hardware-input.js';
import { placeSessionObjects } from './session-objects.js';
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { DRACOLoader } from './vendor/DRACOLoader.js';

const $ = id => document.getElementById(id);
const poster=$('poster'), modelWindow=$('modelWindow'), interaction=$('interaction');
const buttons=['reset','rotateLeft','rotateRight','zoomOut','zoomIn','autoRotate','export'];
const sessionId=new URLSearchParams(location.search).get('session');
if(sessionId){$('fallback').style.display='none';}
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer,scene,camera,controls,initial,ready=false,raf,observer;
let targetAzimuth=null,targetPolar=null,activePointers=0;
let emotion,hardware,originalAzimuth=0;
const rotationMotion=new RotationMotion(120);
let hardwareFollowing=false,externalFollowing=false;
let roofQr, pendingQr = null;
window.addEventListener('message', event => {
 if(event.origin!==location.origin || event.source!==parent || event.data?.type!=='layered-life:qr')return;
 pendingQr=event.data.dataUrl;
 roofQr?.update(pendingQr).catch(()=>{});
});
// 草船二维码定时刷新：持续拉取 Receiver 最新帧，保证屋顶二维码是动态的。
function refreshRoofQr(){fetch('/api/v1/intake/qr').then(r=>r.ok?r.json():null).then(p=>{if(!p)return;const v=p.data?.qrDataUrl??null;if(v===pendingQr)return;pendingQr=v;roofQr?.update(pendingQr).catch(()=>{});}).catch(()=>{});}
refreshRoofQr();setInterval(refreshRoofQr,2000);
function status(text,error=false){$('statusText').textContent=text;$('statusDot').className='status-dot '+(error?'error':'ready');}
function setAuto(value){if(!controls)return;controls.autoRotate=value;$('autoRotate').setAttribute('aria-pressed',String(value));$('autoRotate').querySelector('span').textContent=value?'暂停旋转':'自动旋转';}
function reset(){if(!ready)return;hardware?.stop();setAuto(false);targetAzimuth=targetPolar=null;camera.position.copy(initial.position);camera.zoom=1;camera.updateProjectionMatrix();controls.target.copy(initial.target);controls.update();controls.saveState();updateZoom();}
function updateZoom(){$('zoomValue').textContent=Math.round(camera.zoom*100)+'%';}
function zoom(factor){if(!ready)return;camera.zoom=THREE.MathUtils.clamp(camera.zoom*factor,controls.minZoom,controls.maxZoom);camera.updateProjectionMatrix();updateZoom();}
function rotate(delta){if(!ready)return;setAuto(false);targetAzimuth=(targetAzimuth??controls.getAzimuthalAngle())+delta;}
function fail(error){console.error(error);ready=false;$('loading').hidden=false;$('loadText').textContent='模型载入失败，请重新加载';$('retry').hidden=false;status('加载失败，可重新加载',true);buttons.forEach(id=>$(id).disabled=true);}
async function init(){
 try{
  const [meta,layout]=await Promise.all(['model.json','poster.json'].map(name=>fetch('assets/'+name).then(r=>{if(!r.ok)throw Error('资源加载失败：'+name);return r.json();})));
  const [sx,sy,sw,sh]=layout.slot,[cx,cy,cw,ch]=layout.canvas_in_slot;
  Object.assign(modelWindow.style,{left:(sx+cx*sw)*100+'%',top:(sy+cy*sh)*100+'%',width:cw*sw*100+'%',height:ch*sh*100+'%'});
  renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=Math.pow(2,meta.exposure);
  modelWindow.replaceChildren(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();fail(Error('WebGL context lost'));});
  scene=new THREE.Scene();
  const aspect=meta.render_size[0]/meta.render_size[1],h=meta.ortho_scale;
  camera=new THREE.OrthographicCamera(-h*aspect/2,h*aspect/2,h/2,-h/2,.1,1000);
  camera.position.fromArray(meta.camera_position);camera.up.set(0,1,0);
  controls=new OrbitControls(camera,interaction);controls.target.fromArray(meta.camera_target);
  // Orbit around the model's vertical center shaft, not the poster framing target.
  const framingTarget=controls.target.clone();
  const axis=meta.rotation_axis_xz ?? [0,0];
  controls.target.x=axis[0];controls.target.z=axis[1];
  camera.position.add(controls.target.clone().sub(framingTarget));
  poster.dataset.rotationAxis=JSON.stringify([axis[0],axis[1]]);
  poster.dataset.motionResponseMs='120';
  controls.enablePan=false;controls.enableDamping=false;controls.dampingFactor=.08;
  controls.rotateSpeed=.55;controls.zoomSpeed=.7;controls.minZoom=.65;controls.maxZoom=1.6;
  controls.minPolarAngle=.35;controls.maxPolarAngle=Math.PI/2-.045;controls.autoRotateSpeed=.65;
  controls.touches.ONE=THREE.TOUCH.ROTATE;controls.touches.TWO=THREE.TOUCH.DOLLY_ROTATE;
  controls.update();controls.minPolarAngle=controls.maxPolarAngle=controls.getPolarAngle();initial={position:camera.position.clone(),target:controls.target.clone()};
  controls.addEventListener('change',updateZoom);controls.addEventListener('start',()=>{setAuto(false);targetAzimuth=targetPolar=null;});
  const decoder=new DRACOLoader();decoder.setDecoderPath('./vendor/draco/');decoder.setWorkerLimit(2);
  const loader=new GLTFLoader();loader.setDRACOLoader(decoder);
  const gltf=await loader.loadAsync('assets/'+(sessionId?'empty-building.glb':'building.glb'),e=>{if(e.total)$('loadText').textContent='正在载入模型 '+Math.round(e.loaded/e.total*100)+'%';});
  scene.add(gltf.scene);poster.dataset.template=sessionId?'empty':'example';poster.dataset.sessionObjects='0';
  roofQr=createLiveRoofQr(gltf.scene);
  await roofQr.update(pendingQr);
  // 自己的生活大楼：?session=ID 时把本次会话 Rodin 生成的物件放进各层。
  if(sessionId){$('loadText').textContent='正在放入你的生活物件…';poster.dataset.sessionObjects=JSON.stringify(await placeSessionObjects({sessionId,scene,building:gltf.scene,loader,camera}).then(r=>r.count));}
  scene.add(new THREE.HemisphereLight(0xb5d2ff,0x39302a,1.4));
  const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(10,25,18);scene.add(light);
  gltf.scene.traverse(o=>{if(o.isMesh){o.frustumCulled=true;if(o.material?.transparent){o.material.depthWrite=false;o.renderOrder=1;}}});
  emotion=await createEmotionScene({scene,camera,building:gltf.scene,interaction,modelWindow,initialAzimuth:controls.getAzimuthalAngle(),reducedMotion,sessionId,onOpen:()=>setAuto(false)});
  observer=new ResizeObserver(()=>{renderer.setSize(Math.max(1,modelWindow.clientWidth),Math.max(1,modelWindow.clientHeight),false);});observer.observe(modelWindow);
  renderer.setSize(modelWindow.clientWidth,modelWindow.clientHeight,false);
  ready=true;buttons.forEach(id=>$(id).disabled=false);$('loading').hidden=true;$('retry').hidden=true;$('fallback').classList.add('loaded');status('真实模型已就绪 · 可拖动旋转');
  originalAzimuth=controls.getAzimuthalAngle();
  hardware=createHardwareInput({
    onAngle:angle=>{targetAzimuth=angle===null?null:originalAzimuth+angle;},
    onMode:enabled=>{
      hardwareFollowing=enabled;
      rotationMotion.reset(controls.getAzimuthalAngle());
      setAuto(false);targetAzimuth=targetPolar=null;controls.enableRotate=!enabled;
      controls.enableDamping=false;
      ['rotateLeft','rotateRight','autoRotate'].forEach(id=>$(id).disabled=enabled);
      status(enabled?'硬件跟随模式 · 仍可缩放与点击气泡':'真实模型已就绪 · 可拖动旋转');
    }
  });
  $('hardwareToggle').disabled=false;
  let last=performance.now();
  function frame(time){raf=requestAnimationFrame(frame);if(document.hidden)return;
    const dt=Math.min((time-last)/1000,.05);last=time;
    if(targetAzimuth!==null||targetPolar!==null){
      const spherical=new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      const smooth=reducedMotion?1:1-Math.exp(-12*dt);
      if(targetAzimuth!==null){if(hardwareFollowing){spherical.theta=reducedMotion?targetAzimuth:rotationMotion.step(targetAzimuth,dt);}else{const delta=Math.atan2(Math.sin(targetAzimuth-spherical.theta),Math.cos(targetAzimuth-spherical.theta));spherical.theta+=delta*smooth;if(Math.abs(delta)<.001)targetAzimuth=null;}}
      if(targetPolar!==null){spherical.phi=THREE.MathUtils.lerp(spherical.phi,targetPolar,smooth);if(Math.abs(spherical.phi-targetPolar)<.001)targetPolar=null;}
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    }
    controls.update(dt);emotion.update(dt,controls.getAzimuthalAngle());renderer.render(scene,camera);
    poster.dataset.angle=(controls.getAzimuthalAngle()*180/Math.PI).toFixed(2);
    poster.dataset.frameMs=(dt*1000).toFixed(1);
    poster.dataset.ready='true';
  }frame(last);
  // Small read-only diagnostics for local checks.
  window.posterViewer={getState:()=>({ready,azimuth:controls.getAzimuthalAngle(),polar:controls.getPolarAngle(),zoom:camera.zoom,autoRotate:controls.autoRotate,meshes:gltf.scene.children.length,emotion:emotion.getState(),hardware:hardware.getState()}),reset};
  window.layeredLifeViewer={apiVersion:'1.0',buildingId:'ecology',
    emotions:{getState:()=>emotion.getState(),refresh:()=>emotion.refresh()},
    setExternalRotation:angle=>{
      if(angle===null){externalFollowing=false;hardwareFollowing=false;controls.enableRotate=true;targetAzimuth=null;return;}
      if(!Number.isFinite(angle))throw Error('Invalid rotation');
      if(!externalFollowing){hardware.stop();setAuto(false);rotationMotion.reset(controls.getAzimuthalAngle());externalFollowing=true;}
      hardwareFollowing=true;controls.enableRotate=false;targetAzimuth=originalAzimuth+angle*Math.PI/180;
    },
    setQr:dataUrl=>roofQr.update(dataUrl),getQrState:()=>roofQr.getState(),
    command:name=>{const actions={reset:'reset',left:'rotateLeft',right:'rotateRight',zoomIn:'zoomIn',zoomOut:'zoomOut',auto:'autoRotate',export:'export',hardware:'hardwareToggle',zero:'hardwareZero',emotion:'popEmotion',retry:'retry'};if(actions[name])$(actions[name]).click();},
    getState:()=>({ready,buildingId:'ecology',template:sessionId?'empty':'example',sessionId,sessionObjects:Number(poster.dataset.sessionObjects),angleDegrees:(controls.getAzimuthalAngle()-originalAzimuth)*180/Math.PI,zoom:camera.zoom}),
    setView:({angleDegrees=0,zoom:scale=camera.zoom}={})=>{
      if(!Number.isFinite(angleDegrees)||!Number.isFinite(scale)||scale<.65||scale>1.6)throw Error('Invalid view');
      hardware.stop();setAuto(false);targetAzimuth=targetPolar=null;
      controls.enableDamping=false;controls.update();
      const spherical=new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));spherical.theta=originalAzimuth+angleDegrees*Math.PI/180;
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));camera.zoom=scale;camera.updateProjectionMatrix();controls.update();updateZoom();
      emotion.update(10,controls.getAzimuthalAngle());renderer.render(scene,camera);
    },reset,renderPosterBlob:exportPoster,exportPoster:async()=>{
      const state=window.layeredLifeViewer.getState();
      const response=await fetch('/api/v1/posters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buildingId:'ecology',generatorId:'ecology-poster',theme:'original',view:{angleDegrees:state.angleDegrees,zoom:state.zoom}})});
      const payload=await response.json();if(!response.ok)throw Error(payload.error?.message||'导出失败');return payload.data;
    }};
 }catch(error){fail(error);}
}
$('reset').onclick=reset;$('rotateLeft').onclick=()=>rotate(Math.PI/12);$('rotateRight').onclick=()=>rotate(-Math.PI/12);
$('zoomIn').onclick=()=>zoom(1.1);$('zoomOut').onclick=()=>zoom(1/1.1);$('autoRotate').onclick=()=>setAuto(!controls.autoRotate);
$('retry').onclick=()=>location.reload();
interaction.addEventListener('pointerdown',()=>{activePointers++;});
interaction.addEventListener('pointerup',()=>{activePointers=Math.max(0,activePointers-1);});
interaction.addEventListener('pointercancel',()=>{activePointers=0;});
interaction.addEventListener('dblclick',reset);
document.addEventListener('keydown',e=>{
 if(document.getElementById('emotion-dialog')?.open)return;
 if(!ready||['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;
 const shortcuts={a:'autoRotate',s:'export',k:'hardwareToggle',z:'hardwareZero',p:'popEmotion'};
 if(shortcuts[e.key.toLowerCase()]&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();$(shortcuts[e.key.toLowerCase()]).click();return;}
 if(e.key.toLowerCase()==='r'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();$('hardwareReverse').checked=!$('hardwareReverse').checked;$('hardwareReverse').dispatchEvent(new Event('change'));return;}
 if(e.key.toLowerCase()==='h'){e.preventDefault();reset();}
 if(document.activeElement!==interaction)return;
 if(hardware?.getState().enabled&&e.key.startsWith('Arrow'))return;
 const actions={ArrowLeft:()=>rotate(Math.PI/18),ArrowRight:()=>rotate(-Math.PI/18),'+':()=>zoom(1.1),'=':()=>zoom(1.1),'-':()=>zoom(1/1.1),Home:reset,
 ArrowUp:()=>{setAuto(false);targetPolar=Math.max(controls.minPolarAngle,controls.getPolarAngle()-.1);},ArrowDown:()=>{setAuto(false);targetPolar=Math.min(controls.maxPolarAngle,controls.getPolarAngle()+.1);}};
 if(actions[e.key]){e.preventDefault();actions[e.key]();}
});
async function exportPoster(){
   if(!ready)throw Error('模型尚未载入');
   setAuto(false);
   await Promise.all(['posterBack','posterRearText','posterFront'].map(id=>$(id).decode()));
   renderer.render(scene,camera);
   const out=document.createElement('canvas');out.width=2481;out.height=3508;const ctx=out.getContext('2d');
   ctx.filter=`grayscale(${emotion.getState().blend}) brightness(${1-emotion.getState().blend*.48})`;
   ctx.drawImage($('posterBack'),0,0,out.width,out.height);ctx.filter='none';
   ctx.filter=`brightness(${1-emotion.getState().blend*.55})`;
   ctx.drawImage($('posterRearText'),0,0,out.width,out.height);ctx.filter='none';
   const p=poster.getBoundingClientRect(),m=modelWindow.getBoundingClientRect();
   ctx.drawImage(renderer.domElement,(m.left-p.left)/p.width*out.width,(m.top-p.top)/p.height*out.height,m.width/p.width*out.width,m.height/p.height*out.height);
   ctx.filter=`brightness(${1-emotion.getState().blend*.55})`;
   ctx.drawImage($('posterFront'),0,0,out.width,out.height);ctx.filter='none';
   const blob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));if(!blob)throw Error('PNG export failed');
   return blob;
}
$('export').onclick=async()=>{
 const button=$('export');button.disabled=true;
 try{
   const blob=await exportPoster();
   const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='层叠生态_当前视角.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status('当前视角海报已保存');
 }catch(error){console.error(error);status('图片保存失败，请重试',true);}finally{button.disabled=false;}
};
init();
