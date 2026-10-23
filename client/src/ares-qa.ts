import * as THREE from "three";
import type { Game } from './game';
/** Opt-in release bench, never loaded during ordinary play. All controls are visible. */
/** The bench measures the WebGL2 path (renderer.info) — the cast is deliberate. */
function glRenderer(g: Game): THREE.WebGLRenderer {
  return g.renderer as THREE.WebGLRenderer;
}
export function installAresQA(g: Game): void {
  const panel=document.createElement('aside'); panel.id='ares-qa';
  panel.style.cssText='position:fixed;right:12px;top:12px;z-index:10010;background:#08151eed;color:#cff1e9;padding:14px;border:1px solid #52737a;font:11px/1.55 monospace;max-width:360px;max-height:60vh;overflow:auto';
  const title=document.createElement('b');title.textContent='ARES / RELEASE BENCH';panel.append(title);
  const button=document.createElement('button');button.textContent='Run 20s combat benchmark';button.style.cssText='display:block;margin:10px 0;padding:8px;border:1px solid #80d6cc;background:#19363e;color:white';panel.append(button);
  const resolution=document.createElement('button');resolution.textContent='Set true 4K buffer';resolution.style.cssText=button.style.cssText;panel.append(resolution);
  let fixed4K=false;const normalResize=g.resize.bind(g);
  g.resize=()=>{if(!fixed4K){normalResize();return;}g.renderer.setPixelRatio(1);g.renderer.setSize(3840,2160,false);g.renderer.domElement.style.width='100%';g.renderer.domElement.style.height='100%';g.camera.aspect=16/9;g.camera.updateProjectionMatrix();g.composer?.setPixelRatio(1);g.composer?.setSize(3840,2160);};
  resolution.addEventListener('click',()=>{fixed4K=!fixed4K;g.resize();resolution.textContent=fixed4K?'Restore display resolution':'Set true 4K buffer';});
  const out=document.createElement('pre');out.id='ares-measurements';out.style.cssText='white-space:pre-wrap;margin:0';out.textContent='Waiting for station deployment…';panel.append(out);document.body.append(panel);
  const frame:number[]=[],cpu:number[]=[];let started=0,previous=0,active=false,shots=0,lastAmmo=30;
  glRenderer(g).info.autoReset=false;
  const orig=g.draw.bind(g);g.draw=(dt:number)=>{
    const now=performance.now();
    if(active){
      const elapsed=now-started;
      g.keys.f=Math.floor(elapsed/2500)%4===0;g.keys.r=Math.floor(elapsed/2500)%4===1;g.keys.b=Math.floor(elapsed/2500)%4===2;g.keys.l=Math.floor(elapsed/2500)%4===3;
      g.keys.fire=true;g.fireHeld=true;g.keys.ads=Math.floor(elapsed/3000)%2===0;g.keys.reload=(g.me()?.ammo??30)===0;g.yaw+=dt*.18;
      if(previous&&frame.length<12000)frame.push(now-previous);previous=now;
      if(elapsed>20000){active=false;g.keys.f=g.keys.r=g.keys.b=g.keys.l=g.keys.fire=g.keys.ads=g.keys.reload=g.fireHeld=false;button.textContent='Run 20s combat benchmark';}
    }
    glRenderer(g).info.reset();
    orig(dt);
    if(active&&cpu.length<12000)cpu.push(performance.now()-now);
    const ammo=g.me()?.ammo??30;if(ammo<lastAmmo)shots+=lastAmmo-ammo;lastAmmo=ammo;
  };
  button.addEventListener('click',()=>{if(!g.session&&!g.net)return;frame.length=0;cpu.length=0;started=performance.now();previous=0;active=true;shots=0;button.textContent='Benchmark running…';});
  const q=(a:number[],p:number)=>{if(!a.length)return null;const s=a.slice().sort((a,b)=>a-b);return Math.round(s[Math.floor((s.length-1)*p)]!*100)/100;};
  setInterval(()=>{
    const context=g.diagnostics?.report().context;
    out.textContent=JSON.stringify({status:active?'measuring':frame.length?'complete':'ready',players:g.players.size,buffer:[g.renderer.domElement.width,g.renderer.domElement.height],context,frames:frame.length,frameP50ms:q(frame,.5),frameP95ms:q(frame,.95),drawCpuP50ms:q(cpu,.5),drawCpuP95ms:q(cpu,.95),shots,calls:glRenderer(g).info.render.calls,triangles:glRenderer(g).info.render.triangles},null,2);
  },1000);
}
