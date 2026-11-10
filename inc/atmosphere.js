/* World-space procedural mist. Its density never uses beam angle or intensity.
   Desktop integrates six depths; compact devices use two soft samples. */
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
    uniform vec2 direction;
    uniform float time;
    uniform float intensity;

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
    vec2 light(vec2 p, vec2 eye, float depth) {
      vec2 delta = p - eye;
      float along = dot(delta, direction);
      float across = abs(delta.x * direction.y - delta.y * direction.x);
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
      #ifdef COMPACT
        vec3 air = vec3(p / vec2(200.0,155.0), .4) + vec3(-time*.040,time*.010,time*.022);
        vec3 sharedCurrent = vec3(noise(air*.6+vec3(8.1,time*.018,3.2)),
          noise(air*.6+vec3(2.6,9.4,time*.014)),0.0)-vec3(.5,.5,0.0);
        vec2 sharedLight = light(p, eyes.xy, 0.0) + light(p, eyes.zw, 0.0);
        const int DEPTHS = 2;
      #else
        const int DEPTHS = 6;
      #endif
      for (int i = 0; i < DEPTHS; i++) {
        float z = float(i) / float(DEPTHS - 1);
        float depth = (z - .5) * 2.0;
        // The air moves slowly across the room, independent of the light heads.
        vec3 world = vec3(p / vec2(200.0, 155.0), z * .85);
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
          vec2 incoming = light(p, eyes.xy, depth) + light(p, eyes.zw, depth);
        #endif
        float d = density(world + current * .5);
        // Always-visible faint ambient haze preserves cloud identity in darkness.
        vec3 ambient = vec3(.060, .057, .050);
        vec3 scattered = vec3(1.0, .75, .45) * incoming.x * (.18 + intensity * .82) * .125;
        vec3 shaft = vec3(1.0, .81, .53) * incoming.y * intensity * .10;
        fog += d * (ambient + scattered + shaft) / float(DEPTHS);
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
          const uniforms = Object.fromEntries(['resolution','viewport','eyes','direction','time','intensity']
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
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let width = 1, height = 1, origins = [0,0,0,0], lost = false;
    canvas.dataset.renderer = 'webgl-world-fog';
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); lost = true; canvas.hidden = true; });
    let replacement = null;
    canvas.addEventListener('webglcontextrestored', () => {
      replacement = create(canvas);
      if (replacement) {
        replacement.resize(width, height, [[origins[0], origins[1]], [origins[2], origins[3]]]);
        canvas.hidden = false;
      }
    }, { once: true });
    function resize(w, h, nextOrigins) {
      width = w; height = h; origins = nextOrigins.flat();
      if (replacement) { replacement.resize(w, h, nextOrigins); return; }
      // The mist is deliberately soft: render fewer pixels and let CSS upscale.
      const compact = w < 700 || matchMedia('(pointer: coarse)').matches;
      if (select(compact) === false) { canvas.hidden = true; return; }
      const scale = Math.min(.65, (compact ? 280 : 620) / w, (compact ? 300 : 520) / h);
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    function render(seconds, degrees, level) {
      if (replacement) { replacement.render(seconds, degrees, level); return; }
      if (lost || !selected) return;
      const { uniforms } = selected;
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.viewport, width, height);
      gl.uniform4f(uniforms.eyes, ...origins);
      const radians = degrees * Math.PI / 180;
      gl.uniform2f(uniforms.direction, Math.cos(radians), Math.sin(radians));
      gl.uniform1f(uniforms.time, seconds);
      gl.uniform1f(uniforms.intensity, level);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return { resize, render };
  }
  window.DemeritAtmosphere = { create };
})();
