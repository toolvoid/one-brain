const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, value) => [a[0] * value, a[1] * value, a[2] * value];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => { const n = length(a) || 1; return scale(a, 1 / n); };
const distance = (a, b) => length(subtract(a, b));

export function boundingSphere(points) {
  const rows = (Array.isArray(points) ? points : []).filter((point) => Array.isArray(point) && point.length >= 3 && point.slice(0, 3).every(Number.isFinite));
  if (!rows.length) return { center: [0, 0, 0], radius: 1 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of rows) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  return { center, radius: Math.max(1, ...rows.map((point) => distance(point, center))) };
}

export function cameraDistanceForSphere(radius, fovDegrees, aspect, padding = 1.14, minDistance = 20, maxDistance = 2000) {
  const halfVertical = Math.max(0.01, Math.min(Math.PI / 2 - 0.01, Number(fovDegrees) * Math.PI / 360));
  const safeAspect = Math.max(0.01, Number(aspect) || 1);
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * safeAspect);
  const limitingHalfFov = Math.max(0.01, Math.min(halfVertical, halfHorizontal));
  return Math.min(maxDistance, Math.max(minDistance, Math.max(1, Number(radius) || 1) / Math.sin(limitingHalfFov) * Math.max(1, padding)));
}

export function fitCameraToPoints(points, fovDegrees, aspect, padding = 1.14, minDistance = 20, maxDistance = 2000) {
  const sphere = boundingSphere(points);
  return { ...sphere, distance: cameraDistanceForSphere(sphere.radius, fovDegrees, aspect, padding, minDistance, maxDistance) };
}

export function linkArcPoints(start, end, hub = [0, 0, 0], segments = 24, bow = 9, obstacles = []) {
  const chord = subtract(end, start);
  const chordDirection = normalize(chord);
  const midpoint = scale(add(start, end), 0.5);
  const radial = subtract(midpoint, hub);
  const projected = subtract(radial, scale(chordDirection, dot(radial, chordDirection)));
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const candidates = [];
  if (length(projected) > 1e-5) candidates.push(normalize(projected), scale(normalize(projected), -1));
  for (const axis of axes) {
    const perpendicular = cross(chordDirection, axis);
    if (length(perpendicular) > 1e-5) candidates.push(normalize(perpendicular), scale(normalize(perpendicular), -1));
  }
  const samples = (direction) => {
    const control = add(midpoint, scale(direction, Math.max(2, bow)));
    return [0.2, 0.4, 0.5, 0.6, 0.8].map((t) => add(add(scale(start, (1 - t) ** 2), scale(control, 2 * (1 - t) * t)), scale(end, t ** 2)));
  };
  const score = (direction) => Math.min(...samples(direction).flatMap((point) => [
    distance(point, hub) - 1.8,
    ...obstacles.map((obstacle) => distance(point, obstacle) - 3.5)
  ]));
  let outward = candidates[0] || [0, 1, 0];
  for (const candidate of candidates.slice(1)) if (score(candidate) > score(outward)) outward = candidate;
  const control = add(midpoint, scale(outward, Math.max(2, bow)));
  const count = Math.max(1, Math.floor(segments));
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count, inverse = 1 - t;
    return add(add(scale(start, inverse * inverse), scale(control, 2 * inverse * t)), scale(end, t * t));
  });
}
