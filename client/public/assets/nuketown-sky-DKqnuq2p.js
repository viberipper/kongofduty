import{aV as St,K as qt,e as st,i as q,f as S,a0 as Mt,aN as Yt,an as Ct,aJ as jt,V as k,a as at,aY as Xt,l as Nt,n as ct,F as H,g as et,b as Y,w as Kt,a2 as Zt,I as Jt,ag as Tt,s as pt,af as Qt,Q as te,bb as ee,D as ae,H as ne,c as oe,x as Ft,$ as re,aW as At,aX as ie,J as se,b1 as ce,o as le,bc as Dt}from"./asset-base-CBk30c0P.js";import{s as fe}from"./software-sky-BxvhM3wW.js";const de=e=>Ct(`/assets/nuketown/${e}`),i=e=>parseInt(e.replace("#",""),16),P={grime:.32,grimeH:.9,grimeY:.2},O={grime:.25,grimeH:.5,grimeY:.15},nt={tint:i("#acd1ff"),gain:2.155},z={nt_siding_green:{set:"siding_lap",tint:i("#42c99c"),cavity:.9,env:.5,...P},nt_siding_white:{set:"siding_lap",tint:i("#fafaff"),gain:1.166,cavity:.9,env:.5,...P},nt_siding_yellow:{set:"siding_board",tint:i("#fff670"),gain:1.089,cavity:.85,env:.5,...P},nt_siding_olive:{set:"siding_board",tint:i("#6e7b50"),cavity:.85,env:.5,...P},nt_siding_plum:{set:"siding_board",tint:i("#cfa6bf"),cavity:.85,env:.5,...P},nt_siding_pink:{set:"siding_lap",tint:i("#e8b4b4"),cavity:.9,env:.5,...P},nt_siding_blue:{set:"siding_lap",tint:i("#a9c3d6"),cavity:.9,env:.5,...P},nt_trim_white:{set:"trim_paint",tile:.8,tint:i("#fbfbff"),gain:1.104,env:.6,grime:.15,grimeH:.6,grimeY:.2},nt_soffit_white:{set:"soffit_beadboard",tint:i("#fbfbff"),gain:1.104,cavity:.9,facing:[1,0,.3],env:.5},nt_gutter_white:{set:"trim_paint",tint:i("#fbfbff"),gain:1.104,rough:.45,flatRough:.4,env:.7},nt_trim_wood:{set:"pine_timber",...O},nt_post_wood:{set:"pine_timber",rot:!0,...O},nt_stone_field:{set:"stone_ledge",gain:1.2,cavity:.85,macro2:[3.1,.1],...O},nt_stone_dark:{set:"stone_ledge",tint:i("#a6c1ff"),gain:1.332,cavity:.9,macro2:[3.1,.1]},nt_screen_wood:{set:"fence_privacy"},nt_deck_wood:{set:"deck_pine",...O},nt_deck_wood_diag:{set:"deck_pine",rot:45,...O},nt_door_wood:{set:"door_paint",tint:i("#f2ead6")},nt_door_panel:{set:"door_paint",tint:i("#efe9da")},nt_garage_door:{set:"garage_door",tint:i("#f4f2ea"),cavity:.9,env:.6,...O},nt_garage_door_red:{set:"garage_door",tint:i("#fc4d46"),cavity:.9,env:.6,...O},nt_garage_door_teal:{set:"garage_door",tint:i("#4f9a94"),cavity:.9,env:.6,...O},nt_window_glass:{glass:!0,glassSet:"glass_dust",glassAmount:1,opacity:.08,color:i("#d8e4dc"),ior:1.5,env:2},nt_glass_broken:{glass:!0,glassSet:"glass_cracks",glassAmount:1,opacity:.2,color:10991798,doubleSided:!0},nt_glass_dark:{glass:!0,opacity:.32,color:5595498},nt_roof_shingle:{set:"roof_shingle_grey",tint:i("#d7e0ff"),gain:1.263,cavity:.5,macro2:[4.6,.08]},nt_roof_roll:{set:"roof_roll",tint:i("#d7e0ff"),gain:1.263,normal:.7,macro2:[3.3,.08]},nt_brick:{set:"brick_dark",cavity:.6},nt_lattice:{set:"lattice_diamond",tint:i("#f6f5ef"),alphaTest:.5,doubleSided:!0,cavity:.8},nt_lattice_cut:{set:"lattice_diamond",tint:i("#f6f5ef"),alphaTest:.5,doubleSided:!0,cavity:.8},nt_wall_cream:{set:"plaster_wall",tile:1,tint:i("#eee3c8"),flat:i("#e9dfc6")},nt_wall_mint:{set:"plaster_wall",tile:1,tint:i("#9cc9bf"),flat:i("#a5cbc2")},nt_wall_yellow:{set:"plaster_wall",tile:1,tint:i("#e9d58e"),flat:i("#e6d494")},nt_wall_garage:{set:"osb",normal:.8},nt_osb:{set:"osb",normal:.8},nt_cmu_white:{set:"cmu_white",cavity:.7,flat:i("#dcd8cd")},nt_stone_field_grey:{set:"stone_field_grey",cavity:.6},nt_wallpaper_floral:{set:"wallpaper_floral",flat:i("#cfc8a8"),macroStrength:.1},nt_wallpaper_vine:{set:"wallpaper_vine",flat:i("#d0caaa"),mipBias:.3},nt_wallpaper_oval:{set:"wallpaper_oval",flat:i("#b8963a"),mipBias:.25},nt_wallpaper_star:{set:"wallpaper_star",flat:i("#d8cc9a")},nt_wallpaper_geo_sage:{set:"wallpaper_geo_sage",flat:i("#a6ae86"),mipBias:.25},nt_wainscot_walnut:{set:"wainscot_walnut",...nt,normal:.6,mipBias:.4,flat:i("#584c46")},nt_wall_panel:{set:"wainscot_walnut",...nt,normal:.3,mipBias:.4,flat:i("#584c46")},nt_trim_walnut:{set:"trim_walnut",...nt},nt_stair_wood:{set:"oak_tread"},nt_ceiling:{set:"ceiling_plaster",tint:i("#f3efe6")},nt_plaster_grey:{set:"plaster_wall",tile:1,tint:i("#c2bba4"),flat:i("#bdb6a0")},nt_joist_pine:{set:"joist_pine"},nt_floor_wood:{set:"floor_oak"},nt_floor_oak:{set:"floor_oak"},nt_floor_checker:{set:"vinyl_checker_navy"},nt_vinyl_checker_navy:{set:"vinyl_checker_navy"},nt_floor_checker_caramel:{set:"floor_checker_caramel"},nt_carpet:{set:"carpet",tint:i("#f2da6e")},nt_carpet_ochre:{set:"carpet",tint:i("#f2da6e")},nt_carpet_grey:{set:"carpet",tint:i("#a7a08a")},nt_carpet_greige:{set:"carpet",tint:i("#a7a08a")},nt_carpet_blue:{set:"carpet",tint:i("#7c8496")},nt_carpet_greygreen:{set:"carpet_lowpile",tint:i("#a6aa94")},nt_stair_carpet:{set:"carpet",tint:i("#7a3a48"),faceTint:[.8,.74,1]},nt_runner_burgundy:{set:"carpet",tint:i("#7a3a48"),faceTint:[.8,.74,1]},nt_runner_maroon:{set:"carpet",tint:i("#722b41")},nt_fabric_navy:{set:"fabric_weave",tint:i("#2b49ad"),doubleSided:!0},nt_fabric_gold:{set:"fabric_weave",tint:i("#e0b13c"),doubleSided:!0},nt_brass:{set:"brass"},nt_shade_glass:{color:i("#f4ead8"),emissive:16767392,emissiveIntensity:1.6,rough:.35},nt_concrete_garage:{set:"driveway_concrete"},nt_lamp_warm:{color:1118481,emissive:16767392,emissiveIntensity:3.2,rough:.4},nt_furn_wood:{set:"wood_cabinet"},nt_furn_fabric_red:{set:"vinyl_seat",tint:i("#a03029")},nt_furn_fabric_green:{set:"vinyl_seat",tint:i("#4fa5a1")},nt_furn_counter:{set:"wood_cabinet"},nt_furn_countertop:{set:"counter_laminate"},nt_furn_appliance:{set:"car_paint",tint:i("#f1efe8"),rough:.35},nt_furn_stove:{set:"car_paint",tint:i("#efede6"),rough:.4},nt_furn_tv:{set:"wood_cabinet",color:8413256},nt_furn_bed:{set:"wood_cabinet"},nt_furn_bedding:{set:"vinyl_seat",tint:i("#eadfc6"),rough:.9},nt_grass:{set:"grass_lawn",tint:i("#eff6ff"),gain:1.8,macro2:[30,.06],hue:[i("#d6cc86"),.14]},nt_grass_card:{set:"grass_cards",alphaTest:.5,doubleSided:!0},nt_sand:{set:"desert_ground"},nt_mulch:{set:"soil_bed"},nt_soil_bed:{set:"soil_bed"},nt_dirt_packed:{set:"dirt_packed",tint:i("#e5eaff"),gain:1.609},nt_paver:{set:"paver_concrete",...O},nt_asphalt:{set:"asphalt_street",tint:i("#dee7ff"),gain:1.141},nt_asphalt_old:{set:"asphalt_street",tint:i("#dee7ff"),gain:1.141},nt_sidewalk:{set:"sidewalk_concrete",tint:i("#e5e8f7")},nt_curb:{set:"curb_concrete"},nt_gutter_pan:{set:"gutter_concrete"},nt_concrete:{set:"driveway_concrete",tint:i("#efefff"),gain:.975},nt_decal_tar_decal:{set:"decal_tar",under:"nt_asphalt",flatRough:.55,dfade:{solid:!0}},nt_decal_patch_decal:{set:"decal_patch",under:"nt_asphalt",dfade:{seam:.45}},nt_decal_oil_decal:{set:"decal_oil_tile",under:"nt_asphalt"},nt_decal_manhole_decal:{set:"manhole_iron",metal:.6},nt_hedge:{set:"hedge_leaves",normal:1.4,macro:!1,env:0,flatRough:.88},nt_hedge_card:{set:"hedge_cards",alphaTest:.45,doubleSided:!0},nt_bark:{set:"bark"},nt_scrub_card:{set:"scrub_sage",alphaTest:.5,doubleSided:!0},nt_shrub_card:{set:"shrub_cards",alphaTest:.5,doubleSided:!0},nt_sapling_leaf:{set:"sapling_leaves",alphaTest:.5,doubleSided:!0},nt_fence_wood:{set:"fence_privacy",gain:1.22,normal:.8,mipBias:.3,weather:[.6,.22,.95],grime:.4,grimeH:.1,grimeY:.15},nt_fence_board:{set:"fence_board",normal:.8,mipBias:.3,vcol:!0,seam:[.55,.028],weather:[.6,.22,.95],grime:.4,grimeH:.1,grimeY:.15},nt_picket_white:{set:"picket_paint",tint:i("#f4f2ea"),grime:.45,grimeH:.14,grimeY:.15},nt_metal_fence:{set:"metal_galvanized",flatRough:.74},nt_wood_painted:{set:"timber"},nt_paint_white:{set:"trim_paint",tint:i("#f1efe9")},nt_paint_mint:{set:"siding_lap",tint:i("#42c99c"),cavity:.9},nt_metal:{set:"metal_galvanized"},nt_metal_rust:{set:"rust_metal"},nt_paint_red:{set:"car_paint",tint:i("#a8322c")},nt_paint_yellow_bus:{set:"car_paint",tint:i("#e2b33a")},nt_paint_dark:{set:"trim_paint",tint:i("#4a4a4c"),rough:.6},nt_paint_grey:{set:"trim_paint",tint:i("#b8bab8"),rough:.6},nt_paint_olive:{set:"car_paint",tint:i("#5f6343")},nt_blinds:{set:"trim_paint",tint:i("#e8dcc0")},nt_swing_red:{set:"car_paint",tint:i("#b03a30"),rough:.6},nt_car_bus:{set:"car_paint",tint:i("#e2b33a")},nt_car_red:{set:"car_paint",tint:i("#a8322c")},nt_car_olive:{set:"car_paint",tint:i("#5f6343")},nt_car_black:{set:"car_paint",tint:i("#2a2a2c")},nt_car_grey:{set:"car_paint",tint:i("#b8bcbf")},nt_car_cream:{set:"car_paint",tint:i("#efe6cf")},nt_car_sedan:{set:"car_paint",tint:i("#a9c7a6")},nt_chrome:{set:"chrome",flatRough:.42},nt_default:{set:"concrete_cast"}},ue={};for(const[e,t]of Object.entries(ue))!z[e]&&z[t]&&(z[e]=z[t]);async function Ke(e,t,n,a){for(const u of Object.values(z)){u.glassSet&&e.add(u.glassSet);const _=u.under?z[u.under]?.set:void 0;_&&e.add(_)}const o=new St,s=Math.min(n.capabilities.getMaxAnisotropy(),16),r=new Map,c=[];for(const u of e){const _=t[u];if(!_)continue;const f={info:_};r.set(u,f);const l=m=>{const d=_.files[a&&m!=="macro"?`${m}-low`:m]??_.files[m];d&&c.push(o.loadAsync(de(`tex/${d}`)).then(h=>{h.wrapS=h.wrapT=qt,h.anisotropy=s,m==="c"&&(h.colorSpace=st),f[m]=h}).catch(()=>{}))};l("c"),l("n"),l("orm"),_.macro_tile_m&&!a&&l("macro")}return await Promise.all(c),r}function me(e,t){const n=t.mipBias>0?`, ${t.mipBias.toFixed(2)}`:"",a=[];t.macro&&a.push("NT_MACRO"),t.macro&&t.macro2&&a.push("NT_MACRO2"),t.macro&&t.macro2&&t.hue&&a.push("NT_HUE"),t.cavity>0&&t.orm&&a.push("NT_CAVITY"),t.grime>0&&a.push("NT_GRIME"),t.facing&&a.push("NT_FACING"),t.flat!==void 0&&a.push("NT_FLAT"),t.cutout&&a.push("NT_CUTOUT"),t.vcol&&a.push("NT_VCOL"),t.under?.c&&a.push("NT_UNDER"),t.under?.n&&a.push("NT_UNDER_N"),t.under?.orm&&a.push("NT_UNDER_ORM"),t.under?.c&&t.dfade&&a.push("NT_DFADE"),t.weather&&a.push("NT_WEATHER"),t.seam&&a.push("NT_SEAM"),t.faceTint&&a.push("NT_FTINT");const o=t.grime>0||!!t.facing||t.flat!==void 0||!!t.weather||!!t.faceTint;o&&a.push("NT_WORLD");const s={uTint:{value:t.tint},uMacro:{value:t.macro??null},uMacroScale:{value:t.macroScale},uMacroStrength:{value:t.macro?t.macroStrength:0},uMacro2:{value:new at(t.macro2?t.tile/t.macro2[0]:1,t.macro2?t.macro2[1]:0)},uHue:{value:new Xt(...t.hue?new S(t.hue[0]).toArray():[1,1,1],t.hue?t.hue[1]:0)},uCavity:{value:t.cavity},uOrm:{value:t.orm??null},uGrime:{value:new k(t.grime,t.grimeY,t.grimeH)},uFacing:{value:new k(...t.facing??[1,1,1])},uFlat:{value:new S(t.flat??16777215)},uUnderMap:{value:t.under?.c??null},uUnderN:{value:t.under?.n??null},uUnderOrm:{value:t.under?.orm??null},uUnderScale:{value:t.under?.scale??1},uUnderTint:{value:t.under?.tint??new S(1,1,1)},uDFade:{value:new at(t.dfade?.solid?1:0,t.dfade?.seam??0)},uWeather:{value:new k(...t.weather??[0,1,1])},uSeam:{value:new at(...t.seam??[0,0])},uFTint:{value:new k(...t.faceTint??[1,1,1])}};e.userData.ntUniforms=s;const r=a.map(c=>`#define ${c}`).join(`
`);e.onBeforeCompile=c=>{Object.assign(c.uniforms,s),o&&(c.vertexShader=c.vertexShader.replace("#include <common>",`#include <common>
varying vec3 vNtWorld;
varying vec3 vNtWN;`).replace("#include <project_vertex>",`#include <project_vertex>
          vNtWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vNtWN = normalize( mat3( modelMatrix ) * objectNormal );`)),c.fragmentShader=c.fragmentShader.replace("#include <common>",`${r}
#include <common>
#ifdef NT_WORLD
varying vec3 vNtWorld;
varying vec3 vNtWN;
#endif`).replace("#include <map_pars_fragment>",`#include <map_pars_fragment>
        uniform vec3 uTint; uniform sampler2D uMacro; uniform float uMacroScale; uniform float uMacroStrength;
        uniform vec2 uMacro2; uniform vec4 uHue; uniform float uCavity; uniform sampler2D uOrm;
        uniform vec3 uGrime; uniform vec3 uFacing; uniform vec3 uFlat;
        uniform sampler2D uUnderMap; uniform sampler2D uUnderN; uniform sampler2D uUnderOrm; uniform float uUnderScale; uniform vec3 uUnderTint;
        uniform vec2 uDFade; uniform vec3 uWeather; uniform vec2 uSeam; uniform vec3 uFTint;
        float ntUA = 1.0;`).replace("#include <map_fragment>",`float ntFace = 1.0;
        #ifdef NT_FACING
          // [down, side, up] by the geometry's world facing
          float ntWy = vNtWN.y;
          ntFace = mix( uFacing.y, uFacing.x, smoothstep( -0.45, -0.75, ntWy ) );
          ntFace = mix( ntFace, uFacing.z, smoothstep( 0.45, 0.75, ntWy ) );
        #endif
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv${n} );
          #if defined( NT_UNDER )
            // decal over its underlay: opaque, alpha only mixes the two looks
            ntUA = sampledDiffuseColor.a;
            #ifdef NT_DFADE
              // COLOR_0 = (coverage, 0, 1): GROUND's feathered polylines / patch rings
              float ntCov = -1.0;
              if ( vColor.b > 0.5 && vColor.g < 0.5 ) {
                ntCov = clamp( vColor.r, 0.0, 1.0 );
                ntUA = smoothstep( 0.0, 1.0, ntCov ) * ( uDFade.x > 0.5 ? 1.0 : ntUA );
              }
            #endif
            vec3 paint = mix( texture2D( uUnderMap, vMapUv * uUnderScale ).rgb * uUnderTint, sampledDiffuseColor.rgb * uTint, ntUA );
            #ifdef NT_DFADE
              // tar-seam outline in the middle of the feather
              if ( ntCov >= 0.0 ) paint *= 1.0 - uDFade.y * smoothstep( 0.22, 0.42, ntCov ) * ( 1.0 - smoothstep( 0.55, 0.78, ntCov ) );
            #endif
          #elif defined( NT_CUTOUT )
            vec3 paint = sampledDiffuseColor.rgb * uTint;
            diffuseColor.a *= sampledDiffuseColor.a;
          #else
            vec3 paint = mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * uTint, sampledDiffuseColor.a );
          #endif
          #ifdef NT_FLAT
            // near-horizontal faces: the plain ground colour, no motif (reveals, sills, headers)
            float ntHz = smoothstep( 0.6, 0.85, abs( vNtWN.y ) );
            paint = mix( paint, uFlat * ( 0.94 + 0.06 * dot( sampledDiffuseColor.rgb, vec3( 0.333 ) ) ), ntHz );
          #endif
          float ntM1 = 0.5;
          #ifdef NT_MACRO
            ntM1 = texture2D( uMacro, vMapUv * uMacroScale ).r;
            paint *= 1.0 + ( ntM1 - 0.5 ) * 2.0 * uMacroStrength;
            #ifdef NT_MACRO2
              float ntM2 = texture2D( uMacro, vMapUv * uMacro2.x + vec2( 0.37, 0.61 ) ).r;
              paint *= 1.0 + ( ntM2 - 0.5 ) * 2.0 * uMacro2.y;
              #ifdef NT_HUE
                paint = mix( paint, paint * uHue.rgb, smoothstep( 0.42, 0.78, ntM2 ) * uHue.a );
              #endif
            #endif
          #endif
          #ifdef NT_CAVITY
            float ntCav = texture2D( uOrm, vMapUv ).r;
            paint *= mix( 1.0, ntCav, uCavity * ntFace );
          #endif
          #ifdef NT_GRIME
            // world-space splash-back grime: a gradient up from the ground, macro-modulated
            float ntG = 1.0 - clamp( ( vNtWorld.y - uGrime.y ) / uGrime.z, 0.0, 1.0 );
            ntG = ntG * ntG * uGrime.x * ( 0.55 + 0.9 * ntM1 );
            paint = mix( paint, paint * vec3( 0.74, 0.70, 0.62 ), clamp( ntG, 0.0, 1.0 ) );
          #endif
          #ifdef NT_WEATHER
            // raw wood silvers grey toward the ground (r2 M8): desaturate + shift to the weathered grey
            float ntWe = 1.0 - clamp( ( vNtWorld.y - uGrime.y ) / uWeather.y, 0.0, 1.0 );
            ntWe = clamp( ntWe * uWeather.x * ( 0.6 + 0.8 * ntM1 ), 0.0, 1.0 );
            float ntLu = dot( paint, vec3( 0.2126, 0.7152, 0.0722 ) );
            paint = mix( paint, vec3( ntLu ) * vec3( 1.02, 1.02, 1.0 ) * uWeather.z, ntWe );
          #endif
          #ifdef NT_FTINT
            float ntFt = mix( uFTint.y, uFTint.x, smoothstep( -0.45, -0.75, vNtWN.y ) );
            paint *= mix( ntFt, uFTint.z, smoothstep( 0.45, 0.75, vNtWN.y ) );
          #endif
          #ifdef NT_VCOL
            // per-board tint: COLOR_0.r 0.25..0.75 -> x0.92..x1.08; a missing attribute reads 0 or 1
            float ntV = vColor.r;
            paint *= ( ntV < 0.02 || ntV > 0.98 ) ? 1.0 : 1.0 + ( ntV - 0.5 ) * 0.32;
          #endif
          #if defined( NT_SEAM ) && defined( USE_COLOR )
            // zero-gap board seam: COLOR_0 = (tint, across 0..1, 1); groove AA'd by its derivative
            if ( vColor.b > 0.9 ) {
              float ntAc = clamp( vColor.g, 0.0, 1.0 ), ntE = min( ntAc, 1.0 - ntAc );
              float ntFw = max( fwidth( ntAc ), 1e-4 );
              float ntSg = ( 1.0 - smoothstep( uSeam.y - ntFw, uSeam.y + ntFw, ntE ) ) * clamp( 2.0 * uSeam.y / ntFw, 0.0, 1.0 );
              paint *= 1.0 - uSeam.x * ntSg;
            }
          #endif
          diffuseColor.rgb *= paint;
        #endif`).replace("#include <roughnessmap_fragment>",`#include <roughnessmap_fragment>
        #ifdef NT_UNDER_ORM
          roughnessFactor = mix( texture2D( uUnderOrm, vMapUv * uUnderScale ).g, roughnessFactor, ntUA );
        #endif`).replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
        #if defined( NT_UNDER_N ) && defined( USE_NORMALMAP_TANGENTSPACE )
          {
            vec3 ntUN = texture2D( uUnderN, vMapUv * uUnderScale ).xyz * 2.0 - 1.0;
            vec3 ntDN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            ntDN.xy *= normalScale;
            normal = normalize( tbn * normalize( mix( ntUN, ntDN, ntUA ) ) );
          }
        #endif
        #if defined( NT_FACING ) && defined( USE_NORMALMAP_TANGENTSPACE )
          // facing weight on the detail normal (soffit beads only on soffits)
          if ( ntFace < 0.999 ) {
            vec3 ntMapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            ntMapN.xy *= normalScale * ntFace;
            normal = normalize( tbn * ntMapN );
          }
        #endif`),(t.vcol||t.seam||t.under?.c&&t.dfade)&&(c.fragmentShader=c.fragmentShader.replace("#include <color_fragment>",""))},e.customProgramCacheKey=()=>`nt-surface2|${a.join(",")}|${n}`}function _e(e,t,n){const a=new jt({name:e,color:t.color??10466232,roughness:.04,metalness:0,ior:t.ior??1.5,transparent:!0,opacity:t.opacity??.18,depthWrite:!1,envMapIntensity:t.env??1.4,premultipliedAlpha:!0});t.doubleSided&&(a.side=Mt);const o=t.glassSet?n.get(t.glassSet):void 0;if(o?.c){const r=o.c.clone(),c=1/(o.info.tile_m||1);r.repeat.set(c,-c),r.needsUpdate=!0,a.map=r}const s=t.glassAmount??.5;return a.onBeforeCompile=r=>{r.uniforms.uGlassAmt={value:s},r.fragmentShader=r.fragmentShader.replace("#include <map_pars_fragment>",`#include <map_pars_fragment>
uniform float uGlassAmt;`).replace("#include <map_fragment>",`float ntGA = 0.0;
        #ifdef USE_MAP
          vec4 ntGl = texture2D( map, vMapUv );
          ntGA = clamp( ntGl.a * uGlassAmt, 0.0, 1.0 );
          // dust on glass reads as a pale film in daylight (the overlay rgb is the dirt itself)
          diffuseColor.rgb = mix( diffuseColor.rgb, min( ntGl.rgb * 1.55, vec3( 1.0 ) ), ntGA );
          diffuseColor.a = mix( diffuseColor.a, 0.9, ntGA * 0.75 );
        #endif`).replace("#include <roughnessmap_fragment>",`#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.55, ntGA );`).replace("#include <opaque_fragment>",`vec3 ntGD = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
        vec3 ntGS = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
        float ntGR = clamp( max( max( ntGS.r, ntGS.g ), ntGS.b ), 0.0, 1.0 );
        float ntA = diffuseColor.a;
        gl_FragColor = vec4( ntGD * ntA + ntGS, clamp( ntA + ntGR * ( 1.0 - ntA ), 0.0, 1.0 ) );`).replace("#include <fog_fragment>",`vec4 ntPre = gl_FragColor;
#include <fog_fragment>
gl_FragColor.rgb = ntPre.rgb + ( gl_FragColor.rgb - ntPre.rgb ) * ntPre.a;`).replace("#include <premultiplied_alpha_fragment>","")},a.customProgramCacheKey=()=>`nt-glass2|${a.map?1:0}|${a.side}`,a}function pe(e,t,n){if(t.glass)return _e(e,t,n);const a=t.set?n.get(t.set):void 0,o=new q({name:e,color:t.color??16777215,roughness:t.rough??1,metalness:t.metal??(a?.orm?1:0)});if(a){const s=t.tile??a.info.tile_m??1,r=1/s,c=_=>{if(!_)return;const f=_.clone();return f.repeat.set(r,-r),t.rot&&(f.rotation=(t.rot===!0?90:t.rot)*Math.PI/180),f.needsUpdate=!0,f};a.c&&(o.map=c(a.c)),a.n&&(o.normalMap=c(a.n),o.normalScale.setScalar(t.normal??1));let u;if(a.orm?(u=c(a.orm),o.roughnessMap=u,o.metalnessMap=u,o.aoMap=u,o.aoMapIntensity=.85):o.metalness=t.metal??0,o.map){const _=t.under?z[t.under]:void 0,f=_?.set?n.get(_.set):void 0,l=f??a,m=l.info.macro_tile_m?s/l.info.macro_tile_m:1,d=f?.info.tile_m??1;me(o,{tint:new S(t.tint??16777215).multiplyScalar(t.gain??1),macro:t.macro===!1?void 0:l.macro,macroScale:m,macroStrength:t.macroStrength??l.info.macro_strength??.15,under:f?{c:f.c,n:f.n,orm:f.orm,scale:s/d,tint:new S(_.tint??16777215).multiplyScalar(_.gain??1)}:void 0,macro2:t.macro2,hue:t.hue,mipBias:t.mipBias??0,cavity:t.cavity??0,orm:u,grime:t.grime??0,grimeH:t.grimeH??.8,grimeY:t.grimeY??.2,facing:t.facing,flat:t.flat,cutout:t.alphaTest!==void 0,vcol:!!t.vcol,dfade:t.dfade,weather:t.weather,seam:t.seam,faceTint:t.faceTint,tile:s}),(t.vcol||t.seam||t.dfade&&f?.c)&&(o.vertexColors=!0)}}else t.tint!==void 0&&o.color.setHex(t.tint);return t.alphaTest!==void 0&&(o.alphaTest=t.alphaTest,o.alphaToCoverage=!0),t.doubleSided&&(o.side=Mt),t.emissive!==void 0&&(o.emissive.setHex(t.emissive),o.emissiveIntensity=t.emissiveIntensity??1),t.flatRough!==void 0&&(o.roughnessMap=null,o.roughness=t.flatRough),o.envMapIntensity=t.env??1,Yt(o),e.endsWith("_decal")&&(o.polygonOffset=!0,o.polygonOffsetFactor=-2,o.polygonOffsetUnits=-2),o}const Ze=["desert_ground","asphalt_street"];function L(e,t){const n=Math.sin(e*127.1+t*311.7)*43758.5453;return n-Math.floor(n)}function lt(e,t){const n=Math.floor(e),a=Math.floor(t),o=e-n,s=t-a,r=o*o*(3-2*o),c=s*s*(3-2*s),u=L(n,a),_=L(n+1,a),f=L(n,a+1),l=L(n+1,a+1);return u+(_-u)*r+(f-u)*c+(u-_-f+l)*r*c}function R(e,t,n=4){let a=0,o=.5,s=1;for(let r=0;r<n;r++)a+=o*lt(e*s,t*s),s*=2.03,o*=.5;return a}function gt(e,t,n=5){let a=0,o=.55,s=1,r=1,c=0;for(let u=0;u<n;u++){let _=1-Math.abs(2*lt(e*s+u*17.3,t*s-u*9.1)-1);_*=_*r,r=Math.min(1,_*1.6),a+=o*_,c+=o,s*=2.07,o*=.5}return a/c}const E=Y.smoothstep,w=(e,t)=>L(e*1.618+t*7.31,t*3.77-e*.41),J=46,Q=21,tt=-4.5,ge={x0:-51,x1:49,z0:-28,z1:19},B={x0:-37.5,x1:37.5,z0:2,z1:85.5},I=81,Et=[{x:-95,z:-140,r:24,y:.34},{x:-75,z:38,r:16,y:.05}],ht=(e,t,n,a=0)=>t>e.x0-a&&t<e.x1+a&&n>e.z0-a&&n<e.z1+a;function Ut(e,t){const n=s=>(e/(J+s))**2+((t-tt)/(Q+.85*s))**2;if(n(0)<=1)return 0;let a=0,o=2e3;for(let s=0;s<40;s++){const r=(a+o)/2;n(r)>1?a=r:o=r}return a}const Gt=e=>2.5*Math.sin((e-I)*.021)+1.2*Math.sin((e-I)*.057+1.3);function Ot(e,t){let n=he(e,t);for(const a of ve){const o=Math.hypot(e-a.x,t-a.z);o<a.r*1.6&&(n=Y.lerp(a.y,n,E(o,a.r,a.r*1.6)))}return n}function he(e,t){const n=Ut(e,t);let a=E(n,18,90)*(.35+.65*E(n,60,240));const o=Math.max(B.x0-e,0,e-B.x1),s=Math.max(B.z0-t,0,t-B.z1);a*=E(Math.hypot(o,s),0,25);let r=-.1+a*(6*R(e*.009+3,t*.009+7)-2.6+1.6*R(e*.03-2,t*.03+5,3));if(t>I-10){const c=1-E(Math.abs(e-Gt(t)),3,14);r=Y.lerp(r,-.1+a*(1.2*R(t*.01,3.1)-.5),c*.85)}return r}const ve=Et,we=(e,t,n=0)=>Et.some(a=>Math.hypot(e-a.x,t-a.z)<a.r+n);function ye(e,t=!1){const n=new Nt;n.name="nuketown/backdrop",n.userData.qaIgnore=!0;{const s=pe("nt_sand",z.nt_sand??z.nt_default,e);s.name="nuketown/desert-floor",s.map||s.color.set("#b29b7b"),be(s);const r=[.02,.35,.65,.88],c=[0,.15,.4,.8,1.5,3,5,8,12,17,23,30,40,52,66,82,100,125,155,190,230,275,320,370],u=t?120:220,_=[],f=[],l=[];for(let v=0;v<r.length+c.length;v++)for(let g=0;g<=u;g++){const F=g/u*Math.PI*2,M=v<r.length?r[v]:1,A=v<r.length?0:c[v-r.length],N=Math.cos(F)*(J*M+A),b=tt+Math.sin(F)*(Q*M+A*.85);_.push(N,Ot(N,b),b),f.push(N,1+b)}const m=u+1;for(let v=0;v<r.length+c.length-1;v++)for(let g=0;g<u;g++){const F=v*m+g,M=F+1,A=F+m,N=A+1;l.push(F,M,A,M,N,A)}const d=new ct;d.setAttribute("position",new H(_,3)),d.setAttribute("uv",new H(f,2)),d.setIndex(l),d.computeVertexNormals();const h=new et(d,s);h.receiveShadow=!0,h.name="nuketown/desert-floor",n.add(h)}n.add(Se(t));const a=wt({r0:190,r1:285,na:t?360:900,nr:t?14:30,hMin:6,hMax:26,seed:1,fog:1.35,crest:.55});a.name="nuketown/ridge-mid",n.add(a);const o=wt({r0:300,r1:385,na:t?360:1100,nr:t?12:26,hMin:20,hMax:62,seed:2,fog:1.8,crest:.45});return o.name="nuketown/range-far",n.add(o),n.follow=s=>{o.position.set(s.x,0,s.z)},n}function be(e){const t=e.onBeforeCompile;e.onBeforeCompile=(a,o)=>{t.call(e,a,o),a.vertexShader=a.vertexShader.replace("#include <common>",`#include <common>
varying vec3 vNtW;`).replace("#include <fog_vertex>",`#include <fog_vertex>
vNtW = (modelMatrix * vec4(transformed, 1.0)).xyz;`),a.fragmentShader=a.fragmentShader.replace("#include <common>",`#include <common>
        varying vec3 vNtW;
        float ntH(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float ntN(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(ntH(i), ntH(i + vec2(1, 0)), u.x), mix(ntH(i + vec2(0, 1)), ntH(i + vec2(1, 1)), u.x), u.y); }
        float ntF(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * ntN(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }`).replace("#include <map_fragment>",`#include <map_fragment>
        {
          vec2 w = vNtW.xz;
          // distance beyond the map plate (ellipse ${J}x${Q}, centre z ${tt}), 0 inside
          float q = length(vec2(w.x / ${J.toFixed(1)}, (w.y - (${tt.toFixed(1)})) / ${Q.toFixed(1)}));
          float far = smoothstep(1.0, 2.3, q);
          // big crust / darker gravel patches, then pebble breakup at mid range
          float p1 = ntF(w * 0.011 + 3.0);
          float p2 = ntF(w * 0.05 + 11.0);
          // wind streaks: stretched along the south-westerly (x -0.6, z 0.8)
          vec2 wd = vec2(-0.6, 0.8), wp = vec2(-wd.y, wd.x);
          float st = ntF(vec2(dot(w, wd) * 0.012, dot(w, wp) * 0.16) + 5.0);
          // every layer averages ~1, so the far field keeps the plate's mean value (no pale ring)
          vec3 lay = mix(vec3(0.9, 0.86, 0.82), vec3(1.07, 1.05, 1.03), smoothstep(0.3, 0.7, p1));
          lay *= 0.93 + 0.14 * p2;
          lay *= 1.04 - 0.14 * smoothstep(0.45, 0.75, st);
          diffuseColor.rgb *= mix(vec3(1.0), lay, far);
          // packed-dirt track past the gate: darker, redder, two wheel ruts
          float tx = 2.5 * sin((w.y - ${I.toFixed(1)}) * 0.021) + 1.2 * sin((w.y - ${I.toFixed(1)}) * 0.057 + 1.3);
          float dx = abs(w.x - tx) + (ntN(w * 0.4) - 0.5) * 0.9;
          float track = (1.0 - smoothstep(2.6, 4.2, dx)) * smoothstep(${(I-1).toFixed(1)}, ${(I+3).toFixed(1)}, w.y);
          float ruts = smoothstep(0.6, 0.15, abs(dx - 1.05));
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.71, 0.62) * (1.0 - 0.16 * ruts), track);
        }`)};const n=e.customProgramCacheKey.bind(e);e.customProgramCacheKey=()=>`${n()}|ntFarField1`,e.needsUpdate=!0}function xe(e,t){const n=e.onBeforeCompile;e.onBeforeCompile=(o,s)=>{n.call(e,o,s),o.fragmentShader=`#define NT_FOG_SCALE ${t.toFixed(2)}
${o.fragmentShader}`};const a=e.customProgramCacheKey.bind(e);e.customProgramCacheKey=()=>`${a()}|ntFog${t.toFixed(2)}`}const vt=Math.atan2(-140,-95);function wt(e){const{r0:t,r1:n,na:a,nr:o,hMin:s,hMax:r,seed:c}=e,u=[],_=[],f=[],l=new S("#86664f"),m=new S("#3f2f27"),d=new S("#977a60"),h=new S("#a08a6c"),v=new S,g=c*37.7;for(let b=0;b<=o;b++){const y=b/o,C=t+(n-t)*y;for(let x=0;x<=a;x++){const p=x/a*Math.PI*2,T=Math.cos(p)*C,D=Math.sin(p)*C,W=.5+.5*(Math.cos(p)*.6-Math.sin(p)*.8);let G=s+(r-s)*(.35+.65*E(R(Math.cos(p)*2.2+g,Math.sin(p)*2.2-g,3)*.7+W*.45,.25,.85));const Ht=Math.atan2(Math.sin(p-vt),Math.cos(p-vt));G*=1-.6*Math.exp(-((Ht/.2)**2));const j=.009,Wt=R(Math.cos(p)*n*j*.5+g,Math.sin(p)*n*j*.5-g,3),$t=gt(Math.cos(p)*n*j+g,Math.sin(p)*n*j-g,5),ft=E(y,0,e.crest)*(1-.55*E(y,e.crest+.15,1)),dt=Math.cos(p)*C*.06,ut=Math.sin(p)*C*.06,X=1-Math.abs(2*R(dt+g+y*1.7,ut-g-y*2.3,3)-1),mt=gt(dt*.55-g,ut*.55+g+y*1.3,3);let $=G*(.2+.55*Wt+.6*$t)*ft;$+=G*.11*(mt-.5)*ft,$-=$*.16*X*X*E(y,.08,.5);const _t=-2.5+$;u.push(T,_t,D);const Bt=.5+.5*Math.sin(_t*.55+R(T*.02+g,D*.02,2)*4),Vt=1-E($,.5,G*.22);v.copy(l).lerp(d,Bt*.4).lerp(m,(X*X*.7+(1-mt)*.35)*E(y,.06,.45)).lerp(h,Vt*.75),v.multiplyScalar(.92+.16*L(x*.37+g,b*1.3)),_.push(v.r,v.g,v.b)}}const F=a+1;for(let b=0;b<o;b++)for(let y=0;y<a;y++){const C=b*F+y,x=C+1,p=C+F,T=p+1;f.push(C,x,p,x,T,p)}const M=new ct;M.setAttribute("position",new H(u,3)),M.setAttribute("color",new H(_,3)),M.setIndex(f),M.computeVertexNormals();const A=new q({vertexColors:!0,roughness:1,metalness:0});xe(A,e.fog);const N=new et(M,A);return N.frustumCulled=!1,N}function K(e,t){const n=[],a=new S("#5c4e3f"),o=new S("#868572"),s=(l,m,d)=>{const h=l.attributes.position,v=[];for(let g=0;g<h.count;g++){const F=1-d+d*E(h.getY(g),.1,1);v.push(m.r*F,m.g*F,m.b*F)}return l.setAttribute("color",new H(v,3)),l};for(let l=0;l<5;l++){const m=e*2.1+l*1.257,d=new Jt(.02,.045,.42,3,1,!0);d.translate(0,.21,0),d.rotateZ(Math.cos(m)*.55),d.rotateX(Math.sin(m)*.55),n.push(s(d.toNonIndexed(),a,.25))}for(let l=0;l<t;l++){const m=.2+.14*w(l,e),d=new Tt(m,0),h=d.attributes.position;for(let M=0;M<h.count;M++){const A=.7+.6*w(M+l*31,e*3.1);h.setXYZ(M,h.getX(M)*A,h.getY(M)*A*.8,h.getZ(M)*A)}const v=l/t*Math.PI*2+w(l,e+1)*.9,g=l===0?.05:.2+.24*w(l,e+2);d.translate(Math.cos(v)*g,.3+.32*w(l,e+3)+(l===0?.14:0)-g*.25,Math.sin(v)*g);const F=o.clone().multiplyScalar(.84+.28*w(l,e+4));n.push(s(d.toNonIndexed(),F,.45))}const r=n.reduce((l,m)=>l+m.attributes.position.count,0),c=new Float32Array(r*3),u=new Float32Array(r*3);let _=0;for(const l of n)c.set(l.attributes.position.array,_*3),u.set(l.attributes.color.array,_*3),_+=l.attributes.position.count;const f=new ct;return f.setAttribute("position",new pt(c,3)),f.setAttribute("color",new pt(u,3)),f.computeVertexNormals(),f}function yt(e){const t=new Tt(1,1),n=t.attributes.position;for(let r=0;r<n.count;r++){const c=new k(n.getX(r),n.getY(r),n.getZ(r));c.multiplyScalar(.7+.45*lt(c.x*1.9+e,c.z*1.9+c.y*1.3-e)),n.setXYZ(r,c.x,c.y*.62+.3,c.z)}const a=t.toNonIndexed(),o=a.attributes.position,s=[];for(let r=0;r<o.count;r++){const c=.72+.28*E(o.getY(r),0,.8);s.push(c,c,c)}return a.setAttribute("color",new H(s,3)),a.computeVertexNormals(),a}function Se(e){const t=new Nt;t.name="nuketown/scrub";const n=[K(1.3,8),K(4.7,9),K(8.1,7)],a=K(2.2,4),o=[yt(3.3),yt(6.6)],s=new q({vertexColors:!0,roughness:1,metalness:0,flatShading:!0,name:"nuketown/scrub"}),r=new q({vertexColors:!0,roughness:.95,metalness:0,flatShading:!0,name:"nuketown/boulders"}),c=[[],[],[]],u=[],_=[[],[]],f=[new S("#ffffff"),new S("#e6e9dc"),new S("#f3eadb"),new S("#d9d6c8")],l=[new S("#c8b89a"),new S("#b9a587"),new S("#d2c3a6")],m=e?6.5:4;let d=0;for(let N=-380;N<=380;N+=m)for(let b=-380;b<=380;b+=m){d++;const y=N+(w(d,1)-.5)*m*1.1,C=b+(w(d,2)-.5)*m*1.1;if(ht(ge,y,C)||ht(B,y,C,2)||we(y,C,3))continue;const x=Ut(y,C);if(x<2.5||x>330||Math.hypot(y,C)>360||C>I-2&&Math.abs(y-Gt(C))<5.5)continue;const p=m*m/(16+x*.4+x*x*.0015),T=E(R(y*.035+5,C*.035-2,3),.32,.62)*1.6,D=w(d,3);if(D<p*T){const W=(.75+.85*w(d,4)**1.3)*(x>110?1.2:1),G={x:y,z:C,s:W,yaw:w(d,5)*6.283,c:f[Math.floor(w(d,6)*f.length)].clone().multiplyScalar(.86+.26*w(d,7)),R:x};x<110?c[Math.floor(w(d,8)*3)].push(G):u.push(G)}else D>1-p*.035&&_[Math.floor(w(d,9)*2)].push({x:y,z:C,s:.45+1.6*w(d,10)**2.4,yaw:w(d,11)*6.283,c:l[Math.floor(w(d,12)*l.length)].clone().multiplyScalar(.92+.16*w(d,13)),R:x})}const h=new Kt,v=new te,g=new Zt,F=new k,M=new k,A=(N,b,y,C,x)=>{if(!y.length)return;const p=new Qt(N,b,y.length);p.name=C,y.forEach((T,D)=>{const W=Ot(T.x,T.z)-(x?.22*T.s:.05);g.set(x?(w(D,14)-.5)*.35:(w(D,14)-.5)*.12,T.yaw,x?(w(D,15)-.5)*.35:(w(D,15)-.5)*.12),v.setFromEuler(g);const G=x?T.s*(.9+.5*w(D,16)):T.s*(.9+.35*w(D,17));M.set(G,T.s*(x?.8:.9+.25*w(D,19)),x?T.s:G*(.85+.3*w(D,18))),h.compose(F.set(T.x,W,T.z),v,M),p.setMatrixAt(D,h),p.setColorAt(D,T.c)}),p.instanceMatrix.needsUpdate=!0,p.instanceColor&&(p.instanceColor.needsUpdate=!0),p.receiveShadow=!0,p.castShadow=!1,p.frustumCulled=!1,t.add(p)};return c.forEach((N,b)=>A(n[b],s,N,`nuketown/scrub-${b}`,!1)),A(a,s,u,"nuketown/scrub-far",!1),_.forEach((N,b)=>A(o[b],r,N,`nuketown/boulders-${b}`,!0)),t}const bt=e=>Ct(`/assets/nuketown/${e}`),V=new k(-.5,.56,.66).normalize(),kt=.63,Me=[.59719,.35458,.04823,.076,.90834,.01566,.0284,.13383,.83777],Ce=[1.60475,-.53108,-.07367,-.10208,1.10813,-.00605,-.00327,-.07276,1.07602];function Ne(e,t){const n=(f,l)=>[0,1,2].map(m=>f[m*3]*l[0]+f[m*3+1]*l[1]+f[m*3+2]*l[2]),a=f=>(f*(f+.0245786)-90537e-9)/(f*(.983729*f+.432951)+.238081);let o=[e[0]*1.14,e[1]*1.08,e[2]];const s=.3*o[0]+.5*o[1]+.2*o[2];o=o.map(f=>f*.97+s*.03).map(f=>f*t/.6),o=n(Ce,n(Me,o).map(a)).map(f=>Math.min(1,Math.max(0,f))),o=o.map(f=>f<=.0031308?f*12.92:Math.pow(f,.41666)*1.055-.055);const r=.2126*o[0]+.7152*o[1]+.0722*o[2];if(r<.18)return o;const c=(f,l,m)=>{const d=Math.min(1,Math.max(0,(m-f)/(l-f)));return d*d*(3-2*d)},u=c(.18,.52,r)*(1-c(.6,1,r)),_=1+(r*r*(3-2*r)-r)*.55*u/Math.max(r,1e-4);return o.map(f=>f*_)}function U(e,t=kt){const n=new S(e),a=[n.r,n.g,n.b].map(s=>s<=.0031308?s*12.92:Math.pow(s,.41666)*1.055-.055);let o=[.2,.2,.2];for(let s=0;s<80;s++){const r=Ne(o,t);o=o.map((c,u)=>c*Math.pow((a[u]+.002)/(r[u]+.002),.6))}return new S(o[0],o[1],o[2])}const Te=380,zt="#8fafb8",Rt="#c1bba7",ot="#b3a288",Fe="#bdb6a1",Ae="#ece8de",De="#98a2a6",Ee="#9a8d78",Ue=34,Ge=-9,Oe=50,ke=9,xt=(e,t)=>{const n=Y.degToRad(e),a=Y.degToRad(t);return new k(Math.sin(n)*Math.cos(a),Math.sin(a),-Math.cos(n)*Math.cos(a))};function rt(e,t=1,n=1,a=1,o=new S(1,1,1)){const s=new le({uniforms:{uSun:{value:e.clone().normalize()},uZenith:{value:U(zt)},uHorizon:{value:U(Rt)},uGround:{value:U(ot)},uCloudLit:{value:U(Ae)},uCloudShade:{value:U(De)},uDust:{value:U(Ee)},uBowC:{value:xt(Ue,Ge)},uDustC:{value:xt(Oe,ke)},uGain:{value:t},uRainbow:{value:n},uSunAmt:{value:a},uTint:{value:o}},vertexShader:"varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }",fragmentShader:`precision highp float;
      uniform vec3 uSun, uZenith, uHorizon, uGround, uCloudLit, uCloudShade, uDust, uBowC, uDustC;
      uniform float uGain, uRainbow, uSunAmt; uniform vec3 uTint; varying vec3 vDir;
      float hash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
      float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
      vec3 spectral(float t){ // t in [0,1] red -> violet
        return clamp(vec3(1.5 - abs(t * 4.0 - 0.5), 1.4 - abs(t * 4.0 - 2.0), 1.3 - abs(t * 4.0 - 3.3)), 0.0, 1.0);
      }
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        float cs = dot(d, uSun);
        // ---- gradient: band (lower ~10 deg) -> zenith colour by ~25 deg, deeper overhead
        float band = 1.0 - smoothstep(0.07, 0.42, h);
        vec3 col = mix(uZenith * mix(1.0, 0.9, smoothstep(0.5, 1.0, h)), uHorizon, band * band * (3.0 - 2.0 * band));
        // warmer, brighter band toward the sun (forward scatter in the dust)
        float sunSide = 0.5 + 0.5 * dot(normalize(vec2(d.x, d.z) + 1e-5), normalize(vec2(uSun.x, uSun.z)));
        col *= 1.0 + band * (sunSide - 0.5) * 0.16 * vec3(1.06, 1.0, 0.9);
        // the last couple of degrees: dust hugging the ground
        col = mix(col, uGround, 1.0 - smoothstep(-0.005, 0.06, h));
        // ---- brown dust mass, low in the north (soft, lumpy edge)
        vec3 dm = d - uDustC;
        float dmr = length(vec2(dm.x, dm.z)) * 0.95 + max(dm.y, 0.0) * 1.6 + max(-dm.y, 0.0) * 0.6;
        float dn = fbm(d.xz / (h + 0.35) * 2.6 + 3.0);
        float dust = (1.0 - smoothstep(0.2, 0.85, dmr + (dn - 0.5) * 0.7)) * smoothstep(-0.02, 0.08, h);
        col = mix(col, uDust * (0.82 + 0.36 * fbm(d.xz / (h + 0.3) * 5.0 + 7.0)), dust * 0.78);
        // ---- rainbow: primary (violet inside), Alexander's dark band, secondary (reversed, fainter)
        if (uRainbow > 0.0) {
          float ang = degrees(acos(clamp(dot(d, uBowC), -1.0, 1.0)));
          float above = smoothstep(0.015, 0.16, h);
          float p1 = smoothstep(39.4, 40.4, ang) * (1.0 - smoothstep(42.2, 43.2, ang));
          float p2 = smoothstep(49.6, 50.8, ang) * (1.0 - smoothstep(53.4, 54.6, ang));
          vec3 bow = mix(vec3(0.55), spectral(1.0 - (ang - 39.6) / 3.2), 0.8) * p1 + mix(vec3(0.55), spectral((ang - 50.0) / 4.0), 0.7) * p2 * 0.5;
          float l = lum(col);
          col *= 1.0 + above * uRainbow * (0.04 * (1.0 - smoothstep(38.0, 41.0, ang)) - 0.035 * smoothstep(42.2, 43.5, ang) * (1.0 - smoothstep(49.0, 50.5, ang)));
          col += bow * l * 0.2 * above * uRainbow * (0.65 + 0.35 * dust);
        }
        // ---- cumulus on a sky plane: scattered puffs in loose groups, lit toward the sun
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.1) * 1.6;
          vec2 w = vec2(vnoise(uv * 1.3 + 5.2), vnoise(uv * 1.3 + 1.7)) - 0.5;
          vec2 q = uv * 2.4 + w * 0.55;
          float n = fbm(q);
          float cluster = smoothstep(0.42, 0.66, fbm(uv * 0.42 + 11.0));
          float base = n * (0.72 + 0.5 * cluster);
          float cov = smoothstep(0.56, 0.7, base);
          vec2 toSun = normalize(uSun.xz + 1e-5) * 0.09;
          float n2 = fbm(q + toSun) * (0.72 + 0.5 * cluster);
          float lit = clamp(0.62 + (base - n2) * 6.0, 0.0, 1.0);
          // thick cores read darker underneath (flat grey bases), thin edges glow
          float core = smoothstep(0.66, 0.84, base);
          vec3 cc = mix(uCloudShade, uCloudLit, lit * (1.0 - 0.45 * core) + 0.12 * (1.0 - core));
          cc *= 1.0 + 0.3 * pow(max(cs, 0.0), 8.0);
          // far clouds sink into the dust band
          cc = mix(cc, col, 1.0 - smoothstep(0.05, 0.4, h));
          col = mix(col, cc, cov * smoothstep(0.02, 0.22, h) * 0.95);
        }
        // ---- the sun: hot disc, tight halo, wide warm forward-scatter (bloomed BO1 sun)
        float c0 = max(cs, 0.0);
        vec3 glow = vec3(1.0, 0.9, 0.74) * (pow(c0, 5.0) * 0.16 + pow(c0, 30.0) * 0.38 + pow(c0, 220.0) * 1.3 + pow(c0, 1600.0) * 7.0);
        col += uSunAmt * glow * lum(uZenith) * 2.2;
        col += uSunAmt * vec3(1.0, 0.97, 0.92) * smoothstep(0.99975, 0.9999, cs) * 30.0;
        gl_FragColor = vec4(col * uGain * uTint, 1.0);
      }`,side:At,depthWrite:!1,depthTest:!1,fog:!1}),r=new et(new Ft(Te,96,48),s);return r.renderOrder=-100,r.frustumCulled=!1,r.name="nuketown/sky",r.userData.qaIgnore=!0,r}const It=9e-4,Pt=.55,it=10,Lt=.035,ze=.35;function Re(e){const t=Dt;if(t.__ntHeightFog)return;t.__ntHeightFog=!0;const n=a=>a.toFixed(5);t.fog_pars_vertex=`#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorld;
