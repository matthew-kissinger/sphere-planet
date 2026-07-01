import * as THREE from 'three/webgpu';
import { color, float, positionWorld, positionLocal, cameraPosition, normalWorld, normalize, uniform, attribute, vec3, time, mix, smoothstep as tslSmoothstep } from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Goldberg } from './geo/goldberg';
import { buildLayers, PLANET_RADIUS, WATER_SURFACE } from './world/layers';
import { Terrain } from './world/terrain';
import { Columns } from './world/columns';
import { Streamer } from './world/streamer';
import { chunkKeyOfTile } from './world/chunks';
import { FarSphere } from './render/farsphere';
import { Character } from './render/character';
import { Player } from './player/player';
import { Input } from './player/input';
import { pick, type PickResult } from './edit/pick';
import { Metrics } from './demo/metrics';
import { Autopilot, OrbitDemo } from './demo/autopilot';
import { Hud, splash, hideSplash } from './demo/hud';

const params = new URLSearchParams(location.search);
const SEED = params.get('seed') ?? 'GP192-01';
const M = Number.parseInt(params.get('m') ?? '192', 10);
const COARSE_M = 96;

const DIST_MIN = 2.4;
const DIST_MAX = 4200;
const GLIDE_CAM_EXP = Math.log(9 / DIST_MIN) / Math.log(DIST_MAX / DIST_MIN);
const SUN = new THREE.Vector3(0.62, 0.55, 0.56).normalize();

