// js/views/charts.js — weight & length trajectory charts with WHO-style
// percentile curves overlaid.  Drawn as inline SVG (NFR-29 compatible)
// so they print cleanly in the pediatrician report too if reused.
//
// Aesthetic: weight-and-balance abacus — dark green grid + thin
// percentile threads + the user's events as bright accent dots
// connected by a polyline.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = 12;
const MS_PER_DAY = 24 * 3600 * 1000;
const MS_PER_MONTH = 30.4375 * MS_PER_DAY;

// Z-scores for the standard 9-percentile fan (10..90 step 10).
const Z = [-1.2816, -0.8416, -0.5244, -0.2533, 0, 0.2533, 0.5244, 0.8416, 1.2816];
const PCT_LABELS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

// WHO Child Growth Standards — Boys 0-12 months — approximated to one
// kilo / one centimetre, sex-averaged enough for an abacus visual.
// Three anchor curves (P10 / P50 / P90); the 9-fan is interpolated
// per-month via z-score scaling around P50.
const WHO_WEIGHT_BOYS = {
  // index = month (0..12)
  P10: [2.7, 3.5, 4.4, 5.1, 5.7, 6.2, 6.6, 6.9, 7.2, 7.4, 7.6, 7.8, 8.0],
  P50: [3.3, 4.5, 5.6, 6.4, 7.0, 7.5, 7.9, 8.3, 8.6, 8.9, 9.2, 9.4, 9.6],
  P90: [4.0, 5.4, 6.6, 7.5, 8.2, 8.8, 9.3, 9.7, 10.1, 10.4, 10.7, 11.0, 11.3],
};

const WHO_LENGTH_BOYS = {
  P10: [47.5, 51.5, 55.0, 57.6, 59.7, 61.5, 63.0, 64.5, 65.9, 67.2, 68.5, 69.7, 70.9],
  P50: [49.9, 54.7, 58.4, 61.4, 63.9, 65.9, 67.6, 69.2, 70.6, 72.0, 73.3, 74.5, 75.7],
  P90: [52.4, 57.9, 61.7, 65.2, 68.1, 70.4, 72.2, 74.0, 75.4, 76.8, 78.1, 79.4, 80.6],
};

// For each integer month, return [P10, P20, ..., P90] interpolated from
// the {P10, P50, P90} anchors via z-score scaling.
function fanForMonth(anchors, m) {
  const i = Math.max(0, Math.min(MONTHS, m));
  const p10 = anchors.P10[i], p50 = anchors.P50[i], p90 = anchors.P90[i];
  // sigma estimate from the symmetric P10/P90 distance: 2 × 1.2816 σ.
  const sigma = (p90 - p10) / (2 * 1.2816);
  return Z.map((z) => p50 + z * sigma);
}

// Build a 9-curve dataset over months 0..12 — each curve is an array of
// {month, value}.
function buildCurves(anchors) {
  const curves = Z.map(() => []);
  for (let m = 0; m <= MONTHS; m++) {
    const fan = fanForMonth(anchors, m);
    for (let p = 0; p < Z.length; p++) curves[p].push({ month: m, value: fan[p] });
  }
  return curves;
}

