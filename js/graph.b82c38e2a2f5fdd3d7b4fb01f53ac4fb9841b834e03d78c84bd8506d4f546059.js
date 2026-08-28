(() => {
  const svgEl = document.getElementById('graph');
  if (!svgEl || !window.d3) return;

  const box = svgEl.closest('.graph-box');
  const searchInput = document.getElementById('graph-search');
  const resultsEl = document.getElementById('graph-results');
  const filtersEl = document.getElementById('graph-filters');
  const filterButton = document.querySelector('[data-act="filters"]');
  const filterCount = document.querySelector('[data-filter-count]');
  const panelEl = box.querySelector('.graph-panel');
  const tooltipEl = box.querySelector('.graph-tooltip');
  const emptyEl = box.querySelector('.graph-empty');
  const statusEl = document.querySelector('.graph-status');
  const state = {
    size: { width: 0, height: 0 },
    camera: { fitScale: 1, transform: d3.zoomIdentity, userInteracted: false },
    selection: { type: null, nodeId: null, edgeId: null, panelOpen: false },
    hover: { type: null, id: null },
    search: { query: '', matchIds: [], resultIds: [], activeIndex: -1, open: false },
    filters: { tags: new Set(), includeUntagged: false, yearMin: null, yearMax: null, series: new Set(), popoverOpen: false },
    visibleNodeIds: new Set(), graph: null
  };
  let svg, viewport, nodeSel, edgeSel, zoom, simulation, resizeObserver, settled = false;

  const setStatus = text => { statusEl.textContent = text; };
  const parseSeries = id => {
    const match = /^(\d+(?:-\d+)*)-n-(.+)$/.exec(id);
    if (!match) return null;
    return { stem: match[2], part: match[1], sort: match[1].split('-').map(Number) };
  };
  const pairKey = (a, b) => JSON.stringify([a, b].sort());
  const dateValue = node => Number.isFinite(Date.parse(node.date)) ? Date.parse(node.date) : 0;
  const nodeYear = node => {
    const value = new Date(node.date).getFullYear();
    return Number.isFinite(value) ? value : null;
  };
  const radius = node => 5 + 2.5 * Math.sqrt(node.relatedDegree || 0);
  const edgeId = edge => pairKey(edge.sourceId, edge.targetId);

  function normaliseGraph(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) throw new Error('неверный формат graph.json');
    const nodeById = new Map();
    data.nodes.forEach(raw => {
      if (!raw || typeof raw.id !== 'string' || !raw.id || nodeById.has(raw.id)) return;
      const node = { ...raw, tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [], series: parseSeries(raw.id), relatedDegree: 0, layoutDegree: 0 };
      nodeById.set(node.id, node);
    });
    const pairs = new Map();
    data.links.forEach(raw => {
      if (!raw || typeof raw.source !== 'string' || typeof raw.target !== 'string' || raw.source === raw.target || !nodeById.has(raw.source) || !nodeById.has(raw.target)) return;
      const key = pairKey(raw.source, raw.target);
      let link = pairs.get(key);
      if (!link) {
        link = { sourceId: raw.source, targetId: raw.target, relatedWeight: 0, seriesWeight: 0, weight: 0, renderKind: 'series' };
        pairs.set(key, link);
      }
      if (raw.kind === 'series') link.seriesWeight += 1;
      else link.relatedWeight += 1;
    });
    const links = [...pairs.values()];
    links.forEach(link => {
      link.weight = link.relatedWeight + link.seriesWeight;
      link.renderKind = link.relatedWeight ? 'related' : 'series';
      const source = nodeById.get(link.sourceId), target = nodeById.get(link.targetId);
      source.layoutDegree += 1;
      target.layoutDegree += 1;
      if (link.relatedWeight) {
        source.relatedDegree += link.relatedWeight;
        target.relatedDegree += link.relatedWeight;
      }
    });
    const nodes = [...nodeById.values()];
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    const relatedNeighbours = new Map(nodes.map(node => [node.id, new Set()]));
    links.forEach(link => {
      adjacency.get(link.sourceId).add(link.targetId);
      adjacency.get(link.targetId).add(link.sourceId);
      if (link.relatedWeight) {
        relatedNeighbours.get(link.sourceId).add(link.targetId);
        relatedNeighbours.get(link.targetId).add(link.sourceId);
      }
    });
    const seriesGroups = new Map();
    nodes.filter(node => node.series).forEach(node => {
      const group = seriesGroups.get(node.series.stem) || [];
      group.push(node);
      seriesGroups.set(node.series.stem, group);
    });
    seriesGroups.forEach(group => group.sort((a, b) => a.series.sort.join('.').localeCompare(b.series.sort.join('.'), undefined, { numeric: true })));
    const visibleSeries = new Set([...seriesGroups].filter(([, group]) => group.length >= 2).map(([stem]) => stem));
    return { nodes, links, nodeById, adjacency, relatedNeighbours, seriesGroups, visibleSeries };
  }

  function loadGraph() {
    const url = svgEl.dataset.graphUrl;
    if (!url) return Promise.reject(new Error('не задан адрес graph.json'));
    return fetch(url).then(response => {
      if (!response.ok) throw new Error(`не удалось загрузить граф: ${response.status}`);
      return response.json();
    }).then(normaliseGraph);
  }

  function measureLabels() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = '11px system-ui';
    const degrees = state.graph.nodes.map(node => node.layoutDegree).sort((a, b) => a - b);
    const hubIndex = Math.max(0, Math.ceil(degrees.length * .985) - 1);
    const threshold = degrees[hubIndex] || Infinity;
    state.graph.nodes.forEach(node => {
      node.labelWidth = context.measureText(node.title).width;
      node.hubLabel = node.layoutDegree >= threshold && node.layoutDegree > 0;
      node.isolate = node.layoutDegree === 0;
    });
  }

  function labelRectCollide(nodes) {
    let localNodes = nodes;
    function force(alpha) {
      const labels = localNodes.filter(node => node.hubLabel);
      for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i], b = labels[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const overlapX = (a.labelWidth + b.labelWidth) / 2 + 6 - Math.abs(dx);
        const overlapY = 12 - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const push = (Math.min(overlapX, overlapY) / 2) * alpha * .7;
          const xDirection = dx || 1, yDirection = dy || 1;
          a.vx -= push * Math.sign(xDirection); b.vx += push * Math.sign(xDirection);
          a.vy -= push * .25 * Math.sign(yDirection); b.vy += push * .25 * Math.sign(yDirection);
        }
      }
      labels.forEach(label => localNodes.forEach(node => {
        if (node === label) return;
        const left = label.x + radius(label) + 4, right = left + label.labelWidth;
        const top = label.y - 6, bottom = label.y + 6;
        const nearestX = Math.max(left, Math.min(node.x, right));
        const nearestY = Math.max(top, Math.min(node.y, bottom));
        let dx = node.x - nearestX, dy = node.y - nearestY;
        if (!dx && !dy) { dx = node.x - (left + right) / 2 || 1; dy = node.y - label.y; }
        const distance = Math.hypot(dx, dy), minimum = radius(node) + 6;
        if (distance < minimum) {
          const push = (minimum - distance) * alpha * .7 / 2;
          const x = dx / distance, y = dy / distance;
          label.vx -= x * push; label.vy -= y * push;
          node.vx += x * push; node.vy += y * push;
        }
      }));
    }
    force.initialize = nodes => { localNodes = nodes; };
    return force;
  }

  function makeSimulation() {
    const connected = state.graph.nodes.filter(node => !node.isolate);
    const linked = state.graph.links.filter(link => !state.graph.nodeById.get(link.sourceId).isolate && !state.graph.nodeById.get(link.targetId).isolate)
      .map(link => ({ ...link, source: link.sourceId, target: link.targetId }));
    simulation = d3.forceSimulation(connected)
      .force('link', d3.forceLink(linked).id(node => node.id)
        .distance(link => Math.max(45, 95 - 25 * link.weight))
        .strength(link => link.weight / Math.min(link.source.layoutDegree, link.target.layoutDegree)))
      .force('charge', d3.forceManyBody().strength(-140))
      .force('collision', d3.forceCollide(node => radius(node) + 6))
      .force('x', d3.forceX(state.size.width / 2).strength(.03))
      .force('y', d3.forceY(state.size.height / 2).strength(.03))
      .force('labels', labelRectCollide(connected))
      .on('tick', renderGeometry)
      .stop();
  }

  function parkIsolates() {
    const connected = state.graph.nodes.filter(node => !node.isolate);
    const xs = connected.map(node => node.x), ys = connected.map(node => node.y);
    const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : Math.max(240, state.size.width);
    const maxY = ys.length ? Math.max(...ys) : 0;
    const width = Math.max(180, maxX - minX);
    const isolates = state.graph.nodes.filter(node => node.isolate);
    const step = Math.max(...isolates.map(node => node.labelWidth || 0), 70) + 28;
    const columns = Math.max(1, Math.floor(width / step));
    isolates.forEach((node, index) => {
      node.x = minX + (index % columns) * step;
      node.y = maxY + 72 + Math.floor(index / columns) * 36;
    });
  }

  function settleLayout() {
    if (!simulation) return;
    simulation.stop();
    for (let tick = 0; tick < 300; tick += 1) simulation.tick();
    parkIsolates();
    renderGeometry();
    setZoomBounds();
    fitToVisible(true);
    simulation.stop();
    settled = true;
  }

  function worldBounds(visibleOnly = true) {
    const nodes = state.graph.nodes.filter(node => !visibleOnly || state.visibleNodeIds.has(node.id));
    if (!nodes.length) return null;
    const minX = Math.min(...nodes.map(node => node.x - radius(node) - (node.isolate ? node.labelWidth : 0)));
    const maxX = Math.max(...nodes.map(node => node.x + radius(node) + (node.isolate ? node.labelWidth : 0)));
    const minY = Math.min(...nodes.map(node => node.y - radius(node)));
    const maxY = Math.max(...nodes.map(node => node.y + radius(node)));
    return { minX, maxX, minY, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  function transformForBounds(bounds) {
    const padding = 48;
    const width = Math.max(1, state.size.width - padding * 2), height = Math.max(1, state.size.height - padding * 2);
    const scale = Math.min(width / bounds.width, height / bounds.height);
    return d3.zoomIdentity.translate(state.size.width / 2 - scale * (bounds.minX + bounds.maxX) / 2, state.size.height / 2 - scale * (bounds.minY + bounds.maxY) / 2).scale(scale);
  }

  function setZoomBounds() {
    const bounds = worldBounds(true);
    if (!bounds) return;
    const expanded = [[bounds.minX - bounds.width / 2, bounds.minY - bounds.height / 2], [bounds.maxX + bounds.width / 2, bounds.maxY + bounds.height / 2]];
    state.camera.fitScale = transformForBounds(bounds).k;
    zoom.scaleExtent([state.camera.fitScale * .5, 5]).translateExtent(expanded);
  }

  function fitToVisible(animate = false) {
    const bounds = worldBounds(true);
    if (!bounds) return;
    setZoomBounds();
    const transform = transformForBounds(bounds);
    const target = animate ? svg.transition().duration(300) : svg;
    target.call(zoom.transform, transform);
  }

  function centerOnNode(node) {
    if (!node || !state.visibleNodeIds.has(node.id)) return;
    const targetScale = Math.max(state.camera.transform.k, state.camera.fitScale * 1.6);
    const transform = d3.zoomIdentity.translate(state.size.width / 2 - node.x * targetScale, state.size.height / 2 - node.y * targetScale).scale(targetScale);
    svg.transition().duration(300).call(zoom.transform, transform);
  }

  function renderGeometry() {
    edgeSel.selectAll('line').attr('x1', link => state.graph.nodeById.get(link.sourceId).x).attr('y1', link => state.graph.nodeById.get(link.sourceId).y)
      .attr('x2', link => state.graph.nodeById.get(link.targetId).x).attr('y2', link => state.graph.nodeById.get(link.targetId).y);
    nodeSel.attr('transform', node => `translate(${node.x},${node.y})`);
  }

  function labelOpacity(node) {
    const ratio = state.camera.transform.k / state.camera.fitScale;
    const selected = state.selection.nodeId;
    if (node.id === selected || state.hover.id === node.id || (selected && state.graph.adjacency.get(selected).has(node.id))) return 1;
    const hub = node.hubLabel || node.isolate;
    if (hub) return Math.max(0, Math.min(1, (ratio - 1) / .6));
    const threshold = 10 / 11;
    if (11 * state.camera.transform.k < 10) return 0;
    const screenX = node.x * state.camera.transform.k + state.camera.transform.x;
    const screenY = node.y * state.camera.transform.k + state.camera.transform.y;
    const near = screenX > -80 && screenX < state.size.width + 80 && screenY > -40 && screenY < state.size.height + 40;
    return near ? Math.min(1, (state.camera.transform.k - threshold) / (threshold * .4)) : 0;
  }

  function renderState() {
    if (!state.graph) return;
    const selectedNode = state.selection.nodeId;
    const selectedEdge = state.selection.edgeId;
    const selectedLink = selectedEdge ? state.graph.links.find(link => edgeId(link) === selectedEdge) : null;
    const spotlight = state.search.query.trim();
    const matches = new Set(state.search.matchIds);
    const hoverNode = state.hover.type === 'node' ? state.hover.id : null;
    const focusNode = selectedNode || hoverNode;
    const neighbourIds = focusNode ? state.graph.adjacency.get(focusNode) : new Set();
    nodeSel.classed('hidden', node => !state.visibleNodeIds.has(node.id))
      .classed('pinned', node => node.id === selectedNode)
      .classed('edge-pinned', node => !!selectedLink && (selectedLink.sourceId === node.id || selectedLink.targetId === node.id))
      .classed('neighbour', node => neighbourIds.has(node.id))
      .classed('search-dimmed', node => !!spotlight && state.visibleNodeIds.has(node.id) && !matches.has(node.id))
      .classed('hover-dimmed', node => !state.selection.type && !!hoverNode && state.visibleNodeIds.has(node.id) && node.id !== hoverNode && !neighbourIds.has(node.id));
    edgeSel.classed('hidden', link => !state.visibleNodeIds.has(link.sourceId) || !state.visibleNodeIds.has(link.targetId))
      .classed('pinned', link => edgeId(link) === selectedEdge)
      .classed('search-dimmed', link => !!spotlight && (!matches.has(link.sourceId) || !matches.has(link.targetId)))
      .classed('hover-dimmed', link => !state.selection.type && !!hoverNode && link.sourceId !== hoverNode && link.targetId !== hoverNode);
    nodeSel.select('text').style('opacity', labelOpacity);
    renderTooltip();
  }

  function matchesFilters(node) {
    const filters = state.filters;
    const tagOK = !filters.tags.size && !filters.includeUntagged ||
      (filters.includeUntagged && !node.tags.length) || node.tags.some(tag => filters.tags.has(tag));
    const year = nodeYear(node);
    const yearOK = (filters.yearMin === null || (year !== null && year >= filters.yearMin)) && (filters.yearMax === null || (year !== null && year <= filters.yearMax));
    const seriesOK = !filters.series.size || (node.series && filters.series.has(node.series.stem));
    return tagOK && yearOK && seriesOK;
  }

  function applyFilters() {
    state.visibleNodeIds = new Set(state.graph.nodes.filter(matchesFilters).map(node => node.id));
    if (state.selection.nodeId && !state.visibleNodeIds.has(state.selection.nodeId)) clearSelection();
    if (state.selection.edgeId) {
      const edge = state.graph.links.find(link => edgeId(link) === state.selection.edgeId);
      if (!edge || !state.visibleNodeIds.has(edge.sourceId) || !state.visibleNodeIds.has(edge.targetId)) clearSelection();
    }
    emptyEl.hidden = state.visibleNodeIds.size !== 0;
    setZoomBounds();
    renderFilterPopover();
    if (state.search.query) updateSearch();
    else renderState();
  }

  function filterOption(label, checked, onChange) {
    const wrapper = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked; input.addEventListener('change', () => { onChange(input.checked); applyFilters(); });
    wrapper.append(input, document.createTextNode(` ${label}`));
    return wrapper;
  }

  function renderFilterPopover() {
    const tags = [...new Set(state.graph.nodes.flatMap(node => node.tags))].sort();
    const series = [...state.graph.visibleSeries].sort();
    const active = state.filters.tags.size + state.filters.series.size + Number(state.filters.includeUntagged) + Number(state.filters.yearMin !== null) + Number(state.filters.yearMax !== null);
    filterCount.textContent = active;
    if (!state.filters.popoverOpen) return;
    filtersEl.replaceChildren();
    const makeChoices = (legend, values, selected, callback, includeUntagged = false) => {
      const fieldset = document.createElement('fieldset'), title = document.createElement('legend'), query = document.createElement('input'), options = document.createElement('div');
      title.textContent = legend; query.type = 'search'; query.placeholder = 'поиск'; options.className = 'filter-options';
      const paint = () => { options.replaceChildren(); if (includeUntagged) options.append(filterOption('без wiki-тега', state.filters.includeUntagged, value => { state.filters.includeUntagged = value; })); values.filter(value => value.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).forEach(value => options.append(filterOption(value, selected.has(value), valueChecked => { if (valueChecked) selected.add(value); else selected.delete(value); callback(); }))); };
      query.addEventListener('input', paint); fieldset.append(title, query, options); paint(); return fieldset;
    };
    filtersEl.append(makeChoices('wiki-теги', tags, state.filters.tags, () => {}, true));
    const years = state.graph.nodes.map(nodeYear).filter(year => year !== null);
    const dates = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = 'год публикации'; dates.append(legend);
    [['от', 'yearMin'], ['до', 'yearMax']].forEach(([label, key]) => { const item = document.createElement('label'), input = document.createElement('input'); input.type = 'number'; input.placeholder = label; input.value = state.filters[key] ?? ''; input.addEventListener('change', () => { state.filters[key] = input.value === '' ? null : Number(input.value); applyFilters(); }); item.append(`${label} `, input); dates.append(item); });
    filtersEl.append(dates, makeChoices('серии', series, state.filters.series, () => {}));
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'сбросить фильтры'; reset.addEventListener('click', resetFilters); filtersEl.append(reset);
  }

  function resetFilters() {
    state.filters.tags.clear(); state.filters.series.clear(); state.filters.includeUntagged = false; state.filters.yearMin = null; state.filters.yearMax = null;
    applyFilters();
  }

  function rankMatches(query) {
    const term = query.toLocaleLowerCase();
    return state.graph.nodes.filter(node => state.visibleNodeIds.has(node.id) && node.title.toLocaleLowerCase().includes(term)).sort((a, b) => {
      const aIndex = a.title.toLocaleLowerCase().indexOf(term), bIndex = b.title.toLocaleLowerCase().indexOf(term);
      return aIndex - bIndex || b.layoutDegree - a.layoutDegree || a.title.localeCompare(b.title);
    });
  }

  function updateSearch(preserveActive = false) {
    state.search.query = searchInput.value;
    const matches = state.search.query.trim() ? rankMatches(state.search.query) : [];
    state.search.matchIds = matches.map(node => node.id);
    state.search.resultIds = state.search.matchIds.slice(0, 8);
    if (!state.search.resultIds.length) state.search.activeIndex = -1;
    else if (!preserveActive || state.search.activeIndex < 0 || state.search.activeIndex >= state.search.resultIds.length) state.search.activeIndex = 0;
    state.search.open = state.search.resultIds.length > 0;
    searchInput.setAttribute('aria-expanded', String(state.search.open));
    resultsEl.hidden = !state.search.open;
    resultsEl.replaceChildren(...matches.slice(0, 8).map((node, index) => {
      const item = document.createElement('li'), button = document.createElement('button');
      item.role = 'option'; item.id = `graph-result-${index}`; item.setAttribute('aria-selected', String(index === state.search.activeIndex));
      button.type = 'button'; button.textContent = `${node.title} · ${new Date(node.date).toLocaleDateString('ru-RU')}`; button.addEventListener('click', () => chooseSearchResult(node)); item.append(button); return item;
    }));
    renderState();
  }

  function chooseSearchResult(node) {
    if (!node || !state.visibleNodeIds.has(node.id)) return;
    state.search.open = false; resultsEl.hidden = true; searchInput.setAttribute('aria-expanded', 'false');
    pinNode(node.id); centerOnNode(node);
  }

  function pinNode(id) {
    state.selection = { type: 'node', nodeId: id, edgeId: null, panelOpen: true };
    renderPanel(); renderState();
  }
  function pinEdge(id) {
    state.selection = { type: 'edge', nodeId: null, edgeId: id, panelOpen: false };
    panelEl.hidden = true; renderState();
  }
  function clearSelection() {
    state.selection = { type: null, nodeId: null, edgeId: null, panelOpen: false };
    panelEl.hidden = true; renderState();
  }

  function addText(parent, tag, text) { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; }
  function selectTravel(id) { if (state.visibleNodeIds.has(id)) { pinNode(id); centerOnNode(state.graph.nodeById.get(id)); } }
  function renderPanel() {
    panelEl.replaceChildren();
    if (!state.selection.panelOpen || !state.selection.nodeId) { panelEl.hidden = true; return; }
    const node = state.graph.nodeById.get(state.selection.nodeId);
    panelEl.hidden = false;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'panel-close'; close.textContent = 'закрыть'; close.addEventListener('click', () => { state.selection.panelOpen = false; renderPanel(); }); panelEl.append(close);
    addText(panelEl, 'h2', node.title); addText(panelEl, 'p', new Date(node.date).toLocaleDateString('ru-RU'));
    if (node.series) addText(panelEl, 'p', `серия «${node.series.stem}», часть ${node.series.part.replace('-', '.')}`);
    const related = [...state.graph.relatedNeighbours.get(node.id)].map(id => state.graph.nodeById.get(id)).sort((a, b) => dateValue(b) - dateValue(a));
    if (related.length) { addText(panelEl, 'p', 'связанные заметки'); const list = document.createElement('ul'); related.forEach(other => { const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.textContent = other.title; button.addEventListener('click', () => selectTravel(other.id)); item.append(button); list.append(item); }); panelEl.append(list); }
    if (node.series) {
      const group = state.graph.seriesGroups.get(node.series.stem) || [], index = group.indexOf(node), nav = document.createElement('p');
      if (group[index - 1]) { const prev = document.createElement('button'); prev.type = 'button'; prev.textContent = 'предыдущая'; prev.addEventListener('click', () => selectTravel(group[index - 1].id)); nav.append(prev); }
      if (group[index + 1]) { const next = document.createElement('button'); next.type = 'button'; next.textContent = 'следующая'; next.addEventListener('click', () => selectTravel(group[index + 1].id)); nav.append(next); }
      panelEl.append(nav);
      const pills = document.createElement('p'); group.forEach(part => { const pill = document.createElement('button'); pill.type = 'button'; pill.textContent = part.series.part.replace('-', '.'); pill.disabled = part.id === node.id; pill.addEventListener('click', () => selectTravel(part.id)); pills.append(pill); }); panelEl.append(pills);
    }
    if (!node.layoutDegree) addText(panelEl, 'p', 'нет связей');
    const read = document.createElement('a'); read.href = node.url; read.textContent = 'читать пост'; panelEl.append(read);
  }

  function renderTooltip() {
    if (!state.hover.type && !state.selection.edgeId) { tooltipEl.hidden = true; return; }
    let text = '';
    if (state.selection.edgeId) {
      const link = state.graph.links.find(edge => edgeId(edge) === state.selection.edgeId);
      if (link) text = `${state.graph.nodeById.get(link.sourceId).title} ↔ ${state.graph.nodeById.get(link.targetId).title}`;
    } else if (state.hover.type === 'node') {
      const node = state.graph.nodeById.get(state.hover.id); text = `${node.title} · ${new Date(node.date).toLocaleDateString('ru-RU')}${node.series ? ` · ч. ${node.series.part.replace('-', '.')}` : ''}`;
    } else if (state.hover.type === 'edge') {
      const link = state.graph.links.find(edge => edgeId(edge) === state.hover.id); text = `${state.graph.nodeById.get(link.sourceId).title} ↔ ${state.graph.nodeById.get(link.targetId).title}`;
    }
    if (!text) { tooltipEl.hidden = true; return; }
    tooltipEl.textContent = text; tooltipEl.hidden = false;
  }

  function moveTooltip(event) {
    const rect = box.getBoundingClientRect();
    tooltipEl.style.left = `${Math.min(rect.width - 30, event.clientX - rect.left + 12)}px`;
    tooltipEl.style.top = `${Math.min(rect.height - 30, event.clientY - rect.top + 12)}px`;
  }

  function handleEscape() {
    if (state.filters.popoverOpen) { state.filters.popoverOpen = false; filtersEl.hidden = true; filterButton.setAttribute('aria-expanded', 'false'); return; }
    if (state.search.open || state.search.query) { state.search.open = false; state.search.query = ''; searchInput.value = ''; resultsEl.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); updateSearch(); return; }
    if (state.selection.panelOpen) { state.selection.panelOpen = false; renderPanel(); return; }
    if (state.selection.type) clearSelection();
  }

  function bindEvents() {
    searchInput.addEventListener('input', updateSearch);
    searchInput.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (!state.search.resultIds.length) return; event.preventDefault(); const delta = event.key === 'ArrowDown' ? 1 : -1; state.search.activeIndex = (state.search.activeIndex + delta + state.search.resultIds.length) % state.search.resultIds.length; updateSearch(true); }
      if (event.key === 'Enter') { event.preventDefault(); chooseSearchResult(state.graph.nodeById.get(state.search.resultIds[state.search.activeIndex] || state.search.resultIds[0])); }
    });
    filterButton.addEventListener('click', event => { event.stopPropagation(); state.filters.popoverOpen = !state.filters.popoverOpen; filtersEl.hidden = !state.filters.popoverOpen; filterButton.setAttribute('aria-expanded', String(state.filters.popoverOpen)); renderFilterPopover(); });
    box.querySelector('[data-act="reset-filters"]').addEventListener('click', resetFilters);
    document.querySelectorAll('[data-act="reset"], [data-act="zoom-in"], [data-act="zoom-out"]').forEach(button => button.addEventListener('click', () => {
      state.camera.userInteracted = true;
      if (button.dataset.act === 'reset') fitToVisible(true);
      else svg.transition().duration(180).call(zoom.scaleBy, button.dataset.act === 'zoom-in' ? 1.4 : 1 / 1.4);
    }));
    document.addEventListener('click', event => { if (state.filters.popoverOpen && !filtersEl.contains(event.target) && !filterButton.contains(event.target)) { state.filters.popoverOpen = false; filtersEl.hidden = true; filterButton.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); handleEscape(); }
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { event.preventDefault(); searchInput.focus(); }
    });
  }

  function buildGraph() {
    svg = d3.select(svgEl); viewport = svg.append('g').attr('class', 'viewport');
    const edgeRelationship = link => link.relatedWeight && link.seriesWeight ? 'связанная заметка и переход между частями серии' : link.relatedWeight ? 'связанная заметка' : 'переход между частями серии';
    const edges = viewport.append('g').selectAll('g.edge').data(state.graph.links).join('g').attr('class', link => `edge ${link.renderKind}`).attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', link => `${state.graph.nodeById.get(link.sourceId).title} ↔ ${state.graph.nodeById.get(link.targetId).title}, ${edgeRelationship(link)}`);
    edges.append('line').attr('class', 'hit'); edges.append('line').attr('class', 'vis').attr('stroke-width', link => link.renderKind === 'series' ? 1 : 1 + 1.2 * link.relatedWeight);
    edgeSel = edges;
    const nodes = viewport.append('g').selectAll('g.node').data(state.graph.nodes).join('g').attr('class', node => `node${node.isolate ? ' isolate' : ''}`).attr('tabindex', 0).attr('role', 'button').attr('aria-label', node => `${node.title}, ${new Date(node.date).toLocaleDateString('ru-RU')}`);
    nodes.append('circle').attr('r', radius);
    nodes.filter(node => node.series && state.graph.visibleSeries.has(node.series.stem)).append('circle').attr('class', 'series-ring').attr('r', node => radius(node) + 3);
    nodes.append('text').attr('x', node => radius(node) + 4).attr('y', 4).text(node => node.title);
    nodeSel = nodes;
    const invoke = (handler, event, datum) => { event.stopPropagation(); handler(datum); };
    nodes.on('click', (event, node) => invoke(node => pinNode(node.id), event, node)).on('dblclick', (event, node) => { event.stopPropagation(); window.location.href = node.url; })
      .on('mouseenter', (event, node) => { state.hover = { type: 'node', id: node.id }; moveTooltip(event); renderState(); }).on('mousemove', moveTooltip).on('mouseleave', () => { state.hover = { type: null, id: null }; renderState(); })
      .on('keydown', (event, node) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pinNode(node.id); } });
    edges.on('click', (event, link) => invoke(link => pinEdge(edgeId(link)), event, link)).on('mouseenter', (event, link) => { state.hover = { type: 'edge', id: edgeId(link) }; moveTooltip(event); renderState(); }).on('mousemove', moveTooltip).on('mouseleave', () => { state.hover = { type: null, id: null }; renderState(); })
      .on('keydown', (event, link) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pinEdge(edgeId(link)); } });
    svg.on('click', () => clearSelection()).on('dblclick.zoom', null);
    zoom = d3.zoom().on('zoom', event => { if (event.sourceEvent && (event.sourceEvent.type === 'wheel' || event.sourceEvent.type.startsWith('mouse') || event.sourceEvent.type.startsWith('touch'))) state.camera.userInteracted = true; state.camera.transform = event.transform; viewport.attr('transform', event.transform); renderState(); });
    svg.call(zoom).on('dblclick.zoom', null);
    nodes.filter(node => !node.isolate).call(d3.drag().on('start', (event, node) => { if (!event.active) simulation.alpha(.3).alphaTarget(.3).restart(); node.fx = node.x; node.fy = node.y; }).on('drag', (event, node) => { node.fx = event.x; node.fy = event.y; renderGeometry(); }).on('end', (event, node) => { if (!event.active) simulation.alphaTarget(0); node.fx = null; node.fy = null; }));
  }

  function bindResize() {
    resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0].contentRect; if (!rect.width || !rect.height) return;
      state.size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      svgEl.setAttribute('width', state.size.width); svgEl.setAttribute('height', state.size.height);
      if (!settled) return;
      simulation.force('x', d3.forceX(state.size.width / 2).strength(.03)).force('y', d3.forceY(state.size.height / 2).strength(.03));
      setZoomBounds(); if (!state.camera.userInteracted) fitToVisible(false);
    });
    resizeObserver.observe(box);
  }

  loadGraph().then(graph => {
    state.graph = graph; state.visibleNodeIds = new Set(graph.nodes.map(node => node.id));
    const rect = box.getBoundingClientRect(); state.size = { width: Math.round(rect.width), height: Math.round(rect.height) };
    svgEl.setAttribute('width', state.size.width); svgEl.setAttribute('height', state.size.height);
    measureLabels(); buildGraph(); makeSimulation(); settleLayout(); bindEvents(); bindResize(); renderFilterPopover(); setStatus(`${graph.nodes.length} заметок, ${graph.links.length} связей`);
  }).catch(error => { setStatus(`граф недоступен: ${error.message}`); });
})();
