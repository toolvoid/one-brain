export const PERFORMANCE_STATIC_FPS = 30;
export const PERFORMANCE_MOVING_FPS = 30;
export const NORMAL_GRAPH_FPS = 60;

export function graphFrameIntervalMs(performanceMode = false, cameraMoving = false) {
  const fps = performanceMode
    ? (cameraMoving ? PERFORMANCE_MOVING_FPS : PERFORMANCE_STATIC_FPS)
    : NORMAL_GRAPH_FPS;
  return 1000 / fps;
}

export function shouldRenderGraphLabels(performanceMode = false, cameraMoving = false, now = 0, lastRenderedAt = 0) {
  return !performanceMode || cameraMoving || now - lastRenderedAt >= 100;
}

export function shouldUpdateNodeBuffers(eventCount = 0, hubFlashUntil = 0, hubFlashStrength = 0, now = 0) {
  return Number(eventCount) > 0 || Number(hubFlashUntil) >= Number(now) || Number(hubFlashStrength) > 0.01;
}

export function shouldUpdateLineBuffers(eventActive = false, edgeDrawActive = false, visualDirty = false) {
  return Boolean(eventActive || edgeDrawActive || visualDirty);
}

export function shouldKeepGraphAnimating(cameraMoving = false, focusAnimating = false, eventCount = 0, edgeDrawCount = 0, hubFlashActive = false) {
  return Boolean(cameraMoving || focusAnimating || Number(eventCount) > 0 || Number(edgeDrawCount) > 0 || hubFlashActive);
}
