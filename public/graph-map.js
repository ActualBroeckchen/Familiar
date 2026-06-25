// graph-map.js — shared force-directed graph-map engine
//
// One reusable canvas engine behind BOTH map views: the Phylactery
// knowledge graph (nodes + weighted relationship edges) and the Unruh
// schedule's consequence graph (events/tasks/phases/states + causal /
// temporal edges). The two stores hold genuinely graph-shaped data, so
// the rendering, force layout, hit-testing, pan/zoom, colour palette,
// legend and tooltip live here once rather than being copy-pasted per
// view (see CLAUDE.md — no copy-paste of substantial logic).
//
// What's generic lives here; what's domain-specific stays with each
// host: the engine renders + emits interaction events (onNodeClick,
// onBackgroundClick), and the host owns its own editor/popover, data
// fetch, and node/edge shapes. Hosts normalise their edges to
// { id, fromId, toId, type, weight? } before calling setData.
//
// Pan/zoom works by wheel, by the +/−/Fit buttons (zoomBy/fit — the
// touchpad-friendly path), and by touch (one-finger drag-pan,
// two-finger pinch-zoom). The viewport transform is the same one the
// Phylactery map always used: world = (screen - tx) / zoom.

'use strict';

(function (global) {
  const PALETTE = [
      0,  15,  30,  45,  60,  75,  90, 105,
    120, 135, 150, 165, 180, 195, 210, 225,
    240, 255, 270, 285, 300, 315, 330, 345,
  ];
  const NODE_R     = 6;
  const LABEL_ZOOM = 1.4;
  const ZOOM_MIN   = 0.2;
  const ZOOM_MAX   = 8;

  // Self-contained HTML escape so the engine carries no dependency on
  // the host's globals (it's a separate <script> that loads first).
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function createGraphMap(config = {}) {
    const {
      canvas,
      statusEl    = null,
      legendEl    = null,
      tooltipEl   = null,
      // Gate hover work when the map isn't on screen.
      isActive    = () => true,
      onNodeClick = () => {},
      onBackgroundClick = () => {},
      // Domain hooks (all optional — sensible defaults below).
      nodeTypeKey = n => n.type || 'untyped',
      edgeTypeKey = e => e.type || e.customType || 'related',
      edgeWeight  = e => (typeof e.weight === 'number' ? e.weight : undefined),
      nodeColor   = null,           // (n, hue) => css; default below
      edgeColor   = null,           // (e, hue) => css; default below (weight fade)
      edgeDash    = null,           // (e) => truthy ⇒ dashed (e.g. a projection)
      labelFor    = n => String(n.label ?? n.id),
      tooltipNodeHTML = null,       // (n) => html
      tooltipEdgeHTML = null,       // (e, a, b) => html
    } = config;

    const ctx = canvas.getContext('2d');

    const state = {
      nodes: [], edges: [], nodeById: new Map(),
      zoom: 1, tx: 0, ty: 0,
      hover: null, drag: null, raf: 0, inited: false,
      colors: { node: new Map(), edge: new Map() },
      // active pointers for touch pinch/pan
      pointers: new Map(), pinch: null,
    };

    // ── Colour encoding ─────────────────────────────────────────────
    function assignColors() {
      const nodeTypes = Array.from(new Set(state.nodes.map(nodeTypeKey))).sort();
      const edgeTypes = Array.from(new Set(state.edges.map(edgeTypeKey))).sort();
      state.colors.node.clear();
      state.colors.edge.clear();
      const N = PALETTE.length;
      const stride = 7;             // coprime to 24 → spreads adjacent types apart
      const off = Math.floor(N / 2);
      nodeTypes.forEach((t, i) => state.colors.node.set(t, PALETTE[(i * stride) % N]));
      edgeTypes.forEach((t, i) => state.colors.edge.set(t, PALETTE[((i * stride) + off) % N]));
    }
    const nodeHue = n => state.colors.node.get(nodeTypeKey(n)) ?? 0;
    const edgeHue = e => state.colors.edge.get(edgeTypeKey(e)) ?? 0;
    const defaultNodeColor = (n, hue) => `hsl(${hue}, 65%, 60%)`;
    const colorOfNode = n => (nodeColor || defaultNodeColor)(n, nodeHue(n));
    function colorOfEdge(e) {
      if (edgeColor) return edgeColor(e, edgeHue(e));
      const hue = edgeHue(e);
      const raw = edgeWeight(e);
      const w   = Math.max(0, Math.min(1, typeof raw === 'number' ? raw : 0.5));
      const sat   = Math.round(20 + 70 * w);
      const lt    = Math.round(32 + 30 * w);
      const alpha = (0.35 + 0.55 * w).toFixed(2);
      return `hsla(${hue}, ${sat}%, ${lt}%, ${alpha})`;
    }

    function buildLegend() {
      assignColors();
      if (!legendEl) return;
      const rows = [];
      const nodeTypes = Array.from(state.colors.node.keys()).sort();
      const edgeTypes = Array.from(state.colors.edge.keys()).sort();
      if (nodeTypes.length) {
        rows.push('<div class="ke-graph-legend-section">Nodes</div>');
        for (const t of nodeTypes) {
          rows.push(`<div class="ke-graph-legend-row"><span class="ke-graph-legend-swatch" style="background:hsl(${state.colors.node.get(t)},65%,60%)"></span>${esc(t)}</div>`);
        }
      }
      if (edgeTypes.length) {
        rows.push('<div class="ke-graph-legend-section">Edges</div>');
        for (const t of edgeTypes) {
          rows.push(`<div class="ke-graph-legend-row"><span class="ke-graph-legend-swatch" style="background:hsl(${state.colors.edge.get(t)},75%,55%)"></span>${esc(t)}</div>`);
        }
      }
      legendEl.innerHTML = rows.join('');
      legendEl.classList.toggle('hidden', !rows.length);
    }

    // ── Layout (Fruchterman-Reingold) ───────────────────────────────
    function layout(width, height, { fresh = true } = {}) {
      const nodes = state.nodes, edges = state.edges;
      if (!nodes.length) return;
      if (!fresh) {
        for (const n of nodes) {
          if (n.x !== undefined && n.y !== undefined) continue;
          let sx = 0, sy = 0, c = 0;
          for (const e of edges) {
            const other = e.fromId === n.id ? state.nodeById.get(e.toId)
                        : e.toId   === n.id ? state.nodeById.get(e.fromId) : null;
            if (other && other.x !== undefined) { sx += other.x; sy += other.y; c++; }
          }
          if (c > 0) {
            n.x = sx / c + (Math.random() - 0.5) * 40;
            n.y = sy / c + (Math.random() - 0.5) * 40;
          } else {
            n.x = width  / 2 + (Math.random() - 0.5) * width  * 0.3;
            n.y = height / 2 + (Math.random() - 0.5) * height * 0.3;
          }
        }
        return;
      }
      const area = width * height;
      const k = Math.sqrt(area / nodes.length) * 0.75;
      for (const n of nodes) {
        n.x = width  / 2 + (Math.random() - 0.5) * width  * 0.6;
        n.y = height / 2 + (Math.random() - 0.5) * height * 0.6;
      }
      const iterations = nodes.length <= 60 ? 300 : nodes.length <= 200 ? 220 : 140;
      let t = Math.min(width, height) / 8;
      const cool = t / iterations;
      for (let iter = 0; iter < iterations; iter++) {
        for (const n of nodes) { n.dx = 0; n.dy = 0; }
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx*dx + dy*dy + 0.01; }
            const d = Math.sqrt(d2);
            const f = (k * k) / d;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.dx += fx; a.dy += fy;
            b.dx -= fx; b.dy -= fy;
          }
        }
        for (const e of edges) {
          const a = state.nodeById.get(e.fromId);
          const b = state.nodeById.get(e.toId);
          if (!a || !b) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f  = (d * d) / k;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.dx -= fx; a.dy -= fy;
          b.dx += fx; b.dy += fy;
        }
        for (const n of nodes) {
          const dlen = Math.sqrt(n.dx * n.dx + n.dy * n.dy) || 0.01;
          n.x += (n.dx / dlen) * Math.min(dlen, t);
          n.y += (n.dy / dlen) * Math.min(dlen, t);
          n.x += (width  / 2 - n.x) * 0.01;
          n.y += (height / 2 - n.y) * 0.01;
        }
        t = Math.max(0.5, t - cool);
      }
    }

    function fit() {
      const rect = canvas.getBoundingClientRect();
      if (!state.nodes.length || !rect.width) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of state.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const pad = 40;
      const w = (maxX - minX) || 1;
      const h = (maxY - minY) || 1;
      const zoom = Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h, 2);
      state.zoom = Math.max(0.3, zoom);
      state.tx = rect.width  / 2 - ((minX + maxX) / 2) * state.zoom;
      state.ty = rect.height / 2 - ((minY + maxY) / 2) * state.zoom;
      requestDraw();
    }

    function resize() {
      const dpr  = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    }

    // ── Rendering ───────────────────────────────────────────────────
    function requestDraw() {
      if (state.raf) return;
      state.raf = requestAnimationFrame(() => { state.raf = 0; draw(); });
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(state.tx, state.ty);
      ctx.scale(state.zoom, state.zoom);

      for (const e of state.edges) {
        const a = state.nodeById.get(e.fromId);
        const b = state.nodeById.get(e.toId);
        if (!a || !b) continue;
        const isHover = state.hover && state.hover.kind === 'edge' && state.hover.ref === e;
        ctx.strokeStyle = isHover ? '#ffffff' : colorOfEdge(e);
        const raw = edgeWeight(e);
        const w = Math.max(0, Math.min(1, typeof raw === 'number' ? raw : 0.5));
        ctx.lineWidth = (0.7 + w * 1.6) / state.zoom;
        // Dashed = a projection (something the host hasn't confirmed yet);
        // solid = structural or observed. Scaled by zoom so the dash reads
        // the same at any scale.
        ctx.setLineDash(edgeDash && edgeDash(e) ? [6 / state.zoom, 4 / state.zoom] : []);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cpx = mx + (-dy / len) * len * 0.12;
        const cpy = my + ( dx / len) * len * 0.12;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
        ctx.stroke();
      }

      ctx.setLineDash([]);   // reset so node outlines aren't dashed
      const r = NODE_R / state.zoom;
      for (const n of state.nodes) {
        const isHover = state.hover && state.hover.kind === 'node' && state.hover.ref === n;
        ctx.fillStyle   = colorOfNode(n);
        ctx.strokeStyle = isHover ? '#ffffff' : 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = (isHover ? 2 : 1) / state.zoom;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      const showAll = state.zoom >= LABEL_ZOOM;
      ctx.font         = `${12 / state.zoom}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#cdd6f4';
      ctx.strokeStyle  = 'rgba(0,0,0,0.7)';
      ctx.lineWidth    = 3 / state.zoom;
      for (const n of state.nodes) {
        const isHover = state.hover && state.hover.kind === 'node' && state.hover.ref === n;
        if (!showAll && !isHover) continue;
        const label = labelFor(n);
        const x = n.x + r + 4 / state.zoom;
        ctx.strokeText(label, x, n.y);
        ctx.fillText(label,   x, n.y);
      }
    }

    // ── Hit testing ─────────────────────────────────────────────────
    function clientToWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left, sy = clientY - rect.top;
      return { x: (sx - state.tx) / state.zoom, y: (sy - state.ty) / state.zoom, sx, sy };
    }
    function hitNode(wx, wy) {
      const r = NODE_R / state.zoom;
      const tol = Math.max(r, 8 / state.zoom);
      let best = null, bestD = tol * tol;
      for (const n of state.nodes) {
        const dx = n.x - wx, dy = n.y - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD) { bestD = d2; best = n; }
      }
      return best;
    }
    function hitEdge(wx, wy) {
      const tol = 6 / state.zoom, tol2 = tol * tol;
      let best = null, bestD = tol2;
      for (const e of state.edges) {
        const a = state.nodeById.get(e.fromId);
        const b = state.nodeById.get(e.toId);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.sqrt(dx * dx + dy * dy);
        if (L < 1) continue;
        const cpx = (a.x + b.x) / 2 + (-dy / L) * L * 0.12;
        const cpy = (a.y + b.y) / 2 + ( dx / L) * L * 0.12;
        const minX = Math.min(a.x, b.x, cpx) - tol, maxX = Math.max(a.x, b.x, cpx) + tol;
        const minY = Math.min(a.y, b.y, cpy) - tol, maxY = Math.max(a.y, b.y, cpy) + tol;
        if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;
        const d2 = distSqToQuadratic(wx, wy, a.x, a.y, cpx, cpy, b.x, b.y);
        if (d2 <= bestD) { bestD = d2; best = e; }
      }
      return best;
    }
    function distSqToQuadratic(px, py, x0, y0, cpx, cpy, x1, y1) {
      const SEG = 16;
      let prevX = x0, prevY = y0, best = Infinity;
      for (let i = 1; i <= SEG; i++) {
        const t = i / SEG, omt = 1 - t;
        const x = omt * omt * x0 + 2 * omt * t * cpx + t * t * x1;
        const y = omt * omt * y0 + 2 * omt * t * cpy + t * t * y1;
        const dx = x - prevX, dy = y - prevY;
        const L2 = dx * dx + dy * dy;
        if (L2 > 0.0001) {
          let tt = ((px - prevX) * dx + (py - prevY) * dy) / L2;
          if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
          const ix = prevX + tt * dx, iy = prevY + tt * dy;
          const ex = px - ix, ey = py - iy;
          const d2 = ex * ex + ey * ey;
          if (d2 < best) best = d2;
        }
        prevX = x; prevY = y;
      }
      return best;
    }

    function updateHover(clientX, clientY) {
      const { x, y, sx, sy } = clientToWorld(clientX, clientY);
      const node = hitNode(x, y);
      let hover = node ? { kind: 'node', ref: node } : null;
      if (!hover) {
        const edge = hitEdge(x, y);
        if (edge) hover = { kind: 'edge', ref: edge };
      }
      const changed = (hover?.ref !== state.hover?.ref);
      state.hover = hover;
      if (!tooltipEl) { if (changed) requestDraw(); return; }
      if (!hover) {
        tooltipEl.classList.add('hidden');
        if (changed) requestDraw();
        return;
      }
      if (hover.kind === 'node') {
        const n = hover.ref;
        tooltipEl.innerHTML = tooltipNodeHTML ? tooltipNodeHTML(n)
          : `<div class="ke-graph-tooltip-title">${esc(labelFor(n))}</div>
             <div class="ke-graph-tooltip-sub">${esc(n.type ?? 'untyped')}</div>
             ${n.description ? `<div>${esc(String(n.description).slice(0, 160))}</div>` : ''}`;
      } else {
        const ed = hover.ref;
        const a = state.nodeById.get(ed.fromId), b = state.nodeById.get(ed.toId);
        if (tooltipEdgeHTML) {
          tooltipEl.innerHTML = tooltipEdgeHTML(ed, a, b);
        } else {
          const raw = edgeWeight(ed);
          const w = typeof raw === 'number' ? raw.toFixed(2) : null;
          tooltipEl.innerHTML = `<div class="ke-graph-tooltip-title">${esc(edgeTypeKey(ed))}</div>
            <div class="ke-graph-tooltip-sub">${esc(a ? labelFor(a) : ed.fromId)} → ${esc(b ? labelFor(b) : ed.toId)}</div>
            ${w !== null ? `<div class="ke-graph-tooltip-sub">weight: ${esc(w)}</div>` : ''}`;
        }
      }
      tooltipEl.style.left = `${sx + 12}px`;
      tooltipEl.style.top  = `${sy + 12}px`;
      tooltipEl.classList.remove('hidden');
      if (changed) requestDraw();
    }

    // ── Pointer interaction (mouse + touch unified via Pointer events) ─
    function applyZoomAround(mx, my, scale) {
      const wx = (mx - state.tx) / state.zoom;
      const wy = (my - state.ty) / state.zoom;
      state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom * scale));
      state.tx = mx - wx * state.zoom;
      state.ty = my - wy * state.zoom;
      requestDraw();
    }

    function init() {
      if (state.inited) return;
      state.inited = true;

      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        applyZoomAround(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });

      // Pointer events cover mouse, pen, and touch. One pointer = pan
      // (or click if it didn't move); two pointers = pinch-zoom. This is
      // what makes the map usable on a touchpad/touchscreen without a
      // scroll wheel.
      canvas.style.touchAction = 'none';
      canvas.addEventListener('pointerdown', e => {
        canvas.setPointerCapture?.(e.pointerId);
        state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.pointers.size === 2) {
          const [p, q] = [...state.pointers.values()];
          state.pinch = { dist: Math.hypot(p.x - q.x, p.y - q.y) };
          state.drag = null;
        } else if (state.pointers.size === 1) {
          state.drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, button: e.button };
        }
      });
      canvas.addEventListener('pointermove', e => {
        if (state.pointers.has(e.pointerId)) state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (state.pinch && state.pointers.size === 2) {
          const [p, q] = [...state.pointers.values()];
          const dist = Math.hypot(p.x - q.x, p.y - q.y);
          if (state.pinch.dist > 0) {
            const rect = canvas.getBoundingClientRect();
            const cx = (p.x + q.x) / 2 - rect.left;
            const cy = (p.y + q.y) / 2 - rect.top;
            applyZoomAround(cx, cy, dist / state.pinch.dist);
          }
          state.pinch.dist = dist;
          return;
        }
        if (state.drag) {
          const dx = e.clientX - state.drag.x, dy = e.clientY - state.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
          state.tx = state.drag.tx + dx;
          state.ty = state.drag.ty + dy;
          requestDraw();
          return;
        }
        if (!isActive()) return;
        updateHover(e.clientX, e.clientY);
      });
      function endPointer(e) {
        const wasDrag = state.drag;
        state.pointers.delete(e.pointerId);
        if (state.pointers.size < 2) state.pinch = null;
        if (state.pointers.size === 1) {
          // Second finger lifted mid-pinch — resume panning from the
          // remaining pointer without a jump.
          const [only] = [...state.pointers.values()];
          state.drag = { x: only.x, y: only.y, tx: state.tx, ty: state.ty, moved: true, button: 0 };
          return;
        }
        if (!wasDrag) return;
        state.drag = null;
        if (!wasDrag.moved) {
          const { x, y } = clientToWorld(e.clientX, e.clientY);
          const node = hitNode(x, y);
          if (node) onNodeClick(node, e.clientX, e.clientY);
          else onBackgroundClick();
        }
      }
      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', e => {
        state.pointers.delete(e.pointerId);
        if (state.pointers.size < 2) state.pinch = null;
        if (state.pointers.size === 0) state.drag = null;
      });

      canvas.addEventListener('mouseleave', () => {
        state.hover = null;
        if (tooltipEl) tooltipEl.classList.add('hidden');
        requestDraw();
      });

      const ro = new ResizeObserver(() => { resize(); requestDraw(); });
      ro.observe(canvas.parentElement);
    }

    // ── Public controller ───────────────────────────────────────────
    function setData(rawNodes, rawEdges, { preservePositions = true } = {}) {
      const prevById = preservePositions ? state.nodeById : null;
      const nodes = (rawNodes ?? []).map(n => {
        const prev = prevById?.get(n.id);
        return prev ? { ...n, x: prev.x, y: prev.y } : { ...n };
      });
      const edges = (rawEdges ?? []).slice();
      const isFresh = nodes.every(n => n.x === undefined);
      state.nodes = nodes;
      state.edges = edges;
      state.nodeById = new Map(nodes.map(n => [n.id, n]));
      if (!nodes.length) { buildLegend(); requestDraw(); return { fresh: isFresh, empty: true }; }
      resize();
      const rect = canvas.getBoundingClientRect();
      layout(rect.width || 600, rect.height || 400, { fresh: isFresh });
      if (isFresh) fit();
      buildLegend();
      requestDraw();
      return { fresh: isFresh, empty: false };
    }

    return {
      init,
      setData,
      draw: requestDraw,
      fit,
      resize,
      // +/− buttons zoom around the canvas centre (the touchpad path).
      zoomBy(factor) {
        const rect = canvas.getBoundingClientRect();
        applyZoomAround(rect.width / 2, rect.height / 2, factor);
      },
      // Recolour + legend + redraw without relayout — for an in-place
      // edit that changed a node/edge type.
      refresh() { buildLegend(); requestDraw(); },
      getNode(id) { return state.nodeById.get(id); },
      // Screen position of a node — for anchoring a host popover.
      screenOf(node) {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + node.x * state.zoom + state.tx, y: rect.top + node.y * state.zoom + state.ty };
      },
      get nodes() { return state.nodes; },
      get edges() { return state.edges; },
      get zoom()  { return state.zoom; },
    };
  }

  global.createGraphMap = createGraphMap;
})(window);
