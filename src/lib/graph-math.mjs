const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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

export function straightLinkPoints(start, end) {
  return [start.slice(0, 3), end.slice(0, 3)];
}

export function lineDrawPoints(start, end, progress) {
  const t = Math.min(1, Math.max(0, Number(progress) || 0));
  const tip = start.map((value, axis) => value + (end[axis] - value) * t);
  return [start.slice(0, 3), tip];
}

export function linkLineDrawState(baseAlpha, elapsed, duration = 900, settleDuration = 400, peakAlpha = 0.48) {
  const safeElapsed = Number(elapsed);
  if (!Number.isFinite(safeElapsed) || safeElapsed < 0) return { progress: 0, alpha: 0, done: false };
  const drawProgress = Math.min(1, safeElapsed / Math.max(1, duration));
  const easedDrawProgress = drawProgress * drawProgress * (3 - 2 * drawProgress);
  if (drawProgress < 1) return { progress: easedDrawProgress, alpha: peakAlpha, done: false };
  const settleProgress = Math.min(1, Math.max(0, (safeElapsed - duration) / Math.max(1, settleDuration)));
  const eased = settleProgress * settleProgress * (3 - 2 * settleProgress);
  return {
    progress: 1,
    alpha: peakAlpha + ((Number(baseAlpha) || 0) - peakAlpha) * eased,
    done: settleProgress >= 1
  };
}
