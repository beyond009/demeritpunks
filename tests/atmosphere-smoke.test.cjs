const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require.resolve('../inc/atmosphere.js'), 'utf8');

function fixture({ width = 1000, available = true } = {}) {
  const uniforms = {}, listeners = {}, shaders = [], uploads = [], stores = [], parameters = [];
  const calls = { created: 0, resize: [], emissions: [], steps: [], cleared: 0 };
  const field = { width: 5, height: 3, pixels: new Uint8Array(15), mass: 0, peak: 0 };
  let emission = { active: false };
  const engine = { field,
    resize: (...args) => calls.resize.push(args),
    setEmission: next => { emission = next; calls.emissions.push(next); },
    step: dt => { calls.steps.push(dt); field.mass += emission.active && emission.openness > .16 ? dt : -Math.min(field.mass, dt * .1);
      field.pixels[0] = Math.round(field.mass * 100); field.peak = field.mass; },
    clear: () => { calls.cleared++; field.mass = 0; field.pixels.fill(0); },
  };
  const gl = { FRAGMENT_SHADER: 1, VERTEX_SHADER: 2, HIGH_FLOAT: 3, COMPILE_STATUS: 4,
    LINK_STATUS: 5, ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, TRIANGLES: 9,
    TEXTURE0: 10, TEXTURE_2D: 11, UNPACK_ALIGNMENT: 12, UNPACK_FLIP_Y_WEBGL: 13,
    TEXTURE_WRAP_S: 14, TEXTURE_WRAP_T: 15, CLAMP_TO_EDGE: 16, TEXTURE_MIN_FILTER: 17,
    TEXTURE_MAG_FILTER: 18, LINEAR: 19, LUMINANCE: 20, UNSIGNED_BYTE: 21,
    getShaderPrecisionFormat: () => ({ precision: 23 }), createShader: type => ({ type }),
    shaderSource: (shader, source) => { shader.source = source; shaders.push(source); },
    compileShader() {}, getShaderParameter: () => true, deleteShader() {},
    createProgram: () => ({}), attachShader() {}, bindAttribLocation() {}, linkProgram() {},
    getProgramParameter: () => true, deleteProgram() {}, getUniformLocation: (_, name) => name,
    useProgram() {}, createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {}, viewport() {},
    createTexture: () => ({}), activeTexture() {}, bindTexture() {},
    pixelStorei: (...args) => stores.push(args), texParameteri: (...args) => parameters.push(args),
    texImage2D: (...args) => uploads.push({ kind: 'new', width: args[3], height: args[4], pixels: Array.from(args[8]) }),
    texSubImage2D: (...args) => uploads.push({ kind: 'sub', width: args[4], height: args[5], pixels: Array.from(args[8]) }),
    uniform2f: (name, ...values) => uniforms[name] = values,
    uniform4f: (name, ...values) => uniforms[name] = values,
    uniform1f: (name, value) => uniforms[name] = value,
    uniform1i: (name, value) => uniforms[name] = value,
    drawArrays() {},
  };
  const canvas = { dataset: {}, getContext: () => gl,
    addEventListener: (name, fn) => listeners[name] = fn };
  const window = available ? { DemeritSmokePhysics: { create: () => { calls.created++; return engine; } } } : {};
  vm.runInNewContext(code, { window, matchMedia: () => ({ matches: false }), Float32Array, Uint8Array });
  const atmosphere = window.DemeritAtmosphere.create(canvas);
  atmosphere.resize(width, 844, [[250, 150], [380, 160]]);
  const mouth = { x: 300, y: 400, openness: 1, breath: 1, scale: 1, active: true };
  return { atmosphere, uniforms, listeners, canvas, shaders, mouth, field, calls, uploads, stores, parameters, gl };
}

test('legacy environment mode needs no physics; first setEmission replaces it, even inactive', () => {
  const f = fixture(); f.atmosphere.render(0, 145, .8);
  assert.equal(f.uniforms.mouthMode, 0); assert.equal(f.calls.created, 0);
  f.atmosphere.setEmission({ ...f.mouth, active: false });
  f.atmosphere.render(.1, 145, .8);
  assert.equal(f.uniforms.mouthMode, 1); assert.equal(f.calls.created, 1);
  assert.equal(f.field.mass, 0);
  assert.equal(f.uploads.at(-1).width, 5); assert.equal(f.uploads.at(-1).height, 3);
  assert.ok(f.uploads.at(-1).pixels.every(value => value === 0));
  f.atmosphere.setEmission(f.mouth); assert.equal(f.calls.created, 1);
});

