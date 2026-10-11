export function saveViewBeforeFocus(savedView, position, target) {
  if (savedView) return savedView;
  return { position: { x: position.x, y: position.y, z: position.z }, target: { x: target.x, y: target.y, z: target.z } };
}

export function clearSavedView() { return null; }

