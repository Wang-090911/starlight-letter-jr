'use strict';
// The numeric scene and shader choreography come from the approved Python
// renderer. Fonts have already become point destinations, so no font network
// request or platform font substitution can change the dedication.
(() => {
  const canvas=document.getElementById('heart');
  const loading=document.getElementById('loading');
  const replay=document.getElementById('replay');
  const notice=document.getElementById('notice');
  const film=document.getElementById('film');
  const still=document.getElementById('still');
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let animation=null, stopped=false, lost=false, frame=0;
  let started=0, elapsed=0, pausedAt=0, lastDraw=-1000, ended=false;
  let fallbackMode=false;
  document.body.dataset.state='loading';

  function program(gl,vs,fs){
    function shader(type,source){
      const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
        const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(message);
      }
      return s;
    }
    const vertex=shader(gl.VERTEX_SHADER,vs),fragment=shader(gl.FRAGMENT_SHADER,fs);
    const p=gl.createProgram();gl.attachShader(p,vertex);gl.attachShader(p,fragment);gl.linkProgram(p);
    gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  class ParticleLetter {
    constructor(gl,shaders,config,points,curve){
      this.gl=gl;this.config=config;this.targets=[];
      if(!gl.getExtension('EXT_color_buffer_float'))throw new Error('HDR unavailable');
      this.particles=program(gl,shaders.PARTICLE_VERTEX,shaders.PARTICLE_FRAGMENT);
      this.blur=program(gl,shaders.FULLSCREEN_VERTEX,shaders.BLUR_FRAGMENT);
      this.composite=program(gl,shaders.FULLSCREEN_VERTEX,shaders.COMPOSITE_FRAGMENT);
      this.locations=new Map();
      this.pointVAO=gl.createVertexArray();gl.bindVertexArray(this.pointVAO);
      this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER,points,gl.STATIC_DRAW);
      let offset=0;
      for(const [name,n] of [['a_shape',4],['a_light',4],['a_target',4],['a_reveal',2],['a_launch',2]]){
        const location=gl.getAttribLocation(this.particles,name);
        if(location>=0){gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,n,gl.FLOAT,false,64,offset);}
        offset+=n*4;
      }
      this.screenVAO=gl.createVertexArray();gl.bindVertexArray(null);
      this.curve=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.curve);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,2048,1,0,gl.RG,gl.FLOAT,new Float32Array(curve));
      this.textureOptions(gl.NEAREST);
      gl.useProgram(this.particles);
      this.uniform(this.particles,'u_curve',0,'i');
      this.uniform(this.particles,'u_duration',config.duration);
      this.uniform(this.particles,'u_render_scale',2);
      this.uniform(this.particles,'u_signature_exit',config.signatureExit,'v2');
      this.uniform(this.particles,'u_small_center',config.smallCenter,'v2');
      this.uniform(this.particles,'u_small_scale',config.smallScale);
      this.uniform(this.particles,'u_autograph_center',config.autographCenter,'v2');
      gl.useProgram(this.blur);this.uniform(this.blur,'u_source',0,'i');
      gl.useProgram(this.composite);
      for(const [i,name] of ['u_scene','u_near','u_far'].entries())this.uniform(this.composite,name,i,'i');
      this.resize();
    }
    textureOptions(filter){
      const gl=this.gl;
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    uniform(p,name,value,type='f'){
      const gl=this.gl;
      if(!this.locations.has(p))this.locations.set(p,new Map());
      const cache=this.locations.get(p);
      if(!cache.has(name))cache.set(name,gl.getUniformLocation(p,name));
      const location=cache.get(name);
      if(type==='v2')gl.uniform2fv(location,value);
      else if(type==='i')gl.uniform1i(location,value);
      else gl.uniform1f(location,value);
    }
    target(size){
      const gl=this.gl,texture=gl.createTexture(),fbo=gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,size,size,0,gl.RGBA,gl.HALF_FLOAT,null);
      this.textureOptions(gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('HDR target unavailable');
      const target={texture,fbo,size};this.targets.push(target);return target;
    }
    resize(){
      const gl=this.gl;
      const query=new URLSearchParams(location.search);
      const testSize=Number(query.get('qaSize'));
      const size=testSize>=160 && testSize<=820?Math.round(testSize):
        Math.min(820,Math.max(440,Math.round(canvas.getBoundingClientRect().width*Math.min(devicePixelRatio||1,2))));
      if(size===this.size)return;
      this.size=size;canvas.width=canvas.height=size;
      for(const t of this.targets){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.fbo);}
      this.targets=[];
      this.scene=this.target(size*2);
      this.near1=this.target(Math.max(64,Math.floor(size/2)));
      this.near2=this.target(Math.max(64,Math.floor(size/2)));
      this.far1=this.target(Math.max(32,Math.floor(size/4)));
      this.far2=this.target(Math.max(32,Math.floor(size/4)));
      gl.useProgram(this.particles);this.uniform(this.particles,'u_pixels',size);
    }
    bindTexture(texture,index){
      const gl=this.gl;gl.activeTexture(gl.TEXTURE0+index);gl.bindTexture(gl.TEXTURE_2D,texture);
    }
    blurPass(source,target,horizontal,radius){
      const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,target.size,target.size);
      this.bindTexture(source.texture,0);
      this.uniform(this.blur,'u_step',horizontal?[radius/source.size,0]:[0,radius/source.size],'v2');
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    draw(t){
      const gl=this.gl,c=this.config;
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.scene.fbo);gl.viewport(0,0,this.scene.size,this.scene.size);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      if(t>0){
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
        gl.useProgram(this.particles);gl.bindVertexArray(this.pointVAO);
        this.bindTexture(this.curve,0);
        this.uniform(this.particles,'u_time',t);
        this.uniform(this.particles,'u_progress',Math.max(0,Math.min(1,t/(c.duration*.94))));
        gl.drawArrays(gl.POINTS,0,c.count);gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(this.screenVAO);gl.useProgram(this.blur);
      this.blurPass(this.scene,this.near1,true,2.4);
      this.blurPass(this.near1,this.near2,false,1.1);
      this.blurPass(this.near2,this.far1,true,3.6);
      this.blurPass(this.far1,this.far2,false,2);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,this.size,this.size);
      gl.useProgram(this.composite);
      this.bindTexture(this.scene.texture,0);this.bindTexture(this.near2.texture,1);this.bindTexture(this.far2.texture,2);
      let settle=Math.max(0,Math.min(1,(t-c.duration-5)/5));settle=settle*settle*(3-2*settle);
      this.uniform(this.composite,'u_settle',settle);
      this.uniform(this.composite,'u_flourish',1+.10*Math.exp(-Math.pow((t/c.duration-.95)/.055,2)));
      gl.drawArrays(gl.TRIANGLES,0,3);
      this.time=t;
    }
  }

  function tick(now){
    if(stopped || lost || document.hidden)return;
    elapsed=(now-started)/1000;
    if(now-lastDraw>=(ended?1000/30:0)){
      animation.draw(elapsed);lastDraw=now;
    }
    if(!ended && elapsed>=animation.config.finish){ended=true;replay.hidden=false;document.body.dataset.state='complete';}
    frame=requestAnimationFrame(tick);
  }
  function play(){
    stopped=false;ended=false;elapsed=0;lastDraw=-1000;
    started=performance.now();pausedAt=started;replay.hidden=true;notice.textContent='';
    document.body.dataset.state='playing';cancelAnimationFrame(frame);frame=requestAnimationFrame(tick);
  }
  async function fallback(){
    if(fallbackMode)return;fallbackMode=true;cancelAnimationFrame(frame);
    canvas.style.display='none';loading.hidden=true;
    document.body.dataset.state='fallback';
    if(reduced){still.style.display='block';replay.hidden=false;return;}
    film.style.display='block';film.src='animation.mp4';film.muted=true;
    try{await film.play();}
    catch{replay.hidden=false;replay.setAttribute('aria-label','播放动画');notice.textContent='轻触右下角，让星光开始。';}
    film.addEventListener('ended',()=>{replay.hidden=false;document.body.dataset.state='complete';});
    film.addEventListener('error',()=>{film.style.display='none';still.style.display='block';notice.textContent='动画暂时没有载入，轻触右下角再试一次。';replay.hidden=false;});
  }
  replay.addEventListener('click',()=>{
    if(fallbackMode){
      still.style.display='none';film.style.display='block';
      if(!film.src)film.src='animation.mp4';film.currentTime=0;film.muted=true;
      notice.textContent='';replay.hidden=true;
      film.play().catch(()=>{replay.hidden=false;notice.textContent='暂时无法播放，请稍后重试。';});
    }else play();
  });
  document.addEventListener('visibilitychange',()=>{
    if(fallbackMode){if(document.hidden){film.pause();}else if(!film.ended){film.play().catch(()=>{replay.hidden=false;});}return;}
    if(!animation)return;
    if(document.hidden){pausedAt=performance.now();cancelAnimationFrame(frame);}
    else{started+=performance.now()-pausedAt;if(!stopped)frame=requestAnimationFrame(tick);}
  });
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;fallback();});
  window.addEventListener('resize',()=>{if(animation && !fallbackMode){animation.resize();animation.draw(elapsed);}});
  window.addEventListener('pagehide',()=>cancelAnimationFrame(frame));
  window.addEventListener('pageshow',event=>{if(event.persisted && animation && !fallbackMode && !stopped){started=performance.now()-elapsed*1000;frame=requestAnimationFrame(tick);}});

  async function load(url,binary=false){
    const response=await fetch(url);if(!response.ok)throw new Error('Scene load failed');
    return binary?response.arrayBuffer():response.json();
  }
  async function init(){
    try{
      if(new URLSearchParams(location.search).has('compat'))return fallback();
      const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,powerPreference:'high-performance',preserveDrawingBuffer:false});
      if(!gl)return fallback();
      const [shaders,config,points,curve]=await Promise.all([load('shaders.json'),load('scene.json'),load('particles.bin',true),load('curve.bin',true)]);
      if(points.byteLength!==config.count*64 || curve.byteLength!==2048*8)throw new Error('Scene data incomplete');
      animation=new ParticleLetter(gl,shaders,config,points,curve);
      loading.hidden=true;
      const forced=new URLSearchParams(location.search).get('qaTime');
      if(forced!==null && Number.isFinite(Number(forced))){
        elapsed=Math.max(0,Math.min(120,Number(forced)));stopped=true;animation.draw(elapsed);document.body.dataset.state='qa';
      }else if(reduced){animation.draw(config.finish);elapsed=config.finish;stopped=true;replay.hidden=false;document.body.dataset.state='complete';}
      else play();
    }catch(error){console.warn('Using compatible animation playback:',error);await fallback();}
  }
  init();
})();
