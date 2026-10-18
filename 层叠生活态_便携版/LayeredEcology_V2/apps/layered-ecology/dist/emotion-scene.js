import * as THREE from './vendor/three.module.js';
import { sessionEmotionRecords, exampleEmotionRecords } from './emotion-records.js';
import { createEmotionDialog } from './emotion-dialog.js';

export const angleDistance=(a,b)=>Math.abs(Math.atan2(Math.sin(a-b),Math.cos(a-b)));
export function angleBlend(angle,center){
  const distance=angleDistance(angle,center);
  return 1-THREE.MathUtils.smoothstep(distance,Math.PI*48/180,Math.PI/3);
}

export async function createEmotionScene({scene,camera,building,interaction,modelWindow,initialAzimuth,reducedMotion,sessionId=null,onOpen}){
  const palette=await fetch('assets/emotions.json').then(r=>{if(!r.ok)throw Error('情绪配色载入失败');return r.json();});
  const lightMap=await new THREE.TextureLoader().loadAsync('assets/light-color.jpg');
  lightMap.flipY=false;lightMap.colorSpace=THREE.SRGBColorSpace;
  const mix={value:0},center=initialAzimuth+Math.PI;
  const materials=new Set();
  building.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);});
  for(const material of materials){
    const cleanFloor=material.userData?.cleanFloorLighting===true;
    const baked=material.name==='Baked architectural lighting'||cleanFloor;
    material.onBeforeCompile=shader=>{
      shader.uniforms.emotionMix=mix;shader.uniforms.lightColorMap={value:cleanFloor?material.emissiveMap:lightMap};
      shader.fragmentShader='uniform float emotionMix;\nuniform sampler2D lightColorMap;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
        float gray=dot(outgoingLight,vec3(.2126,.7152,.0722));
        vec3 monochrome=vec3(gray*.27);
        ${cleanFloor?`vec3 illumination=texture2D(lightColorMap,vEmissiveMapUv).rgb;
        float lightGray=dot(illumination,vec3(.2126,.7152,.0722));
        float warmth=clamp((illumination.r-illumination.b)*4.,0.,1.);
        // Clean neutral floors need no thresholded relighting mask: it creates false dark islands.
        monochrome=max(vec3(0.),vec3(gray*.32)+(illumination-vec3(lightGray))*.45*warmth);`:baked?`vec3 illumination=texture2D(lightColorMap,vEmissiveMapUv).rgb;
        float lightGray=max(dot(illumination,vec3(.2126,.7152,.0722)),.001);
        // Use illumination chroma, never material chroma. Keep neutral/cool ambient gray.
        float warm=smoothstep(.04,.22,illumination.r-illumination.b);
        monochrome=max(vec3(0.),mix(monochrome,vec3(gray*.9),warm)+(illumination-vec3(lightGray))*(gray/lightGray)*warm*1.3);`:''}
        outgoingLight=mix(outgoingLight,monochrome,emotionMix);
        #include <opaque_fragment>`);
    };
    material.customProgramCacheKey=()=>`emotion-${cleanFloor?'clean-floor':baked}`;
    material.needsUpdate=true;
  }
  const group=new THREE.Group();scene.add(group);
  const sphere=new THREE.SphereGeometry(1,24,16),bubbles=[];
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
  let elapsed=0,popped=0,down=null,records=[],signature='',dataError='',refreshing=null;
  const hitLayer=document.createElement('div');hitLayer.className='emotion-hit-layer';document.body.append(hitLayer);
  const note=document.createElement('p');note.className='emotion-state-note';note.hidden=true;note.setAttribute('role','status');document.body.append(note);
  const dialog=createEmotionDialog({onOpen,onClose:(id,restoreFocus)=>{
    const b=bubbles.find(b=>b.record.id===id);
    if(b&&mix.value>.3&&!dataError){b.respawnAt=elapsed-.8;b.button.hidden=false;if(restoreFocus)b.button.focus({preventScroll:true});}
    else if(restoreFocus)interaction.focus({preventScroll:true});
  }});
  function texture(kind,color,word=''){
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=kind==='word'?192:512;
    const ctx=canvas.getContext('2d');
    if(kind==='word'){ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='700 132px "Microsoft YaHei",sans-serif';ctx.strokeStyle='#10151e';ctx.lineWidth=14;ctx.strokeText(word,256,96);ctx.fillStyle=color;ctx.fillText(word,256,96);}
    else {ctx.strokeStyle=color;ctx.lineWidth=8;ctx.beginPath();ctx.arc(256,256,220,0,Math.PI*2);ctx.stroke();}
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;return map;
  }
  function addBubble(record,i){
    const sector=record.sector,color=record.color,floor=record.floor;
    const material=new THREE.MeshBasicMaterial({color,transparent:true,opacity:0,depthWrite:false,toneMapped:false});
    material.onBeforeCompile=shader=>{
      shader.vertexShader='varying vec3 bubbleNormal; varying vec3 bubbleView;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\nbubbleNormal=normalize(normalMatrix*normal); bubbleView=normalize(-mvPosition.xyz);');
      shader.fragmentShader='varying vec3 bubbleNormal; varying vec3 bubbleView;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`float rim=pow(1.-abs(dot(normalize(bubbleNormal),normalize(bubbleView))),2.);
      outgoingLight+=vec3(.4)*pow(max(dot(normalize(bubbleNormal),normalize(vec3(-.4,.7,1.))),0.),32.);
      diffuseColor.a*=.72+.28*rim;
      #include <opaque_fragment>`);
    };
    const mesh=new THREE.Mesh(sphere,material);mesh.renderOrder=2;group.add(mesh);
    const ring=new THREE.Sprite(new THREE.SpriteMaterial({map:texture('ring',color),transparent:true,opacity:0,depthWrite:false,toneMapped:false}));group.add(ring);
    const label=new THREE.Sprite(new THREE.SpriteMaterial({transparent:true,opacity:0,depthWrite:false,depthTest:false,toneMapped:false}));label.renderOrder=3;group.add(label);
    const button=document.createElement('button');button.type='button';button.className='emotion-hit';button.hidden=true;
    button.dataset.photoId=record.photoId||'';button.dataset.recordId=record.id;button.dataset.emotion=record.label;
    button.setAttribute('aria-label',`${record.source==='example'?'示例：':''}${record.objectName} · ${record.label}，查看情绪说明`);
    button.addEventListener('pointerdown',e=>e.stopPropagation());
    button.addEventListener('click',e=>{e.stopPropagation();burst(b);});hitLayer.append(button);
    const b={mesh,ring,label,button,record,sector,color,floor,phase:i*2.399,base:new THREE.Vector3(i%2?-4.8:4.8,5.5+floor*3.2,i%2?3.8:-3.8),radius:.76,burstAt:-100,respawnAt:0,generation:0};
    mesh.userData.bubble=b;bubbles.push(b);
  }
  function setRecords(next){
    const nextSignature=JSON.stringify(next);if(nextSignature===signature)return;
    signature=nextSignature;records=next;
    for(const b of bubbles){
      group.remove(b.mesh,b.ring,b.label);b.mesh.material.dispose();
      for(const sprite of [b.ring,b.label]){sprite.material.map?.dispose();sprite.material.dispose();}
      b.button.remove();
    }
    bubbles.length=0;next.forEach(addBubble);dialog.update(next);
  }
  function refresh(){
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      try{
        if(!sessionId){setRecords(exampleEmotionRecords(palette));dataError='';return;}
        const response=await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`,{cache:'no-store'});
        if(!response.ok)throw Error('无法读取本次标注，请重新打开我的生活大楼。');
        const snapshot=(await response.json()).data;
        if(snapshot?.sessionId!==sessionId)throw Error('会话已变化，请重新打开我的生活大楼。');
        const next=sessionEmotionRecords(snapshot,palette);dataError='';setRecords(next);
      }catch(error){dataError=error.message;dialog.close();setRecords([]);}
    })().finally(()=>refreshing=null);
    return refreshing;
  }
  await refresh();
  const refreshTimer=sessionId?setInterval(()=>{if(!document.hidden)void refresh();},4000):null;
  window.addEventListener('pagehide',()=>clearInterval(refreshTimer),{once:true});
  window.addEventListener('message',event=>{
    if(event.origin===location.origin&&event.source===parent&&event.data?.type==='layered-life:refresh-emotions'&&event.data.sessionId===sessionId)void refresh();
  });
  const live=document.getElementById('emotionLive');
  function burst(b){
    if(mix.value<.3||elapsed<b.respawnAt||dataError)return;
    const word=b.record.label;b.generation++;b.burstAt=elapsed;b.respawnAt=elapsed+4;
    b.label.material.map?.dispose();b.label.material.map=texture('word',b.color,word);b.label.material.needsUpdate=true;
    b.ring.position.copy(b.mesh.position);b.label.position.copy(b.mesh.position);live.textContent=`${b.record.objectName}：${word}`;popped++;
    dialog.show(b.record,b.screen);
  }
  interaction.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,id:e.pointerId,time:performance.now()};});
  interaction.addEventListener('pointercancel',()=>down=null);
  interaction.addEventListener('pointerup',e=>{
    const start=down;down=null;if(!start||start.id!==e.pointerId||Math.hypot(e.clientX-start.x,e.clientY-start.y)>7||performance.now()-start.time>700)return;
    const r=modelWindow.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);
    const hits=ray.intersectObjects([building,...bubbles.filter(b=>b.mesh.visible).map(b=>b.mesh)],true);
    const first=hits.find(h=>h.object.userData.bubble||!h.object.material?.transparent);
    if(first?.object.userData.bubble)burst(first.object.userData.bubble);
  });
  document.getElementById('popEmotion').onclick=()=>{const b=bubbles.find(b=>b.mesh.visible&&elapsed>=b.respawnAt);if(b)burst(b);};
  return {
    update(dt,angle){
      elapsed+=dt;const target=angleBlend(angle,center);
      mix.value=THREE.MathUtils.lerp(mix.value,target,1-Math.exp(-dt/ (reducedMotion?.18:.55)));
      if(Math.abs(mix.value-target)<.0001)mix.value=target;
      document.getElementById('posterBack').style.filter=`grayscale(${mix.value}) brightness(${1-mix.value*.48})`;
      for(const id of ['posterRearText','posterFront'])document.getElementById(id).style.filter=`brightness(${1-mix.value*.55})`;
      document.getElementById('popEmotion').disabled=mix.value<.3||Boolean(dataError)||!bubbles.length;
      document.getElementById('emotionHint').textContent=mix.value>.4?'点击气泡，查看对应照片的感受':'转向建筑背面，发现情绪气泡';
      note.textContent=dataError||(!sessionId?'示例情绪 · 你的选择显示在“我的生活大楼”中':'');
      note.hidden=mix.value<.3||!note.textContent;
      if(mix.value<.3)dialog.close();
      const bounds=modelWindow.getBoundingClientRect();
      for(const b of bubbles){
        const t=elapsed,age=t-b.burstAt,alive=t>=b.respawnAt;
        b.mesh.position.copy(b.base);
        if(!reducedMotion)b.mesh.position.add(new THREE.Vector3(Math.sin(t*.42+b.phase)*.32,Math.sin(t*.6+b.phase)*.24,Math.cos(t*.38+b.phase)*.28));
        const fade=THREE.MathUtils.smoothstep(t-b.respawnAt,0,.8);
        b.mesh.scale.setScalar(b.radius*(.85+.15*fade));b.mesh.material.opacity=mix.value*.96*fade;b.mesh.visible=alive&&mix.value>.005&&!dataError;
        b.ring.visible=age>=0&&age<.5&&mix.value>.005;b.ring.material.opacity=mix.value*(1-age/.5);b.ring.scale.setScalar(b.radius*(2+age*7));
        b.label.visible=age>=.12&&age<2.8&&mix.value>.005;b.label.material.opacity=mix.value*THREE.MathUtils.smoothstep(age,.12,.35)*(1-THREE.MathUtils.smoothstep(age,1.8,2.8));
        b.label.position.y=b.base.y+(reducedMotion?0:Math.min(age,2)*.3);b.label.scale.set(5.6,2.1,1);
        const point=b.mesh.position.clone().project(camera);
        const x=bounds.left+(point.x+1)*bounds.width/2,y=bounds.top+(1-point.y)*bounds.height/2;
        b.screen={x,y};
        b.button.hidden=!b.mesh.visible||mix.value<.3||Math.abs(point.x)>1||Math.abs(point.y)>1||Math.abs(point.z)>1||x<0||y<0||x>innerWidth||y>innerHeight;
        b.button.style.left=x+'px';b.button.style.top=y+'px';
        if(dialog.selectedId===b.record.id)dialog.position(b.screen);
      }
    },
    refresh,
    getState:()=>({blend:mix.value,triggerCenter:center,halfRange:Math.PI/3,popped,sessionId,dataError,openRecordId:dialog.selectedId,records:structuredClone(records),bubbles:bubbles.map(b=>({photoId:b.record.photoId,recordId:b.record.id,label:b.record.label,color:b.color,floor:b.floor,visible:b.mesh.visible,clickable:!b.button.hidden,screen:b.screen,respawnIn:Math.max(0,b.respawnAt-elapsed),position:b.mesh.position.toArray(),generation:b.generation}))})
  };
}
