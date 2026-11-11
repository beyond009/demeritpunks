/* World-space procedural mist. Its density never uses beam angle or intensity.
   Desktop integrates six depths; compact devices use two soft samples.
   setEmission({...}) enables persistent mouth mode. Density then comes only
   from world-space exhaled smoke; inactive emission never clears old smoke. */
(() => {
  const vertex = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const fragment = `
    precision highp float;
    uniform vec2 resolution;
    uniform vec2 viewport;
    uniform vec4 eyes;
    uniform vec4 directions;
    uniform float time;
    uniform float intensity;
    uniform vec2 headLevels;
    uniform float mouthMode;
    uniform sampler2D smokeDensity;

    float concentration(vec2 p) {
      // Field row zero is screen-top. p is already in CSS top-down space,
      // so no upload flip or angle-dependent texture transform is needed.
      return min(1.0, texture2D(smokeDensity, p / viewport).r * 1.2);
    }

    float hash(vec3 p) {
      p = fract(p * .1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }
    float noise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                     mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                     mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float density(vec3 p) {
      #ifdef COMPACT
        float n = noise(p) * .68;
        n += noise(p * 2.03 + vec3(13.4,7.1,3.6)) * .32;
      #else
        float n = noise(p) * .57;
        n += noise(p * 2.03 + vec3(13.4,7.1,3.6)) * .29;
        n += noise(p * 4.11 + vec3(3.8,17.2,8.1)) * .14;
      #endif
      return smoothstep(.28, .72, n);
    }
    vec2 light(vec2 p, vec2 eye, vec2 beamDirection, float depth) {
      vec2 delta = p - eye;
      float along = dot(delta, beamDirection);
      float across = abs(delta.x * beamDirection.y - delta.y * beamDirection.x);
      float travel = max(0.0, along);
      // A wide Gaussian scattering field, not a rotating visibility mask.
      // At 300px along the beam, its soft spill extends hundreds of pixels.
      float spread = 105.0 + travel * .20;
      float radial = across * across + depth * depth * 1500.0;
      float spill = exp(-radial / (2.0 * spread * spread));
      float coreWidth = 14.0 + travel * .042;
      float core = exp(-radial / (2.0 * coreWidth * coreWidth));
      float falloff = exp(-travel / 1050.0) * smoothstep(-55.0, 110.0, along);
      return vec2(spill, core) * falloff;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution;
      vec2 p = vec2(uv.x, 1.0 - uv.y) * viewport;
      vec3 fog = vec3(0.0);
      // Concentration is evaluated once, independently of both beam angles.
      // Outside emitted smoke there is no infinite room-fog substitute.
      float cloud = mouthMode > .5 ? concentration(p) : 1.0;
      if (cloud < .001) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
      #ifdef COMPACT
        vec2 grain = mix(vec2(200.0,155.0), vec2(90.0,72.0), mouthMode);
        vec3 air = vec3(p / grain, .4) + vec3(-time*.040,time*.010,time*.022);
        vec3 sharedCurrent = vec3(noise(air*.6+vec3(8.1,time*.018,3.2)),
          noise(air*.6+vec3(2.6,9.4,time*.014)),0.0)-vec3(.5,.5,0.0);
        vec2 sharedLight = light(p, eyes.xy, directions.xy, 0.0) * headLevels.x + light(p, eyes.zw, directions.zw, 0.0) * headLevels.y;
        const int DEPTHS = 2;
      #else
        const int DEPTHS = 6;
      #endif
      for (int i = 0; i < DEPTHS; i++) {
        float z = float(i) / float(DEPTHS - 1);
        float depth = (z - .5) * 2.0;
        // The air moves slowly across the room, independent of the light heads.
        vec2 detailScale = mix(vec2(200.0,155.0), vec2(90.0,72.0), mouthMode);
        vec3 world = vec3(p / detailScale, z * .85);
        world += vec3(-time * .040, time * .010, time * .022);
        // Slow local currents bend the advected cloud instead of sliding a
        // single flat pattern. They keep moving when playback is paused.
        #ifdef COMPACT
          vec3 current = sharedCurrent;
          vec2 incoming = sharedLight;
        #else
          vec3 current = vec3(
            noise(world * .6 + vec3(8.1, time * .018, 3.2)),
            noise(world * .6 + vec3(2.6, 9.4, time * .014)), 0.0) - vec3(.5,.5,0.0);
          vec2 incoming = light(p, eyes.xy, directions.xy, depth) * headLevels.x + light(p, eyes.zw, directions.zw, depth) * headLevels.y;
        #endif
        float d = density(world + current * .5) * cloud;
        // Always-visible faint ambient haze preserves cloud identity in darkness.
        vec3 ambient = vec3(.085, .080, .071);
        vec3 scattered = vec3(1.0, .75, .45) * incoming.x * (.18 + intensity * .82) * .125;
        vec3 shaft = vec3(1.0, .81, .53) * incoming.y * intensity * .10;
        float sourceGain = 1.0 + mouthMode * 4.2;
        fog += d * (ambient + (scattered + shaft) * sourceGain) / float(DEPTHS);
      }
      // Thin fog, without opaque smoke puffs or a full-page colour wash.
      gl_FragColor = vec4(fog, 1.0);
    }
  `;

  function create(canvas) {
    if (!canvas) return null;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false,
      stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl || !gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision) return null;
    function compile(type, code) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    }
    const variants = new Map();
    let selected = null;
    function select(compact) {
      const key = compact ? 'compact' : 'full';
      if (selected?.key === key) return;
      if (!variants.has(key)) {
        let program;
        try {
          const vs = compile(gl.VERTEX_SHADER, vertex);
          const fs = compile(gl.FRAGMENT_SHADER, (compact ? '#define COMPACT\n' : '') + fragment);
          program = gl.createProgram();
          gl.attachShader(program, vs); gl.attachShader(program, fs);
          gl.bindAttribLocation(program, 0, 'position');
          gl.linkProgram(program);
          gl.deleteShader(vs); gl.deleteShader(fs);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
          const uniforms = Object.fromEntries(['resolution','viewport','eyes','directions','time','intensity','headLevels','mouthMode','smokeDensity']
            .map(name => [name, gl.getUniformLocation(program, name)]));
          variants.set(key, { key, program, uniforms });
        } catch (error) {
          if (program) gl.deleteProgram(program);
          return false;
        }
      }
      selected = variants.get(key);
      gl.useProgram(selected.program);
      canvas.dataset.quality = key;
      return true;
    }
    let width = 1, height = 1, origins = [0,0,0,0], lost = false;
    let mouthMode = false, emission = { active: false }, physics = null;
    let compact = false, lastPhysicsTime = null, uploadPending = true;
    let densityTexture = null, textureWidth = 0, textureHeight = 0;
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
    function initializeTexture() {
      densityTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, densityTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1));
      textureWidth = textureHeight = 1;
      uploadPending = true;
    }
    function uploadDensity() {
      if (!uploadPending) return;
      const field = physics?.field;
      if (!field?.pixels || field.width < 1 || field.height < 1) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, densityTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (textureWidth !== field.width || textureHeight !== field.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, field.width, field.height, 0,
          gl.LUMINANCE, gl.UNSIGNED_BYTE, field.pixels);
        textureWidth = field.width; textureHeight = field.height;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, field.width, field.height,
          gl.LUMINANCE, gl.UNSIGNED_BYTE, field.pixels);
      }
      uploadPending = false;
    }
    function initializeBuffer() {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    initializeBuffer(); initializeTexture();
    canvas.dataset.renderer = 'webgl-world-fog';
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); lost = true; canvas.hidden = true; lastPhysicsTime = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // GPU resources are rebuilt in place; room-space smoke and the pending
      // mouth emission survive. No duplicate listeners or replacement chains.
      variants.clear(); selected = null; lost = false;
      initializeBuffer(); initializeTexture();
      resize(width, height, [[origins[0], origins[1]], [origins[2], origins[3]]]);
      canvas.hidden = !selected;
    });
    function setEmission(next = {}) {
      mouthMode = true;
      emission = { x: finite(next.x, 0), y: finite(next.y, 0),
        openness: clamp(finite(next.openness, 0), 0, 1),
        breath: clamp(finite(next.breath, 0), 0, 1),
        scale: clamp(finite(next.scale, 1), .25, 3),
        active: !!next.active && Number.isFinite(next.x) && Number.isFinite(next.y) };
      if (!physics && window.DemeritSmokePhysics?.create) {
        physics = window.DemeritSmokePhysics.create();
        physics.resize(width, height);
        lastPhysicsTime = null;
        uploadPending = true;
      }
      physics?.setEmission(emission);
      canvas.dataset.smoke = physics ? 'fluid-mouth' : 'mouth-unavailable';
    }
    function step(seconds) {
      if (!physics) return;
      const now = finite(seconds, lastPhysicsTime ?? 0);
      if (lastPhysicsTime === null || now < lastPhysicsTime) { lastPhysicsTime = now; return; }
      const interval = 1 / (compact ? 15 : 20);
      if (now - lastPhysicsTime < interval - 1e-6) return;
      const dt = clamp(now - lastPhysicsTime, 0, .15);
      lastPhysicsTime = now;
      physics.step(dt);
      const field = physics.field;
      canvas.dataset.smokeMass = finite(field.mass, 0).toFixed(1);
      canvas.dataset.smokePeak = finite(field.peak, 0).toFixed(3);
      canvas.dataset.smokeCells = `${field.width}x${field.height}`;
      uploadPending = true;
    }
    function resize(w, h, nextOrigins) {
      width = w; height = h; origins = nextOrigins.flat();
      // The mist is deliberately soft: render fewer pixels and let CSS upscale.
      compact = w < 700 || matchMedia('(pointer: coarse)').matches;
      physics?.resize(w, h);
      uploadPending = true;
      if (select(compact) === false) { canvas.hidden = true; return; }
      const scale = Math.min(.65, (compact ? 280 : 620) / w, (compact ? 300 : 520) / h);
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    function render(seconds, degrees, level, levels = [1, 1]) {
      step(seconds);
      if (lost || !selected) return;
      uploadDensity();
      const { uniforms } = selected;
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.viewport, width, height);
      gl.uniform4f(uniforms.eyes, ...origins);
      // Older callers can supply a shared angle; compiled scores supply one
      // for each head. Fog density/advection is unchanged by either direction.
      const first = Array.isArray(degrees) ? degrees[0] : degrees;
      const second = Array.isArray(degrees) ? degrees[1] : degrees;
      const left = (Number.isFinite(first) ? first : 145) * Math.PI / 180;
      const right = (Number.isFinite(second) ? second : Number.isFinite(first) ? first : 145) * Math.PI / 180;
      gl.uniform4f(uniforms.directions, Math.cos(left), Math.sin(left), Math.cos(right), Math.sin(right));
      gl.uniform1f(uniforms.time, seconds);
      gl.uniform1f(uniforms.intensity, level);
      gl.uniform2f(uniforms.headLevels, ...levels.map(value => clamp(finite(value, 1), 0, 1)));
      gl.uniform1f(uniforms.mouthMode, mouthMode ? 1 : 0);
      gl.uniform1i(uniforms.smokeDensity, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return { resize, render, setEmission };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DemeritAtmosphere = api;
})();
