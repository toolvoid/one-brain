import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { fitCameraToPoints, straightLinkPoints } from '../lib/graph-math.mjs';
import { linksJustEnabled } from '../lib/graph-links.mjs';
import { clearSavedView, saveViewBeforeFocus } from '../lib/graph-focus.mjs';
import { safeCreateWebGLRenderer } from '../lib/graph-renderer.mjs';
import { graphFrameIntervalMs, shouldKeepGraphAnimating, shouldRenderGraphLabels, shouldUpdateLineBuffers, shouldUpdateNodeBuffers } from '../lib/graph-animation.mjs';
import { isSoftwareRenderer, PERFORMANCE_MODE_EVENT, PERFORMANCE_NODE_LIMIT, readManualPerformanceMode, selectPerformanceNodes } from '../lib/graph-performance.mjs';

const SOURCES = ['chatgpt', 'claude', 'codex', 'gemini', 'groq', 'deepseek', 'perplexity'];
const COLORS = {
  chatgpt: '#42d6c2', claude: '#f29a60', codex: '#70a9ff',
  gemini: '#b18cff', groq: '#f2d66d', deepseek: '#ff7095', perplexity: '#35c9f0'
};
const ANCHORS = {
  chatgpt: [12, 0, 0], claude: [0, 12, 0], codex: [0, 0, 12],
  gemini: [-12, 0, 0], groq: [0, -12, 0], deepseek: [0, 0, -12], perplexity: [9, 9, 9]
};
const HUB = new THREE.Vector3(0, 0, 0);
const LINK_LINE_DRAW_DURATION = 900;
const LINK_LINE_SETTLE_DURATION = 400;

function rendererString(renderer) {
  try {
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) || '');
  } catch { return ''; }
}

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