#endif`,t.fog_vertex=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`,t.fog_pars_fragment=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,t.fog_fragment=`#ifdef USE_FOG
	{
		vec3 ntRay = vFogWorld - cameraPosition;
		float ntL = length( ntRay );
		#ifdef FOG_EXP2
			float ntDy = ntRay.y / ${n(it)};
			float ntK = abs( ntDy ) > 1e-3 ? ( 1.0 - exp( - ntDy ) ) / ntDy : 1.0;
			float ntTau = fogDensity * ntL * ( 1.0 + ${n(Pt)} * exp( - max( cameraPosition.y, 0.0 ) / ${n(it)} ) * ntK );
			#ifdef NT_FOG_SCALE
				ntTau *= NT_FOG_SCALE;
			#endif
			float fogFactor = min( 1.0 - ( 1.0 - ${n(Lt)} ) * exp( - ntTau ), 0.985 );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		float ntSun = pow( max( dot( ntRay / max( ntL, 1e-3 ), vec3( ${n(e.x)}, ${n(e.y)}, ${n(e.z)} ) ), 0.0 ), 6.0 );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * ( 1.0 + ${n(ze)} * ntSun * vec3( 1.0, 0.95, 0.85 ) ), fogFactor );
	}
#endif`}const Ie=1.5;function Pe(){const e=Dt;if(e.__ntSoftShadow)return;const t=e.shadowmap_pars_fragment,n=t.indexOf("#elif defined( SHADOWMAP_TYPE_PCF_SOFT )"),a=n<0?-1:t.indexOf("#elif defined( SHADOWMAP_TYPE_VSM )",n);n<0||a<0||(e.__ntSoftShadow=!0,e.shadowmap_pars_fragment=t.slice(0,n)+`#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			shadow = 0.0;
			for ( int j = -1; j <= 1; j ++ ) {
				for ( int i = -1; i <= 1; i ++ ) {
					vec2 uv = shadowCoord.xy + vec2( float( i ), float( j ) ) * texelSize * ${Ie.toFixed(2)};
					vec2 f = fract( uv * shadowMapSize + 0.5 );
					uv -= f * texelSize;
					float s00 = texture2DCompare( shadowMap, uv, shadowCoord.z );
					float s10 = texture2DCompare( shadowMap, uv + vec2( texelSize.x, 0.0 ), shadowCoord.z );
					float s01 = texture2DCompare( shadowMap, uv + vec2( 0.0, texelSize.y ), shadowCoord.z );
					float s11 = texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z );
					float w = ( i == 0 ? 2.0 : 1.0 ) * ( j == 0 ? 2.0 : 1.0 );
					shadow += w * mix( mix( s00, s10, f.x ), mix( s01, s11, f.x ), f.y );
				}
			}
			shadow *= ( 1.0 / 16.0 );
		`+t.slice(a))}async function Le(e,t){const n=new St,a={};return e&&!t&&await Promise.all(Object.entries(e).map(async([o,s])=>{const r={giScale:s.giScale??1};s.ao&&(r.ao=await n.loadAsync(bt(s.ao)).catch(()=>{})),s.gi&&(r.gi=await n.loadAsync(bt(s.gi)).catch(()=>{}));for(const c of[r.ao,r.gi])c&&(c.channel=1,c.flipY=!1);r.gi&&(r.gi.colorSpace=st),a[o]=r})),a}const Z=new S(1.08,.97,.86),He=.6,We=.8,$e=1.8,Be=1.8;function Ve(e,t,n){t&&e instanceof q&&!n&&(t.ao&&(e.aoMap=t.ao,e.aoMapIntensity=1),t.gi&&(e.lightMap=t.gi,e.lightMapIntensity=t.giScale*$e,qe(e)))}function qe(e){if(e.userData.ntLightmapFill)return;e.userData.ntLightmapFill=!0;const t=e.onBeforeCompile;e.onBeforeCompile=(a,o)=>{t.call(e,a,o),a.fragmentShader=a.fragmentShader.replace("#include <lights_fragment_maps>",`float ntSkyVis = 1.0;
      #if defined( RE_IndirectDiffuse ) && defined( USE_LIGHTMAP )
        vec4 ntLm = texture2D( lightMap, vLightMapUv );
        // alpha = 0.5 + 0.5 * baked sky visibility (nt_bake.py): vis ~1 open ground, ~0.5 open
        // wall, ~0 indoors (a lightmap without it reads 1: all exterior, as before)
        float ntSky = clamp( ( ntLm.a - 0.5 ) * 2.0, 0.0, 1.0 );
        float ntOut = smoothstep( 0.06, 0.24, ntSky );
        vec3 lightMapIrradiance = ntLm.rgb * lightMapIntensity * vec3( ${Z.r.toFixed(3)}, ${Z.g.toFixed(3)}, ${Z.b.toFixed(3)} );
        lightMapIrradiance *= mix( ${We.toFixed(3)}, 1.0, ntOut );
        irradiance += lightMapIrradiance;
        {
          float ntUp = dot( geometryNormal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
          irradiance += lightMapIrradiance * ${He.toFixed(3)} * ( 1.0 - abs( ntUp ) ) * ntOut;
        }
        ntSkyVis = smoothstep( 0.03, 0.4, ntSky );
      #endif
      #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
        radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * ntSkyVis;
      #endif`)};const n=e.customProgramCacheKey.bind(e);e.customProgramCacheKey=()=>`${n()}|ntLmFill6`,e.needsUpdate=!0}function Ye(e,t,n,a,o){const s=rt(V);e.add(s);const r=ye(a,n);e.add(r),Re(V),e.fog=new ee(U(Fe),It);const c=new ae(16773596,3.1);c.position.copy(V).multiplyScalar(120),c.target.position.set(-1,0,-5),c.castShadow=!n,c.shadow.mapSize.set(4096,4096);const u=c.shadow.camera;u.left=-58,u.right=58,u.top=40,u.bottom=-40,u.near=40,u.far=230,Pe(),c.shadow.bias=-25e-5,c.shadow.normalBias=.05,c.shadow.radius=2,e.add(c,c.target);const _=Object.keys(o).length>0,f=new ne(13226706,10127970,n?2.7:_?0:.3);if(e.add(f),n){const l=document.createElement("canvas");l.width=4,l.height=128;const m=l.getContext("2d"),d=m.createLinearGradient(0,0,0,128),h=`#${U(zt).getHexString()}`;d.addColorStop(0,h),d.addColorStop(.32,h),d.addColorStop(.47,`#${U(Rt).getHexString()}`),d.addColorStop(.5,`#${U(ot).getHexString()}`),d.addColorStop(1,`#${U(ot).getHexString()}`),m.fillStyle=d,m.fillRect(0,0,4,128);const v=new se(l);v.colorSpace=st,v.mapping=ce,e.background=v,s.visible=!1,fe(e)}else{const l=new oe,m=rt(V,Be,0,0,Z);l.add(m);const d=new et(new Ft(300,32,16,0,Math.PI*2,Math.PI*.5,Math.PI*.5),new re({color:new S(.24,.21,.15),side:At}));l.add(d);const h=new ie(t);e.environment=h.fromScene(l,.02,1,2e3).texture,e.environmentIntensity=1,h.dispose()}return{sky:s,sun:c,update:(l,m)=>{s.position.copy(m.position),r.follow(m.position)}}}const Je=Object.freeze(Object.defineProperty({__proto__:null,FOG_DENSITY:It,FOG_GROUND:Pt,FOG_H:it,FOG_VEIL:Lt,NUKETOWN_EXPOSURE:kt,NUKETOWN_SUN_DIR:V,applyLightmap:Ve,buildSkyRig:Ye,displayToScene:U,loadLightmaps:Le,makeSky:rt},Symbol.toStringTag,{value:"Module"}));export{Ze as B,Lt as F,V as N,z as S,Le as a,Ye as b,Ve as c,It as d,Pt as e,it as f,Ke as l,pe as m,Je as n};
//# sourceMappingURL=nuketown-sky-DKqnuq2p.js.map
