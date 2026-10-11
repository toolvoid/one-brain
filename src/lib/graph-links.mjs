export const DEFAULT_LINK_VISIBILITY = Object.freeze({ titleMatched: true, manual: true, semantic: true });

export function graphLinkCounts(links) {
  const rows = Array.isArray(links) ? links : [];
  return {
    titleMatched: rows.filter((link) => link.kind === 'auto').length,
    manual: rows.filter((link) => link.kind === 'manual').length,
    semantic: rows.filter((link) => link.kind === 'semantic').length
  };
}

export function visibleGraphLinks(links, visibility = DEFAULT_LINK_VISIBILITY, maxLinks = 3000) {
  const rows = Array.isArray(links) ? links : [];
  const state = typeof visibility === 'boolean' ? { ...DEFAULT_LINK_VISIBILITY, semantic: visibility } : { ...DEFAULT_LINK_VISIBILITY, ...visibility };
  return rows.filter((link) => {
    if (link.kind === 'semantic') return state.semantic && rows.length <= maxLinks;
    if (link.kind === 'manual') return state.manual;
    if (link.kind === 'auto') return state.titleMatched;
    return false;
  });
}
