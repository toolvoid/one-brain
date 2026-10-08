import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek'];
const COLORS = {
  chatgpt: '#42d6c2', claude: '#f29a60', codex: '#70a9ff',
  gemini: '#b18cff', groq: '#f2d66d', deepseek: '#ff7095'
};
const ANCHORS = {
  chatgpt: [12, 0, 0], claude: [0, 12, 0], codex: [0, 0, 12],
  gemini: [-12, 0, 0], groq: [0, -12, 0], deepseek: [0, 0, -12]
};
const HUB = new THREE.Vector3(0, 0, 0);

function hashPosition(id, source) {
  let seed = 2166136261;
  for (const char of String(id)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  for (const char of source) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const random = () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = 2.1 + Math.cbrt(random()) * 3.5;
  const q = Math.sqrt(1 - z * z);
  const anchor = new THREE.Vector3(...(ANCHORS[source] || [0, 0, 0]));
  return anchor.add(new THREE.Vector3(q * Math.cos(a), z, q * Math.sin(a)).multiplyScalar(r));
}

const POINT_VERTEX = `
  attribute vec3 baseColor;
  attribute float baseSize;
  attribute float baseAlpha;
  attribute float nodeScale;
  attribute float nodeGlow;
  attribute float packetAlpha;
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float s = baseSize * max(0.001, nodeScale);
    gl_PointSize = clamp(s * pixelRatio, 1.0, 38.0);
    gl_Position = projectionMatrix * mv;
    vColor = baseColor * (1.0 + nodeGlow);
    vAlpha = max(baseAlpha, packetAlpha);
  }
`;
const POINT_FRAGMENT = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    if (d > 0.5) discard;
    float core = 1.0 - smoothstep(0.08, 0.48, d);
    float halo = exp(-d * 12.0) * 0.45;
    gl_FragColor = vec4(vColor, vAlpha * max(core, halo));
  }
`;
const LINE_VERTEX = `
  attribute vec3 baseColor;
  attribute float baseAlpha;
  attribute float lineGlow;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = baseColor * (1.0 + lineGlow);
    vAlpha = baseAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const LINE_FRAGMENT = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(vColor, vAlpha); }
