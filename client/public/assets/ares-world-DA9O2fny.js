import{V as $,c as E,f as O,aV as ve,aT as ue,aU as de,i as k,a0 as J,l as F,aN as pe,D as H,H as he,g,x as f,$ as D,aW as I,aX as Q,af as fe,w as ge,an as we,e as N,J as Z,K as ee,o as z,a1 as te,b as ye,aD as xe,aE as Me,X as Se}from"./asset-base-CBk30c0P.js";const P=o=>we(`/assets/ares/${o}`),_=new $(.18,.64,.75).normalize(),U=new $(-.32,.05,-.95).normalize(),oe=380,be=1,ae=230,K=new Map;function V(o,a,e,t){const i=`${a}_${e}`;let s=K.get(i);return s||(s=o.load(P(`tex/${i}.webp`)),s.wrapS=s.wrapT=ee,s.anisotropy=t,e==="c"&&(s.colorSpace=N),K.set(i,s)),s}const ke=new Set(["grate","tread","foil"]),_e={hull:{set:"hull",tile:1.6,color:13354684,rough:1,metal:0,normal:.6},hullAlt:{set:"hull",tile:1.6,color:11446947,rough:1,metal:0,normal:.6},graphite:{set:"graphite",tile:1.4,color:10133928,useColor:!0,rough:1,metal:.35,normal:.8},steel:{set:"steel",tile:.9,color:13225425,useColor:!0,rough:.8,metal:1,normal:.6},foil:{set:"foil",tile:.8,color:14263626,rough:.9,metal:1,normal:1.4,env:1.3},orange:{set:"paint",tile:1.2,color:13130278,rough:1,metal:0,normal:.5,paint:!0},teal:{set:"paint",tile:1.2,color:2919560,rough:1,metal:0,normal:.5,paint:!0},coral:{set:"paint",tile:1.2,color:12604991,rough:1,metal:0,normal:.5,paint:!0},floor:{set:"floor",tile:2,color:6580849,useColor:!0,rough:1,metal:.15,normal:.7},floorAlt:{set:"floor",tile:2,color:4870231,useColor:!0,rough:1,metal:.15,normal:.7},tread:{set:"tread",tile:.9,color:10923186,useColor:!0,rough:1,metal:.45,normal:1},grate:{set:"grate",tile:.45,color:8226188,useColor:!0,rough:1,metal:.4,normal:1.2},seam:{color:1053462,rough:.9,metal:.2},solar:{set:"solar",tile:1.6,color:16777215,useColor:!0,rough:.35,metal:.6,normal:.8,env:1.4},rubber:{set:"rubber",tile:.6,color:1908513,rough:1,metal:0,normal:.6},copper:{set:"steel",tile:.6,color:12875594,rough:.55,metal:1,normal:.6},lightCool:{color:724239,emissive:13625583,emissiveIntensity:2.2,rough:.4,metal:0},lightWarm:{color:724239,emissive:16766627,emissiveIntensity:2.4,rough:.4,metal:0}};function ze(o,a,e){const t=new k({color:o.color,roughness:o.rough??.6,metalness:o.metal??0});if(o.set){const i=1/(o.tile??1),s=d=>{const v=d.clone();return v.repeat.set(i,i),v.needsUpdate=!0,v};o.useColor&&(t.map=s(V(a,o.set,"c",e))),t.normalMap=s(V(a,o.set,"n",e)),t.normalScale.setScalar(o.normal??1);const r=s(V(a,o.set,"rm",e));t.roughnessMap=r,t.metalnessMap=(o.metal??0)>0?r:null}return o.emissive!==void 0&&(t.emissive.setHex(o.emissive),t.emissiveIntensity=o.emissiveIntensity??1),t.envMapIntensity=o.env??1,o.paint&&(t.polygonOffset=!0,t.polygonOffsetFactor=-2,t.polygonOffsetUnits=-2),t}function Ce(){const a=document.createElement("canvas");a.width=a.height=512;const e=a.getContext("2d");e.fillStyle="#081016",e.fillRect(0,0,512,512);let t=7;const i=()=>(t=t*1664525+1013904223>>>0)/4294967296;e.strokeStyle="rgba(120,190,200,0.16)",e.lineWidth=1;for(let r=0;r<=512;r+=32)e.beginPath(),e.moveTo(r+.5,0),e.lineTo(r+.5,512),e.stroke(),e.beginPath(),e.moveTo(0,r+.5),e.lineTo(512,r+.5),e.stroke();for(let r=0;r<3;r++){e.strokeStyle=r===0?"rgba(236,180,110,0.9)":"rgba(150,220,226,0.75)",e.lineWidth=2,e.beginPath();const d=90+r*140;for(let v=16;v<496;v+=4){const w=d+Math.sin(v*.03+r*2)*18+(i()-.5)*8;v===16?e.moveTo(v,w):e.lineTo(v,w)}e.stroke()}for(let r=0;r<14;r++){const d=10+i()*60;e.fillStyle=r%5===0?"rgba(236,170,100,0.85)":"rgba(140,210,220,0.6)",e.fillRect(24+r*18,482-d,10,d)}e.fillStyle="rgba(200,230,232,0.55)";for(let r=0;r<9;r++)e.fillRect(300,300+r*18,80+i()*110,5);const s=new Z(a);return s.colorSpace=N,s.wrapS=s.wrapT=ee,s.repeat.set(1/1.4,1/1.4),s}function Ae(){return new z({uniforms:{uTime:{value:0}},vertexShader:`varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main(){ vec4 w = modelMatrix*vec4(position,1.); vP = w.xyz; vN = normalize(mat3(modelMatrix)*normal);
      vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,fragmentShader:`precision highp float; uniform float uTime; varying vec3 vP; varying vec3 vN; varying vec3 vV;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      void main(){
        float a = atan(vP.z, vP.x);
        float y = vP.y;
        float flow = n(vec2(a*3.0, y*1.6 - uTime*0.9))*0.6 + n(vec2(a*7.0, y*3.2 - uTime*1.7))*0.4;
        float band = smoothstep(0.35, 1.0, flow);
        float facing = pow(max(dot(normalize(vN), normalize(vV)), 0.0), 0.6);
        vec3 hot = vec3(1.0, 0.86, 0.66);
        vec3 deep = vec3(0.95, 0.42, 0.16);
        vec3 col = mix(deep, hot, band*0.8 + facing*0.35) * (1.25 + band*0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`})}const De=`precision highp float;
  uniform sampler2D uMilky; uniform float uMilkyGain;
  varying vec3 vDir;
  float hash(vec3 p){ p = fract(p*0.3183099 + vec3(0.71,0.113,0.419)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  vec3 stars(vec3 d){
    // three octaves of crisp point stars: a hashed cell, one star per lucky cell
    vec3 col = vec3(0.0);
    for (int o = 0; o < 3; o++) {
      float sc = o == 0 ? 160.0 : o == 1 ? 340.0 : 700.0;
      vec3 p = d * sc;
      vec3 c = floor(p);
      float r = hash(c);
      float th = o == 0 ? 0.993 : o == 1 ? 0.988 : 0.982;
      if (r > th) {
        vec3 sp = c + 0.5 + (vec3(hash(c+1.3), hash(c+2.7), hash(c+4.1)) - 0.5) * 0.6;
        float dist = length(p - sp);
        float b = smoothstep(0.55, 0.0, dist) * pow((r - th) / (1.0 - th), 1.6);
        float t = hash(c + 9.0);
        vec3 tint = mix(vec3(0.75,0.82,1.0), vec3(1.0,0.86,0.7), t);
        col += tint * b * (o == 0 ? 1.8 : o == 1 ? 0.8 : 0.4);
      }
    }
    return col;
  }
  void main(){
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y,-1.,1.)) / 3.14159265 + 0.5);
    vec3 milky = texture2D(uMilky, uv).rgb;
    milky = pow(milky, vec3(1.35)) * uMilkyGain;
    vec3 col = milky + stars(d);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;function Pe(o,a){const e=new z({uniforms:{uMilky:{value:o},uMilkyGain:{value:a}},vertexShader:"varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position = p.xyww; }",fragmentShader:De,side:I,depthWrite:!1,depthTest:!1}),t=new g(new f(oe,64,32),e);return t.renderOrder=-100,t.frustumCulled=!1,t.name="ares/sky",t.userData.qaIgnore=!0,t}function Ie(o,a){return new z({uniforms:{uAlb:{value:o},uSun:{value:a.clone()},uGain:{value:1}},vertexShader:`varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main(){ vUv = uv; vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz;
      gl_Position = projectionMatrix*viewMatrix*w; }`,fragmentShader:`precision highp float; uniform sampler2D uAlb; uniform vec3 uSun; uniform float uGain; varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        vec3 alb = texture2D(uAlb, vUv).rgb;
        alb = pow(alb, vec3(1.15)) * vec3(1.06, 0.95, 0.88);
        float ndl = dot(N, uSun);
        // soft terminator: Mars' thin atmosphere still scatters a little past it
        float lit = smoothstep(-0.08, 0.35, ndl);
        vec3 col = alb * (lit * 1.55 + 0.012);
        // limb haze: dusty, butterscotch on the day side, thin blue at the edge
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        vec3 haze = mix(vec3(0.86, 0.55, 0.34), vec3(0.62, 0.72, 0.86), pow(fres, 2.0));
        col = mix(col, haze * smoothstep(-0.2, 0.4, ndl) * 1.1, fres * 0.75);
        // uGain < 1 in the lighting environment: Mars warms the station's fill
        // without turning white suits peach (the visible sky keeps full colour)
        col = mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, mix(0.35, 1.0, uGain)) * uGain;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,depthWrite:!1})}function Ne(o){const a=new z({uniforms:{uSun:{value:o.clone()}},vertexShader:"varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }",fragmentShader:`precision highp float; uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(N, V)), 5.0);
        float day = smoothstep(-0.25, 0.3, dot(N, uSun));
        vec3 c = mix(vec3(0.95, 0.62, 0.42), vec3(0.55, 0.68, 0.95), rim);
        gl_FragColor = vec4(c * rim * day * 0.9, rim * day * 0.9);
      }`,transparent:!0,depthWrite:!1,blending:te,side:I});return new g(new f(ae*1.025,96,64),a)}function Te(){const o=document.createElement("canvas");o.width=o.height=256;const a=o.getContext("2d"),e=a.createRadialGradient(128,128,0,128,128,128);e.addColorStop(0,"rgba(255,252,244,1)"),e.addColorStop(.07,"rgba(255,248,236,1)"),e.addColorStop(.1,"rgba(255,236,210,0.35)"),e.addColorStop(.3,"rgba(255,220,180,0.06)"),e.addColorStop(1,"rgba(255,220,180,0)"),a.fillStyle=e,a.fillRect(0,0,256,256);const t=new Z(o);t.colorSpace=N;const i=new xe(new Me({map:t,depthWrite:!1,toneMapped:!1,transparent:!0,blending:te}));return i.scale.setScalar(70),i.position.copy(_).multiplyScalar(oe*.92),i.name="ares/sun",i.renderOrder=-90,i}function X(o,a){const e=new F;e.name="ares/sky-group",e.userData.qaIgnore=!0,e.add(Pe(o,.75));const t=new F,i=new g(new f(ae,128,96),Ie(a,_));i.rotation.set(.35,2.4,.12),t.add(i,Ne(_));const s=370,r=ye.degToRad(-23),d=new $(U.x,0,U.z).normalize();t.position.copy(d).multiplyScalar(Math.cos(r)*s).setY(Math.sin(r)*s);for(const v of t.children)v.renderOrder=-80;return e.add(t),e.add(Te()),e}async function Re(o){const a=new E;a.name="ARES RELAY",a.background=new O(0);const e=Math.min(o.capabilities.getMaxAnisotropy(),16),t=new ve,i=(l,n=!1)=>t.loadAsync(P(l)).then(m=>(n&&(m.colorSpace=N),m.anisotropy=e,m)),s=new ue;s.setMeshoptDecoder(de);const[r,d,v,w,S,ne,re]=await Promise.all([s.loadAsync(P("station.glb")),i("milkyway.webp",!0),i("mars.webp",!0),i("ao_floor.webp"),i("ao_station.webp"),i("ao_vault.webp"),i("ao_exterior.webp")]);v.anisotropy=e;const T={floor:w,station:S,vault:ne,exterior:re};for(const l of Object.values(T))l.channel=1,l.flipY=!1;const G={};try{const l=await fetch(P("gi.json")).then(n=>n.ok?n.json():{});await Promise.all(Object.entries(l).map(async([n,m])=>{const c=await i(`gi_${n}.webp`,!0);c.channel=1,c.flipY=!1,G[n]={tex:c,scale:m.scale}}))}catch{}const ie=Object.keys(G).length>0,j=X(d,v);a.add(j);const y={};for(const[l,n]of Object.entries(_e))y[l]=ze(n,t,e);const se=new k({color:329480,roughness:.25,metalness:.1,emissiveMap:Ce(),emissive:16777215,emissiveIntensity:1.25});y.screen=se;const le=new k({color:9415091,roughness:.04,metalness:0,transparent:!0,opacity:.1,depthWrite:!1,envMapIntensity:2.2,side:J});y.glass=le;const L=Ae();y.core=L;const B=new Map,ce=(l,n)=>{const m=`${n}/${l}`;let c=B.get(m);if(c)return c;const h=y[l]??y.hull;if(h instanceof k&&l!=="glass"&&T[n]){const u=h.clone();u.aoMap=T[n],u.aoMapIntensity=n==="floor"?1:.9;const M=G[n];M&&(u.lightMap=M.tex,u.lightMapIntensity=M.scale*be,u.envMapIntensity=(h.envMapIntensity??1)*.55),c=u}else c=h;return B.set(m,c),c},b=new F;b.name="ares/station",a.add(b);const R=r.scene;R.traverse(l=>{const n=l;if(!n.isMesh)return;let m="station";for(let u=n;u;u=u.parent)if(["floor","station","vault","exterior"].includes(u.name)){m=u.name;break}const c=n.material.name||"hull";n.material=ce(c,m),ke.has(c)&&n.material instanceof k&&pe(n.material);const h=c.startsWith("light")||c==="screen"||c==="core";n.castShadow=!h&&c!=="glass"&&m!=="floor",n.receiveShadow=c!=="glass"&&!h,c==="glass"&&(n.renderOrder=10),n.name=`ares/${m}/${c}`,n.matrixAutoUpdate=!1,n.updateMatrix()}),R.updateMatrixWorld(!0),b.add(R);const p=new H(16775151,3.3);p.position.copy(_).multiplyScalar(80),p.target.position.set(0,0,0),p.castShadow=!0,p.shadow.mapSize.set(4096,4096);const x=p.shadow.camera;x.left=-48,x.right=48,x.top=44,x.bottom=-44,x.near=20,x.far=160,p.shadow.bias=-2e-4,p.shadow.normalBias=.03,p.shadow.radius=1.5,a.add(p,p.target);const Y=new H(14265231,.12);Y.position.copy(U).multiplyScalar(60).setY(8),a.add(Y);const me=new he(11845836,6117975,ie?.5:.85);a.add(me);{const l=new E,n=X(d,v);n.traverse(u=>{const M=u.material;M?.uniforms?.uGain&&(M.uniforms.uGain.value=.45)}),l.add(n);const m=new g(new f(30,16,8,0,Math.PI*2,0,Math.PI*.32),new D({color:5858158,side:I}));l.add(m);const c=new g(new f(14,16,8),new D({color:new O(1,.97,.92).multiplyScalar(40)}));c.position.copy(_).multiplyScalar(300),l.add(c);const h=new Q(o);a.environment=h.fromScene(l,.02,1,600).texture,a.environmentIntensity=1,h.dispose()}const q=new D({color:16777215}),C=new fe(new f(.16,10,8),q,3);C.name="ares/beacons",C.userData.qaIgnore=!0,[[26,21.9,-38.6],[57.9,4.6,34],[-69,2.6,12]].forEach((l,n)=>C.setMatrixAt(n,new ge().makeTranslation(l[0],l[1],l[2]))),b.add(C);let W=0;return{scene:a,sun:p,root:b,update:(l,n)=>{W+=Math.min(l,.05),j.position.copy(n.position),L.uniforms.uTime.value=W;const m=Math.pow(Math.max(0,Math.cos(W*Math.PI/2.2)),30);q.color.setRGB(.25+m*3,.22+m*2.4,.2+m*2)}}}let A=null;function We(o){if(A)return A;const a=new E,e=new g(new f(10,32,16),new z({side:I,vertexShader:"varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }",fragmentShader:`varying vec3 vD; void main(){ vec3 d = normalize(vD);
        vec3 up = vec3(0.16, 0.18, 0.21), hor = vec3(0.30, 0.30, 0.31), down = vec3(0.24, 0.22, 0.2);
        vec3 c = d.y > 0.0 ? mix(hor, up, smoothstep(0.0, 0.8, d.y)) : mix(hor, down, smoothstep(0.0, 0.6, -d.y));
        gl_FragColor = vec4(c, 1.0); }`}));a.add(e);const t=(s,r,d,v,w)=>{const S=new g(new Se(s,r),new D({color:new O(v).multiplyScalar(w),side:J}));S.position.set(...d),S.lookAt(0,0,0),a.add(S)};t(8,.6,[0,7,-3],16773600,3.2),t(8,.6,[0,7,3],15134975,2.4),t(3,5,[8,1.5,0],16777215,1.4),t(3,5,[-8,1.5,2],16767426,.9),t(6,3,[0,2,9],16775151,2);const i=new Q(o);return A=i.fromScene(a,.035).texture,i.dispose(),A}export{_ as ARES_SUN_DIR,We as aresViewmodelEnv,Re as buildAresWorld};
//# sourceMappingURL=ares-world-DA9O2fny.js.map
