/**
 * Stranger Things Dimensional Reveal
 * Interactive WebGL Liquid Reveal Shader with Dynamic Speed-Sensitive Trail
 */

(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    baseImagePath: './assets/Hawk_final.jpeg',
    revealImagePath: './assets/Upside_final.jpeg',
    // Trail physics
    lerpSpeed: 0.28,             // Spring interpolation factor
    minSpeedThreshold: 8.0,      // Speed (px/sec) below which no reveal occurs
    maxSpeedThreshold: 700.0,    // Speed (px/sec) for maximum brush scale
    minBrushRadius: 30.0,        // Radius at minimum trigger speed (px)
    maxBrushRadius: 80.0,       // Radius at high velocity (px)
    minTrailLife: 0.5,           // Trail lifespan (seconds) at low speed
    maxTrailLife: 0.5,           // Trail lifespan (seconds) at max speed
    trailFadePower: 1.0,         // Nonlinear power for falloff taper
    stationaryDecayMultiplier: 2.5, // Accelerated fade when cursor stops
    // Shader noise parameters
    noiseScale: 4.5,             // Frequency of edge distortion noise
    noiseSpeed: 1.2,             // Speed of crawling edge animation
    distortionAmount: 0.05,      // Magnitude of liquid UV displacement
    edgeNoiseStrength: 0.15,     // Organic boundary bleed strength
    edgeSoftness: 0.2,           // Edge smoothstep width
    riftGlowIntensity: 0.5,      // Crimson dimensional rift glow strength
    chromaticAberration: 0.008   // Rift boundary chromatic displacement
  };

  // --- DOM Elements ---
  const glCanvas = document.getElementById('gl-canvas');
  const sporesCanvas = document.getElementById('spores-canvas');
  const hintTag = document.getElementById('hint-tag');

  // WebGL Context
  const gl = glCanvas.getContext('webgl', { alpha: false, antialias: true, depth: false, stencil: false }) ||
    glCanvas.getContext('experimental-webgl');

  if (!gl) {
    console.error('WebGL is not supported on this browser.');
    return;
  }

  // --- Offscreen Trail Mask Canvas ---
  const trailCanvas = document.createElement('canvas');
  const trailCtx = trailCanvas.getContext('2d');

  // --- Particle Spores Background & Pre-rendered Sprite ---
  const sporesCtx = sporesCanvas.getContext('2d');
  let spores = [];
  const SPORE_COUNT = window.innerWidth < 768 ? 35 : 70;

  // Pre-rendered glowing spore sprite (eliminates expensive canvas shadowBlur in loop)
  const sporeSprite = document.createElement('canvas');
  const sporeSpriteSize = 32;
  sporeSprite.width = sporeSpriteSize;
  sporeSprite.height = sporeSpriteSize;
  const sCtx = sporeSprite.getContext('2d');
  const halfSpore = sporeSpriteSize / 2;
  const sporeGrad = sCtx.createRadialGradient(halfSpore, halfSpore, 0, halfSpore, halfSpore, halfSpore);
  sporeGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  sporeGrad.addColorStop(0.25, 'rgba(255, 255, 255, 0.85)');
  sporeGrad.addColorStop(0.55, 'rgba(255, 255, 255, 0.25)');
  sporeGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  sCtx.fillStyle = sporeGrad;
  sCtx.beginPath();
  sCtx.arc(halfSpore, halfSpore, halfSpore, 0, Math.PI * 2);
  sCtx.fill();

  // --- Device & Performance Profiling ---
  const isMobile = window.innerWidth < 768 || /Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent);
  const fbmOctaves = isMobile ? 2 : 3;

  // --- State Variables ---
  let width = window.innerWidth;
  let height = window.innerHeight;
  const maxInitialDpr = window.innerWidth < 768 ? 1.0 : 1.5;
  let dpr = Math.min(window.devicePixelRatio || 1, maxInitialDpr);

  // Mask upload caching flags to skip idle gl.texImage2D calls
  let pointerMoved = true;
  let hadSegments = true;

  // Hero visibility tracking for IntersectionObserver
  let isHeroVisible = true;
  let heroAnimationId = null;

  let mouse = {
    x: width / 2,
    y: height / 2,
    targetX: width / 2,
    targetY: height / 2,
    smoothedSpeed: 0,
    isHovering: false,
    hasInteracted: false
  };

  let trailSegments = [];

  let baseTexture = null;
  let revealTexture = null;
  let maskTexture = null;
  let baseImageWidth = 1024;
  let baseImageHeight = 571;
  let imagesLoaded = 0;

  let program = null;
  let uniformLocations = {};

  let lastTime = performance.now();
  let totalTime = 0;

  // --- GLSL Shaders ---
  const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;

    void main() {
      // Map [-1, 1] quad to [0, 1] UVs
      v_uv = (a_position + 1.0) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;

    varying vec2 v_uv;

    uniform sampler2D u_baseTexture;
    uniform sampler2D u_revealTexture;
    uniform sampler2D u_maskTexture;

    uniform vec2 u_resolution;
    uniform vec2 u_imageResolution;
    uniform float u_time;

    uniform float u_noiseScale;
    uniform float u_distortionAmount;
    uniform float u_edgeNoiseStrength;
    uniform float u_edgeSoftness;
    uniform float u_riftGlowIntensity;
    uniform float u_chromaStrength;

    // --- Simplex Noise 2D ---
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187,
                          0.366025403784439,
                         -0.577350269189626,
                          0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v -   i + dot(i, C.xx);
      vec2 i1;
      i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
            + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m = m*m;
      m = m*m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
      vec3 g;
      g.x  = a0.x  * x0.x  + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    // Fractal Brownian Motion for rich organic boiling texture (2 octaves on mobile, 3 on desktop)
    float fbm(vec2 p) {
      float total = 0.0;
      float amp = 0.55;
      float freq = 1.0;
      for (int i = 0; i < ${fbmOctaves}; i++) {
        total += snoise(p * freq) * amp;
        freq *= 2.15;
        amp *= 0.48;
      }
      return total;
    }

    // Robust aspect ratio cover UV formula
    vec2 getCoverUV(vec2 uv, vec2 screenRes, vec2 imgRes) {
      float screenRatio = screenRes.x / screenRes.y;
      float imgRatio = imgRes.x / imgRes.y;
      vec2 ratio = vec2(
        min(screenRatio / imgRatio, 1.0),
        min(imgRatio / screenRatio, 1.0)
      );
      return (uv - 0.5) * ratio + 0.5;
    }

    void main() {
      // 1. Correct aspect-ratio UV coordinates
      vec2 coverUV = getCoverUV(v_uv, u_resolution, u_imageResolution);

      // 2. Sample noise displacement for fluid crawl
      vec2 noiseCoord = v_uv * u_noiseScale + vec2(u_time * 0.08, u_time * 0.06);
      float n1 = fbm(noiseCoord);
      float n2 = fbm(noiseCoord + vec2(5.2, 1.3) + vec2(-u_time * 0.07, u_time * 0.09));

      vec2 liquidOffset = vec2(n1, n2) * u_distortionAmount;

      // 3. Sample mask (v_uv is in [0,1] screen space)
      float rawMask = texture2D(u_maskTexture, v_uv).r;
      float displacedMask = texture2D(u_maskTexture, v_uv + liquidOffset * (rawMask * 0.8 + 0.2)).r;

      // 4. Add organic crawling edge noise to the reveal boundary
      float crawlNoise = n1 * u_edgeNoiseStrength;
      float activeMask = displacedMask + crawlNoise * smoothstep(0.02, 0.4, displacedMask) * (1.0 - smoothstep(0.6, 0.98, displacedMask));
      activeMask = clamp(activeMask, 0.0, 1.0);

      // 5. Soft liquid thresholding
      float reveal = smoothstep(0.1 - u_edgeSoftness * 0.5, 0.1 + u_edgeSoftness * 0.5, activeMask);

      // 6. Sample Base Image (Hawkins daylight)
      vec4 baseCol = texture2D(u_baseTexture, coverUV);

      // 7. Sample Reveal Image (Upside Down) with edge chromatic aberration
      float chromaDist = u_chromaStrength * smoothstep(0.05, 0.5, reveal) * (1.0 - smoothstep(0.5, 0.95, reveal));
      vec2 chromaOffset = vec2(n1, n2) * chromaDist;
      
      vec4 revealCol;
      revealCol.r = texture2D(u_revealTexture, coverUV + chromaOffset * 1.5).r;
      revealCol.g = texture2D(u_revealTexture, coverUV).g;
      revealCol.b = texture2D(u_revealTexture, coverUV - chromaOffset * 1.5).b;
      revealCol.a = 1.0;

      // 8. Dimensional Rift Crimson Border Glow
      float rim = smoothstep(0.01, 0.25, reveal) * (1.0 - smoothstep(0.25, 0.75, reveal));
      vec3 rimColor = vec3(1.0, 0.18, 0.08) * rim * u_riftGlowIntensity;
      
      // Secondary subtle inner tendril glow
      float innerRim = smoothstep(0.15, 0.4, reveal) * (1.0 - smoothstep(0.4, 0.85, reveal));
      vec3 innerRimColor = vec3(0.7, 0.05, 0.2) * innerRim * (u_riftGlowIntensity * 0.5);

      // 9. Final Blended Composition
      vec3 finalColor = mix(baseCol.rgb, revealCol.rgb, reveal) + rimColor + innerRimColor;

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  // --- WebGL Helpers ---
  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function initWebGL() {
    const vertShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    if (!vertShader || !fragShader) {
      console.error('Failed to create shaders');
      return;
    }

    program = gl.createProgram();
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program linking error:', gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    // Quad geometry (2 triangles covering full screen)
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1.0, -1.0,
      1.0, -1.0,
      -1.0, 1.0,
      -1.0, 1.0,
      1.0, -1.0,
      1.0, 1.0
    ]), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    uniformLocations = {
      baseTexture: gl.getUniformLocation(program, 'u_baseTexture'),
      revealTexture: gl.getUniformLocation(program, 'u_revealTexture'),
      maskTexture: gl.getUniformLocation(program, 'u_maskTexture'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      imageResolution: gl.getUniformLocation(program, 'u_imageResolution'),
      time: gl.getUniformLocation(program, 'u_time'),
      noiseScale: gl.getUniformLocation(program, 'u_noiseScale'),
      distortionAmount: gl.getUniformLocation(program, 'u_distortionAmount'),
      edgeNoiseStrength: gl.getUniformLocation(program, 'u_edgeNoiseStrength'),
      edgeSoftness: gl.getUniformLocation(program, 'u_edgeSoftness'),
      riftGlowIntensity: gl.getUniformLocation(program, 'u_riftGlowIntensity'),
      chromaStrength: gl.getUniformLocation(program, 'u_chromaStrength')
    };

    // Initialize blank mask texture
    maskTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // Placeholder textures
    baseTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, baseTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([80, 90, 80, 255]));

    revealTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, revealTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 40, 255]));
  }

  function setupTextureFromImage(texture, image) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  function loadImages() {
    const baseImg = new Image();
    const revealImg = new Image();

    baseImg.onload = () => {
      baseImageWidth = baseImg.naturalWidth || 1024;
      baseImageHeight = baseImg.naturalHeight || 571;
      setupTextureFromImage(baseTexture, baseImg);
      imagesLoaded++;
      checkReady();
    };

    baseImg.onerror = (e) => {
      console.warn('Could not load base image directly', e);
    };

    revealImg.onload = () => {
      setupTextureFromImage(revealTexture, revealImg);
      imagesLoaded++;
      checkReady();
    };

    revealImg.onerror = (e) => {
      console.warn('Could not load reveal image directly', e);
    };

    if (window.ASSETS && window.ASSETS.hawkins && window.ASSETS.upsidedown) {
      baseImg.src = window.ASSETS.hawkins;
      revealImg.src = window.ASSETS.upsidedown;
    } else {
      if (window.location.protocol.startsWith('http')) {
        baseImg.crossOrigin = 'anonymous';
        revealImg.crossOrigin = 'anonymous';
      }
      baseImg.src = CONFIG.baseImagePath;
      revealImg.src = CONFIG.revealImagePath;
    }

    const aboutPosterImg = document.getElementById('about-poster-img');
    if (aboutPosterImg && window.ASSETS && window.ASSETS.about) {
      aboutPosterImg.src = window.ASSETS.about;
    }

    // Static Base Image for Mobile Hero View
    const mobileHeroImg = document.getElementById('mobile-hero-base');
    if (mobileHeroImg) {
      if (window.ASSETS && window.ASSETS.hawkins) {
        mobileHeroImg.src = window.ASSETS.hawkins;
      } else {
        mobileHeroImg.src = CONFIG.baseImagePath;
      }
    }
  }

  function checkReady() {
    resize();
    if (window.innerWidth >= 768 && !heroAnimationId) {
      lastTime = performance.now();
      heroAnimationId = requestAnimationFrame(render);
    }
  }

  // --- Atmospheric Spores Setup (Stranger Things White Particles) ---
  function initSpores() {
    spores = [];
    const count = window.innerWidth < 768 ? 35 : 70;
    for (let i = 0; i < count; i++) {
      spores.push({
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.random() * 2.2 + 0.8,
        speedX: (Math.random() - 0.5) * 0.35,
        speedY: (Math.random() - 0.6) * 0.45,
        opacity: Math.random() * 0.45 + 0.2,
        flickerSpeed: Math.random() * 0.03 + 0.01,
        flickerOffset: Math.random() * Math.PI * 2
      });
    }
  }

  function updateAndDrawSpores(time) {
    sporesCtx.clearRect(0, 0, width, height);

    for (let i = 0; i < spores.length; i++) {
      const s = spores[i];
      s.x += s.speedX;
      s.y += s.speedY;

      if (s.x < 0) s.x = width;
      if (s.x > width) s.x = 0;
      if (s.y < 0) s.y = height;
      if (s.y > height) s.y = 0;

      const alpha = s.opacity * (0.7 + 0.3 * Math.sin(time * s.flickerSpeed + s.flickerOffset));
      const renderSize = s.size * 3.5;

      sporesCtx.globalAlpha = Math.max(0, Math.min(1, alpha));
      sporesCtx.drawImage(
        sporeSprite,
        s.x - renderSize / 2,
        s.y - renderSize / 2,
        renderSize,
        renderSize
      );
    }
    sporesCtx.globalAlpha = 1.0;
  }

  // --- Window Resize Handling ---
  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const maxDpr = window.innerWidth < 768 ? 1.0 : 1.5;
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

    glCanvas.width = width * dpr;
    glCanvas.height = height * dpr;
    glCanvas.style.width = width + 'px';
    glCanvas.style.height = height + 'px';

    sporesCanvas.width = width;
    sporesCanvas.height = height;

    // Downscale trailCanvas to 0.25x on mobile, 0.5x on desktop
    const maskScale = window.innerWidth < 768 ? 0.25 : 0.5;
    trailCanvas.width = Math.max(160, Math.floor(width * maskScale));
    trailCanvas.height = Math.max(120, Math.floor(height * maskScale));

    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    initSpores();
    pointerMoved = true;
    hadSegments = true;
  }

  window.addEventListener('resize', resize);

  // --- Interactive Event Listeners ---
  function onPointerMove(clientX, clientY) {
    if (window.innerWidth < 768) return; // Keep hero static on mobile view

    pointerMoved = true;
    const rect = glCanvas.getBoundingClientRect();
    if (clientY > rect.bottom || clientY < rect.top || clientX < rect.left || clientX > rect.right) {
      mouse.isHovering = false;
      return;
    }
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    mouse.targetX = canvasX;
    mouse.targetY = canvasY;
    mouse.isHovering = true;

    if (!mouse.hasInteracted) {
      mouse.hasInteracted = true;
      hintTag.classList.add('hidden');
    }
  }

  window.addEventListener('mousemove', (e) => {
    onPointerMove(e.clientX, e.clientY);
  });

  window.addEventListener('touchstart', (e) => {
    if (window.innerWidth < 768) return; // Mobile view displays static base image without veil tearing
    if (e.touches.length > 0) {
      const t = e.touches[0];
      mouse.x = t.clientX;
      mouse.y = t.clientY;
      onPointerMove(t.clientX, t.clientY);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (window.innerWidth < 768) return; // Mobile view displays static base image without veil tearing
    if (e.touches.length > 0) {
      onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('mouseleave', () => {
    mouse.isHovering = false;
  });

  window.addEventListener('touchend', () => {
    mouse.isHovering = false;
  });

  // --- Trail Simulation Engine ---
  function updateTrail(dt) {
    const prevSmoothedX = mouse.x;
    const prevSmoothedY = mouse.y;

    // Smooth cursor interpolation
    mouse.x += (mouse.targetX - mouse.x) * CONFIG.lerpSpeed;
    mouse.y += (mouse.targetY - mouse.y) * CONFIG.lerpSpeed;

    // Velocity calculation
    const dx = mouse.x - prevSmoothedX;
    const dy = mouse.y - prevSmoothedY;
    const distanceMoved = Math.hypot(dx, dy);
    const instantSpeed = dt > 0 ? (distanceMoved / dt) : 0;

    mouse.smoothedSpeed += (instantSpeed - mouse.smoothedSpeed) * 0.22;

    // Dynamic speed factor
    let speedFactor = 0.0;
    if (mouse.smoothedSpeed > CONFIG.minSpeedThreshold) {
      const speedNorm = (mouse.smoothedSpeed - CONFIG.minSpeedThreshold) / (CONFIG.maxSpeedThreshold - CONFIG.minSpeedThreshold);
      speedFactor = Math.min(Math.max(speedNorm, 0.0), 1.0);
      speedFactor = Math.pow(speedFactor, 0.85);
    }

    const currentRadius = CONFIG.minBrushRadius + (CONFIG.maxBrushRadius - CONFIG.minBrushRadius) * speedFactor;
    const currentLifespan = CONFIG.minTrailLife + (CONFIG.maxTrailLife - CONFIG.minTrailLife) * speedFactor;
    const currentStrength = speedFactor;

    // Add new segment
    if (speedFactor > 0.04 && distanceMoved > 1.0) {
      trailSegments.push({
        x1: prevSmoothedX,
        y1: prevSmoothedY,
        x2: mouse.x,
        y2: mouse.y,
        radius: currentRadius,
        strength: currentStrength,
        age: 0,
        maxLife: currentLifespan
      });
    }

    // Age existing segments and accelerate decay if stationary
    const decayMultiplier = (speedFactor < 0.05) ? CONFIG.stationaryDecayMultiplier : 1.0;

    for (let i = trailSegments.length - 1; i >= 0; i--) {
      const seg = trailSegments[i];
      seg.age += dt * decayMultiplier;

      if (seg.age >= seg.maxLife) {
        trailSegments.splice(i, 1);
      }
    }

    if (trailSegments.length > 90) {
      trailSegments.splice(0, trailSegments.length - 90);
    }
  }

  // --- Render Offscreen Mask Canvas ---
  function renderTrailMask() {
    const maskW = trailCanvas.width;
    const maskH = trailCanvas.height;
    const scaleX = maskW / width;
    const scaleY = maskH / height;

    trailCtx.fillStyle = '#000000';
    trailCtx.fillRect(0, 0, maskW, maskH);

    if (trailSegments.length === 0) return;

    trailCtx.save();
    trailCtx.lineCap = 'round';
    trailCtx.lineJoin = 'round';

    for (let i = 0; i < trailSegments.length; i++) {
      const seg = trailSegments[i];
      const lifeRatio = Math.max(0, 1.0 - (seg.age / seg.maxLife));
      const taperedAlpha = Math.pow(lifeRatio, CONFIG.trailFadePower) * seg.strength;

      if (taperedAlpha <= 0.005) continue;

      const sx1 = seg.x1 * scaleX;
      // Invert Y coordinate for WebGL texture orientation (Y=0 is bottom in WebGL)
      const sy1 = (height - seg.y1) * scaleY;
      const sx2 = seg.x2 * scaleX;
      const sy2 = (height - seg.y2) * scaleY;
      const r = seg.radius * scaleX * (0.65 + 0.35 * lifeRatio);

      trailCtx.beginPath();
      trailCtx.moveTo(sx1, sy1);
      trailCtx.lineTo(sx2, sy2);
      trailCtx.lineWidth = Math.max(1.0, r * 2.0);
      trailCtx.strokeStyle = `rgba(255, 255, 255, ${taperedAlpha.toFixed(3)})`;
      trailCtx.stroke();
    }

    trailCtx.restore();
  }

  // --- Main Animation & Render Loop ---
  function render(now) {
    // 0. Pause Hero WebGL loop immediately if scrolled out of view or on mobile view
    if (!isHeroVisible || window.innerWidth < 768) {
      heroAnimationId = null;
      return;
    }

    const dt = Math.min((now - lastTime) / 1000.0, 0.1);
    lastTime = now;
    totalTime += dt;

    // 1. Physics
    updateTrail(dt);

    // 2 & 3. Render Mask and upload ONLY when trail is active, decaying, or pointer moved
    const hasSegments = trailSegments.length > 0;
    const needsMaskUpload = hasSegments || hadSegments || pointerMoved;

    if (needsMaskUpload) {
      renderTrailMask();
      gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, trailCanvas);
      pointerMoved = false;
    }
    hadSegments = hasSegments;

    // 4. Bind Shader & Textures
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTexture);
    gl.uniform1i(uniformLocations.baseTexture, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, revealTexture);
    gl.uniform1i(uniformLocations.revealTexture, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.uniform1i(uniformLocations.maskTexture, 2);

    // Uniforms
    gl.uniform2f(uniformLocations.resolution, glCanvas.width, glCanvas.height);
    gl.uniform2f(uniformLocations.imageResolution, baseImageWidth, baseImageHeight);
    gl.uniform1f(uniformLocations.time, totalTime * CONFIG.noiseSpeed);

    gl.uniform1f(uniformLocations.noiseScale, CONFIG.noiseScale);
    gl.uniform1f(uniformLocations.distortionAmount, CONFIG.distortionAmount);
    gl.uniform1f(uniformLocations.edgeNoiseStrength, CONFIG.edgeNoiseStrength);
    gl.uniform1f(uniformLocations.edgeSoftness, CONFIG.edgeSoftness);
    gl.uniform1f(uniformLocations.riftGlowIntensity, CONFIG.riftGlowIntensity);
    gl.uniform1f(uniformLocations.chromaStrength, CONFIG.chromaticAberration);

    // 5. Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    heroAnimationId = requestAnimationFrame(render);
  }

  // Dedicated lightweight loop for ambient spores across all sections
  function renderSporesLoop(now) {
    updateAndDrawSpores(now * 0.001);
    requestAnimationFrame(renderSporesLoop);
  }

  // =========================================================================
  // SECTION 3: BYERS LIVING ROOM ALPHABET WALL & LIGHT UNMASKING ENGINE
  // =========================================================================

  // =========================================================================
  // SECTION 3: BYERS LIVING ROOM ALPHABET WALL & LIGHT UNMASKING ENGINE
  // =========================================================================

  const BYERS_SLOTS = [
    // ROW 1 (A - H)
    {
      letter: 'A', row: 1, bulb_x: 4.5, bulb_y: 9.5, paper_x: 4.8, paper_y: 13.5, color: 'red', colorHex: '#ff3b30', rgb: '255, 59, 48', angle: -2,
      project: {
        title: 'SmartCafe360', tag: 'EXPEDITION #01', category: 'Software Engineering',
        img: 'assets/Projects/cafe.jpg',
        desc: 'It is a Cafe Management system.',
        tech: ['Python', 'MySQL'],
        demoUrl: 'https://github.com/mokshits2008/SmartCafe360', codeUrl: 'https://github.com/mokshits2008/SmartCafe360'
      }
    },
    {
      letter: 'B', row: 1, bulb_x: 14.5, bulb_y: 13.5, paper_x: 14.5, paper_y: 17.0, color: 'yellow', colorHex: '#ffd60a', rgb: '255, 214, 10', angle: 1.5
    },
    {
      letter: 'C', row: 1, bulb_x: 24.5, bulb_y: 16.5, paper_x: 24.5, paper_y: 20.0, color: 'blue', colorHex: '#0a84ff', rgb: '10, 132, 255', angle: -1
    },
    {
      letter: 'D', row: 1, bulb_x: 37.5, bulb_y: 18.5, paper_x: 37.5, paper_y: 22.0, color: 'red', colorHex: '#ff453a', rgb: '255, 69, 58', angle: 2
    },
    {
      letter: 'E', row: 1, bulb_x: 47.5, bulb_y: 14.5, paper_x: 47.5, paper_y: 18.0, color: 'green', colorHex: '#30d158', rgb: '48, 209, 88', angle: -2.5
    },
    {
      letter: 'F', row: 1, bulb_x: 55.5, bulb_y: 21.5, paper_x: 55.5, paper_y: 25.0, color: 'blue', colorHex: '#5e5ce6', rgb: '94, 92, 230', angle: 1.8
    },
    { letter: 'G', row: 1, bulb_x: 67.5, bulb_y: 22.0, paper_x: 67.5, paper_y: 25.5, color: 'yellow', colorHex: '#ffd60a', rgb: '255, 214, 10', angle: -1.2 },
    { letter: 'H', row: 1, bulb_x: 88.5, bulb_y: 10.5, paper_x: 88.5, paper_y: 14.0, color: 'green', colorHex: '#32d74b', rgb: '50, 215, 75', angle: 2.2 },

    // ROW 2 (I - Q)
    { letter: 'I', row: 2, bulb_x: 9.5, bulb_y: 39.5, paper_x: 9.5, paper_y: 43.0, color: 'green', colorHex: '#30d158', rgb: '48, 209, 88', angle: -1.5 },
    { letter: 'J', row: 2, bulb_x: 21.5, bulb_y: 45.0, paper_x: 21.5, paper_y: 48.5, color: 'orange', colorHex: '#ff9f0a', rgb: '255, 159, 10', angle: 2 },
    { letter: 'K', row: 2, bulb_x: 30.5, bulb_y: 47.0, paper_x: 30.5, paper_y: 50.5, color: 'blue', colorHex: '#0a84ff', rgb: '10, 132, 255', angle: -2 },
    { letter: 'L', row: 2, bulb_x: 39.5, bulb_y: 49.0, paper_x: 39.5, paper_y: 52.5, color: 'green', colorHex: '#32d74b', rgb: '50, 215, 75', angle: 1.5 },
    { letter: 'M', row: 2, bulb_x: 48.5, bulb_y: 49.0, paper_x: 48.5, paper_y: 52.5, color: 'yellow', colorHex: '#ffd60a', rgb: '255, 214, 10', angle: -1 },
    { letter: 'N', row: 2, bulb_x: 57.5, bulb_y: 46.0, paper_x: 57.5, paper_y: 49.5, color: 'red', colorHex: '#ff453a', rgb: '255, 69, 58', angle: 2.5 },
    { letter: 'O', row: 2, bulb_x: 65.5, bulb_y: 44.0, paper_x: 65.5, paper_y: 47.5, color: 'red', colorHex: '#ff375f', rgb: '255, 55, 95', angle: -2 },
    { letter: 'P', row: 2, bulb_x: 74.0, bulb_y: 45.0, paper_x: 74.0, paper_y: 48.5, color: 'green', colorHex: '#30d158', rgb: '48, 209, 88', angle: 1.2 },
    { letter: 'Q', row: 2, bulb_x: 88.0, bulb_y: 46.5, paper_x: 88.0, paper_y: 50.0, color: 'orange', colorHex: '#ff9f0a', rgb: '255, 159, 10', angle: -1.8 },

    // ROW 3 (R - Z)
    { letter: 'R', row: 3, bulb_x: 5.5, bulb_y: 67.5, paper_x: 5.5, paper_y: 71.0, color: 'orange', colorHex: '#ff9f0a', rgb: '255, 159, 10', angle: 2 },
    { letter: 'S', row: 3, bulb_x: 16.0, bulb_y: 70.0, paper_x: 16.0, paper_y: 73.5, color: 'green', colorHex: '#32d74b', rgb: '50, 215, 75', angle: -1.5 },
    { letter: 'T', row: 3, bulb_x: 25.0, bulb_y: 73.0, paper_x: 25.0, paper_y: 76.5, color: 'orange', colorHex: '#ff9f0a', rgb: '255, 159, 10', angle: 1.8 },
    { letter: 'U', row: 3, bulb_x: 33.5, bulb_y: 76.0, paper_x: 33.5, paper_y: 79.5, color: 'yellow', colorHex: '#ffd60a', rgb: '255, 214, 10', angle: -2.2 },
    { letter: 'V', row: 3, bulb_x: 43.0, bulb_y: 76.0, paper_x: 43.0, paper_y: 79.5, color: 'blue', colorHex: '#0a84ff', rgb: '10, 132, 255', angle: 1 },
    { letter: 'W', row: 3, bulb_x: 51.5, bulb_y: 76.5, paper_x: 51.5, paper_y: 80.0, color: 'red', colorHex: '#ff453a', rgb: '255, 69, 58', angle: -1.5 },
    { letter: 'X', row: 3, bulb_x: 60.0, bulb_y: 74.5, paper_x: 60.0, paper_y: 78.0, color: 'orange', colorHex: '#ff9f0a', rgb: '255, 159, 10', angle: 2.2 },
    { letter: 'Y', row: 3, bulb_x: 68.0, bulb_y: 74.0, paper_x: 68.0, paper_y: 77.5, color: 'blue', colorHex: '#5e5ce6', rgb: '94, 92, 230', angle: -1 },
    { letter: 'Z', row: 3, bulb_x: 87.5, bulb_y: 74.0, paper_x: 87.5, paper_y: 77.5, color: 'red', colorHex: '#ff375f', rgb: '255, 55, 95', angle: 2 }
  ];

  function initByersWallUnmasking() {
    const lettersLayer = document.getElementById('alphabet-letters-layer');
    const wallLightsOn = document.getElementById('wall-lights-on');
    const wallLightsOff = document.getElementById('wall-lights-off');
    const glowBloomContainer = document.getElementById('glow-bloom-container');

    if (!lettersLayer || !wallLightsOn) return;

    // Use base64 images if available in window.ASSETS for instant zero-latency loading
    if (window.ASSETS) {
      if (window.ASSETS.lights_off && wallLightsOff) wallLightsOff.src = window.ASSETS.lights_off;
      if (window.ASSETS.lights_on && wallLightsOn) wallLightsOn.src = window.ASSETS.lights_on;
    }

    const parchmentSrc = (window.ASSETS && window.ASSETS.parchment_clean) ? window.ASSETS.parchment_clean : 'assets/parchment_clean.png';

    // Fast lookup map
    const slotMap = {};
    BYERS_SLOTS.forEach(slot => { slotMap[slot.letter] = slot; });

    function renderSlots() {
      lettersLayer.innerHTML = '';

      BYERS_SLOTS.forEach((slot) => {
        const slotEl = document.createElement('div');
        slotEl.className = 'pinned-parchment-slot' + (slot.project ? ' has-project' : '');
        slotEl.id = `slot-${slot.letter}`;
        slotEl.setAttribute('data-letter', slot.letter);
        slotEl.style.left = `${slot.paper_x}%`;
        slotEl.style.top = `${slot.paper_y}%`;
        slotEl.style.transform = `translate(-50%, 0) rotate(${slot.angle}deg)`;
        slotEl.style.setProperty('--slot-glow-color', slot.colorHex);
        slotEl.style.setProperty('--slot-glow-rgb', slot.rgb);

        let innerHTML = `
          <div class="pin-thumbtack" aria-hidden="true"></div>
          <div class="parchment-card">
            <img src="${parchmentSrc}" class="parchment-texture-img" alt="Parchment">
            ${slot.project ? `
              <div class="parchment-photo-frame">
                <img src="${slot.project.img}" class="parchment-project-thumb" alt="${slot.project.title}">
              </div>
            ` : ''}
          </div>
        `;

        if (slot.project) {
          innerHTML += `
            <div class="slot-hover-tag">${slot.project.title} ↗</div>
          `;
        }

        slotEl.innerHTML = innerHTML;
        lettersLayer.appendChild(slotEl);

        // Event Listeners for Realistic Hover & Touch Light Reveal (Blinks once then glows)
        slotEl.addEventListener('mouseenter', () => {
          unmaskSingleLight(slot);
        });

        slotEl.addEventListener('mouseleave', () => {
          clearLightUnmask();
        });

        slotEl.addEventListener('touchstart', () => {
          unmaskSingleLight(slot);
        }, { passive: true });

        slotEl.addEventListener('click', () => {
          if (slot.project) {
            openExpeditionModal(slot.project);
          }
        });
      });
    }

    // Dynamic Loader for projects.json (Supports up to 26 projects A-Z)
    async function loadProjectsData() {
      try {
        const res = await fetch('projects.json?t=' + Date.now());
        if (res.ok) {
          const projectsList = await res.json();
          if (Array.isArray(projectsList)) {
            // Clear default projects
            BYERS_SLOTS.forEach(s => s.project = null);

            projectsList.forEach(item => {
              if (!item || !item.letter) return;
              const slot = slotMap[item.letter.toUpperCase()];
              if (slot) {
                slot.project = {
                  title: item.title || '',
                  tag: item.tag || `EXPEDITION #${slot.letter}`,
                  desc: item.desc || '',
                  img: item.img || 'assets/Projects/cafe.jpg',
                  url: item.url || item.demoUrl || item.githubUrl || '#',
                  tech: item.tech || []
                };
              }
            });

            renderSlots();
          }
        }
      } catch (e) {
        console.info('Using embedded fallback projects:', e);
      }
    }

    // Initial Render and Data Fetch
    renderSlots();
    loadProjectsData();

    // Unmask a single bulb with ultra-realistic multi-layered light blooming
    function unmaskSingleLight(slot) {
      if (!wallLightsOn) return;

      const maskGradient = `radial-gradient(circle 180px at ${slot.bulb_x}% ${slot.bulb_y}%, rgba(0,0,0,1) 0%, rgba(0,0,0,0.95) 28%, rgba(0,0,0,0.65) 58%, rgba(0,0,0,0.18) 82%, rgba(0,0,0,0) 100%)`;
      wallLightsOn.style.webkitMaskImage = maskGradient;
      wallLightsOn.style.maskImage = maskGradient;
      wallLightsOn.style.opacity = '1';

      if (glowBloomContainer) {
        glowBloomContainer.innerHTML = `
          <div class="realistic-light-glow" style="left: ${slot.bulb_x}%; top: ${slot.bulb_y}%; --glow-col: ${slot.colorHex}; --glow-rgb: ${slot.rgb};">
            <div class="glow-ambient-spill"></div>
            <div class="glow-corona"></div>
            <div class="glow-hot-core"></div>
            <div class="glow-lens-streak"></div>
          </div>
        `;
      }
    }

    function clearLightUnmask() {
      if (!wallLightsOn) return;
      wallLightsOn.style.opacity = '0';
      if (glowBloomContainer) glowBloomContainer.innerHTML = '';
    }
  }

  // --- Expedition Dossier Modal Controller ---
  const expModalEl = document.getElementById('expedition-modal');
  const expModalImg = document.getElementById('modal-project-img');
  const expModalTag = document.getElementById('modal-project-tag');
  const expModalTitle = document.getElementById('modal-project-title');
  const expModalDesc = document.getElementById('modal-project-desc');
  const expModalTechList = document.getElementById('modal-tech-list');
  const expModalDemoBtn = document.getElementById('modal-demo-btn');
  const expModalCloseBtn = document.getElementById('modal-close-btn');
  const expModalBackdrop = document.getElementById('modal-backdrop');

  function openExpeditionModal(project) {
    if (!expModalEl) return;

    if (expModalImg) expModalImg.src = project.img;
    if (expModalTag) expModalTag.textContent = project.tag || '';
    if (expModalTitle) expModalTitle.textContent = project.title || '';
    if (expModalDesc) expModalDesc.textContent = project.desc || '';

    if (expModalTechList) {
      expModalTechList.innerHTML = '';
      if (Array.isArray(project.tech)) {
        project.tech.forEach((t) => {
          const tagEl = document.createElement('span');
          tagEl.className = 'modal-tech-tag';
          tagEl.textContent = t;
          expModalTechList.appendChild(tagEl);
        });
      }
    }

    if (expModalDemoBtn) {
      expModalDemoBtn.href = project.url || project.demoUrl || '#';
    }

    expModalEl.classList.add('is-open');
    expModalEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeExpeditionModal() {
    if (!expModalEl) return;
    expModalEl.classList.remove('is-open');
    expModalEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (expModalCloseBtn) expModalCloseBtn.addEventListener('click', closeExpeditionModal);
  if (expModalBackdrop) expModalBackdrop.addEventListener('click', closeExpeditionModal);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeExpeditionModal();
    }
  });

  // --- Start ---
  initWebGL();
  resize();
  loadImages();
  initByersWallUnmasking();

  // Immediately render hero WebGL loop on desktop viewport
  if (window.innerWidth >= 768) {
    lastTime = performance.now();
    heroAnimationId = requestAnimationFrame(render);
  }

  // Pause the Hero WebGL loop when scrolled out of view or on mobile
  const heroContainer = document.querySelector('.hero-container');
  if (heroContainer && 'IntersectionObserver' in window) {
    const heroObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        isHeroVisible = entry.isIntersecting;
        if (isHeroVisible && window.innerWidth >= 768) {
          if (!heroAnimationId) {
            lastTime = performance.now();
            heroAnimationId = requestAnimationFrame(render);
          }
        } else {
          if (heroAnimationId) {
            cancelAnimationFrame(heroAnimationId);
            heroAnimationId = null;
          }
        }
      });
    }, { threshold: 0.02 });
    heroObserver.observe(heroContainer);
  }

  // Start dedicated spore particle loop
  requestAnimationFrame(renderSporesLoop);

})();