// boot-time yield: setTimeout, not rAF — rAF never fires in a backgrounded tab and
// would stall boot; timers keep it moving and the splash repaints whenever visible
function raf(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;

  splash('goldberg topology…', 0.02);
  await raf(); await raf();
  const geo = new Goldberg(M);
  splash(`${geo.count.toLocaleString()} tiles · ${geo.buildMs.toFixed(0)} ms`, 0.14);
  await raf();

  const layers = buildLayers();
  const terrain = new Terrain(SEED);
  const columns = new Columns(geo, layers, terrain);

  // --- renderer: WebGPU first, WebGL fallback ---
  splash('starting renderer…', 0.18);
  await raf();
  let renderer: THREE.WebGPURenderer;
  const forceGL = params.get('gpu') === 'gl'; // test hook for the fallback path
  try {
    renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: forceGL });
    await renderer.init();
  } catch (err) {
    console.warn('WebGPU init failed; falling back to WebGL2', err);
    renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
    await renderer.init();
  }
  const isWebGPU = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060c);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 14000);

  // --- lights ---
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x8fb4dd, 0x2c2418, 0.5);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x404a58, 0.35));

  // --- materials ---
  const chunkMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const farMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 });

  // --- streaming ---
  const streamer = new Streamer(geo, layers, columns, scene, chunkMaterial);

  // --- far sphere (sliced build behind the splash) ---
  const coarse = new Goldberg(COARSE_M);
  const farSphere = await FarSphere.build(coarse, geo, terrain, farMaterial, async (frac) => {
    splash(`far side + horizon… ${Math.round(frac * 100)}%`, 0.2 + frac * 0.3);
    await raf();
  });
  scene.add(farSphere.mesh);

  // --- ocean ---
  splash('filling the oceans…', 0.52);
  await raf();
  const water = (() => {
    // indexed sphere so per-vertex shore sampling is cheap (~41k verts, not 245k)
    const geom = mergeVertices(new THREE.IcosahedronGeometry(WATER_SURFACE, 6));
    const posAttr = geom.getAttribute('position');
    const shore = new Float32Array(posAttr.count);
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      const l = Math.hypot(x, y, z);
      const h = terrain.heightAt(x / l, y / l, z / l);
      // 1 at the waterline, 0 by 22 m of depth (or over land, where terrain covers it anyway)
      shore[i] = Math.max(0, Math.min(1, 1 + h / 22));
    }
    geom.setAttribute('shore', new THREE.BufferAttribute(shore, 1));

    const mat = new THREE.MeshStandardNodeMaterial();
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(1.0).sub(normalWorld.dot(viewDir).abs()).max(0.0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shoreAttr = float(attribute('shore', 'float') as any);

    // slow crossing swells: +-18 cm of radial breathing, wavelengths ~40 m
    const p = positionLocal;
    const wave = p.dot(vec3(0.131, 0.112, 0.123)).add(time.mul(0.6)).sin()
      .add(p.dot(vec3(-0.104, 0.141, -0.092)).add(time.mul(0.97)).sin())
      .mul(0.09);
    mat.positionNode = p.add(p.normalize().mul(wave));

    const deep = color(0x0a2e52);
    const shallow = color(0x1d7a96);
    const foam = tslSmoothstep(float(0.86), float(0.99), shoreAttr.add(wave.mul(0.25)));
    mat.colorNode = mix(deep, shallow, shoreAttr.pow(1.7)).add(color(0xcfe8ee).mul(foam).mul(0.5));
    mat.opacityNode = float(0.82).add(fresnel.pow(2.0).mul(0.14)).sub(shoreAttr.pow(2.0).mul(0.28)).add(foam.mul(0.3)).min(0.96);
    mat.roughnessNode = float(0.14).add(foam.mul(0.4));
    mat.metalnessNode = float(0.02);
    mat.transparent = true;
    mat.depthWrite = false;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    scene.add(mesh);
    return mesh;
  })();

  // --- stars ---
  {
    const starCount = 2600;
    const pos = new Float32Array(starCount * 3);
    let sr = 1;
    const rand = (): number => {
      sr = (sr * 1103515245 + 12345) & 0x7fffffff;
      return sr / 0x7fffffff;
    };
    for (let i = 0; i < starCount; i++) {
      const z = rand() * 2 - 1;
      const ph = rand() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      pos[i * 3] = rr * Math.cos(ph) * 11000;
      pos[i * 3 + 1] = rr * Math.sin(ph) * 11000;
      pos[i * 3 + 2] = z * 11000;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xbfcbe0, size: 1.6, sizeAttenuation: false });
    const stars = new THREE.Points(g, mat);
    stars.frustumCulled = false;
    scene.add(stars);
  }

  // --- atmosphere shell (TSL fresnel, additive) ---
  const atmo = (() => {
    const geom = new THREE.IcosahedronGeometry(PLANET_RADIUS * 1.05, 6);
    const mat = new THREE.MeshBasicNodeMaterial();
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(1.0).sub(normalWorld.dot(viewDir).abs()).max(0.0).pow(2.6);
    const sunFacing = normalWorld.dot(uniform(SUN)).mul(0.5).add(0.5);
    mat.colorNode = color(0x4d9ae6);
    mat.opacityNode = fresnel.mul(sunFacing.mul(0.6).add(0.25)).mul(0.85);
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.BackSide;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
    return mesh;
  })();

  // --- player + input + demos ---
  const player = new Player(geo, layers, columns);
  // spawn on land near pentagon 0 (BFS outward until comfortable grass altitude)
  const spawnTile = (() => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const t = queue.shift()!;
      const h = columns.heightOf(t);
      if (h > 4 && h < 30) return t;
      const deg = geo.degreeOf(t);
      for (let k = 0; k < deg; k++) {
        const n = geo.neighbor(t, k);
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
      if (seen.size > 30000) break;
    }
    return 0;
  })();
  player.spawnAt(spawnTile);
  const input = new Input(renderer.domElement);
  const hud = new Hud();
  const metrics = new Metrics(() => {
    const s = streamer.stats();
    return { loads: streamer.loads, releases: streamer.releases, buildSamples: streamer.buildSamples, resident: s.resident, triangles: s.triangles };
  });
  const autopilot = new Autopilot(geo, layers, columns, metrics, (msg) => hud.flash(msg, 10));
  const orbitDemo = new OrbitDemo(metrics, (msg) => hud.flash(msg, 10));
  const character = new Character(scene);

  // --- highlight (Line with an explicit closing vertex; LineLoop is unsupported on WebGPURenderer) ---
  const highlightGeom = new THREE.BufferGeometry();
  const highlightPos = new THREE.BufferAttribute(new Float32Array(8 * 3), 3);
  highlightGeom.setAttribute('position', highlightPos);
  const highlight = new THREE.Line(
    highlightGeom,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: true }),
  );
  highlight.visible = false;
  highlight.frustumCulled = false;
  scene.add(highlight);

  // --- initial ring ---
  {
    const [ux, uy, uz] = player.up();
    streamer.refreshDesired(ux, uy, uz, 2);
    let total = Math.max(1, streamer.stats().queued);
    while (streamer.stats().queued > 0) {
      streamer.pump(24, 64);
      splash(`growing terrain around spawn… ${total - streamer.stats().queued}/${total}`, 0.55 + 0.4 * (1 - streamer.stats().queued / total));
      await raf();
    }
  }
  farSphere.setResidentChunks(streamer.residentKeys());
  streamer.residencyDirty = false;

  hideSplash();
  hud.flash(`${isWebGPU ? 'WebGPU' : 'WebGL2 fallback'} · seed ${SEED} · GP(${M},0) · ${geo.count.toLocaleString()} tiles`, 8);

  // --- camera state ---
  let zoomExp = 0;
  let zoomExpTarget = 0;
  let zoomHold = false;       // scripted zoom: ignore wheel until released
  let glideAutoZoom = false;  // pulled back automatically for the glider
  let camDist = 0;
  const camWorld = { x: 0, y: 0, z: 0 };

  // --- edit state ---
  let lastPick: PickResult | null = null;
  let mineTimer = 0;
  let placeTimer = 0;
  let edits = 0;
  let lastEditMs = 0;

  const rebuildAround = (tileId: number): void => {
    const t0 = performance.now();
    const keys = new Set<number>([chunkKeyOfTile(geo, tileId)]);
    const deg = geo.degreeOf(tileId);
    for (let k = 0; k < deg; k++) keys.add(chunkKeyOfTile(geo, geo.neighbor(tileId, k)));
    for (const key of keys) {
      if (streamer.resident.has(key)) streamer.rebuildNow(key);
    }
    lastEditMs = performance.now() - t0;
  };

  const playerReach = (): number => (player.mode === 'fly' ? 60 : 9.5);

  const tryMine = (): void => {
    if (!lastPick) return;
    if (columns.mine(lastPick.hitTile, lastPick.hitLayer)) {
      edits++;
      rebuildAround(lastPick.hitTile);
    }
  };

  const tryPlace = (): void => {
    if (!lastPick || lastPick.prevTile < 0 || lastPick.prevLayer < 0) return;
    if (lastPick.prevTile === player.tile) {
      const feetK = layers.layerOfRadius(player.radius() + 0.05);
      const headK = Math.max(0, layers.layerOfRadius(player.radius() + 1.75));
      if (lastPick.prevLayer >= headK && lastPick.prevLayer <= feetK) return;
    }
    if (columns.place(lastPick.prevTile, lastPick.prevLayer)) {
      edits++;
      rebuildAround(lastPick.prevTile);
    }
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let fWas = false, gWas = false, oWas = false;

  // --- debug/eval hooks ---
  const setZoom = (e: number | null): void => {
    if (e === null) { zoomHold = false; return; }
    zoomExpTarget = Math.max(0, Math.min(1, e));
    zoomHold = true;
  };

  (window as any).__world = {
    geo, layers, columns, streamer, player, metrics, terrain,
    stats: () => ({
      backend: isWebGPU ? 'webgpu' : 'webgl2',
      topoMs: geo.buildMs,
      farMs: farSphere.buildMs,
      ...streamer.stats(),
      generated: columns.generatedCount,
      edits,
      zoom: camDist,
      agl: player.altitudeAGL(),
      gliding: player.gliding,
      spawnTile,
    }),
    startTraversal: () => autopilot.toggle(player),
    startOrbit: () => orbitDemo.start(),
    setZoom,
    look: (yawRad: number, pitchRad: number) => { player.applyLook(yawRad / 0.0023, pitchRad / 0.0023); },
    setFly: (on: boolean) => { player.mode = on ? 'fly' : 'walk'; },

    /** scripted edit benchmark: dig a crater around the player and raise a small tower */
    editTest: () => {
      const times: number[] = [];
      const doEdit = (fn: () => boolean, tile: number): void => {
        const t0 = performance.now();
        if (fn()) { rebuildAround(tile); times.push(performance.now() - t0); edits++; }
      };
      const ring0 = [player.tile];
      const ring1: number[] = [];
      const ring2: number[] = [];
      const deg0 = geo.degreeOf(player.tile);
      for (let k = 0; k < deg0; k++) ring1.push(geo.neighbor(player.tile, k));
      for (const t of ring1) {
        const d = geo.degreeOf(t);
        for (let k = 0; k < d; k++) {
          const n = geo.neighbor(t, k);
          if (n !== player.tile && !ring1.includes(n) && !ring2.includes(n)) ring2.push(n);
        }
      }
      for (const t of [...ring0, ...ring1, ...ring2]) {
        const top = columns.groundLayerBelow(t, layers.bounds[0]);
        doEdit(() => columns.mine(t, top), t);
        if (ring0.includes(t) || ring1.includes(t)) doEdit(() => columns.mine(t, top + 1), t);
      }
      const towerTile = ring2[0];
      const towerTop = columns.groundLayerBelow(towerTile, layers.bounds[0]);
      for (let i = 1; i <= 6; i++) doEdit(() => columns.place(towerTile, towerTop - i), towerTile);
      const sorted = [...times].sort((a, b) => a - b);
      return {
        edits: times.length,
        avgMs: times.reduce((a, b) => a + b, 0) / times.length,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted[sorted.length - 1],
      };
    },

    /**
     * Edit persistence proof: edit, release EVERY chunk mesh on the planet, regenerate,
     * and compare the regenerated mesh bytes against the pre-release mesh.
     */
    persistTest: async () => {
      const T = player.tile;
      const top = columns.groundLayerBelow(T, layers.bounds[0]);
      columns.mine(T, top);
      columns.mine(T, top + 1);
      const nb = geo.neighbor(T, 0);
      const nbTop = columns.groundLayerBelow(nb, layers.bounds[0]);
      columns.place(nb, nbTop - 1);
      edits += 3;
      rebuildAround(T);
      rebuildAround(nb);
      const key = chunkKeyOfTile(geo, T);
      const hash = (fa: Float32Array | undefined): number => {
        if (!fa) return 0;
        let h = 2166136261 >>> 0;
        for (let i = 0; i < fa.length; i += 3) {
          h ^= (fa[i] * 8192) | 0;
          h = Math.imul(h, 16777619);
        }
        return h >>> 0;
      };
      const meshBytes = (k: number) =>
        streamer.resident.get(k)?.mesh?.geometry.getAttribute('position')?.array as Float32Array | undefined;
      const beforeHash = hash(meshBytes(key));
      const maskBefore = Uint32Array.from(columns.editOf(T)!.solid);
      // depart: drop every mesh on the planet
      streamer.releaseAll();
      const editsSurviveRelease = !!columns.editOf(T);
      // return: regenerate the ring
      const [ux, uy, uz] = player.up();
      streamer.refreshDesired(ux, uy, uz, player.altitudeAGL());
      while (streamer.stats().queued > 0) {
        streamer.pump(50, 400);
        await new Promise((r) => setTimeout(r, 0));
      }
      const afterHash = hash(meshBytes(key));
      const maskAfter = Uint32Array.from(columns.editOf(T)!.solid);
      return {
        editsSurviveRelease,
        maskIdentical: maskBefore.length === maskAfter.length && maskBefore.every((v, i) => v === maskAfter[i]),
        meshByteIdentical: beforeHash !== 0 && beforeHash === afterHash,
        minedCellStillGone: !columns.solidAt(T, top),
        placedCellStillThere: columns.solidAt(nb, nbTop - 1),
      };
    },

    /** teleport to a steep peak and glide toward the steepest descent, capturing frame metrics */
    gliderTest: async () => {
      // prefer a tall-but-unclamped peak so slopes actually fall away from the summit
      let bestId = 0, bestScore = -1e9;
      const c = geo.centers;
      const hOf = (id: number): number => terrain.heightAt(c[id * 3], c[id * 3 + 1], c[id * 3 + 2]);
      for (let id = 0; id < geo.count; id += 41) {
        const h = hOf(id);
        if (h < 60 || h > 112) continue;
        // score by local drop over the 1-ring: tall AND steep
        let minN = h;
        const deg = geo.degreeOf(id);
        for (let k = 0; k < deg; k++) minN = Math.min(minN, hOf(geo.neighbor(id, k)));
        const score = h + (h - minN) * 12;
        if (score > bestScore) { bestScore = score; bestId = id; }
      }
      const bestH = hOf(bestId);
      player.mode = 'walk';
      player.spawnAt(bestId);
      // face the steepest downhill in the 2-ring
      let lowId = bestId, lowH = bestH;
      const deg0 = geo.degreeOf(bestId);
      for (let k = 0; k < deg0; k++) {
        const n = geo.neighbor(bestId, k);
        const dn = geo.degreeOf(n);
        for (let q = 0; q < dn; q++) {
          const nn = geo.neighbor(n, q);
          const h = hOf(nn);
          if (h < lowH) { lowH = h; lowId = nn; }
        }
      }
      {
        const dx = c[lowId * 3] - c[bestId * 3], dy = c[lowId * 3 + 1] - c[bestId * 3 + 1], dz = c[lowId * 3 + 2] - c[bestId * 3 + 2];
        const [ux0, uy0, uz0] = player.up();
        const d = dx * ux0 + dy * uy0 + dz * uz0;
        let fx = dx - d * ux0, fy = dy - d * uy0, fz = dz - d * uz0;
        const fl = Math.hypot(fx, fy, fz) || 1;
        player.fwdX = fx / fl; player.fwdY = fy / fl; player.fwdZ = fz / fl;
      }
      player.pitch = -0.12;
      player.vx = 0; player.vy = 0; player.vz = 0;
      setZoom(GLIDE_CAM_EXP * 1.35);
      await new Promise((r) => setTimeout(r, 1500)); // let chunks stream in under the peak
      const start = [player.px, player.py, player.pz];
      // running jump off the edge, then hold the wing open
      const [ux, uy, uz] = player.up();
      player.vx = ux * 7.4 + player.fwdX * 11;
      player.vy = uy * 7.4 + player.fwdY * 11;
      player.vz = uz * 7.4 + player.fwdZ * 11;
      player.grounded = false;
      player.forceGlide = true;
      metrics.begin('glide');
      const t0 = performance.now();
      let minAGL = Infinity, maxSpeed = 0;
      while (performance.now() - t0 < 25000) {
        await new Promise((r) => setTimeout(r, 250));
        minAGL = Math.min(minAGL, player.altitudeAGL());
        maxSpeed = Math.max(maxSpeed, Math.hypot(player.vx, player.vy, player.vz));
        if (player.grounded || player.submerged > 0) break;
      }
      player.forceGlide = false;
      const rep = metrics.end();
      const r1 = Math.hypot(...start), r2 = player.radius();
      const dot = (start[0] * player.px + start[1] * player.py + start[2] * player.pz) / (r1 * r2);
      const distance = Math.acos(Math.min(1, Math.max(-1, dot))) * (r1 + r2) / 2;
      setZoom(null);
      return {
        peakHeight: bestH,
        glideDistanceM: Math.round(distance),
        endedBy: player.grounded ? 'landed' : player.submerged > 0 ? 'water' : 'timer',
        minAGL: Math.round(minAGL * 10) / 10,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        capture: rep,
      };
    },
  };

  let last = performance.now();
  let frameIdx = 0;
  let hudTimer = 0;
  let streamTimer = 0;
  let lastFarRefresh = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const dt = Math.min(0.05, dtMs / 1000);
    frameIdx++;

    const drained = input.drain();

    // key edges
    const fDown = input.down('KeyF'), gDown = input.down('KeyG'), oDown = input.down('KeyO');
    if (fDown && !fWas && !autopilot.active) player.toggleFly();
    if (gDown && !gWas) { autopilot.toggle(player); hud.flash(autopilot.active ? 'autopilot: circumnavigating…' : 'autopilot off', 4); }
    if (oDown && !oWas) { orbitDemo.start(); hud.flash('orbit pull-back demo…', 4); }
    fWas = fDown; gWas = gDown; oWas = oDown;

    // look + move
    if (input.active() && !autopilot.active) player.applyLook(drained.dx, drained.dy);
    if (autopilot.active) {
      autopilot.update(dt, player);
    } else {
      const fwd = (input.down('KeyW') ? 1 : 0) + (input.down('KeyS') ? -1 : 0);
      const strafe = (input.down('KeyD') ? 1 : 0) + (input.down('KeyA') ? -1 : 0);
      const upDown = (input.down('Space') ? 1 : 0) + (input.down('ControlLeft') || input.down('KeyC') ? -1 : 0);
      player.update(dt, {
        forward: fwd, strafe,
        upDown: player.mode === 'fly' ? upDown : 0,
        sprint: input.down('ShiftLeft'),
        jump: input.down('Space'),
        glideHeld: input.down('Space'),
      });
    }

    // user wheel always takes priority over scripted/auto zoom
    if (drained.wheelTouched) { zoomHold = false; glideAutoZoom = false; }

    // glider auto camera: ease out to third person when the wing opens, back on landing
    if (!zoomHold) {
      if (player.gliding && camDist < 5 && !glideAutoZoom) {
        glideAutoZoom = true;
        zoomExpTarget = GLIDE_CAM_EXP;
      }
      if (glideAutoZoom && !player.gliding && player.grounded) {
        glideAutoZoom = false;
        zoomExpTarget = 0;
      }
    }

    // zoom
    const orbitOverride = orbitDemo.update(dt);
    if (orbitOverride !== null) {
      zoomExpTarget = orbitOverride;
      zoomExp = orbitOverride;
    } else {
      zoomExpTarget = Math.max(0, Math.min(1, zoomExpTarget + drained.wheel * 0.00045));
      zoomExp += (zoomExpTarget - zoomExp) * Math.min(1, dt * 7);
    }
    camDist = zoomExp < 0.012 ? 0 : DIST_MIN * Math.pow(DIST_MAX / DIST_MIN, zoomExp);

    // --- camera (all f64 until the very end) ---
    const [ux, uy, uz] = player.up();
    const eye = player.eye();
    const cosP = Math.cos(player.pitch), sinP = Math.sin(player.pitch);
    const vfx = player.fwdX * cosP + ux * sinP;
    const vfy = player.fwdY * cosP + uy * sinP;
    const vfz = player.fwdZ * cosP + uz * sinP;
    let cwx: number, cwy: number, cwz: number;
    let tx: number, ty: number, tz: number;
    if (camDist === 0) {
      cwx = eye[0]; cwy = eye[1]; cwz = eye[2];
      tx = eye[0] + vfx; ty = eye[1] + vfy; tz = eye[2] + vfz;
    } else {
      // pull-back direction turns radial with distance, so at orbit you sit directly
      // above your own location and it faces the camera (instead of sliding to the rim)
      const blend = smoothstep(140, 2600, camDist);
      const bb = blend * 0.95;
      let ox = -vfx * (1 - bb) + ux * (0.12 * (1 - bb) + bb);
      let oy = -vfy * (1 - bb) + uy * (0.12 * (1 - bb) + bb);
      let oz = -vfz * (1 - bb) + uz * (0.12 * (1 - bb) + bb);
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol; oy /= ol; oz /= ol;
      cwx = eye[0] + ox * camDist;
      cwy = eye[1] + oy * camDist;
      cwz = eye[2] + oz * camDist;
      const cr = Math.hypot(cwx, cwy, cwz);
      const camTile = geo.tileOf(cwx, cwy, cwz);
      const camGround = layers.topRadius(columns.groundLayerBelow(camTile, cr));
      const minR = camGround + 1.2;
      if (cr < minR) {
        const s = minR / cr;
        cwx *= s; cwy *= s; cwz *= s;
      }
      tx = eye[0] * (1 - blend); ty = eye[1] * (1 - blend); tz = eye[2] * (1 - blend);
    }
    camWorld.x = cwx; camWorld.y = cwy; camWorld.z = cwz;
    camera.position.set(0, 0, 0);
    {
      // as the view goes overhead the radial up degenerates against the view axis;
      // roll screen-up toward the player's heading so "up" is where you're facing
      const blend = camDist === 0 ? 0 : smoothstep(140, 2600, camDist) * 0.95;
      let cux = ux * (1 - blend) + player.fwdX * blend;
      let cuy = uy * (1 - blend) + player.fwdY * blend;
      let cuz = uz * (1 - blend) + player.fwdZ * blend;
      const cul = Math.hypot(cux, cuy, cuz) || 1;
      camera.up.set(cux / cul, cuy / cul, cuz / cul);
    }
    camera.lookAt(tx - cwx, ty - cwy, tz - cwz);
    const wantNear = Math.min(60, Math.max(0.09, camDist * 0.02));
    if (Math.abs(wantNear - camera.near) / camera.near > 0.05) {
      camera.near = wantNear;
      camera.updateProjectionMatrix();
    }

    // --- streaming ---
    streamTimer -= dt;
    if (streamTimer <= 0) {
      streamTimer = 0.18;
      const agl = player.altitudeAGL();
      streamer.refreshDesired(ux, uy, uz, agl);
    }
    const builtThisFrame = streamer.pump();
    // far-sphere refilter is a 184k-tri scan + index re-upload: keep it off build frames
    // and cap it at 4 Hz — a briefly unfiltered far tri sits 6 m under a loaded chunk, invisible
    if (streamer.residencyDirty && builtThisFrame === 0 && now - lastFarRefresh > 250) {
      farSphere.setResidentChunks(streamer.residentKeys());
      streamer.residencyDirty = false;
      lastFarRefresh = now;
    }

    // --- camera-relative transforms (floating origin: camera stays at 0,0,0) ---
    streamer.updateTransforms(camWorld.x, camWorld.y, camWorld.z);
    farSphere.mesh.position.set(-camWorld.x, -camWorld.y, -camWorld.z);
    water.position.set(-camWorld.x, -camWorld.y, -camWorld.z);
    atmo.position.set(-camWorld.x, -camWorld.y, -camWorld.z);
    sun.position.set(SUN.x * 11000 - camWorld.x, SUN.y * 11000 - camWorld.y, SUN.z * 11000 - camWorld.z);
    sunTarget.position.set(-camWorld.x, -camWorld.y, -camWorld.z);
    character.update(player, camWorld, camDist);

    // --- picking + edits ---
    if (input.active() && camDist < 120 && frameIdx % 2 === 0) {
      const dirx = tx - cwx, diry = ty - cwy, dirz = tz - cwz;
      const dl = Math.hypot(dirx, diry, dirz) || 1;
      const reach = playerReach();
      const p = pick(geo, layers, columns, camWorld.x, camWorld.y, camWorld.z, dirx / dl, diry / dl, dirz / dl, reach + camDist);
      if (p) {
        const hitR = layers.topRadius(p.hitLayer);
        const c = geo.centers;
        const hx = c[p.hitTile * 3] * hitR - player.px;
        const hy = c[p.hitTile * 3 + 1] * hitR - player.py;
        const hz = c[p.hitTile * 3 + 2] * hitR - player.pz;
        lastPick = Math.hypot(hx, hy, hz) > reach ? null : p;
      } else {
        lastPick = null;
      }
    }
    if (!input.active() || camDist >= 120) lastPick = null;

    if (lastPick) {
      highlight.visible = true;
      const deg = geo.degreeOf(lastPick.hitTile);
      const r = layers.topRadius(lastPick.hitLayer) + 0.03;
      const corner = new Float64Array(3);
      for (let k = 0; k < deg; k++) {
        geo.cornerUnit(lastPick.hitTile, k, corner);
        highlightPos.setXYZ(k, corner[0] * r - camWorld.x, corner[1] * r - camWorld.y, corner[2] * r - camWorld.z);
      }
      for (let k = deg; k < 7; k++) {
        highlightPos.setXYZ(k, highlightPos.getX(deg - 1), highlightPos.getY(deg - 1), highlightPos.getZ(deg - 1));
      }
      // close the loop
      highlightPos.setXYZ(deg, highlightPos.getX(0), highlightPos.getY(0), highlightPos.getZ(0));
      highlightPos.needsUpdate = true;
      highlightGeom.setDrawRange(0, deg + 1);
    } else {
      highlight.visible = false;
    }

    mineTimer -= dt; placeTimer -= dt;
    if ((drained.mine || (input.mineHeld && mineTimer <= 0)) && lastPick) { tryMine(); mineTimer = 0.17; }
    if ((drained.place || (input.placeHeld && placeTimer <= 0)) && lastPick) { tryPlace(); placeTimer = 0.17; }

    // --- hud + metrics ---
    metrics.frame(dtMs);
    hud.tick(dt);
    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.25;
      const s = streamer.stats();
      const agl = player.altitudeAGL();
      const speed = Math.hypot(player.vx, player.vy, player.vz);
      const modeLabel = autopilot.active ? 'autopilot'
        : player.gliding ? 'GLIDING'
        : player.submerged > 0.4 ? 'swimming'
        : player.mode;
      hud.setStats([
        `${isWebGPU ? 'WebGPU' : 'WebGL2'}  ${metrics.fpsEma.toFixed(0)} fps  ${metrics.frameMsEma.toFixed(1)} ms`,
        `mode ${modeLabel}${player.grounded ? ' (grounded)' : ''}  speed ${speed.toFixed(1)} m/s`,
        `alt ${agl.toFixed(1)} m AGL  h ${(player.radius() - PLANET_RADIUS).toFixed(1)} m  zoom ${camDist.toFixed(0)} m`,
        `tile ${player.tile}${geo.degreeOf(player.tile) === 5 ? ' *pentagon*' : ''}  seed ${SEED}`,
        `chunks ${s.resident} resident / ${s.queued} queued  ${(s.triangles / 1000).toFixed(0)}k tris`,
        `columns ${columns.generatedCount.toLocaleString()} / ${geo.count.toLocaleString()} generated  edits ${edits}`,
        lastEditMs > 0 ? `last edit rebuild ${lastEditMs.toFixed(1)} ms` : '',
        input.lockUnavailable && !input.locked ? 'pointer lock unavailable here: DRAG to look' : '',
        metrics.active() ? `● capturing: ${metrics.active()}` : '',
      ].filter((l) => l !== ''));
    }

    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  console.error(err);
  splash(`boot failed: ${err}`, 0);
});