test('field uses top-down byte texture with odd-width alignment and safe WebGL1 sampling', () => {
  const f = fixture(); f.atmosphere.setEmission(f.mouth);
  f.field.pixels[0] = 200; f.field.pixels[14] = 7;
  f.atmosphere.render(0, 130, .5);
  assert.equal(f.uploads.at(-1).pixels[0], 200);
  assert.equal(f.uploads.at(-1).pixels[14], 7);
  assert.ok(f.stores.some(([key, value]) => key === f.gl.UNPACK_ALIGNMENT && value === 1));
  assert.ok(f.stores.every(([key, value]) => key !== f.gl.UNPACK_FLIP_Y_WEBGL || value === false));
  for (const key of [f.gl.TEXTURE_WRAP_S, f.gl.TEXTURE_WRAP_T]) {
    assert.ok(f.parameters.some(([, parameter, value]) => parameter === key && value === f.gl.CLAMP_TO_EDGE));
  }
  assert.equal(f.uniforms.smokeDensity, 0);
  const fragment = f.shaders.find(source => source.includes('sampler2D smokeDensity'));
  assert.ok(fragment.includes('texture2D(smokeDensity, p / viewport)'));
  assert.ok(fragment.indexOf('float cloud =') < fragment.indexOf('for (int i = 0; i < DEPTHS;'));
  assert.ok(!fragment.includes('clouds[12]'));
});

test('physics and uploads are throttled; light direction and intensity never affect density', () => {
  const a = fixture(), b = fixture();
  a.atmosphere.setEmission(a.mouth); b.atmosphere.setEmission(b.mouth);
  for (let i = 0; i <= 60; i++) {
    a.atmosphere.render(i / 60, 115, .2); b.atmosphere.render(i / 60, [150, 137], 1);
  }
  assert.equal(a.calls.steps.length, 20);
  assert.deepEqual(a.calls.steps, b.calls.steps);
  assert.deepEqual(a.uploads, b.uploads);
  assert.notDeepEqual(a.uniforms.directions, b.uniforms.directions);
  assert.notEqual(a.uniforms.intensity, b.uniforms.intensity);
  assert.ok(a.uploads.filter(upload => upload.kind === 'sub').length <= 20);
  const compact = fixture({ width: 390 }); compact.atmosphere.setEmission(compact.mouth);
  for (let i = 0; i <= 60; i++) compact.atmosphere.render(i / 60, 130, .5);
  assert.equal(compact.calls.steps.length, 15);
  assert.ok(compact.canvas.width <= 280 && compact.canvas.height <= 300);
});

test('inactive mouth retains and simulates existing smoke; missing engine produces black mouth field', () => {
  const f = fixture(); f.atmosphere.setEmission(f.mouth);
  for (let i = 0; i <= 60; i++) f.atmosphere.render(i / 60, 145, .8);
  const mass = f.field.mass; assert.ok(mass > 0);
  f.atmosphere.setEmission({ ...f.mouth, x: 900, active: false });
  for (let i = 61; i <= 90; i++) f.atmosphere.render(i / 60, 130, .2);
  assert.ok(f.field.mass > 0 && f.field.mass < mass);
  assert.equal(f.calls.cleared, 0);
  const missing = fixture({ available: false }); missing.atmosphere.setEmission(missing.mouth);
  missing.atmosphere.render(0, 145, .8);
  assert.equal(missing.uniforms.mouthMode, 1);
  assert.deepEqual(missing.uploads.at(-1).pixels, [0]);
});

test('context restoration reuploads existing field without resetting physics or adding a large step', () => {
  const f = fixture(); f.atmosphere.setEmission(f.mouth);
  for (let i = 0; i <= 60; i++) f.atmosphere.render(i / 60, 130, .5);
  const pixels = Array.from(f.field.pixels), steps = f.calls.steps.length;
  let prevented = false;
  f.listeners.webglcontextlost({ preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.equal(f.canvas.hidden, true);
  f.listeners.webglcontextrestored(); f.atmosphere.render(300, 130, .5);
  assert.equal(f.canvas.hidden, false); assert.equal(f.calls.created, 1);
  assert.equal(f.calls.cleared, 0); assert.equal(f.calls.steps.length, steps);
  assert.deepEqual(f.uploads.at(-1).pixels, pixels);
  f.atmosphere.render(300.05, 130, .5);
  assert.ok(f.calls.steps.at(-1) <= .051);
});