function svg(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

// Color palettes — 'dark' for the in-app station/log view, 'print'
// for the Pediatrician Report (FR-129 plain + NFR-29 print fidelity).
const PALETTES = {
  dark: {
    bg: '#0a0d0a', frame: '#2c3a2c', grid: '#1f2a1f',
    axisLabel: '#aac8aa', title: '#7fff7f',
    fanMid: '#3a6f3a', fan: '#234023', fanLabel: '#3a6f3a', fanLabelMid: '#7fff7f',
    data: '#ffb84d', dataStroke: '#0a0d0a',
  },
  print: {
    bg: '#ffffff', frame: '#666', grid: '#dde6dd',
    axisLabel: '#333', title: '#1f6f1f',
    fanMid: '#1f6f1f', fan: '#a3c9a3', fanLabel: '#5a805a', fanLabelMid: '#1f6f1f',
    data: '#b85c00', dataStroke: '#ffffff',
  },
};

// Renders one chart.  events: array filtered to one type (weight events
// for the weight chart) — each must have .timestamp and one of
// {weightKg, lengthCm}.  field: 'weightKg' | 'lengthCm'. anchorMs: epoch
// ms representing month 0 on the X axis.
function renderChart({ title, units, anchors, events, field, anchorMs, palette = 'dark' }) {
  const C = PALETTES[palette] ?? PALETTES.dark;
  // Build the percentile fan.
  const curves = buildCurves(anchors);

  // Determine y-range from the fan ∪ user data, with a small pad.
  let yMin = curves[0][0].value;
  let yMax = curves[Z.length - 1][MONTHS].value;
  for (const ev of events) {
    const v = ev[field];
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  yMin = Math.floor(yMin - 0.5);
  yMax = Math.ceil(yMax + 0.5);

  const W = 600, H = 260;
  const PAD_L = 38, PAD_R = 12, PAD_T = 28, PAD_B = 32;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const sx = (m) => PAD_L + (m / MONTHS) * innerW;
  const sy = (v) => PAD_T + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    height: H,
    role: 'img',
    'aria-label': title,
    style: `background:${C.bg};border:1px solid ${C.grid};display:block;`,
  });

  // Title.
  root.appendChild(svg('text', {
    x: PAD_L, y: 16, fill: C.title,
    'font-family': 'ui-monospace,Menlo,monospace',
    'font-size': '12', 'letter-spacing': '0.1em',
  }, [textNode(title.toUpperCase())]));

  // Y-axis ticks + grid.
  const yTickStep = niceStep(yMax - yMin);
  for (let v = Math.ceil(yMin); v <= yMax; v += yTickStep) {
    const y = sy(v);
    root.appendChild(svg('line', { x1: PAD_L, x2: W - PAD_R, y1: y, y2: y, stroke: C.grid, 'stroke-width': '1' }));
    root.appendChild(svg('text', {
      x: PAD_L - 4, y: y + 3, fill: C.axisLabel, 'text-anchor': 'end',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [textNode(`${v}${units}`)]));
  }

  // X-axis ticks (every 3 months).
  for (let m = 0; m <= MONTHS; m += 3) {
    const x = sx(m);
    root.appendChild(svg('line', { x1: x, x2: x, y1: PAD_T, y2: H - PAD_B, stroke: C.grid }));
    root.appendChild(svg('text', {
      x, y: H - PAD_B + 12, fill: C.axisLabel, 'text-anchor': 'middle',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [textNode(`${m}m`)]));
  }

  // Frame.
  root.appendChild(svg('rect', {
    x: PAD_L, y: PAD_T, width: innerW, height: innerH,
    fill: 'none', stroke: C.frame, 'stroke-width': '1',
  }));

  // Percentile fan.
  for (let p = 0; p < Z.length; p++) {
    const isMid = PCT_LABELS[p] === 50;
    const points = curves[p].map((d) => `${sx(d.month)},${sy(d.value)}`).join(' ');
    root.appendChild(svg('polyline', {
      points,
      fill: 'none',
      stroke: isMid ? C.fanMid : C.fan,
      'stroke-width': isMid ? '1.4' : '0.7',
      'stroke-dasharray': isMid ? '' : '2,2',
    }));
    // Label the curve at the right edge.
    const last = curves[p][MONTHS];
    root.appendChild(svg('text', {
      x: sx(last.month) + 2, y: sy(last.value) + 3,
      fill: isMid ? C.fanLabelMid : C.fanLabel,
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '8',
    }, [textNode(`p${PCT_LABELS[p]}`)]));
  }

  // User events: dots + connecting polyline.
  const sorted = events.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const dataPts = sorted.map((ev) => {
    const m = (new Date(ev.timestamp).getTime() - anchorMs) / MS_PER_MONTH;
    return { m, v: ev[field], ts: ev.timestamp };
  }).filter((p) => p.m >= -0.1 && p.m <= MONTHS + 0.1);

  if (dataPts.length >= 2) {
    const points = dataPts.map((p) => `${sx(p.m)},${sy(p.v)}`).join(' ');
    root.appendChild(svg('polyline', {
      points, fill: 'none', stroke: C.data, 'stroke-width': '1.6',
    }));
  }
  for (const p of dataPts) {
    root.appendChild(svg('circle', {
      cx: sx(p.m), cy: sy(p.v), r: '3.5',
      fill: C.data, stroke: C.dataStroke, 'stroke-width': '1',
    }));
  }
  return root;
}

function niceStep(span) {
  if (span <= 4) return 0.5;
  if (span <= 10) return 1;
  if (span <= 25) return 2;
  if (span <= 60) return 5;
  return 10;
}

function textNode(s) { return document.createTextNode(s); }

// Public: build the {weightSvg, lengthSvg} pair for the Mission Log
// view.  Returns null when there are no weight events at all (chart
// would be empty / misleading).
export function weightLengthCharts(state, { palette = 'dark', subset = null } = {}) {
  const allEvents = (state.events ?? []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (allEvents.length === 0) return null;
  const eventsForChart = subset ?? state.events ?? [];
  const weightEvents = eventsForChart.filter((e) => e.type === 'weight');
  if (weightEvents.length === 0) return null;
  // Anchor month-0 at the very first event in the canonical state, even
  // when a subset is being charted, so the X axis is meaningful across
  // re-rendered windows (e.g. last-7d in the report).
  const anchorMs = new Date(allEvents[0].timestamp).getTime();
  const weightSvg = renderChart({
    title: 'Weight trajectory · WHO percentile fan',
    units: ' kg',
    anchors: WHO_WEIGHT_BOYS,
    events: weightEvents,
    field: 'weightKg',
    anchorMs,
    palette,
  });
  const lengthSvg = renderChart({
    title: 'Length / height trajectory · WHO percentile fan',
    units: ' cm',
    anchors: WHO_LENGTH_BOYS,
    events: weightEvents,
    field: 'lengthCm',
    anchorMs,
    palette,
  });
  return { weightSvg, lengthSvg, anchorMs };
}