`;

const BrainGraph = forwardRef(function BrainGraph({ memories = [], links = [], counts = {}, sidebarCollapsed = false, dataReady = false, linksVisible = true, onLinksVisibleChange = () => {} }, ref) {
  const hostRef = useRef(null);
  const apiRef = useRef({ retrieve: () => false });
  useImperativeHandle(ref, () => ({
    retrieve: (id) => apiRef.current.retrieve(id),
    focus: (id) => apiRef.current.focus(id)
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#05070f');
    scene.fog = new THREE.FogExp2('#05070f', 0.004);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 250);
    camera.position.set(32, 24, 42);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'brain-webgl';
    host.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'brain-label-layer';
    host.appendChild(labels.domElement);
    const controls = new OrbitControls(camera, labels.domElement);
    controls.rotateSpeed = -1;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 20;
    controls.maxDistance = 110;
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.3));

    const pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { pixelRatio: { value: renderer.getPixelRatio() } }
    });
    const lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERTEX, fragmentShader: LINE_FRAGMENT, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
    });
    let pointGeometry = new THREE.BufferGeometry();
    let lineGeometry = new THREE.BufferGeometry();
    const points = new THREE.Points(pointGeometry, pointMat);
    const lines = new THREE.LineSegments(lineGeometry, lineMat);
    points.frustumCulled = false;
    lines.frustumCulled = false;
    scene.add(lines, points);

    const labelObjects = {};
    const labelCounts = {};
    for (const key of SOURCES) {
      const card = document.createElement('div');
      card.className = 'brain-label-card';
      card.innerHTML = `<span class="brain-label-dot"></span><strong>${key}</strong><small class="brain-label-count">0 memories</small>`;
      card.querySelector('.brain-label-dot').style.background = COLORS[key];
      const obj = new CSS2DObject(card);
      obj.position.set(...ANCHORS[key]);
      const outward = new THREE.Vector3(...ANCHORS[key]).normalize().multiplyScalar(3.2);
      obj.position.add(outward);
      scene.add(obj);
      labelObjects[key] = card;
      labelCounts[key] = card.querySelector('.brain-label-count');
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'brain-memory-tooltip';
    tooltip.hidden = true;
    host.appendChild(tooltip);

    let nodeMeta = [];
    let edgeMeta = [];
    let memorySlot = new Map();
    let edgeIndex = new Map();
    let packetSlots = new Map();
    let pointAttrs = null;
    let lineAttrs = null;
    let currentMemories = [];
    let currentLinks = [];
    let currentCounts = {};
    let previousMemoryIds = new Set();
    let previousLinkIds = new Set();
    let initialized = false;
    let events = [];
    let edgeDraws = new Map();
    let hubFlash = { color: new THREE.Color('#ffffff'), strength: 0, until: 0 };
    let focusMove = null;

    function fitView(smooth = true) {
      const radius = Math.max(...SOURCES.map((key) => new THREE.Vector3(...ANCHORS[key]).length() + 3.2)) + 1.5;
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.01));
      const limitingHalfFov = Math.max(0.05, Math.min(verticalHalfFov, horizontalHalfFov));
      const distance = Math.min(110, Math.max(20, radius / Math.sin(limitingHalfFov) * 1.12));
      const direction = new THREE.Vector3(32, 24, 42).normalize();
      const cameraTo = HUB.clone().addScaledVector(direction, distance);
      if (!smooth) {
        camera.position.copy(cameraTo);
        controls.target.copy(HUB);
        focusMove = null;
        controls.update();
        return;
      }
      focusMove = {
        cameraFrom: camera.position.clone(), targetFrom: controls.target.clone(),
        cameraTo, targetTo: HUB.clone(), startedAt: performance.now(), duration: 700
      };
    }

    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'brain-fit-button';
    fitButton.textContent = 'Fit';
    fitButton.setAttribute('aria-label', 'Fit all AI anchors and hub in view');
    fitButton.addEventListener('click', () => fitView(true));
    host.appendChild(fitButton);

    const linksToggle = document.createElement('div');
    linksToggle.className = 'brain-links-toggle';
    linksToggle.setAttribute('role', 'group');
    linksToggle.setAttribute('aria-label', 'Memory links visibility');
    linksToggle.innerHTML = '<span>Links:</span><button type="button" data-visible="true">On</button><button type="button" data-visible="false">Off</button>';
    linksToggle.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-visible]');
      if (button) host.__brainSetLinksVisible?.(button.dataset.visible === 'true');
    });
    host.appendChild(linksToggle);

    function makeEdge(key, a, b, color, alpha, glow = 0) {
      edgeMeta.push({ key, a: a.clone(), b: b.clone(), color: new THREE.Color(color), alpha, glow, memoryLink: key.startsWith('link:') });
    }
    function rebuild(nextMemories, nextLinks, nextCounts, animateChanges) {
      const nextMemoryIds = new Set(nextMemories.map((memory) => String(memory.id)));
      const shouldFit = !initialized || nextMemoryIds.size !== previousMemoryIds.size || [...nextMemoryIds].some((id) => !previousMemoryIds.has(id));
      const oldMem = pointGeometry;
      const oldLine = lineGeometry;
      currentMemories = nextMemories;
      currentLinks = nextLinks;
      currentCounts = nextCounts;
      nodeMeta = [];
      edgeMeta = [];
      memorySlot = new Map();
      edgeIndex = new Map();
      packetSlots = new Map();
      for (const key of SOURCES) {
        const n = Number(nextCounts[key]) || 0;
        labelCounts[key].textContent = `${n} ${n === 1 ? 'memory' : 'memories'}`;
        const active = n > 0;
        const c = active ? new THREE.Color(COLORS[key]) : new THREE.Color('#63738a');
        labelObjects[key].querySelector('.brain-label-dot').style.background = active ? COLORS[key] : '#63738a';
        labelObjects[key].querySelector('.brain-label-dot').style.boxShadow = active ? `0 0 9px ${COLORS[key]}` : 'none';
        nodeMeta.push({ kind: 'anchor', key, source: key, position: new THREE.Vector3(...ANCHORS[key]), color: c, size: 13, alpha: active ? 0.95 : 0.22, scale: 1, glow: 0 });
        makeEdge(`anchor:${key}`, HUB, new THREE.Vector3(...ANCHORS[key]), active ? COLORS[key] : '#536176', active ? 0.34 : 0.045);
      }
      const hubIndex = nodeMeta.length;
      nodeMeta.unshift({ kind: 'hub', key: 'hub', source: '', position: HUB.clone(), color: new THREE.Color('#ffffff'), size: 28, alpha: 0.96, scale: 1, glow: 0.6 });
      for (const memory of nextMemories) {
        const source = SOURCES.includes(memory.source) ? memory.source : 'chatgpt';
        const position = hashPosition(memory.id, source);
        const active = (Number(nextCounts[source]) || 0) > 0;
        const index = nodeMeta.length;
        memorySlot.set(String(memory.id), index);
        nodeMeta.push({ kind: 'memory', key: String(memory.id), id: memory.id, source, title: memory.title || memory.content || 'Memory', position, color: new THREE.Color(active ? COLORS[source] : '#728095'), size: 5.2, alpha: 0.88, scale: 1, glow: 0 });
        const edgeKey = `memory:${memory.id}`;
        const newAdd = animateChanges && !previousMemoryIds.has(String(memory.id));
        const anchor = new THREE.Vector3(...ANCHORS[source]);
        const edgeColor = new THREE.Color(COLORS[source]).lerp(new THREE.Color('#ffffff'), 0.42);
        // Draw new memories along their single structural edge from the anchor.
        makeEdge(edgeKey, anchor, newAdd ? anchor : position, edgeColor, 0.1);
        if (newAdd) {
          // Draw the existing structural edge outward so each memory has exactly one
          // anchor connection, including while the add animation is playing.
          edgeDraws.set(edgeKey, { start: anchor, end: position, startedAt: performance.now(), duration: 450 });
        }
        packetSlots.set(String(memory.id), nodeMeta.length);
        const packetBase = nodeMeta.length;
        for (let p = 0; p < 3; p++) nodeMeta.push({ kind: 'packet', key: `${memory.id}:${p}`, id: memory.id, source, position: position.clone(), color: new THREE.Color(COLORS[source]), size: 7, alpha: 0, scale: 1, glow: 0 });
        packetSlots.set(String(memory.id), packetBase);
      }
      const byId = new Map(nextMemories.map((m) => [String(m.id), m]));
      for (const link of nextLinks) {
        const a = byId.get(String(link.a_id));
        const b = byId.get(String(link.b_id));
        if (!a || !b) continue;
        const ka = String(a.id), kb = String(b.id);
        const id = String(link.id ?? `${ka}-${kb}`);
        const drawing = animateChanges && !previousLinkIds.has(id);
        const aPos = hashPosition(a.id, a.source);
        const bPos = hashPosition(b.id, b.source);
        makeEdge(`link:${id}`, aPos, drawing ? aPos : bPos, '#ffffff', 0.1, 0);
      }
      edgeMeta.forEach((e, i) => edgeIndex.set(e.key, i));

      const positionArray = new Float32Array(nodeMeta.length * 3);
      const colorArray = new Float32Array(nodeMeta.length * 3);
      const sizes = new Float32Array(nodeMeta.length);
      const alphas = new Float32Array(nodeMeta.length);
      const scales = new Float32Array(nodeMeta.length);
      const glows = new Float32Array(nodeMeta.length);
      const packets = new Float32Array(nodeMeta.length);
      nodeMeta.forEach((node, i) => {
        node.position.toArray(positionArray, i * 3);
        node.color.toArray(colorArray, i * 3);
        sizes[i] = node.size; alphas[i] = node.alpha; scales[i] = node.scale; glows[i] = node.glow; packets[i] = 0;
      });
      pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3).setUsage(THREE.DynamicDrawUsage));
      pointGeometry.setAttribute('baseColor', new THREE.BufferAttribute(colorArray, 3));
      pointGeometry.setAttribute('baseSize', new THREE.BufferAttribute(sizes, 1));
      pointGeometry.setAttribute('baseAlpha', new THREE.BufferAttribute(alphas, 1));
      pointGeometry.setAttribute('nodeScale', new THREE.BufferAttribute(scales, 1).setUsage(THREE.DynamicDrawUsage));
      pointGeometry.setAttribute('nodeGlow', new THREE.BufferAttribute(glows, 1).setUsage(THREE.DynamicDrawUsage));
      pointGeometry.setAttribute('packetAlpha', new THREE.BufferAttribute(packets, 1).setUsage(THREE.DynamicDrawUsage));
      pointGeometry.computeBoundingSphere();
      const linePositions = new Float32Array(edgeMeta.length * 6);
      const lineColors = new Float32Array(edgeMeta.length * 6);
      const lineAlphas = new Float32Array(edgeMeta.length * 2);
      const lineGlows = new Float32Array(edgeMeta.length * 2);
      edgeMeta.forEach((edge, i) => {
        edge.a.toArray(linePositions, i * 6); edge.b.toArray(linePositions, i * 6 + 3);
        edge.color.toArray(lineColors, i * 6); edge.color.toArray(lineColors, i * 6 + 3);
        lineAlphas[i * 2] = edge.alpha; lineAlphas[i * 2 + 1] = edge.alpha;
        lineGlows[i * 2] = edge.glow; lineGlows[i * 2 + 1] = edge.glow;
      });
      lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('baseColor', new THREE.BufferAttribute(lineColors, 3).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('baseAlpha', new THREE.BufferAttribute(lineAlphas, 1));
      lineGeometry.setAttribute('lineGlow', new THREE.BufferAttribute(lineGlows, 1).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.computeBoundingSphere();
      points.geometry = pointGeometry;
      lines.geometry = lineGeometry;
      oldMem.dispose(); oldLine.dispose();

      if (animateChanges) {
        const now = performance.now();
        for (const memory of nextMemories) {
          const id = String(memory.id);
          if (!previousMemoryIds.has(id)) {
            const idx = memorySlot.get(id);
            pointGeometry.attributes.nodeScale.array[idx] = 0;
            events.push({ kind: 'add', memoryId: id, source: memory.source, startedAt: now });
          }
        }
        for (const link of nextLinks) {
          const id = String(link.id ?? `${link.a_id}-${link.b_id}`);
          if (!previousLinkIds.has(id)) {
            const a = byId.get(String(link.a_id)); const b = byId.get(String(link.b_id));
            if (!a || !b) continue;
            const key = `link:${id}`;
            edgeDraws.set(key, { start: hashPosition(a.id, a.source), end: hashPosition(b.id, b.source), startedAt: now, duration: 550 });
            events.push({ kind: 'link', aId: String(a.id), bId: String(b.id), linkId: id, linkKind: link.kind, startedAt: now });
          }
        }
      }
      previousMemoryIds = new Set(nextMemories.map((m) => String(m.id)));
      previousLinkIds = new Set(nextLinks.map((link) => String(link.id ?? `${link.a_id}-${link.b_id}`)));
      if (shouldFit) fitView(true);
    }

    function retrieve(memoryId) {
      const memory = currentMemories.find((m) => String(m.id) === String(memoryId));
      if (!memory) return false;
      const linkedIds = currentLinks.filter((link) => String(link.a_id) === String(memoryId) || String(link.b_id) === String(memoryId))
        .flatMap((link) => [String(link.a_id), String(link.b_id)]).filter((id) => id !== String(memoryId));
      events.push({ kind: 'retrieve', memoryId: String(memoryId), source: memory.source, linkedIds, startedAt: performance.now() });
      return true;
    }
    function focus(memoryId) {
      const index = memorySlot.get(String(memoryId));
      if (index === undefined) return false;
      const target = nodeMeta[index].position.clone();
      const offset = camera.position.clone().sub(controls.target);
      if (offset.lengthSq() < 0.001) offset.set(1, 0.7, 1);
      offset.setLength(Math.min(offset.length(), 24));
      focusMove = {
        cameraFrom: camera.position.clone(), targetFrom: controls.target.clone(),
        cameraTo: target.clone().add(offset), targetTo: target,
        startedAt: performance.now(), duration: 700
      };
      retrieve(memoryId);
      return true;
    }
    apiRef.current = { retrieve, focus };
    // Start with valid GPU attributes before the first animation frame; the first data snapshot
    // establishes the baseline and should not animate every memory already in the database.
    rebuild([], [], {}, false);
    host.__brainGraphRebuild = (nextMemories, nextLinks, nextCounts) => {
      rebuild(nextMemories, nextLinks, nextCounts, initialized);
      initialized = true;
    };

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.55;
    const pointer = new THREE.Vector2();
    function onPointerMove(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, false);
      const hit = hits.find((item) => nodeMeta[item.index]?.kind === 'memory');
      if (!hit) { tooltip.hidden = true; return; }
      const node = nodeMeta[hit.index];
      tooltip.textContent = node.title;
      tooltip.hidden = false;
      tooltip.style.left = `${event.clientX - rect.left + 12}px`;
      tooltip.style.top = `${event.clientY - rect.top + 12}px`;
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', () => { tooltip.hidden = true; });

    function resize() {
      const width = Math.max(1, host.clientWidth - (host.__brainGraphCollapsed ? 0 : Math.min(360, window.innerWidth * 0.92)));
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height; camera.updateProjectionMatrix();
      renderer.setSize(width, height); labels.setSize(width, height); composer.setSize(width, height);
      pointMat.uniforms.pixelRatio.value = renderer.getPixelRatio();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host); resize(); fitView(false);
    host.__brainGraphResize = resize;

    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const attr = pointGeometry.attributes;
      const pos = attr.position.array;
      const scale = attr.nodeScale.array;
      const glow = attr.nodeGlow.array;
      const packetAlpha = attr.packetAlpha.array;
      scale.fill(1); glow.fill(0); packetAlpha.fill(0);
      nodeMeta.forEach((node, i) => node.color.toArray(attr.baseColor.array, i * 3));
      for (const event of events) {
        const elapsed = (now - event.startedAt) / 1000;
        const memoryIds = event.kind === 'link' ? [event.aId, event.bId] : [event.memoryId];
        const duration = event.kind === 'retrieve' ? 2 : event.kind === 'add' ? 1.7 : 1.6;
        if (elapsed > duration) continue;
        const strength = Math.max(0, 1 - elapsed / duration);
        const sourceColor = new THREE.Color(event.kind === 'link' ? (event.linkKind === 'semantic' ? '#55c7bd' : '#ffffff') : COLORS[event.source] || '#ffffff');
        for (const id of memoryIds) {
          const idx = memorySlot.get(id);
          if (idx === undefined) continue;
          scale[idx] = event.kind === 'add' ? Math.min(1, elapsed / 0.32) : 1 + 0.24 * strength;
          glow[idx] = (event.kind === 'retrieve' ? 1.6 : 1.1) * strength;
          const base = packetSlots.get(id);
          if (base !== undefined && elapsed > 0.38) {
            const travel = Math.min(1, (elapsed - 0.38) / (event.kind === 'retrieve' ? 1.35 : 0.95));
            const anchor = new THREE.Vector3(...ANCHORS[nodeMeta[idx].source]);
            const start = nodeMeta[idx].position;
            const corner = travel < 0.58 ? start.clone().lerp(anchor, travel / 0.58) : anchor.clone().lerp(HUB, (travel - 0.58) / 0.42);
            for (let p = 0; p < 3; p++) {
              const lag = p * 0.055;
              const t = Math.max(0, travel - lag);
              const packetPos = t < 0.58 ? start.clone().lerp(anchor, t / 0.58) : anchor.clone().lerp(HUB, (t - 0.58) / 0.42);
              packetPos.toArray(pos, (base + p) * 3);
              packetAlpha[base + p] = Math.max(0, (1 - lag * 5) * strength * (elapsed > 0.38 ? 0.95 : 0));
            }
            if (elapsed > 0.38 && travel > 0.55) {
              hubFlash.color.copy(sourceColor); hubFlash.strength = Math.max(hubFlash.strength, strength); hubFlash.until = now + 120;
            }
            void corner;
          }
        }
        if (event.kind === 'retrieve') {
          for (const id of event.linkedIds) {
            const idx = memorySlot.get(id);
            if (idx !== undefined) {
              glow[idx] = Math.max(glow[idx], 1.25 * strength);
              scale[idx] = Math.max(scale[idx], 1 + 0.15 * strength);
              new THREE.Color('#ffffff').lerp(nodeMeta[idx].color, 1 - strength * 0.8).toArray(attr.baseColor.array, idx * 3);
            }
          }
        }
      }
      const kept = [];
      for (const e of events) if ((now - e.startedAt) < (e.kind === 'retrieve' ? 2000 : 1800)) kept.push(e);
      events = kept;
      if (hubFlash.until < now) hubFlash.strength *= 0.93;
      const hubColor = new THREE.Color('#ffffff');
      if (hubFlash.strength > 0.01) hubColor.lerp(hubFlash.color, Math.min(1, hubFlash.strength));
      hubColor.toArray(attr.baseColor.array, 0);
      glow[0] = hubFlash.strength * 1.2;
      attr.baseColor.needsUpdate = true;
      for (const [key, draw] of edgeDraws) {
        const i = edgeIndex.get(key);
        if (i === undefined) { edgeDraws.delete(key); continue; }
        const t = Math.min(1, (now - draw.startedAt) / draw.duration);
        const b = draw.start.clone().lerp(draw.end, t);
        if (t < 1) {
          draw.start.toArray(lineGeometry.attributes.position.array, i * 6);
          b.toArray(lineGeometry.attributes.position.array, i * 6 + 3);
        } else {
          draw.start.toArray(lineGeometry.attributes.position.array, i * 6);
          draw.end.toArray(lineGeometry.attributes.position.array, i * 6 + 3);
        }
        if (t >= 1) edgeDraws.delete(key);
      }
      const lineGlow = lineGeometry.attributes.lineGlow.array;
      const lineColors = lineGeometry.attributes.baseColor.array;
      const lineAlpha = lineGeometry.attributes.baseAlpha.array;
      lineGlow.fill(0);
      edgeMeta.forEach((edge, i) => {
        edge.color.toArray(lineColors, i * 6);
        edge.color.toArray(lineColors, i * 6 + 3);
        lineAlpha[2 * i] = lineAlpha[2 * i + 1] = edge.memoryLink && !host.__brainLinksVisible ? 0 : edge.alpha;
      });
      for (const event of events) {
        const elapsed = (now - event.startedAt) / 1000;
        const strength = Math.max(0, 1 - elapsed / (event.kind === 'retrieve' ? 2 : 1.5));
        for (const id of (event.kind === 'link' ? [event.aId, event.bId] : [event.memoryId])) {
          const i = edgeIndex.get(`memory:${id}`);
          if (i !== undefined) { lineGlow[2 * i] = lineGlow[2 * i + 1] = Math.max(lineGlow[2 * i], 0.9 * strength); }
        }
        if (event.kind !== 'link') {
          const anchorIndex = edgeIndex.get(`anchor:${event.source}`);
          if (anchorIndex !== undefined) lineGlow[2 * anchorIndex] = lineGlow[2 * anchorIndex + 1] = Math.max(lineGlow[2 * anchorIndex], 1.05 * strength);
        }
        if (event.kind === 'link' && host.__brainLinksVisible) {
          const i = edgeMeta.findIndex((edge) => edge.key.startsWith('link:') && (edge.key === `link:${event.linkId}`));
          if (i >= 0) lineGlow[2 * i] = lineGlow[2 * i + 1] = (event.linkKind === 'semantic' ? 0.8 : 1.3) * strength;
        }
        if (event.kind === 'retrieve') for (const id of event.linkedIds) {
          const i = edgeIndex.get(`memory:${id}`);
          if (i !== undefined) {
            lineGlow[2 * i] = lineGlow[2 * i + 1] = Math.max(lineGlow[2 * i], 1.1 * strength);
            new THREE.Color('#ffffff').lerp(edgeMeta[i].color, 1 - strength).toArray(lineColors, i * 6);
            new THREE.Color('#ffffff').lerp(edgeMeta[i].color, 1 - strength).toArray(lineColors, i * 6 + 3);
          }
          const linkedMemory = currentMemories.find((memory) => String(memory.id) === id);
          const anchorEdge = linkedMemory && edgeIndex.get(`anchor:${linkedMemory.source}`);
          if (anchorEdge !== undefined) lineGlow[2 * anchorEdge] = lineGlow[2 * anchorEdge + 1] = Math.max(lineGlow[2 * anchorEdge], 1.1 * strength);
          for (const link of host.__brainLinksVisible ? currentLinks : []) {
            const a = String(link.a_id), b = String(link.b_id);
            if ((a === event.memoryId && b === id) || (b === event.memoryId && a === id)) {
              const linkEdge = edgeIndex.get(`link:${String(link.id ?? `${a}-${b}`)}`);
              if (linkEdge !== undefined) lineGlow[2 * linkEdge] = lineGlow[2 * linkEdge + 1] = Math.max(lineGlow[2 * linkEdge], 1.25 * strength);
            }
          }
        }
      }
      attr.position.needsUpdate = true; attr.nodeScale.needsUpdate = true; attr.nodeGlow.needsUpdate = true; attr.packetAlpha.needsUpdate = true;
      lineGeometry.attributes.position.needsUpdate = true; lineGeometry.attributes.lineGlow.needsUpdate = true; lineGeometry.attributes.baseColor.needsUpdate = true; lineGeometry.attributes.baseAlpha.needsUpdate = true;
      if (focusMove) {
        const progress = Math.min(1, (now - focusMove.startedAt) / focusMove.duration);
        const eased = progress * progress * (3 - 2 * progress);
        camera.position.lerpVectors(focusMove.cameraFrom, focusMove.cameraTo, eased);
        controls.target.lerpVectors(focusMove.targetFrom, focusMove.targetTo, eased);
        if (progress >= 1) focusMove = null;
      }
      controls.update(); composer.render(); labels.render(scene, camera);
    }
    animate();
    const style = document.createElement('style');
    style.textContent = `
      .brain-webgl,.brain-label-layer { position:absolute; inset:0; width:100%; height:100%; }
      .brain-label-layer { pointer-events:auto; overflow:hidden; right:0; }
      .brain-webgl { right:0; }
      .brain-label-card { display:grid; grid-template-columns:8px auto; align-items:center; gap:2px 7px; padding:7px 9px; border:1px solid rgba(182,205,233,.24); border-radius:8px; color:#eaf0fa; background:rgba(8,13,24,.78); box-shadow:0 4px 16px rgba(0,0,0,.25); font:11px/1.2 system-ui,sans-serif; white-space:nowrap; }
      .brain-label-dot { width:7px;height:7px;border-radius:50%;box-shadow:0 0 9px currentColor;grid-row:span 2; }
      .brain-label-card strong { font-weight:600;text-transform:capitalize; }
      .brain-label-count { color:#aab8ca;font-size:9px; }
      .brain-memory-tooltip { position:absolute;z-index:4;max-width:280px;padding:5px 8px;border:1px solid rgba(180,200,228,.24);border-radius:5px;color:#eef4ff;background:rgba(8,13,24,.95);font:11px/1.3 system-ui,sans-serif;pointer-events:none; }
      .brain-fit-button { position:absolute;z-index:5;right:18px;bottom:18px;padding:7px 12px;border:1px solid rgba(190,210,238,.24);border-radius:7px;color:#dce8f8;background:rgba(12,19,32,.86);font:11px/1 system-ui,sans-serif;cursor:pointer; }
      .brain-fit-button:hover { background:rgba(35,48,68,.96); }
      .brain-links-toggle { position:absolute;z-index:5;right:18px;top:18px;display:flex;align-items:center;gap:2px;padding:4px 5px;border:1px solid rgba(190,210,238,.24);border-radius:7px;color:#dce8f8;background:rgba(12,19,32,.86);font:11px/1 system-ui,sans-serif; }
      .brain-links-toggle span { padding:0 4px;color:#aab8ca; }
      .brain-links-toggle button { padding:4px 7px;border:0;border-radius:4px;color:#aab8ca;background:transparent;font:inherit;cursor:pointer; }
      .brain-links-toggle button[aria-pressed="true"] { color:#f0f6ff;background:rgba(90,117,153,.45); }
      .brain-links-toggle button:hover { color:#fff; }
    `;
    host.appendChild(style);

    return () => {
      cancelAnimationFrame(raf); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      composer.dispose(); pointGeometry.dispose(); lineGeometry.dispose(); pointMat.dispose(); lineMat.dispose();
      renderer.dispose(); labels.domElement.remove(); tooltip.remove(); fitButton.remove(); linksToggle.remove(); style.remove();
      delete host.__brainGraphRebuild;
      delete host.__brainGraphResize;
      for (const obj of Object.values(labelObjects)) obj.remove();
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.__brainLinksVisible = linksVisible;
    host.__brainSetLinksVisible = onLinksVisibleChange;
    const buttons = host.querySelectorAll('.brain-links-toggle button[data-visible]');
    buttons.forEach((button) => button.setAttribute('aria-pressed', String((button.dataset.visible === 'true') === linksVisible)));
  }, [linksVisible, onLinksVisibleChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      host.__brainGraphCollapsed = sidebarCollapsed;
      const webgl = host.querySelector('.brain-webgl');
      const labelLayer = host.querySelector('.brain-label-layer');
      if (webgl) webgl.style.left = sidebarCollapsed ? '0' : 'min(360px, 92vw)';
      if (labelLayer) labelLayer.style.left = sidebarCollapsed ? '0' : 'min(360px, 92vw)';
      if (webgl) webgl.style.width = sidebarCollapsed ? '100%' : 'calc(100% - min(360px, 92vw))';
      if (labelLayer) labelLayer.style.width = sidebarCollapsed ? '100%' : 'calc(100% - min(360px, 92vw))';
      host.__brainGraphResize?.();
    }
  }, [sidebarCollapsed]);

  // Keep the latest data available to the persistent renderer and rebuild only on data changes.
  useEffect(() => {
    const graph = hostRef.current?.__brainGraphRebuild;
    if (graph && dataReady) graph(memories, links, counts);
  }, [memories, links, counts, dataReady]);

  return <div ref={hostRef} className="brain-graph" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
});

export default BrainGraph;
