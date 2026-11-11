/* A small stable-fluid solver for the mouth-emitted smoke. Velocities are in
   CSS pixels/second; the renderer receives a top-to-bottom density texture.
   No animation loop, light input, images, or DOM access lives in this module. */
(() => {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const MAX_DENSITY = 4.5;
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

  function create() {
    let viewWidth = 1, viewHeight = 1, nx = 0, ny = 0, pitch = 0, dx = 1, dy = 1;
    let u, v, nextU, nextV, density, nextDensity, pressure, nextPressure, divergence, curl;
    let roomSinX, roomCosX, roomSinY, roomCosY;
    let emission = { active: false }, elapsed = 0;
    const field = { width: 0, height: 0, pixels: new Uint8Array(0), mass: 0, peak: 0 };

    function sample(values, x, y, columns = nx, rows = ny, stride = pitch) {
      x = clamp(x, .5, columns + .5); y = clamp(y, .5, rows + .5);
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const at = y0 * stride + x0;
      return (values[at] * (1 - fx) + values[at + 1] * fx) * (1 - fy) +
        (values[at + stride] * (1 - fx) + values[at + stride + 1] * fx) * fy;
    }

    function boundary(values, type) {
      for (let y = 1; y <= ny; y++) {
        const at = y * pitch;
        values[at] = type === 0 ? 0 : (type === 1 ? -values[at + 1] : values[at + 1]);
        values[at + nx + 1] = type === 0 ? 0 : (type === 1 ? -values[at + nx] : values[at + nx]);
      }
      for (let x = 1; x <= nx; x++) {
        values[x] = type === 0 ? 0 : (type === 2 ? -values[pitch + x] : values[pitch + x]);
        values[(ny + 1) * pitch + x] = type === 0 ? 0 :
          (type === 2 ? -values[ny * pitch + x] : values[ny * pitch + x]);
      }
      values[0] = values[nx + 1] = values[(ny + 1) * pitch] = values[(ny + 2) * pitch - 1] = 0;
    }

    function pack() {
      let sum = 0, maximum = 0, atPixel = 0;
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const value = clamp(density[y * pitch + x], 0, MAX_DENSITY);
          sum += value; maximum = Math.max(maximum, value);
          // Smooth optical saturation preserves thin edges while bounding a
          // sustained source. The physical concentration itself is not u8.
          field.pixels[atPixel++] = Math.round((1 - Math.exp(-value * .65)) * 255);
        }
      }
      field.mass = sum * dx * dy;
      field.peak = maximum;
    }

    function resize(width, height) {
      width = Math.max(1, finite(width, 1)); height = Math.max(1, finite(height, 1));
      if (width === viewWidth && height === viewHeight && nx) return;
      const oldNx = nx, oldNy = ny, oldPitch = pitch, oldU = u, oldV = v, oldDensity = density;
      const oldWidth = viewWidth, oldHeight = viewHeight;
      viewWidth = width; viewHeight = height;
      const compact = width < 700;
      const longest = compact ? 104 : 128;
      const aspect = width / height;
      nx = Math.max(compact ? 40 : 48, Math.round(aspect >= 1 ? longest : longest * aspect));
      ny = Math.max(compact ? 40 : 48, Math.round(aspect >= 1 ? longest / aspect : longest));
      // Very square viewports need less than 128^2 work, and narrow phones keep
      // enough columns for a soft jet rather than a one-cell line.
      const maxCells = compact ? 6500 : 10000;
      if (nx * ny > maxCells) {
        const scale = Math.sqrt(maxCells / (nx * ny));
        nx = Math.floor(nx * scale); ny = Math.floor(ny * scale);
      }
      pitch = nx + 2; dx = width / nx; dy = height / ny;
      const count = pitch * (ny + 2);
      [u, v, nextU, nextV, density, nextDensity, pressure, nextPressure, divergence, curl] =
        Array.from({ length: 10 }, () => new Float32Array(count));
      // The room circulation is stationary in CSS coordinates. Cache its
      // separated row/column terms once, keeping trigonometry out of the
      // per-cell simulation loop and independent of grid resolution.
      roomSinX = new Float32Array(nx + 2); roomCosX = new Float32Array(nx + 2);
      roomSinY = new Float32Array(ny + 2); roomCosY = new Float32Array(ny + 2);
      for (let x = 1; x <= nx; x++) {
        const phase = (x - .5) * dx / 270 * Math.PI;
        roomSinX[x] = Math.sin(phase); roomCosX[x] = Math.cos(phase);
      }
      for (let y = 1; y <= ny; y++) {
        const phase = (y - .5) * dy / 360 * Math.PI;
        roomSinY[y] = Math.sin(phase); roomCosY[y] = Math.cos(phase);
      }
      field.width = nx; field.height = ny; field.pixels = new Uint8Array(nx * ny);
      if (oldNx) {
        for (let y = 1; y <= ny; y++) {
          for (let x = 1; x <= nx; x++) {
            const ox = (x - .5) / nx * oldNx + .5;
            const oy = (y - .5) / ny * oldNy + .5;
            const at = y * pitch + x;
            density[at] = sample(oldDensity, ox, oy, oldNx, oldNy, oldPitch);
            u[at] = sample(oldU, ox, oy, oldNx, oldNy, oldPitch) * width / oldWidth;
            v[at] = sample(oldV, ox, oy, oldNx, oldNy, oldPitch) * height / oldHeight;
          }
        }
      }
      boundary(u, 1); boundary(v, 2); boundary(density, 0); pack();
    }

    function setEmission(next = {}) {
      emission = { x: finite(next.x, 0), y: finite(next.y, 0),
        openness: clamp(finite(next.openness, 0), 0, 1), breath: clamp(finite(next.breath, 0), 0, 1),
        scale: clamp(finite(next.scale, 1), .25, 3),
        active: !!next.active && Number.isFinite(next.x) && Number.isFinite(next.y) };
    }

    function inject(dt) {
      if (!emission.active || emission.openness <= .16 || emission.breath <= .1) return;
      const strength = emission.breath * clamp((emission.openness - .12) / .6, 0, 1);
      const centerX = emission.x / dx + .5, centerY = emission.y / dy + .5;
      const radiusX = Math.max(1.2, 34 * emission.scale / dx);
      const radiusY = Math.max(1.15, 23 * emission.scale / dy);
      const left = Math.max(1, Math.floor(centerX - radiusX * 2.5));
      const right = Math.min(nx, Math.ceil(centerX + radiusX * 2.5));
      const top = Math.max(1, Math.floor(centerY - radiusY * 2.5));
      const bottom = Math.min(ny, Math.ceil(centerY + radiusY * 2.5));
      const exhale = -.1 + Math.sin(elapsed * 3.2) * .12;
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const rx = (x - centerX) / radiusX, ry = (y - centerY) / radiusY;
          const weight = Math.exp(-.5 * (rx * rx + ry * ry));
          const at = y * pitch + x;
          density[at] = Math.min(MAX_DENSITY, density[at] + dt * strength * weight * 18.5);
          const blend = 1 - Math.exp(-dt * weight * strength * 9);
          // A sideways exhalation has a slight downward aim; buoyancy later
          // turns the advected cloud upwards, rather than turning its source.
          u[at] += (-205 * emission.scale - u[at]) * blend;
          v[at] += ((15 + exhale * 8) * emission.scale - v[at]) * blend;
        }
      }
    }

    function project() {
      const inverseX = 1 / (2 * dx), inverseY = 1 / (2 * dy);
      const xx = 1 / (dx * dx), yy = 1 / (dy * dy), divisor = 2 * (xx + yy);
      pressure.fill(0); nextPressure.fill(0);
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x;
          divergence[at] = (u[at + 1] - u[at - 1]) * inverseX +
            (v[at + pitch] - v[at - pitch]) * inverseY;
        }
      }
      for (let iteration = 0; iteration < 8; iteration++) {
        for (let y = 1; y <= ny; y++) {
          for (let x = 1; x <= nx; x++) {
            const at = y * pitch + x;
            nextPressure[at] = ((pressure[at - 1] + pressure[at + 1]) * xx +
              (pressure[at - pitch] + pressure[at + pitch]) * yy - divergence[at]) / divisor;
          }
        }
        // Pressure has a zero normal derivative at the page boundary.
        boundary(nextPressure, 3);
        const swap = pressure; pressure = nextPressure; nextPressure = swap;
      }
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x;
          u[at] -= (pressure[at + 1] - pressure[at - 1]) * inverseX;
          v[at] -= (pressure[at + pitch] - pressure[at - pitch]) * inverseY;
        }
      }
      boundary(u, 1); boundary(v, 2);
    }

    function forces(dt) {
      const ix = 1 / (2 * dx), iy = 1 / (2 * dy);
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x;
          curl[at] = (v[at + 1] - v[at - 1]) * ix - (u[at + pitch] - u[at - pitch]) * iy;
        }
      }
      const drag = Math.exp(-dt * .14), diffusion = Math.min(.13, dt * 15 / (dx * dy));
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x;
          const gx = (Math.abs(curl[at + 1]) - Math.abs(curl[at - 1])) * ix;
          const gy = (Math.abs(curl[at + pitch]) - Math.abs(curl[at - pitch])) * iy;
          const length = Math.sqrt(gx * gx + gy * gy) + 1e-5;
          const confinement = 8 * Math.min(dx, dy) * curl[at];
          const wind = -9.5 + Math.sin(y * .11 + elapsed * .19) * 1.7;
          const cross = Math.sin(x * .1 + y * .07 - elapsed * .14) * .7;
          // A broad room circulation has adjacent rising and descending lanes.
          // Its force is the curl of a smooth stream function, so the pressure
          // projection preserves it instead of pushing the entire cloud down.
          // The dense warm core still rises; thin, cooled fringes can fold down
          // in a neighbouring return flow. The field is fixed in room space.
          const returnU = 3.8 * .75 * roomSinX[x] * roomCosY[y];
          const returnV = -3.8 * roomCosX[x] * roomSinY[y];
          const viscousU = (u[at - 1] + u[at + 1] + u[at - pitch] + u[at + pitch]) * .25;
          const viscousV = (v[at - 1] + v[at + 1] + v[at - pitch] + v[at + pitch]) * .25;
          nextU[at] = clamp((u[at] + (viscousU - u[at]) * diffusion) * drag +
            dt * (wind * .2 + returnU + gy / length * confinement), -255, 255);
          nextV[at] = clamp((v[at] + (viscousV - v[at]) * diffusion) * drag +
            dt * (cross * .16 + returnV - Math.min(1.8, density[at]) * 8 - gx / length * confinement), -95, 95);
        }
      }
      const swapU = u, swapV = v; u = nextU; v = nextV; nextU = swapU; nextV = swapV;
      boundary(u, 1); boundary(v, 2);
    }

    function advect(dt) {
      const decay = Math.exp(-dt / 27);
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x;
          // Semi-Lagrangian backtracing remains stable even when a browser
          // frame is delayed. Pressure projection restores incompressibility.
          const fromX = x - dt * u[at] / dx, fromY = y - dt * v[at] / dy;
          nextU[at] = sample(u, fromX, fromY);
          nextV[at] = sample(v, fromX, fromY);
          nextDensity[at] = sample(density, fromX, fromY) * decay;
        }
      }
      let swap = u; u = nextU; nextU = swap;
      swap = v; v = nextV; nextV = swap;
      swap = density; density = nextDensity; nextDensity = swap;
      boundary(u, 1); boundary(v, 2); boundary(density, 0);
      // Small turbulent diffusion broadens the exhaled plume as it ages.
      // The explicit coefficients stay below the 2-D stability limit.
      const spreadX = Math.min(.2, dt * 145 / (dx * dx));
      const spreadY = Math.min(.2, dt * 145 / (dy * dy));
      for (let y = 1; y <= ny; y++) {
        for (let x = 1; x <= nx; x++) {
          const at = y * pitch + x, center = density[at];
          nextDensity[at] = Math.max(0, center + spreadX * (density[at - 1] + density[at + 1] - 2 * center) +
            spreadY * (density[at - pitch] + density[at + pitch] - 2 * center));
        }
      }
      swap = density; density = nextDensity; nextDensity = swap;
      boundary(density, 0);
    }

    function step(seconds) {
      if (!nx) return;
      const duration = clamp(finite(seconds, 0), 0, .2);
      const count = Math.max(1, Math.ceil(duration / .05)), dt = duration / count;
      for (let substep = 0; substep < count; substep++) {
        elapsed += dt;
        inject(dt); forces(dt); project(); advect(dt); project();
      }
      pack();
    }

    function clear() {
      if (!nx) return;
      for (const values of [u, v, nextU, nextV, density, nextDensity, pressure, nextPressure, divergence, curl]) values.fill(0);
      elapsed = 0; field.pixels.fill(0); field.mass = 0; field.peak = 0;
    }

    function transport() {
      // Optional diagnostics are calculated only on request, never by the
      // renderer's normal frame path. Flux measures actual projected motion.
      let rising = 0, sinking = 0, riseFlux = 0, sinkFlux = 0;
      let riseX = 0, riseY = 0, sinkX = 0, sinkY = 0;
      for (let y = 1; y <= ny; y++) for (let x = 1; x <= nx; x++) {
        const at = y * pitch + x, amount = density[at], speed = v[at];
        if (amount <= .02) continue;
        if (speed < -1) {
          rising += amount; riseFlux -= amount * speed;
          riseX += amount * (x - .5) * dx; riseY += amount * (y - .5) * dy;
        }
        if (speed > 1) {
          sinking += amount; sinkFlux += amount * speed;
          sinkX += amount * (x - .5) * dx; sinkY += amount * (y - .5) * dy;
        }
      }
      return { risingMass: rising * dx * dy, sinkingMass: sinking * dx * dy,
        upwardFlux: riseFlux * dx * dy, downwardFlux: sinkFlux * dx * dy,
        risingCenter: { x: rising ? riseX / rising : 0, y: rising ? riseY / rising : 0 },
        sinkingCenter: { x: sinking ? sinkX / sinking : 0, y: sinking ? sinkY / sinking : 0 } };
    }

    return { resize, setEmission, step, clear, transport, get field() { return field; } };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DemeritSmokePhysics = api;
})();
