import{ap as f,ba as v,o as l,a as i,f as c,p as m,az as h,q as d}from"./asset-base-CBk30c0P.js";import{P as p,F as n}from"./game-BbCAWasA.js";import{F as g,d as x,e as w,f as b}from"./nuketown-sky-DKqnuq2p.js";import"./modulepreload-polyfill-B5Qt9EMX.js";import"./bruiser-Br1ayxPF.js";import"./astronaut-tFiExXRr.js";import"./software-sky-BxvhM3wW.js";class j extends p{constructor(e,s,t,o){super(),this.camera=e,this.scene=o,this.needsSwap=!0,typeof location<"u"&&new URLSearchParams(location.search).get("ntao")==="0"&&(this.enabled=!1);for(const a of[s.renderTarget1,s.renderTarget2])a.depthTexture||(a.depthTexture=new f(a.width,a.height,v)),a.resolveDepthBuffer=!0,a.dispose();const r=()=>new m(1,1,{type:d,depthBuffer:!1,minFilter:h,magFilter:h});this.aoRT=r(),this.blurRT=r();const u=`
      uniform sampler2D tDepth; uniform float uNear, uFar; uniform vec2 uProj, uFull;
      float viewZ(float d){
        ${t?"return -uNear * uFar / (d * (uFar - uNear) + uNear);":"return (uNear * uFar) / ((uFar - uNear) * d - uFar);"}
      }
      // reconstruct at the exact centre of the depth texel actually read (a half-res
      // pixel sits between four of them: unsnapped, flat planes become staircases)
      // integer texel addressing throughout: a half-res pixel centre lands exactly on
      // a full-res texel boundary, and float rounding there flips texels in stripes
      vec3 viewPosI(ivec2 ip){
        ip = clamp(ip, ivec2(0), ivec2(uFull) - 1);
        vec2 s = (vec2(ip) + 0.5) / uFull;
        float z = viewZ(texelFetch(tDepth, ip, 0).r);
        return vec3((s * 2.0 - 1.0) * (-z) / uProj, z);
      }`;this.aoMat=new l({uniforms:{tDepth:{value:null},uNear:{value:.1},uFar:{value:400},uProj:{value:new i(1,1)},uFull:{value:new i(1,1)},uTexel:{value:new i},uRes:{value:new i},uRadius:{value:.9}},vertexShader:"varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",fragmentShader:`precision highp float;
        varying vec2 vUv; uniform vec2 uTexel, uRes; uniform float uRadius;
        ${u}
        void main(){
          ivec2 ic = ivec2(gl_FragCoord.xy) * 2;
          vec3 P = viewPosI(ic);
          float dist = -P.z;
          if (dist < 0.6 || dist > 78.0) { gl_FragColor = vec4(1.0, dist, 0.0, 1.0); return; }
          // normal from depth: the smaller step on each axis (no smearing across silhouettes)
          vec3 px = viewPosI(ic + ivec2(1, 0)) - P, nx = P - viewPosI(ic - ivec2(1, 0));
          vec3 py = viewPosI(ic + ivec2(0, 1)) - P, ny = P - viewPosI(ic - ivec2(0, 1));
          vec3 dx = abs(px.z) < abs(nx.z) ? px : nx, dy = abs(py.z) < abs(ny.z) ? py : ny;
          vec3 N = normalize(cross(dx, dy));
          // ONE fixed set of directions and step offsets for every pixel: no
          // screen-space pattern at all, so the AO is a pure function of the
          // geometry and cannot crawl against it when the camera moves (a 4x4
          // interleaved pattern left a residue at depth edges that did)
          float rot = 0.3926991;  // 22.5 deg: the 8 directions sit between the axes
          float jit = 0.5;
          // near the eye a few mm of camera motion re-reveals parts of an overhang
          // (screen-space parallax): smaller radius there, and the strength fades in
          // from 1.5 m to 4.5 m (gate "shimmer"); contact at play distances is untouched
          float rad = min(uRadius, 0.2 + 0.25 * dist);
          float rPx = min(rad * uProj.y * 0.5 * uRes.y / dist, 64.0);
          float r2 = rad * rad;
          // falloff-weighted MEAN over 6 steps per direction (not the horizon max: a
          // max switches wholesale when one step slides onto an edge, which crawls
          // under millimetre camera moves; a mean moves by 1/48 per step)
          float occ = 0.0;
          for (int i = 0; i < 8; i++) {
            float a = float(i) * 0.7853982 + rot;
            vec2 dir = vec2(cos(a), sin(a));
            float h = 0.0;
            for (int j = 0; j < 6; j++) {
              float t = (float(j) + jit) / 6.0;
              vec2 o = dir * max(t * t * rPx, 1.0 + float(j));
              vec3 v = viewPosI(ic + ivec2(floor(o * 2.0 + 0.5))) - P;
              float vv = dot(v, v);
              float w = 1.0 - smoothstep(r2 * 0.35, r2, vv);
              h += max(dot(v, N) * inversesqrt(vv + 1e-6) - 0.08, 0.0) * w;
            }
            occ += h / 6.0;
          }
          float ao = 1.0 - clamp(occ / 8.0, 0.0, 1.0) * 2.6;
          // surfaces seen edge-on (board ends, thin trim): the depth-derived normal is
          // ill-conditioned there and flips with millimetre camera moves; no AO on them
          ao = mix(1.0, ao, smoothstep(0.12, 0.35, abs(dot(N, normalize(-P)))));
          ao = clamp(ao, 0.0, 1.0);
          ao = mix(ao, 1.0, smoothstep(45.0, 78.0, dist) + 1.0 - smoothstep(1.5, 4.5, dist));
          gl_FragColor = vec4(ao, dist, 0.0, 1.0);
        }`,depthTest:!1,depthWrite:!1}),this.blurMat=new l({uniforms:{tAO:{value:null},uDir:{value:new i}},vertexShader:"varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",fragmentShader:`precision highp float;
        varying vec2 vUv; uniform sampler2D tAO; uniform vec2 uDir;
        void main(){
          vec2 c = texture2D(tAO, vUv).rg;
          float s = 0.0, w = 0.0;
          for (int i = -2; i <= 1; i++) {
            vec2 t = texture2D(tAO, vUv + uDir * float(i)).rg;
            float k = exp(-abs(t.g - c.g) / max(0.05 * c.g, 0.03)) + 1e-4;
            s += t.r * k;
            w += k;
          }
          gl_FragColor = vec4(s / w, c.g, 0.0, 1.0);
        }`,depthTest:!1,depthWrite:!1}),this.compMat=new l({uniforms:{tDiffuse:{value:null},tAO:{value:null},tDepth:{value:null},uNear:{value:.1},uFar:{value:400},uProj:{value:new i(1,1)},uFull:{value:new i(1,1)},uHalf:{value:new i},uStrength:{value:.85},uDebug:{value:0},uFogColor:{value:new c(0,0,0)},uCamY:{value:0}},vertexShader:"varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",fragmentShader:`precision highp float;
        varying vec2 vUv; uniform sampler2D tDiffuse, tAO; uniform vec2 uHalf; uniform float uStrength; uniform int uDebug; uniform vec3 uFogColor; uniform float uCamY;
        ${u}
        void main(){
          vec4 col = texture2D(tDiffuse, vUv);
          float d = -viewZ(texture2D(tDepth, vUv).r);
          // joint-bilateral upsample from the 4 nearest half-res texels
          vec2 p = vUv / uHalf - 0.5, f = fract(p), b = (floor(p) + 0.5) * uHalf;
          float s = 0.0, w = 0.0;
          for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
            vec2 t = texture2D(tAO, b + vec2(float(i), float(j)) * uHalf).rg;
            float k = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) + 1e-3;
            k *= exp(-abs(t.g - d) / max(0.03 * d, 0.02));
            s += t.r * k;
            w += k;
          }
          float ao = w > 1e-4 ? s / w : 1.0;
          ao = mix(1.0, ao, uStrength);
          // occlude the SURFACE, not the haze in front of it (nuketown-sky.ts installHeightFog,
          // level-ray approximation): col = surf (1 - f) + fog f  ->  surf (1 - f) ao + fog f
          float fogF = 1.0 - (1.0 - ${g.toFixed(4)}) * exp(-${x.toFixed(6)} * d * (1.0 + ${w.toFixed(3)} * exp(-max(uCamY, 0.0) / ${b.toFixed(2)})));
          col.rgb = col.rgb * ao + uFogColor * fogF * (1.0 - ao);
          if (uDebug == 1) col.rgb = vec3(ao) * 0.5;
          if (uDebug == 2) col.rgb = vec3(fract(d * 0.5)) * 0.5;
          if (uDebug == 3) col.rgb = vec3(texture2D(tAO, vUv).r) * 0.5;
          gl_FragColor = col;
        }`,depthTest:!1,depthWrite:!1}),this.aoQuad=new n(this.aoMat),this.blurQuad=new n(this.blurMat),this.compQuad=new n(this.compMat)}strength=.7;debug=0;aoRT;blurRT;aoQuad;blurQuad;compQuad;aoMat;blurMat;compMat;setSize(e,s){const t=Math.max(1,Math.round(e/2)),o=Math.max(1,Math.round(s/2));this.aoRT.setSize(t,o),this.blurRT.setSize(t,o),this.aoMat.uniforms.uTexel.value.set(1/e,1/s),this.aoMat.uniforms.uRes.value.set(t,o),this.compMat.uniforms.uHalf.value.set(1/t,1/o)}render(e,s,t){const o=this.camera,r=o.projectionMatrix.elements;for(const a of[this.aoMat,this.compMat])a.uniforms.tDepth.value=t.depthTexture,a.uniforms.uNear.value=o.near,a.uniforms.uFar.value=o.far,a.uniforms.uProj.value.set(r[0],r[5]),a.uniforms.uFull.value.set(t.width,t.height);this.aoRT.width!==Math.max(1,Math.round(t.width/2))&&this.setSize(t.width,t.height),e.setRenderTarget(this.aoRT),this.aoQuad.render(e),this.blurMat.uniforms.tAO.value=this.aoRT.texture,this.blurMat.uniforms.uDir.value.set(1/this.aoRT.width,0),e.setRenderTarget(this.blurRT),this.blurQuad.render(e),this.blurMat.uniforms.tAO.value=this.blurRT.texture,this.blurMat.uniforms.uDir.value.set(0,1/this.aoRT.height),e.setRenderTarget(this.aoRT),this.blurQuad.render(e),this.compMat.uniforms.tDiffuse.value=t.texture,this.compMat.uniforms.tAO.value=this.aoRT.texture,this.compMat.uniforms.uStrength.value=this.strength,this.compMat.uniforms.uDebug.value=this.debug;const u=this.scene?.fog;u&&this.compMat.uniforms.uFogColor.value.copy(u.color),this.compMat.uniforms.uCamY.value=o.position.y,e.setRenderTarget(this.renderToScreen?null:s),this.compQuad.render(e)}dispose(){this.aoRT.dispose(),this.blurRT.dispose();for(const e of[this.aoMat,this.blurMat,this.compMat])e.dispose();for(const e of[this.aoQuad,this.blurQuad,this.compQuad])e.dispose()}}export{j as NuketownAO};
//# sourceMappingURL=nuketown-ao-QJCJR0Ed.js.map