// ============================================================
// SECTION 4: ACHIEVEMENTS – Hawkins Lab CCTV Surveillance Wall
// ============================================================

(function initAchievementsSection() {
  'use strict';

  var CERTS_JSON = './certificates.json';
  var MONITOR_TOTAL = 12;

  var grid = document.getElementById('monitor-grid');
  var lightbox = document.getElementById('cert-lightbox');
  var lbBackdrop = document.getElementById('cert-lightbox-backdrop');
  var lbCloseBtn = document.getElementById('cert-lightbox-close');
  var lbImg = document.getElementById('cert-lightbox-img');
  var lbTitle = document.getElementById('cert-lb-title');
  var lbIssuer = document.getElementById('cert-lb-issuer');
  var lbDate = document.getElementById('cert-lb-date');
  var lbLocation = document.getElementById('cert-lb-location');
  var lbChannel = document.getElementById('cert-lb-channel');
  var lbCamId = document.getElementById('cert-lb-cam-id');
  var lbDownloadBtn = document.getElementById('cert-download-btn');

  if (!grid) return;

  function buildStatic() {
    var s = document.createElement('div');
    s.className = 'cctv-unit-static';
    return s;
  }

  function buildMonitorCard(cert, index) {
    var card = document.createElement('div');
    card.className = 'cctv-tv-box';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    var chNum = (index + 1) < 10 ? '0' + (index + 1) : '' + (index + 1);
    card.setAttribute('aria-label', cert ? (cert.title || 'Security Feed ' + chNum) : 'Camera Feed ' + chNum);

    // Screen Area (sits inside the TV opening)
    var screenEl = document.createElement('div');
    screenEl.className = 'cctv-tv-screen';

    // OSD Header Bar (Top)
    var osdTop = document.createElement('div');
    osdTop.className = 'cctv-osd-top';

    var osdLoc = document.createElement('span');
    osdLoc.className = 'cctv-osd-loc';
    osdLoc.textContent = cert && cert.location ? cert.location : 'HAWKINS LAB // SECTOR ' + chNum;

    var osdCam = document.createElement('span');
    osdCam.className = 'cctv-osd-cam';
    osdCam.textContent = 'CH-' + chNum;

    osdTop.appendChild(osdLoc);
    osdTop.appendChild(osdCam);
    screenEl.appendChild(osdTop);

    // Certificate / Video Image Feed
    if (cert && cert.img) {
      var img = document.createElement('img');
      img.className = 'cctv-cert-img';
      img.src = cert.img;
      img.alt = cert.title || 'Hawkins Lab Surveillance Feed';
      img.loading = 'lazy';
      img.onerror = function () {
        this.remove();
        screenEl.insertBefore(buildStatic(), screenEl.firstChild);
      };
      screenEl.appendChild(img);
    } else {
      screenEl.appendChild(buildStatic());
    }

    // CRT Glare & Scanlines
    var glare = document.createElement('div');
    glare.className = 'cctv-unit-glare';
    glare.setAttribute('aria-hidden', 'true');
    screenEl.appendChild(glare);

    var scanlines = document.createElement('div');
    scanlines.className = 'cctv-unit-scanlines';
    scanlines.setAttribute('aria-hidden', 'true');
    screenEl.appendChild(scanlines);

    card.appendChild(screenEl);

    // Screenshot TV Bezel Frame Overlay
    var bezelImg = document.createElement('img');
    bezelImg.className = 'cctv-tv-bezel-img';
    bezelImg.src = 'assets/cctv_tv_frame.png';
    bezelImg.alt = 'Hawkins CCTV Television Bezel';
    bezelImg.setAttribute('aria-hidden', 'true');
    card.appendChild(bezelImg);

    // Click to Open Hawkins CCTV Lightbox
    if (cert) {
      var openLightbox = function () { openCertLightbox(cert, index); };
      card.addEventListener('click', openLightbox);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLightbox();
        }
      });
    }

    return card;
  }

  function populateGrid(certs) {
    grid.innerHTML = '';
    for (var i = 0; i < MONITOR_TOTAL; i++) {
      var cert = certs[i] || null;
      grid.appendChild(buildMonitorCard(cert, i));
    }
  }

  function openCertLightbox(cert, index) {
    if (!lightbox) return;
    var chNum = (index + 1) < 10 ? '0' + (index + 1) : '' + (index + 1);

    if (lbImg) lbImg.src = cert.img || '';
    if (lbTitle) lbTitle.textContent = cert.title || 'SURVEILLANCE ARCHIVE #' + chNum;
    if (lbIssuer) lbIssuer.textContent = 'ISSUED BY: ' + (cert.issuer || 'HAWKINS DEPT OF ENERGY');
    if (lbDate) lbDate.textContent = cert.date || 'OCT 1983';
    if (lbLocation) lbLocation.textContent = cert.location || 'HAWKINS NATIONAL LABORATORY';
    if (lbChannel) lbChannel.textContent = 'CH-' + chNum;
    if (lbCamId) lbCamId.textContent = 'FEED #' + chNum + ' // DECODED';

    if (lbDownloadBtn) {
      lbDownloadBtn.href = cert.img || '#';
    }

    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeCertLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (lbCloseBtn) lbCloseBtn.addEventListener('click', closeCertLightbox);
  if (lbBackdrop) lbBackdrop.addEventListener('click', closeCertLightbox);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeCertLightbox();
  });

  fetch(CERTS_JSON)
    .then(function (r) {
      if (!r.ok) throw new Error('Not found');
      return r.json();
    })
    .then(function (certs) {
      populateGrid(Array.isArray(certs) ? certs : []);
    })
    .catch(function () {
      populateGrid([]);
    });

  // --- Contact Modal / Transmit Frequency Controller ---
  var contactModalEl = document.getElementById('contact-modal');
  var transmitFreqBtn = document.getElementById('transmit-frequency-btn');
  var contactCloseBtn = document.getElementById('contact-modal-close');
  var contactAbortBtn = document.getElementById('transmission-abort-btn');
  var contactBackdrop = document.getElementById('contact-modal-backdrop');
  var transmissionForm = document.getElementById('transmission-form');
  var transmissionSubmitBtn = document.getElementById('transmission-submit-btn');
  var transmissionStatusText = document.getElementById('transmission-status-text');
  var statusPulseDot = document.getElementById('status-pulse-dot');

  function openContactModal() {
    if (!contactModalEl) return;
    contactModalEl.classList.add('is-open');
    contactModalEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var firstInput = document.getElementById('sender-name');
    if (firstInput) {
      setTimeout(function () {
        firstInput.focus();
      }, 150);
    }
  }

  function closeContactModal() {
    if (!contactModalEl) return;
    contactModalEl.classList.remove('is-open');
    contactModalEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (transmitFreqBtn) {
    transmitFreqBtn.addEventListener('click', function (e) {
      e.preventDefault();
      openContactModal();
    });
  }

  if (contactCloseBtn) contactCloseBtn.addEventListener('click', closeContactModal);
  if (contactAbortBtn) contactAbortBtn.addEventListener('click', closeContactModal);
  if (contactBackdrop) contactBackdrop.addEventListener('click', closeContactModal);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && contactModalEl && contactModalEl.classList.contains('is-open')) {
      closeContactModal();
    }
  });

  if (transmissionForm) {
    transmissionForm.addEventListener('submit', function (e) {
      e.preventDefault();

      var nameInput = document.getElementById('sender-name');
      var emailInput = document.getElementById('sender-email');
      var msgInput = document.getElementById('sender-message');

      var name = nameInput ? nameInput.value.trim() : '';
      var email = emailInput ? emailInput.value.trim() : '';
      var message = msgInput ? msgInput.value.trim() : '';

      if (!name || !email || !message) return;

      if (transmissionSubmitBtn) {
        transmissionSubmitBtn.disabled = true;
        transmissionSubmitBtn.innerHTML = '<span class="btn-bracket">[</span><span class="btn-text">BROADCASTING SIGNAL... ⏳</span><span class="btn-bracket">]</span>';
      }
      if (statusPulseDot) {
        statusPulseDot.className = 'status-pulse-dot transmitting';
      }
      if (transmissionStatusText) {
        transmissionStatusText.textContent = 'TUNING TO 14.28 MHz... TRANSMITTING DISPATCH PACKET...';
      }

      var targetEmail = 'mokshit056@gmail.com';
      var payload = {
        name: name,
        email: email,
        message: message,
        _subject: '[Hawkins Radio Transmission] New dispatch from ' + name + ' (' + email + ')'
      };

      fetch('https://formsubmit.co/ajax/' + targetEmail, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (res.ok) {
            return res.json();
          }
          throw new Error('Signal dispatch response error');
        })
        .then(function () {
          if (statusPulseDot) statusPulseDot.className = 'status-pulse-dot success';
          if (transmissionStatusText) {
            transmissionStatusText.textContent = '✔ TRANSMISSION RECEIVED! DISPATCH SENT TO ' + targetEmail;
          }
          if (transmissionSubmitBtn) {
            transmissionSubmitBtn.innerHTML = '<span class="btn-bracket">[</span><span class="btn-text">DISPATCH DELIVERED ✔</span><span class="btn-bracket">]</span>';
          }
          transmissionForm.reset();
          setTimeout(function () {
            closeContactModal();
            if (transmissionSubmitBtn) {
              transmissionSubmitBtn.disabled = false;
              transmissionSubmitBtn.innerHTML = '<span class="btn-bracket">[</span><span class="btn-text">TRANSMIT DISPATCH 📡</span><span class="btn-bracket">]</span>';
            }
            if (statusPulseDot) statusPulseDot.className = 'status-pulse-dot';
            if (transmissionStatusText) {
              transmissionStatusText.textContent = 'SIGNAL READY // FREQUENCY 14.28 MHz CLEAR';
            }
          }, 3000);
        })
        .catch(function () {
          if (statusPulseDot) statusPulseDot.className = 'status-pulse-dot success';
          if (transmissionStatusText) {
            transmissionStatusText.textContent = '✔ SIGNAL PACKET READY // LAUNCHING DIRECT RADIO FREQUENCY...';
          }
          if (transmissionSubmitBtn) {
            transmissionSubmitBtn.disabled = false;
            transmissionSubmitBtn.innerHTML = '<span class="btn-bracket">[</span><span class="btn-text">TRANSMIT DISPATCH 📡</span><span class="btn-bracket">]</span>';
          }
          var mailtoSubject = encodeURIComponent('[Hawkins Transmission] Dispatch from ' + name);
          var mailtoBody = encodeURIComponent('Operative Name: ' + name + '\nReturn Frequency / Email: ' + email + '\n\nDispatch Payload:\n' + message);
          window.location.href = 'mailto:' + targetEmail + '?subject=' + mailtoSubject + '&body=' + mailtoBody;
        });
    });
  }

  // --- Site Header Navigation Controller ---
  var siteHeaderEl = document.getElementById('site-header');
  var navLinks = document.querySelectorAll('.nav-link');
  var navSectionTargets = [
    { id: 'hero-container', link: document.getElementById('nav-item-home') },
    { id: 'about-section', link: document.getElementById('nav-item-about') },
    { id: 'projects-section', link: document.getElementById('nav-item-projects') },
    { id: 'achievements-section', link: document.getElementById('nav-item-achievements') }
  ];

  function updateActiveNav() {
    var scrollPos = window.scrollY + 180;
    var currentId = 'hero-container';

    if (siteHeaderEl) {
      if (window.scrollY > 40) {
        siteHeaderEl.classList.add('is-scrolled');
      } else {
        siteHeaderEl.classList.remove('is-scrolled');
      }
    }

    for (var i = 0; i < navSectionTargets.length; i++) {
      var sec = document.getElementById(navSectionTargets[i].id);
      if (sec) {
        var top = sec.offsetTop;
        if (scrollPos >= top) {
          currentId = navSectionTargets[i].id;
        }
      }
    }

    navSectionTargets.forEach(function (item) {
      if (item.link) {
        if (item.id === currentId) {
          item.link.classList.add('is-active');
        } else {
          item.link.classList.remove('is-active');
        }
      }
    });
  }

  window.addEventListener('scroll', updateActiveNav, { passive: true });
  updateActiveNav();

  navLinks.forEach(function (link) {
    link.addEventListener('click', function (e) {
      var href = this.getAttribute('href');
      if (href && href.startsWith('#')) {
        var targetEl = document.querySelector(href);
        if (targetEl) {
          e.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

  // --- Footer Email Button Copy to Clipboard ---
  var footerEmailBtn = document.getElementById('footer-email-btn');
  if (footerEmailBtn) {
    footerEmailBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var email = 'mokshit056@gmail.com';

      function showCopiedFeedback() {
        var textSpan = footerEmailBtn.querySelector('.btn-text');
        if (textSpan) {
          var originalText = textSpan.textContent;
          textSpan.textContent = 'COPIED! ✔';
          footerEmailBtn.classList.add('btn-copied');
          setTimeout(function () {
            textSpan.textContent = originalText;
            footerEmailBtn.classList.remove('btn-copied');
          }, 2500);
        }
      }

      function fallbackCopy(text) {
        var textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '-9999px';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
          document.execCommand('copy');
        } catch (err) { }
        document.body.removeChild(textArea);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email)
          .then(showCopiedFeedback)
          .catch(function () {
            fallbackCopy(email);
            showCopiedFeedback();
          });
      } else {
        fallbackCopy(email);
        showCopiedFeedback();
      }
    });
  }

})();