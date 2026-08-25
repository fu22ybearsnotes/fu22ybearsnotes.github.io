/* Graph page (/graph/): renders graph.json (built at Hugo build time from
   related: edges only) with a vendored d3 force layout. No CDN. */
(async () => {
  const svgEl = document.getElementById('graph');
  if (!svgEl) return;
  const data = await fetch('/graph.json').then(r => r.json());
  const { nodes, links } = data;
  const svg = d3.select(svgEl);
  const W = 800, H = 560;

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90))
    .force('charge', d3.forceManyBody().strength(-180))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide(24));

  const link = svg.append('g')
    .selectAll('line').data(links).join('line');

  const node = svg.append('g')
    .selectAll('a').data(nodes).join('a')
    .attr('href', d => d.url);
  node.append('circle').attr('r', 6);
  node.append('text').attr('x', 9).attr('y', 4).text(d => d.title);

  sim.on('tick', () => {
    const clamp = (v, max) => Math.max(10, Math.min(max - 10, v));
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${clamp(d.x, W)},${clamp(d.y, H)})`);
  });

  node.call(d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
})();
