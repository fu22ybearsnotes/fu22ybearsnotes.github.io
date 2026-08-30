(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GraphSelection = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function () {
  function resolve(selection, graph, edgeId) {
    const nodeIds = new Set();
    const edgeIds = new Set();
    const getEdgeId = edgeId || graph.edgeId;
    if (selection.nodeId) {
      nodeIds.add(selection.nodeId);
      (graph.adjacency.get(selection.nodeId) || new Set()).forEach(id => nodeIds.add(id));
      graph.links.forEach(link => {
        if (link.sourceId === selection.nodeId || link.targetId === selection.nodeId) edgeIds.add(getEdgeId(link));
      });
    } else if (selection.edgeId) {
      const edge = graph.links.find(link => getEdgeId(link) === selection.edgeId);
      if (edge) {
        edgeIds.add(selection.edgeId);
        nodeIds.add(edge.sourceId);
        nodeIds.add(edge.targetId);
      }
    }
    return { nodeIds, edgeIds };
  }

  return { resolve };
});