function graphLinkPairKey(a, b) {
  const left = String(a), right = String(b);
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
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

const BrainGraph = forwardRef(function BrainGraph({ memories = [], links = [], allLinks = links, counts = {}, linkCounts = {}, linkVisibility = {}, onLinkVisibilityChange = () => {}, fitRevision = 0, sidebarCollapsed = false, sidebarWidth = 360, dataReady = false, onMemoryClick = () => {}, toolbar = null }, ref) {
  const hostRef = useRef(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const initialLinkRevealDoneRef = useRef(false);
  const previousLinkVisibilityRef = useRef(linkVisibility);
  const onMemoryClickRef = useRef(onMemoryClick);
  onMemoryClickRef.current = onMemoryClick;
  const apiRef = useRef({ retrieve: () => false, focus: () => false, restore: () => false });
  useImperativeHandle(ref, () => ({
    retrieve: (id) => apiRef.current.retrieve(id),
    focus: (id) => apiRef.current.focus(id),
    restore: () => apiRef.current.restore()
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1020');
    scene.fog = new THREE.FogExp2('#0b1020', 0.003);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 250);
    camera.position.set(32, 24, 42);
    const renderer = safeCreateWebGLRenderer(THREE.WebGLRenderer, { antialias: true, alpha: false });
    if (!renderer) {
      setWebglUnavailable(true);
      void Promise.resolve(window.brain?.reportGraphicsContextFailure?.()).catch(() => {});
      return undefined;
    }
    const normalPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const detectedRenderer = rendererString(renderer);
    const automaticPerformanceMode = isSoftwareRenderer(detectedRenderer);
    void Promise.resolve(window.brain?.reportGraphicsRenderer?.(detectedRenderer)).catch(() => {});
    let manualPerformanceMode = readManualPerformanceMode();
    let performanceMode = automaticPerformanceMode || manualPerformanceMode;
    renderer.setPixelRatio(performanceMode ? 1 : normalPixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'brain-webgl';
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      void Promise.resolve(window.brain?.reportGraphicsContextFailure?.()).catch(() => {});
    }, { once: true });
    host.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'brain-label-layer';
    host.appendChild(labels.domElement);
    const controls = new OrbitControls(camera, labels.domElement);
    controls.rotateSpeed = 1;
    controls.minPolarAngle = 0.01;
    controls.maxPolarAngle = Math.PI - 0.01;
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 20;
    controls.maxDistance = 2000;
    let raf = 0;
    let rafPending = false;
    let frameTimer = 0;
    let animateFrame = null;
    function scheduleFrame(delay = 0) {
      if (rafPending) return;
      if (frameTimer) {
        if (delay > 0) return;
        clearTimeout(frameTimer);
        frameTimer = 0;
      }
      if (!animateFrame) return;
      if (delay > 0) {
        frameTimer = setTimeout(() => {
          frameTimer = 0;
          if (!rafPending) { rafPending = true; raf = requestAnimationFrame(animateFrame); }
        }, delay);
      } else {
        rafPending = true;
        raf = requestAnimationFrame(animateFrame);
      }
    }
    controls.addEventListener('start', () => scheduleFrame());
    controls.addEventListener('change', () => scheduleFrame());
    const onVisibilityChange = () => { if (document.visibilityState !== 'hidden') scheduleFrame(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), performanceMode ? 0.08 : 0.18, 0.25, 0.86);
    composer.addPass(bloomPass);

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
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    host.appendChild(tooltip);
    const performanceCount = document.createElement('small');
    performanceCount.className = 'brain-performance-count';
    performanceCount.hidden = true;
    host.appendChild(performanceCount);

    let nodeMeta = [];
    let edgeMeta = [];
    let memorySlot = new Map();
    let edgeIndex = new Map();
    let packetSlots = new Map();
    let pointAttrs = null;
    let lineAttrs = null;
    let segmentToEdge = [];
    let currentMemories = [];
    let currentLinks = [];
    let currentLinkByPair = new Map();
    let currentCounts = {};
    let totalMemoryCount = 0;
    let lastSnapshot = null;
    let previousMemoryIds = new Set();
    let previousMemoryLayout = '';
    let previousLinkIds = new Set();
    let initialized = false;
    let events = [];
    let edgeDraws = new Map();
    let hubFlash = { color: new THREE.Color('#ffffff'), strength: 0, until: 0 };
    let focusMove = null;
    let savedView = null;
    let restoringView = false;
    let manualOrbitPaused = false;
    let hoveredMemoryId = null;
    let hoveredMemorySource = null;
    let hoveredLinkIndex = -1;
    let lineVisualDirty = true;
    let orbitPointerStart = null;

    function fitView(smooth = true, explicit = false) {
      if (explicit) { manualOrbitPaused = false; savedView = clearSavedView(); restoringView = false; }
      const positions = [HUB.toArray(), ...SOURCES.map((key) => ANCHORS[key]), ...currentMemories.map((memory) => hashPosition(memory.id, memory.source).toArray())];
      const fit = fitCameraToPoints(positions, camera.fov, camera.aspect);
      const direction = new THREE.Vector3(32, 24, 42).normalize();
      const center = new THREE.Vector3(...fit.center);
      const cameraTo = center.clone().addScaledVector(direction, fit.distance);
      if (!smooth) {
        camera.position.copy(cameraTo);
        controls.target.copy(center);
        focusMove = null;
        controls.update();
        return;
      }
      focusMove = {
        cameraFrom: camera.position.clone(), targetFrom: controls.target.clone(),
        cameraTo, targetTo: center, startedAt: performance.now(), duration: 700
      };
      scheduleFrame();
    }

    const fitButton = document.createElement('button');
    fitButton.type = 'button';
    fitButton.className = 'brain-fit-button';
    fitButton.textContent = 'Fit';
    fitButton.setAttribute('aria-label', 'Fit all AI anchors and hub in view');
    fitButton.addEventListener('click', () => fitView(true, true));
    host.__brainGraphFit = () => { if (!manualOrbitPaused) fitView(true); };
    controls.addEventListener('start', () => {
      focusMove = null;
      if (restoringView) { savedView = clearSavedView(); restoringView = false; }
    });
    host.appendChild(fitButton);

    const linksControl = document.createElement('div');
    linksControl.className = 'brain-links-control';
    linksControl.innerHTML = '<button class="brain-links-button" type="button" aria-expanded="false">Links</button><div class="brain-links-popover" hidden><label class="brain-link-master"><input data-kind="master" type="checkbox"><span>Show memory links</span></label><div class="brain-link-options"><label><input data-kind="auto" type="checkbox"><i class="brain-link-swatch"></i><span>Title-matched</span><b data-count="auto">0</b></label><label><input data-kind="manual" type="checkbox"><i class="brain-link-swatch"></i><span>Manual</span><b data-count="manual">0</b></label><label><input data-kind="semantic" type="checkbox"><i class="brain-link-swatch"></i><span>Semantic</span><b data-count="semantic">0</b></label></div><small class="brain-link-cap"></small></div>';
    const linksButton = linksControl.querySelector('.brain-links-button');
    const linksPopover = linksControl.querySelector('.brain-links-popover');
    linksButton.addEventListener('click', () => {
      linksPopover.hidden = !linksPopover.hidden;
      linksButton.setAttribute('aria-expanded', String(!linksPopover.hidden));
    });
    linksControl.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-kind]');
      if (!input) return;
      const kind = input.dataset.kind;
      if (kind === 'master') {
        const show = input.checked;
        host.__brainSetLinkVisibility?.({ titleMatched: show, manual: show, semantic: show });
      } else host.__brainSetLinkVisibility?.({ ...host.__brainLinkVisibility, [kind === 'auto' ? 'titleMatched' : kind]: input.checked });
    });
    host.appendChild(linksControl);
    host.__brainGraphLinkState = (visibility, counts) => {
      host.__brainLinkVisibility = visibility || {};
      host.__brainSetLinkVisibility = (next) => onLinkVisibilityChange(next);
      const kinds = [['titleMatched', 'auto'], ['manual', 'manual'], ['semantic', 'semantic']];
      let checked = 0;
      for (const [key, kind] of kinds) {
        const input = linksControl.querySelector(`input[data-kind="${kind}"]`);
        const visible = Boolean(host.__brainLinkVisibility[key]);
        input.checked = visible;
        if (visible) checked += 1;
        linksControl.querySelector(`[data-count="${kind}"]`).textContent = Number(counts?.[key]) || 0;
      }
      const master = linksControl.querySelector('input[data-kind="master"]');
      master.checked = checked === kinds.length;
      master.indeterminate = checked > 0 && checked < kinds.length;
      const total = kinds.reduce((sum, [key]) => sum + (Number(counts?.[key]) || 0), 0);
      linksControl.querySelector('.brain-link-cap').textContent = total > 3000 ? 'Semantic links are automatically hidden above 3,000 total links.' : '';
    };
    host.__brainGraphRevealLinks = () => {
      events = events.filter((event) => event.kind !== 'link');
      const startedAt = performance.now();
      let sequence = 0;
      for (const edge of edgeMeta) {
        if (!edge.memoryLink) continue;
        const link = currentLinks.find((item) => String(item.id ?? `${item.a_id}-${item.b_id}`) === edge.key.slice(5));
        if (!link) continue;
        const aMemory = currentMemories.find((item) => String(item.id) === String(link.a_id));
        const bMemory = currentMemories.find((item) => String(item.id) === String(link.b_id));
        if (!aMemory || !bMemory) continue;
        const a = hashPosition(aMemory.id, aMemory.source);
        const b = hashPosition(bMemory.id, bMemory.source);
        const drawStartedAt = startedAt + Math.min(sequence * 35, 840);
        edgeDraws.set(edge.key, { start: a, end: b, startedAt: drawStartedAt, duration: LINK_LINE_DRAW_DURATION, settleDuration: LINK_LINE_SETTLE_DURATION });
        if (sequence < 32) events.push({
          kind: 'link', linkId: edge.key.slice(5), aId: edge.linkMemoryIds[0], bId: edge.linkMemoryIds[1],
          source: bMemory.source || 'chatgpt', startedAt: drawStartedAt + LINK_LINE_DRAW_DURATION
        });
        sequence += 1;
      }
      scheduleFrame();
    };
    const legend = document.createElement('details');
    legend.className = 'brain-legend';
    legend.innerHTML = '<summary>Legend</summary><div><i class="brain-legend-structural"></i><span>Belongs to AI or hub</span></div><div><i class="brain-legend-link"></i><span>Linked memories</span></div>';
    for (const source of SOURCES) {
      const row = document.createElement('div');
      const dot = document.createElement('i');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${COLORS[source]}`;
      const label = document.createElement('span'); label.textContent = source;
      row.append(dot, label); legend.append(row);
    }
    host.appendChild(legend);

    function makeEdge(key, a, b, color, alpha, glow = 0, linkDetails = null) {
      const memoryLink = key.startsWith('link:');
      edgeMeta.push({ key, a: a.clone(), b: b.clone(), points: linkDetails?.points || [a.toArray(), b.toArray()], color: new THREE.Color(color), alpha, glow, memoryLink, ...linkDetails });
    }
    function rebuild(nextMemories, nextLinks, nextCounts, animateChanges, knownLinks = nextLinks) {
      totalMemoryCount = nextMemories.length;
      let displayMemories = nextMemories;
      if (performanceMode && nextMemories.length > PERFORMANCE_NODE_LIMIT) {
        const degreeById = new Map();
        for (const link of knownLinks) {
          const aId = String(link.a_id), bId = String(link.b_id);
          degreeById.set(aId, (degreeById.get(aId) || 0) + 1);
          degreeById.set(bId, (degreeById.get(bId) || 0) + 1);
        }
        const candidates = nextMemories.map((memory) => {
          const source = SOURCES.includes(memory.source) ? memory.source : 'chatgpt';
          const position = hashPosition(memory.id, source);
          return { value: memory, distance: position.distanceTo(camera.position), degree: degreeById.get(String(memory.id)) || 0 };
        });
        displayMemories = selectPerformanceNodes(candidates, PERFORMANCE_NODE_LIMIT);
      }
      const displayIds = new Set(displayMemories.map((memory) => String(memory.id)));
      const displayLinks = performanceMode
        ? nextLinks.filter((link) => displayIds.has(String(link.a_id)) && displayIds.has(String(link.b_id)))
        : nextLinks;
      performanceCount.hidden = !performanceMode;
      if (!performanceCount.hidden) performanceCount.textContent = totalMemoryCount > displayMemories.length
        ? `Performance mode · showing ${displayMemories.length} of ${totalMemoryCount}`
        : 'Performance mode';
      const nextMemoryIds = new Set(displayMemories.map((memory) => String(memory.id)));
      const memoryLayout = JSON.stringify(displayMemories.map((memory) => [String(memory.id), memory.source]));
      const shouldFit = !initialized || memoryLayout !== previousMemoryLayout;
      const oldMem = pointGeometry;
      const oldLine = lineGeometry;
      currentMemories = displayMemories;
      currentLinks = displayLinks;
      currentLinkByPair = new Map(displayLinks.map((link) => [graphLinkPairKey(link.a_id, link.b_id), link]));
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
        labelObjects[key].hidden = performanceMode && !active;
        const c = active ? new THREE.Color(COLORS[key]) : new THREE.Color('#63738a');
        labelObjects[key].querySelector('.brain-label-dot').style.background = active ? COLORS[key] : '#63738a';
        labelObjects[key].querySelector('.brain-label-dot').style.boxShadow = active ? `0 0 9px ${COLORS[key]}` : 'none';
        nodeMeta.push({ kind: 'anchor', key, source: key, position: new THREE.Vector3(...ANCHORS[key]), color: c, size: 13, alpha: active ? 0.95 : 0.22, scale: 1, glow: 0 });
        makeEdge(`anchor:${key}`, HUB, new THREE.Vector3(...ANCHORS[key]), COLORS[key], active ? 0.24 : 0.04);
      }
      const hubIndex = nodeMeta.length;
      nodeMeta.unshift({ kind: 'hub', key: 'hub', source: '', position: HUB.clone(), color: new THREE.Color('#ffffff'), size: 28, alpha: 0.96, scale: 1, glow: 0.25 });
      for (const memory of displayMemories) {
        const source = SOURCES.includes(memory.source) ? memory.source : 'chatgpt';
        const position = hashPosition(memory.id, source);
        const active = (Number(nextCounts[source]) || 0) > 0;
        const index = nodeMeta.length;
        memorySlot.set(String(memory.id), index);
        nodeMeta.push({ kind: 'memory', key: String(memory.id), id: memory.id, source, title: memory.title || 'Untitled memory', position, color: new THREE.Color(active ? COLORS[source] : '#728095'), size: 5.2, alpha: 0.88, scale: 1, glow: 0 });
        const edgeKey = `memory:${memory.id}`;
        const newAdd = animateChanges && !previousMemoryIds.has(String(memory.id));
        const anchor = new THREE.Vector3(...ANCHORS[source]);
        const edgeColor = new THREE.Color(COLORS[source]);
        // Draw new memories along their single structural edge from the anchor.
        makeEdge(edgeKey, anchor, newAdd ? anchor : position, edgeColor, 0.22);
        if (newAdd) {
          // Draw the existing structural edge outward so each memory has exactly one
          // anchor connection, including while the add animation is playing.
          edgeDraws.set(edgeKey, { start: anchor, end: position, startedAt: performance.now(), duration: 450 });
        }
        if (!performanceMode) {
          const packetBase = nodeMeta.length;
          for (let p = 0; p < 3; p++) nodeMeta.push({ kind: 'packet', key: `${memory.id}:${p}`, id: memory.id, source, position: position.clone(), color: new THREE.Color(COLORS[source]), size: 7, alpha: 0, scale: 1, glow: 0 });
          packetSlots.set(String(memory.id), packetBase);
        }
      }
      const byId = new Map(displayMemories.map((m) => [String(m.id), m]));
      for (const link of displayLinks) {
        const a = byId.get(String(link.a_id));
        const b = byId.get(String(link.b_id));
        if (!a || !b) continue;
        const ka = String(a.id), kb = String(b.id);
        const id = String(link.id ?? `${ka}-${kb}`);
        const aPos = hashPosition(a.id, a.source);
        const bPos = hashPosition(b.id, b.source);
        const points = straightLinkPoints(aPos.toArray(), bPos.toArray());
        makeEdge(`link:${id}`, aPos, bPos, '#ffffff', 0.1, 0, { points, linkKind: link.kind, linkScore: link.score, linkMemoryIds: [ka, kb] });
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
      const totalSegments = edgeMeta.reduce((total, edge) => total + edge.points.length - 1, 0);
      const linePositions = new Float32Array(totalSegments * 6);
      const lineColors = new Float32Array(totalSegments * 6);
      const lineAlphas = new Float32Array(totalSegments * 2);
      const lineGlows = new Float32Array(totalSegments * 2);
      segmentToEdge = new Array(totalSegments);
      let segmentOffset = 0;
      edgeMeta.forEach((edge, edgeNumber) => {
        edge.segmentStart = segmentOffset;
        edge.segmentCount = edge.points.length - 1;
        for (let segment = 0; segment < edge.segmentCount; segment++) {
          const i = segmentOffset + segment;
          new THREE.Vector3(...edge.points[segment]).toArray(linePositions, i * 6);
          new THREE.Vector3(...edge.points[segment + 1]).toArray(linePositions, i * 6 + 3);
          edge.color.toArray(lineColors, i * 6); edge.color.toArray(lineColors, i * 6 + 3);
          lineAlphas[i * 2] = edge.alpha; lineAlphas[i * 2 + 1] = edge.alpha;
          lineGlows[i * 2] = edge.glow; lineGlows[i * 2 + 1] = edge.glow;
          segmentToEdge[i] = edgeNumber;
        }
        segmentOffset += edge.segmentCount;
      });
      lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('baseColor', new THREE.BufferAttribute(lineColors, 3).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.setAttribute('baseAlpha', new THREE.BufferAttribute(lineAlphas, 1));
      lineGeometry.setAttribute('lineGlow', new THREE.BufferAttribute(lineGlows, 1).setUsage(THREE.DynamicDrawUsage));
      lineGeometry.computeBoundingSphere();
      points.geometry = pointGeometry;
      lines.geometry = lineGeometry;
      lineVisualDirty = true;
      oldMem.dispose(); oldLine.dispose();

      if (animateChanges) {
        const now = performance.now();
        for (const memory of displayMemories) {
          const id = String(memory.id);
          if (!previousMemoryIds.has(id)) {
            const idx = memorySlot.get(id);
            pointGeometry.attributes.nodeScale.array[idx] = 0;
            events.push({ kind: 'add', memoryId: id, source: memory.source, startedAt: now });
          }
        }
        for (const link of displayLinks) {
          const id = String(link.id ?? `${link.a_id}-${link.b_id}`);
          if (!previousLinkIds.has(id)) {
            const a = byId.get(String(link.a_id)); const b = byId.get(String(link.b_id));
            if (!a || !b) continue;
            const edgeKey = `link:${id}`;
            edgeDraws.set(edgeKey, { start: hashPosition(a.id, a.source), end: hashPosition(b.id, b.source), startedAt: now, duration: LINK_LINE_DRAW_DURATION, settleDuration: LINK_LINE_SETTLE_DURATION });
            events.push({ kind: 'link', aId: String(a.id), bId: String(b.id), linkId: id, linkKind: link.kind, source: b.source, startedAt: now + LINK_LINE_DRAW_DURATION });
          }
        }
      }
      previousMemoryIds = new Set(displayMemories.map((m) => String(m.id)));
      previousMemoryLayout = memoryLayout;
      previousLinkIds = new Set(knownLinks.map((link) => String(link.id ?? `${link.a_id}-${link.b_id}`)));
      for (const key of edgeDraws.keys()) if (!edgeIndex.has(key)) edgeDraws.delete(key);
      if (shouldFit && !manualOrbitPaused) fitView(true);
      scheduleFrame();
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
      savedView = saveViewBeforeFocus(savedView, camera.position, controls.target);
      restoringView = false;
      focusMove = {
        cameraFrom: camera.position.clone(), targetFrom: controls.target.clone(),
        cameraTo: target.clone().add(offset), targetTo: target,
        startedAt: performance.now(), duration: 700
      };
      retrieve(memoryId);
      scheduleFrame();
      return true;
    }
    function restore() {
      if (!savedView) return false;
      focusMove = {
        cameraFrom: camera.position.clone(), targetFrom: controls.target.clone(),
        cameraTo: new THREE.Vector3(savedView.position.x, savedView.position.y, savedView.position.z),
        targetTo: new THREE.Vector3(savedView.target.x, savedView.target.y, savedView.target.z),
        startedAt: performance.now(), duration: 700
      };
      restoringView = true;
      scheduleFrame();
      return true;
    }
    apiRef.current = { retrieve, focus, restore };
    // Start with valid GPU attributes before the first animation frame; the first data snapshot
    // establishes the baseline and should not animate every memory already in the database.
    rebuild([], [], {}, false);
    host.__brainGraphRebuild = (nextMemories, nextLinks, nextCounts, knownLinks) => {
      lastSnapshot = { nextMemories, nextLinks, nextCounts, knownLinks };
      rebuild(nextMemories, nextLinks, nextCounts, initialized, knownLinks);
      initialized = true;
    };
    function onPerformanceModeChange(event) {
      manualPerformanceMode = typeof event.detail === 'boolean' ? event.detail : readManualPerformanceMode();
      const nextMode = automaticPerformanceMode || manualPerformanceMode;
      if (nextMode === performanceMode) return;
      performanceMode = nextMode;
      renderer.setPixelRatio(performanceMode ? 1 : normalPixelRatio);
      bloomPass.strength = performanceMode ? 0.08 : 0.18;
      pointMat.uniforms.pixelRatio.value = renderer.getPixelRatio();
      composer.setPixelRatio(renderer.getPixelRatio());
      resize(true);
      if (lastSnapshot) rebuild(lastSnapshot.nextMemories, lastSnapshot.nextLinks, lastSnapshot.nextCounts, false, lastSnapshot.knownLinks);
      scheduleFrame();
    }
    window.addEventListener(PERFORMANCE_MODE_EVENT, onPerformanceModeChange);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.55;
    raycaster.params.Line.threshold = 0.55;
    const pointer = new THREE.Vector2();
    let lastHoverCheckAt = -Infinity;
    let graphPointerStart = null;
    const onGraphPointerDown = (event) => { graphPointerStart = [event.clientX, event.clientY]; };
    renderer.domElement.addEventListener('pointerdown', onGraphPointerDown);
    labels.domElement.addEventListener('pointerdown', onGraphPointerDown);
    function onPointerClick(event) {
      if (event.button !== 0) return;
      const dragged = graphPointerStart && Math.hypot(event.clientX - graphPointerStart[0], event.clientY - graphPointerStart[1]) > 4;
      graphPointerStart = null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const pointHit = raycaster.intersectObject(points, false).find((item) => nodeMeta[item.index]?.kind === 'memory');
      if (pointHit) { onMemoryClickRef.current?.(nodeMeta[pointHit.index].id); return; }
      if (!currentLinks.length) { if (!dragged) restore(); return; }
      const edgeHit = raycaster.intersectObject(lines, false).find((item) => {
        const edge = edgeMeta[segmentToEdge[Math.floor((item.index || 0) / 2)]];
        return edge?.memoryLink && edge.linkMemoryIds?.length === 2;
      });
      if (!edgeHit) { if (!dragged) restore(); return; }
      const edge = edgeMeta[segmentToEdge[Math.floor((edgeHit.index || 0) / 2)]];
      if (!currentLinks.some((link) => String(link.id ?? `${link.a_id}-${link.b_id}`) === edge.key.slice(5))) return;
      events.push({ kind: 'link', aId: edge.linkMemoryIds[0], bId: edge.linkMemoryIds[1], linkId: edge.key.slice(5), linkKind: edge.linkKind, startedAt: performance.now() });
      scheduleFrame();
      onMemoryClickRef.current?.(edge.linkMemoryIds[1]);
    }
    function onPointerMove(event) {
      const now = performance.now();
      const rect = renderer.domElement.getBoundingClientRect();
      if (!tooltip.hidden) {
        tooltip.style.transform = `translate3d(${event.clientX - rect.left + 12}px, ${event.clientY - rect.top + 12}px, 0)`;
      }
      if (now - lastHoverCheckAt < 100) return;
      lastHoverCheckAt = now;
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, false);
      const hit = hits.find((item) => nodeMeta[item.index]?.kind === 'memory');
      const previousHoveredMemoryId = hoveredMemoryId;
      const previousHoveredMemorySource = hoveredMemorySource;
      const previousHoveredLinkIndex = hoveredLinkIndex;
      hoveredMemoryId = hit ? String(nodeMeta[hit.index].id) : null;
      hoveredMemorySource = hit ? nodeMeta[hit.index].source : null;
      hoveredLinkIndex = -1;
      if (hoveredMemoryId === null && currentLinks.length) {
        const lineHit = raycaster.intersectObject(lines, false).find((item) => edgeMeta[segmentToEdge[Math.floor((item.index || 0) / 2)]]?.memoryLink);
        if (lineHit) hoveredLinkIndex = segmentToEdge[Math.floor((lineHit.index || 0) / 2)];
      }
      if (hit) {
        const node = nodeMeta[hit.index];
        tooltip.textContent = `${node.title}\n${node.source}`;
      } else if (hoveredLinkIndex >= 0) {
        const edge = edgeMeta[hoveredLinkIndex];
        tooltip.textContent = `${edge.linkKind || 'Memory'} link${edge.linkScore !== null && edge.linkScore !== undefined && Number.isFinite(Number(edge.linkScore)) ? ` · score ${Number(edge.linkScore).toFixed(2)}` : ''}`;
      } else {
        tooltip.hidden = true;
        if (previousHoveredMemoryId !== null || previousHoveredMemorySource !== null || previousHoveredLinkIndex >= 0) lineVisualDirty = true;
        scheduleFrame(); return;
      }
      tooltip.hidden = false;
      tooltip.style.transform = `translate3d(${event.clientX - rect.left + 12}px, ${event.clientY - rect.top + 12}px, 0)`;
      if (previousHoveredMemoryId !== hoveredMemoryId || previousHoveredMemorySource !== hoveredMemorySource || previousHoveredLinkIndex !== hoveredLinkIndex) lineVisualDirty = true;
      scheduleFrame();
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('click', onPointerClick);
    labels.domElement.addEventListener('click', onPointerClick);
    const onOrbitPointerDown = (event) => { orbitPointerStart = [event.clientX, event.clientY]; };
    const onOrbitPointerMove = (event) => {
      if (orbitPointerStart && Math.hypot(event.clientX - orbitPointerStart[0], event.clientY - orbitPointerStart[1]) > 4) {
        manualOrbitPaused = true;
        focusMove = null;
      }
    };
    const onOrbitPointerUp = () => { orbitPointerStart = null; };
    labels.domElement.addEventListener('pointerdown', onOrbitPointerDown);
    labels.domElement.addEventListener('pointermove', onOrbitPointerMove);
    labels.domElement.addEventListener('pointerup', onOrbitPointerUp);
    labels.domElement.addEventListener('pointercancel', onOrbitPointerUp);
    const onPointerLeave = () => { tooltip.hidden = true; hoveredMemoryId = null; hoveredMemorySource = null; hoveredLinkIndex = -1; lineVisualDirty = true; scheduleFrame(); };
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    let previousWidth = 0;
    let previousHeight = 0;
    function resize(forceResourceReset = false) {
      const width = Math.max(1, host.clientWidth - (host.__brainGraphCollapsed ? 0 : host.__brainGraphSidebarWidth));
      const height = Math.max(1, host.clientHeight);
      const dimensionsChanged = width !== previousWidth || height !== previousHeight;
      if (dimensionsChanged || forceResourceReset) {
        pointGeometry.dispose();
        lineGeometry.dispose();
        composer.renderTarget1.dispose();
        composer.renderTarget2.dispose();
        bloomPass.dispose();
        previousWidth = width;
        previousHeight = height;
      }
      camera.aspect = width / height; camera.updateProjectionMatrix();
      renderer.setSize(width, height); labels.setSize(width, height); composer.setSize(width, height);
      bloomPass.setSize(Math.max(1, width * (performanceMode ? 0.5 : 1)), Math.max(1, height * (performanceMode ? 0.5 : 1)));
      pointMat.uniforms.pixelRatio.value = renderer.getPixelRatio();
      if (!manualOrbitPaused && initialized) fitView(true);
      scheduleFrame();
    }
    let resizeTimer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => resize(), 60);
    });
    host.__brainGraphCollapsed = sidebarCollapsed;
    host.__brainGraphSidebarWidth = sidebarWidth;
    observer.observe(host); resize(); fitView(false);
    host.__brainGraphResize = resize;

    const whiteColor = new THREE.Color('#ffffff');
    const scratchColor = new THREE.Color();
    const packetPosition = new THREE.Vector3();
    const anchorPositions = new Map(SOURCES.map((key) => [key, new THREE.Vector3(...ANCHORS[key])]));
    function setPacketPosition(start, anchor, t, target) {
      if (t < 0.58) target.copy(start).lerp(anchor, t / 0.58);
      else target.copy(anchor).lerp(HUB, (t - 0.58) / 0.42);
    }
    function animateMemoryEvent(event, id, elapsed, strength, now, attr, pos, scale, glow, packetAlpha) {
      const idx = memorySlot.get(id);
      if (idx === undefined) return;
      scale[idx] = event.kind === 'add' ? Math.min(1, elapsed / 0.32) : 1 + 0.24 * strength;
      glow[idx] = (event.kind === 'retrieve' ? 1.6 : 1.1) * strength;
      const base = packetSlots.get(id);
      if (base !== undefined && elapsed > 0.38) {
        const travel = Math.min(1, (elapsed - 0.38) / (event.kind === 'retrieve' ? 1.35 : 0.95));
        const anchor = anchorPositions.get(nodeMeta[idx].source);
        const start = nodeMeta[idx].position;
        for (let p = 0; p < 3; p++) {
          const lag = p * 0.055;
          setPacketPosition(start, anchor, Math.max(0, travel - lag), packetPosition);
          packetPosition.toArray(pos, (base + p) * 3);
          packetAlpha[base + p] = Math.max(0, (1 - lag * 5) * strength * 0.95);
        }
        if (travel > 0.55) {
          scratchColor.set(event.kind === 'link' ? (event.linkKind === 'semantic' ? '#55c7bd' : '#ffffff') : COLORS[event.source] || '#ffffff');
          hubFlash.color.copy(scratchColor);
          hubFlash.strength = Math.max(hubFlash.strength, strength);
          hubFlash.until = now + 120;
        }
      }
      if (event.kind === 'retrieve') {
        scratchColor.copy(whiteColor).lerp(nodeMeta[idx].color, 1 - strength * 0.8);
        scratchColor.toArray(attr.baseColor.array, idx * 3);
      }
    }
    function brightenEdge(edge, strength, color, lineGlow, lineColors) {
      if (!edge) return;
      for (let localSegment = 0; localSegment < edge.segmentCount; localSegment++) {
        const segment = edge.segmentStart + localSegment;
        lineGlow[2 * segment] = lineGlow[2 * segment + 1] = Math.max(lineGlow[2 * segment], strength);
        if (color) {
          color.toArray(lineColors, segment * 6);
          color.toArray(lineColors, segment * 6 + 3);
        }
      }
    }
    let lastFrameAt = -Infinity;
    let lastLabelRenderAt = 0;
    let graphReadyReported = false;
    let frameSampleStartedAt = performance.now();
    let frameSampleDuration = 0;
    let frameSampleCount = 0;
    function animate(frameTime) {
      const renderStartedAt = performance.now();
      rafPending = false;
      raf = 0;
      if (document.visibilityState === 'hidden') return;
      const now = Number.isFinite(frameTime) ? frameTime : performance.now();
      if (!graphReadyReported) { graphReadyReported = true; void window.brain?.reportGraphReady?.(); }
      const focusWasMoving = Boolean(focusMove);
      const controlsMoving = focusWasMoving ? false : Boolean(controls.update());
      const cameraMoving = controlsMoving || focusWasMoving;
      const frameInterval = graphFrameIntervalMs(performanceMode, cameraMoving);
      const sinceLastFrame = now - lastFrameAt;
      if (sinceLastFrame < frameInterval) {
        scheduleFrame(frameInterval - sinceLastFrame);
        return;
      }
      lastFrameAt = now;
      const attr = pointGeometry.attributes;
      const pos = attr.position.array;
      const scale = attr.nodeScale.array;
      const glow = attr.nodeGlow.array;
      const packetAlpha = attr.packetAlpha.array;
      const hadActiveEvents = events.length > 0;
      const updateNodeBuffers = shouldUpdateNodeBuffers(events.length, hubFlash.until, hubFlash.strength, now);
      if (updateNodeBuffers) {
        scale.fill(1); glow.fill(0); packetAlpha.fill(0);
        for (let i = 0; i < nodeMeta.length; i++) nodeMeta[i].color.toArray(attr.baseColor.array, i * 3);
        for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
          const event = events[eventIndex];
          const elapsed = (now - event.startedAt) / 1000;
          const duration = event.kind === 'retrieve' ? 2 : event.kind === 'add' ? 1.7 : 1.6;
          if (elapsed > duration) continue;
          const strength = Math.max(0, 1 - elapsed / duration);
          if (event.kind === 'link') {
            animateMemoryEvent(event, event.aId, elapsed, strength, now, attr, pos, scale, glow, packetAlpha);
            animateMemoryEvent(event, event.bId, elapsed, strength, now, attr, pos, scale, glow, packetAlpha);
          } else animateMemoryEvent(event, event.memoryId, elapsed, strength, now, attr, pos, scale, glow, packetAlpha);
          if (event.kind === 'retrieve') for (let linkedOffset = 0; linkedOffset < event.linkedIds.length; linkedOffset++) {
            const id = event.linkedIds[linkedOffset];
            const idx = memorySlot.get(id);
            if (idx === undefined) continue;
            glow[idx] = Math.max(glow[idx], 1.25 * strength);
            scale[idx] = Math.max(scale[idx], 1 + 0.15 * strength);
            scratchColor.copy(whiteColor).lerp(nodeMeta[idx].color, 1 - strength * 0.8).toArray(attr.baseColor.array, idx * 3);
          }
        }
        let eventWrite = 0;
        for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
          const event = events[eventIndex];
          if ((now - event.startedAt) < (event.kind === 'retrieve' ? 2000 : 1800)) events[eventWrite++] = event;
        }
        events.length = eventWrite;
        if (hubFlash.until < now) hubFlash.strength *= 0.93;
        if (hubFlash.strength <= 0.01) hubFlash.strength = 0;
        scratchColor.copy(whiteColor);
        if (hubFlash.strength > 0) scratchColor.lerp(hubFlash.color, Math.min(1, hubFlash.strength));
        scratchColor.toArray(attr.baseColor.array, 0);
        glow[0] = hubFlash.strength * 1.2;
        attr.baseColor.needsUpdate = true;
        attr.nodeScale.needsUpdate = true;
        attr.nodeGlow.needsUpdate = true;
        attr.packetAlpha.needsUpdate = true;
        if (hadActiveEvents && !performanceMode) attr.position.needsUpdate = true;
      }

      const hadEdgeDraws = edgeDraws.size > 0;
      if (hadEdgeDraws) {
        const linePositions = lineGeometry.attributes.position.array;
        for (const [edgeKey, draw] of edgeDraws) {
          const edgeNumber = edgeIndex.get(edgeKey);
          const edge = edgeNumber === undefined ? null : edgeMeta[edgeNumber];
          if (!edge) { edgeDraws.delete(edgeKey); continue; }
          const elapsed = now - draw.startedAt;
          const rawProgress = Math.min(1, Math.max(0, elapsed / Math.max(1, draw.duration)));
          const progress = edge.memoryLink ? rawProgress * rawProgress * (3 - 2 * rawProgress) : rawProgress;
          const start = draw.start, end = draw.end;
          const offset = edge.segmentStart * 6;
          linePositions[offset] = start.x;
          linePositions[offset + 1] = start.y;
          linePositions[offset + 2] = start.z;
          linePositions[offset + 3] = start.x + (end.x - start.x) * progress;
          linePositions[offset + 4] = start.y + (end.y - start.y) * progress;
          linePositions[offset + 5] = start.z + (end.z - start.z) * progress;
        }
        lineGeometry.attributes.position.needsUpdate = true;
      }

      if (shouldUpdateLineBuffers(hadActiveEvents, hadEdgeDraws, lineVisualDirty)) {
        const lineGlow = lineGeometry.attributes.lineGlow.array;
        const lineColors = lineGeometry.attributes.baseColor.array;
        const lineAlpha = lineGeometry.attributes.baseAlpha.array;
        lineGlow.fill(0);
        for (let edgeNumber = 0; edgeNumber < edgeMeta.length; edgeNumber++) {
          const edge = edgeMeta[edgeNumber];
          for (let localSegment = 0; localSegment < edge.segmentCount; localSegment++) {
            const segment = edge.segmentStart + localSegment;
            edge.color.toArray(lineColors, segment * 6);
            edge.color.toArray(lineColors, segment * 6 + 3);
            let alpha = edge.alpha;
            let drawDone = false;
            const activeDraw = edgeDraws.get(edge.key);
            if (activeDraw && edge.memoryLink) {
              const elapsed = now - activeDraw.startedAt;
              const rawProgress = Math.min(1, Math.max(0, elapsed / Math.max(1, activeDraw.duration)));
              if (elapsed < 0) alpha = 0;
              else if (rawProgress < 1) alpha = 0.48;
              else {
                const settle = Math.min(1, Math.max(0, (elapsed - activeDraw.duration) / Math.max(1, activeDraw.settleDuration)));
                const easedSettle = settle * settle * (3 - 2 * settle);
                alpha = 0.48 + (edge.alpha - 0.48) * easedSettle;
                drawDone = settle >= 1;
              }
            } else if (activeDraw) {
              alpha = now < activeDraw.startedAt ? 0 : now < activeDraw.startedAt + activeDraw.duration ? 0.65 : edge.alpha;
              if (!edge.memoryLink && now >= activeDraw.startedAt + activeDraw.duration) edgeDraws.delete(edge.key);
            }
            if (hoveredMemoryId !== null && !(activeDraw && alpha === 0)) {
              const ownMemoryEdge = edge.key === `memory:${hoveredMemoryId}` || edge.key === `anchor:${hoveredMemorySource}`;
              const ownLinkEdge = edge.memoryLink && edge.linkMemoryIds.includes(hoveredMemoryId);
              alpha = ownMemoryEdge ? 0.8 : ownLinkEdge ? 0.6 : edge.alpha * 0.4;
            } else if (hoveredLinkIndex >= 0 && !(activeDraw && alpha === 0)) alpha = edgeNumber === hoveredLinkIndex ? 0.6 : edge.alpha * 0.4;
            if (performanceMode) alpha *= 0.55;
            lineAlpha[2 * segment] = lineAlpha[2 * segment + 1] = alpha;
            if (drawDone) edgeDraws.delete(edge.key);
          }
        }
        for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
          const event = events[eventIndex];
          const elapsed = (now - event.startedAt) / 1000;
          const strength = Math.max(0, 1 - elapsed / (event.kind === 'retrieve' ? 2 : 1.5));
          const edgeStrength = performanceMode ? 0.55 : 1;
          let edgeNumber = edgeIndex.get(`memory:${event.kind === 'link' ? event.aId : event.memoryId}`);
          if (edgeNumber !== undefined) brightenEdge(edgeMeta[edgeNumber], 0.35 * strength * edgeStrength, null, lineGlow, lineColors);
          if (event.kind === 'link') {
            edgeNumber = edgeIndex.get(`memory:${event.bId}`);
            if (edgeNumber !== undefined) brightenEdge(edgeMeta[edgeNumber], 0.35 * strength * edgeStrength, null, lineGlow, lineColors);
          }
          edgeNumber = edgeIndex.get(`anchor:${event.source}`);
          if (edgeNumber !== undefined) brightenEdge(edgeMeta[edgeNumber], 0.4 * strength * edgeStrength, null, lineGlow, lineColors);
          if (event.kind === 'link') {
            edgeNumber = edgeIndex.get(`link:${event.linkId}`);
            if (edgeNumber !== undefined) brightenEdge(edgeMeta[edgeNumber], 0.35 * strength * edgeStrength, null, lineGlow, lineColors);
          }
          if (event.kind === 'retrieve') for (let linkedOffset = 0; linkedOffset < event.linkedIds.length; linkedOffset++) {
            const id = event.linkedIds[linkedOffset];
            edgeNumber = edgeIndex.get(`memory:${id}`);
            if (edgeNumber !== undefined) {
              scratchColor.copy(whiteColor).lerp(edgeMeta[edgeNumber].color, 1 - strength);
              brightenEdge(edgeMeta[edgeNumber], 0.4 * strength * edgeStrength, scratchColor, lineGlow, lineColors);
            }
            const linkedIndex = memorySlot.get(id);
            const anchorEdge = linkedIndex === undefined ? undefined : edgeIndex.get(`anchor:${nodeMeta[linkedIndex].source}`);
            if (anchorEdge !== undefined) brightenEdge(edgeMeta[anchorEdge], 0.4 * strength * edgeStrength, null, lineGlow, lineColors);
            const link = currentLinkByPair.get(graphLinkPairKey(event.memoryId, id));
            if (link) {
              const linkEdge = edgeIndex.get(`link:${String(link.id ?? `${link.a_id}-${link.b_id}`)}`);
              if (linkEdge !== undefined) brightenEdge(edgeMeta[linkEdge], 0.5 * strength * edgeStrength, whiteColor, lineGlow, lineColors);
            }
          }
        }
        lineGeometry.attributes.lineGlow.needsUpdate = true;
        lineGeometry.attributes.baseColor.needsUpdate = true;
        lineGeometry.attributes.baseAlpha.needsUpdate = true;
        lineVisualDirty = false;
      }
      if (focusMove) {
        const progress = Math.min(1, (now - focusMove.startedAt) / focusMove.duration);
        const eased = progress * progress * (3 - 2 * progress);
        camera.position.lerpVectors(focusMove.cameraFrom, focusMove.cameraTo, eased);
        controls.target.lerpVectors(focusMove.targetFrom, focusMove.targetTo, eased);
        if (progress >= 1) {
          focusMove = null;
          if (restoringView) { savedView = clearSavedView(); restoringView = false; }
        }
      }
      const focusControlsMoving = focusWasMoving ? Boolean(controls.update()) : false;
      composer.render();
      if (shouldRenderGraphLabels(performanceMode, cameraMoving || focusControlsMoving, now, lastLabelRenderAt)) {
        labels.render(scene, camera);
        lastLabelRenderAt = now;
      }
      const keepAnimating = shouldKeepGraphAnimating(controlsMoving, Boolean(focusMove), events.length, edgeDraws.size, hubFlash.until >= now || hubFlash.strength > 0.01);
      frameSampleDuration += performance.now() - renderStartedAt;
      frameSampleCount++;
      if (performance.now() - frameSampleStartedAt >= 1000) {
        if (frameSampleCount) window.brain?.reportGraphFrame?.({ frameMs: frameSampleDuration / frameSampleCount, fps: frameSampleCount / Math.max(0.001, (performance.now() - frameSampleStartedAt) / 1000) });
        frameSampleStartedAt = performance.now(); frameSampleDuration = 0; frameSampleCount = 0;
      }
      if (keepAnimating || focusControlsMoving) scheduleFrame(frameInterval);
    }
    animateFrame = animate;
    scheduleFrame();
    const style = document.createElement('style');
    style.textContent = `
      .brain-webgl,.brain-label-layer { position:absolute; inset:0; width:100%; height:100%; }
      .brain-label-layer { pointer-events:auto; overflow:hidden; right:0; }
      .brain-webgl { right:0; }
      .brain-label-card { display:grid; grid-template-columns:8px auto; align-items:center; gap:2px 7px; padding:7px 9px; border:1px solid rgba(182,195,216,.24); border-radius:8px; color:#e5e7eb; background:rgba(11,16,32,.94); font:11px/1.2 system-ui,sans-serif; white-space:nowrap; }
      .brain-label-dot { width:7px;height:7px;border-radius:50%;grid-row:span 2; }
      .brain-label-card strong { font-weight:600;text-transform:capitalize; }
      .brain-label-count { color:#aab8ca;font-size:9px; }
      .brain-memory-tooltip { position:absolute;z-index:4;max-width:280px;padding:7px 9px;border:1px solid rgba(180,200,228,.24);border-radius:6px;color:#eef4ff;background:rgba(11,16,32,.97);font:12px/1.4 system-ui,sans-serif;white-space:pre-line;pointer-events:none; }
      .brain-performance-count { position:absolute;z-index:5;left:14px;top:14px;padding:5px 8px;border:1px solid rgba(240,191,99,.28);border-radius:6px;color:#f0bf63;background:rgba(11,16,32,.9);font:10px/1.2 system-ui,sans-serif; }
      .brain-fit-button { position:absolute;z-index:5;right:18px;bottom:18px;padding:7px 12px;border:1px solid rgba(190,210,238,.24);border-radius:7px;color:#dce8f8;background:rgba(12,19,32,.86);font:11px/1 system-ui,sans-serif;cursor:pointer; }
      .brain-fit-button:hover { background:rgba(35,48,68,.96); }
      .brain-links-control { position:absolute;z-index:6;right:18px;top:18px;font:12px/1.4 system-ui,sans-serif; }
      .brain-links-button { padding:7px 11px;border:1px solid rgba(190,210,238,.24);border-radius:7px;color:#dce8f8;background:rgba(11,16,32,.94);font:inherit;cursor:pointer; }
      .brain-links-popover { position:absolute;top:calc(100% + 6px);right:0;width:250px;padding:11px;border:1px solid rgba(190,210,238,.25);border-radius:9px;color:#e5e7eb;background:#111827; }
      .brain-links-popover[hidden] { display:none; }
      .brain-link-master,.brain-link-options label { display:flex;align-items:center;gap:8px;min-height:30px;color:#d4dbe6;cursor:pointer; }
      .brain-link-master { padding-bottom:7px;border-bottom:1px solid #1f2a44;font-weight:600; }
      .brain-link-options { display:grid;padding:5px 0; }.brain-link-options input,.brain-link-master input { accent-color:#60a5fa; }
      .brain-link-options b { margin-left:auto;color:#9ca3af;font-weight:500;font-variant-numeric:tabular-nums; }
      .brain-link-swatch { width:21px;height:2px;background:rgba(255,255,255,.36); }
      .brain-link-cap { display:block;color:#f0bf63;font-size:10px; }
      .brain-legend { position:absolute;z-index:5;left:14px;bottom:14px;min-width:122px;padding:6px 9px;border:1px solid rgba(190,210,238,.2);border-radius:7px;color:#d1d8e2;background:rgba(11,16,32,.9);font:10px/1.5 system-ui,sans-serif; }
      .brain-legend summary { cursor:pointer; }.brain-legend div { display:flex;align-items:center;gap:7px;padding:3px 0; }
      .brain-legend-structural { width:20px;height:2px;background:#60a5fa; }.brain-legend-link { width:20px;height:2px;background:rgba(255,255,255,.3); }
    `;
    host.appendChild(style);

    return () => {
      if (rafPending) cancelAnimationFrame(raf);
      if (frameTimer) clearTimeout(frameTimer);
      clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect(); controls.dispose();
      window.removeEventListener(PERFORMANCE_MODE_EVENT, onPerformanceModeChange);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onGraphPointerDown);
      labels.domElement.removeEventListener('pointerdown', onGraphPointerDown);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('click', onPointerClick);
      labels.domElement.removeEventListener('click', onPointerClick);
      labels.domElement.removeEventListener('pointerdown', onOrbitPointerDown);
      labels.domElement.removeEventListener('pointermove', onOrbitPointerMove);
      labels.domElement.removeEventListener('pointerup', onOrbitPointerUp);
      labels.domElement.removeEventListener('pointercancel', onOrbitPointerUp);
      composer.dispose(); bloomPass.dispose(); pointGeometry.dispose(); lineGeometry.dispose(); pointMat.dispose(); lineMat.dispose();
      renderer.dispose(); labels.domElement.remove(); tooltip.remove(); fitButton.remove(); linksControl.remove(); legend.remove(); style.remove();
      performanceCount.remove();
      delete host.__brainGraphRebuild;
      delete host.__brainGraphResize;
      delete host.__brainGraphFit;
      delete host.__brainGraphLinkState;
      delete host.__brainGraphRevealLinks;
      for (const obj of Object.values(labelObjects)) obj.remove();
      host.replaceChildren();
    };
  }, []);

  useEffect(() => { hostRef.current?.__brainGraphLinkState?.(linkVisibility, linkCounts); }, [linkVisibility, linkCounts, onLinkVisibilityChange]);
  useEffect(() => { hostRef.current?.__brainGraphFit?.(); }, [fitRevision]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      host.__brainGraphCollapsed = sidebarCollapsed;
      host.__brainGraphSidebarWidth = sidebarWidth;
      const webgl = host.querySelector('.brain-webgl');
      const labelLayer = host.querySelector('.brain-label-layer');
      if (webgl) webgl.style.left = sidebarCollapsed ? '0' : `${sidebarWidth}px`;
      if (labelLayer) labelLayer.style.left = sidebarCollapsed ? '0' : `${sidebarWidth}px`;
      if (webgl) webgl.style.width = sidebarCollapsed ? '100%' : `calc(100% - ${sidebarWidth}px)`;
      if (labelLayer) labelLayer.style.width = sidebarCollapsed ? '100%' : `calc(100% - ${sidebarWidth}px)`;
      host.__brainGraphResize?.();
    }
  }, [sidebarCollapsed, sidebarWidth]);

  // Keep the latest data available to the persistent renderer and rebuild only on data changes.
  useEffect(() => {
    const host = hostRef.current;
    const graph = host?.__brainGraphRebuild;
    if (graph && dataReady) {
      graph(memories, links, counts, allLinks);
      if (!initialLinkRevealDoneRef.current) {
        host.__brainGraphRevealLinks?.();
        initialLinkRevealDoneRef.current = true;
      }
    }
  }, [memories, links, allLinks, counts, dataReady]);

  useEffect(() => {
    if (linksJustEnabled(previousLinkVisibilityRef.current, linkVisibility)) hostRef.current?.__brainGraphRevealLinks?.();
    previousLinkVisibilityRef.current = linkVisibility;
  }, [linkVisibility]);

  return <div ref={hostRef} className="brain-graph" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
    {toolbar && <div className="graph-toolbar">{toolbar}</div>}
    {webglUnavailable && <section aria-label="Memory graph" className="brain-graph-fallback" style={{ position: 'absolute', inset: '18px 12px 18px max(12px, min(360px, 92vw))', overflow: 'auto', padding: 18, border: '1px solid #263241', borderRadius: 12, color: '#e8edf4', background: '#0b0f16', font: '13px system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>3D graph unavailable</h2>
      <p style={{ margin: '0 0 14px', color: '#9aa8b8' }}>This graphics driver could not create a WebGL context. Your memories remain available in the list.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {SOURCES.map((source) => <span key={source} style={{ padding: '7px 10px', border: '1px solid #263241', borderRadius: 8, background: '#111720' }}><i style={{ display: 'inline-block', width: 7, height: 7, marginRight: 7, borderRadius: '50%', background: COLORS[source] }} />{source} · {counts[source] || 0}</span>)}
      </div>
      {memories.length > 0 && <ul style={{ display: 'grid', gap: 5, margin: '14px 0 0', paddingLeft: 20 }}>{memories.slice(0, 12).map((memory) => <li key={memory.id}><button type="button" onClick={() => onMemoryClickRef.current(memory.id)} style={{ border: 0, color: '#cbd7e5', background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>{memory.title || 'Untitled memory'}</button></li>)}</ul>}
    </section>}
  </div>;
});

export default BrainGraph;
