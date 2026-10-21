export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 360;
export const DRAWER_BREAKPOINT = 720;

export function clampSidebarWidth(value) {
  if (value == null || value === '') return SIDEBAR_DEFAULT_WIDTH;
  const width = Number(value);
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readSidebarWidth(storage, key = 'one-brain-sidebar-width') {
  try { return clampSidebarWidth(storage?.getItem(key)); }
  catch { return SIDEBAR_DEFAULT_WIDTH; }
}

export function writeSidebarWidth(storage, value, key = 'one-brain-sidebar-width') {
  const width = clampSidebarWidth(value);
  try { storage?.setItem(key, String(width)); } catch {}
  return width;
}

export function layoutMode(width) {
  return Number(width) <= DRAWER_BREAKPOINT ? 'drawer' : 'sidebar';
}

export function cleanMemoryTitle(value) {
  const title = String(value ?? '').trim();
  return title.replace(/^(?:0(?:\.\d+)?|\.\d+)(?:\s*[-:|·]\s*|\s+)/, '').trim() || title || 'Untitled memory';
}
