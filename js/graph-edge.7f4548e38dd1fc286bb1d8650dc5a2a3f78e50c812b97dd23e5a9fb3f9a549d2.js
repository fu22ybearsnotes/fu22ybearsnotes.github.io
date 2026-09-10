(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GraphEdge = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function () {
  // Undirected edge identity: one visual edge per endpoint pair.
  function pairKey(a, b) {
    return JSON.stringify([a, b].sort());
  }

  // Normalize raw graph.json links into merged visual edges: a related edge
  // and a series edge of the same undirected pair collapse into one edge that
  // keeps both grounds separately; the authored description travels only with
  // the related ground and never replaces the series ground.
  function mergeLinks(rawLinks, hasNode) {
    const pairs = new Map();
    (rawLinks || []).forEach(raw => {
      if (!raw || typeof raw.source !== 'string' || typeof raw.target !== 'string') return;
      if (raw.source === raw.target) return;
      if (hasNode && (!hasNode(raw.source) || !hasNode(raw.target))) return;
      const key = pairKey(raw.source, raw.target);
      let link = pairs.get(key);
      if (!link) {
        link = { sourceId: raw.source, targetId: raw.target, relatedWeight: 0, seriesWeight: 0, weight: 0, renderKind: 'series', description: null };
        pairs.set(key, link);
      }
      if (raw.kind === 'series') link.seriesWeight += 1;
      else {
        link.relatedWeight += 1;
        if (typeof raw.description === 'string') link.description = raw.description;
      }
    });
    const links = [...pairs.values()];
    links.forEach(link => {
      link.weight = link.relatedWeight + link.seriesWeight;
      link.renderKind = link.relatedWeight ? 'related' : 'series';
    });
    return links;
  }

  // Edge-detail view model for the shared selection panel: link-type labels
  // for every ground, endpoint notes ordered old -> new (publication date,
  // ties by stable id order), and the authored description for related edges.
  function edgeDetail(link, nodeById) {
    const dateValue = node => Number.isFinite(Date.parse(node.date)) ? Date.parse(node.date) : 0;
    const endpoints = [link.sourceId, link.targetId]
      .map(id => nodeById.get(id))
      .filter(Boolean)
      .sort((a, b) => dateValue(a) - dateValue(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const labels = [];
    if (link.relatedWeight) labels.push('связанная заметка');
    if (link.seriesWeight) labels.push('переход между частями серии');
    const description = link.relatedWeight && typeof link.description === 'string' ? link.description : null;
    return { labels, endpoints, description };
  }

  return { pairKey, mergeLinks, edgeDetail };
});