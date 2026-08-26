/* Graph page (/graph/): renders graph.json (built at Hugo build time from
   related: edges + intra-series chain edges) with a vendored d3 force layout.
   No CDN.
   - node radius  ~ weighted degree (mutual relations count double)
   - link width   ~ weight (directional duplicates merged into one undirected
                    edge; if both posts name each other, weight = 2)
   - series edges (kind "series", chaining a series' parts) render dashed
     1px regardless of weight
   - stronger links pull nodes closer together (link strength/distance)
   - zoom/pan: wheel + drag-pan + on-screen buttons
   - click node: highlights the node, its edges and neighbours (dblclick opens post)
   - click edge: highlights the edge and its two endpoints
   - click background / Esc: clears the highlight */
(async () => {
  const svgEl = document.getElementById('graph');
  if (!svgEl) return;
  const data = await fetch('/graph.json').then(r => r.json());
  const nodes = data.nodes.map(d => ({ ...d }));

  // Merge directed edges into undirected weighted links (mutual => stronger).
  const byPair = new Map();
  for (const l of data.links) {
    if (l.source === l.target) continue;
    const key = [l.source, l.target].sort().join('');
    const e = byPair.get(key);
    if (e) { e.weight += 1; if (l.kind === 'related') e.kind = 'related'; }
    else byPair.set(key, { source: l.source, target: l.target, weight: 1, kind: l.kind || 'related' });
  }
  const links = [...byPair.values()];

  const deg = new Map(nodes.map(n => [n.id, 0]));
  for (const l of links) {
    deg.set(l.source, deg.get(l.source) + l.weight);
    deg.set(l.target, deg.get(l.target) + l.weight);
  }
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) { adj.get(l.source).add(l.target); adj.get(l.target).add(l.source); }

  const radius = d => 5 + 2.5 * Math.sqrt(deg.get(d.id) || 0);
  const linkWidth = l => l.kind === 'series' ? 1 : 1 + 1.2 * l.weight;

  const svg = d3.select(svgEl);
  const W = 800, H = 560;
  const viewport = svg.append('g').attr('class', 'viewport');

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id)
      .distance(l => Math.max(45, 95 - 25 * l.weight))
      .strength(l => l.weight / Math.min(deg.get(l.source.id), deg.get(l.target.id))))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide(d => radius(d) + 8));

  const edge = viewport.append('g')
    .selectAll('g.edge').data(links).join('g').attr('class', 'edge');
  edge.append('line').attr('class', 'hit');
  edge.append('line').attr('class', 'vis')
    .attr('stroke-width', linkWidth)
    .attr('stroke-dasharray', l => l.kind === 'series' ? '4 3' : null);

  const node = viewport.append('g')
    .selectAll('g.node').data(nodes).join('g').attr('class', 'node');
  node.append('circle').attr('r', radius);
  node.append('text')
    .attr('x', d => radius(d) + 4).attr('y', 4)
    .text(d => d.title);
  node.append('title').text(d => d.title);

  // --- zoom / pan -----------------------------------------------------------
  const zoom = d3.zoom()
    .scaleExtent([0.25, 5])
    .on('zoom', e => viewport.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null); // dblclick is taken by "open post"
  const tween = () => svg.transition().duration(220);
  document.querySelectorAll('.graph-controls button').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = 110;
      const act = btn.dataset.act;
      if (act === 'zoom-in') tween().call(zoom.scaleBy, 1.4);
      else if (act === 'zoom-out') tween().call(zoom.scaleBy, 1 / 1.4);
      else if (act === 'pan-left') tween().call(zoom.translateBy, step, 0);
      else if (act === 'pan-right') tween().call(zoom.translateBy, -step, 0);
      else if (act === 'pan-up') tween().call(zoom.translateBy, 0, step);
      else if (act === 'pan-down') tween().call(zoom.translateBy, 0, -step);
      else if (act === 'reset') tween().duration(400).call(zoom.transform, d3.zoomIdentity);
    });
  });

  // --- highlighting -----------------------------------------------------------
  const clear = () => {
    node.classed('active', false).classed('neighbor', false).classed('faded', false);
    edge.classed('active', false).classed('faded', false);
  };
  const focusNode = d => {
    const ids = adj.get(d.id);
    node.classed('active', n => n.id === d.id)
        .classed('neighbor', n => ids.has(n.id))
        .classed('faded', n => n.id !== d.id && !ids.has(n.id));
    edge.classed('active', l => l.source.id === d.id || l.target.id === d.id)
        .classed('faded', l => l.source.id !== d.id && l.target.id !== d.id);
  };
  const focusEdge = l => {
    const a = l.source.id, b = l.target.id;
    node.classed('active', n => n.id === a || n.id === b)
        .classed('neighbor', false)
        .classed('faded', n => n.id !== a && n.id !== b);
    edge.classed('active', e => e === l)
        .classed('faded', e => e !== l);
  };
  node.on('click', (e, d) => { e.stopPropagation(); focusNode(d); });
  edge.on('click', (e, l) => { e.stopPropagation(); focusEdge(l); });
  svg.on('click', clear); // d3 suppresses this after a pan-drag
  document.addEventListener('keydown', e => { if (e.key === 'Escape') clear(); });
  node.on('dblclick', (e, d) => { e.stopPropagation(); window.location.href = d.url; });

  sim.on('tick', () => {
    for (const d of nodes) {
      const m = radius(d) + 6;
      d.x = Math.max(m, Math.min(W - m, d.x));
      d.y = Math.max(m, Math.min(H - m, d.y));
    }
    edge.selectAll('line')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  node.call(d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
})();
