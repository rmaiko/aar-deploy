// js/views/intervals.js — C-21 inter-event interval histograms (AMD-010).
//
// Three small histograms on the Mission Log: feed-to-feed,
// wet-to-wet, dirty-to-dirty. Bars are observed counts; the optional
// curve is a log-normal MLE fit of the same data — both the parents'
// and the pediatrician's eye for "is this still in pattern" benefits
// from seeing the modal interval.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}
function txt(s) { return document.createTextNode(s); }

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function buildBins(values, binCount) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const p95 = quantile(sorted, 0.95);
  // Clamp so a single outlier doesn't crush the histogram.
  const max = Math.max(p95 * 1.15, 5);
  const width = max / binCount;
  const bins = new Array(binCount).fill(0);
  for (const v of values) {
    if (v < 0) continue;
    const i = Math.min(binCount - 1, Math.floor(v / width));
    bins[i] += 1;
  }
  return { bins, max, width };
}

function logNormalFit(values) {
  const positives = values.filter((v) => v > 0);
  if (positives.length < 3) return null;
  const ln = positives.map(Math.log);
  const mu = ln.reduce((a, b) => a + b, 0) / ln.length;
  const variance = ln.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, ln.length - 1);
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) return null;
  return { mu, sigma, n: positives.length };
}

function logNormalPdf(x, mu, sigma) {
  if (x <= 0) return 0;
  const z = (Math.log(x) - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (x * sigma * Math.sqrt(2 * Math.PI));
}

// Compute deltas between consecutive events of one `type`, in minutes.
function intervalsForType(events, type, sideOpt) {
  const filtered = events
    .filter((e) => e.type === type && (!sideOpt || e.side === sideOpt))
    .map((e) => new Date(e.timestamp).getTime())
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < filtered.length; i++) {
    const dMin = (filtered[i] - filtered[i - 1]) / 60_000;
    if (dMin > 0) out.push(dMin);
  }
  return out;
}

function formatMin(n) {
  if (n < 60) return `${Math.round(n)}m`;
  const h = n / 60;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

function renderHistogramSvg(values, title) {
  const W = 560, H = 180;
  const PAD_L = 36, PAD_R = 12, PAD_T = 22, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%', height: H,
    role: 'img',
    'aria-label': `${title} histogram`,
    style: 'background:#0a0d0a;border:1px solid #1f2a1f;display:block;',
  });

  // Title.
  root.appendChild(svg('text', {
    x: PAD_L, y: 14, fill: '#7fff7f',
    'font-family': 'ui-monospace,Menlo,monospace',
    'font-size': '11', 'letter-spacing': '0.1em',
  }, [txt(title.toUpperCase())]));

  if (values.length < 2) {
    root.appendChild(svg('text', {
      x: W / 2, y: H / 2 + 4, fill: '#aac8aa',
      'text-anchor': 'middle',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '11',
    }, [txt('insufficient data')]));
    return root;
  }

  const BIN_COUNT = 16;
  const binData = buildBins(values, BIN_COUNT);
  const fit = logNormalFit(values);
  const N = values.length;

  let yMax = Math.max(...binData.bins);
  // Make sure the curve fits even when its peak slightly exceeds bins.
  if (fit) {
    let curveMax = 0;
    for (let i = 0; i < BIN_COUNT; i++) {
      const x = (i + 0.5) * binData.width;
      const expected = logNormalPdf(x, fit.mu, fit.sigma) * N * binData.width;
      if (expected > curveMax) curveMax = expected;
    }
    yMax = Math.max(yMax, curveMax);
  }
  yMax = Math.max(1, Math.ceil(yMax * 1.15));

  const sx = (v) => PAD_L + (v / binData.max) * innerW;
  const sy = (n) => PAD_T + innerH - (n / yMax) * innerH;

  // Y-axis ticks (count).
  const yStep = yMax <= 4 ? 1 : (yMax <= 10 ? 2 : Math.ceil(yMax / 5));
  for (let n = 0; n <= yMax; n += yStep) {
    const y = sy(n);
    root.appendChild(svg('line', { x1: PAD_L, x2: W - PAD_R, y1: y, y2: y, stroke: '#1f2a1f' }));
    root.appendChild(svg('text', {
      x: PAD_L - 4, y: y + 3, fill: '#aac8aa', 'text-anchor': 'end',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(String(n))]));
  }

  // X-axis ticks (intervals at 0, max/4, max/2, 3max/4, max).
  for (let i = 0; i <= 4; i++) {
    const v = (binData.max / 4) * i;
    const x = sx(v);
    root.appendChild(svg('line', { x1: x, x2: x, y1: PAD_T, y2: H - PAD_B, stroke: '#1f2a1f' }));
    root.appendChild(svg('text', {
      x, y: H - PAD_B + 12, fill: '#aac8aa', 'text-anchor': 'middle',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(formatMin(v))]));
  }
  // Frame.
  root.appendChild(svg('rect', {
    x: PAD_L, y: PAD_T, width: innerW, height: innerH,
    fill: 'none', stroke: '#2c3a2c', 'stroke-width': '1',
  }));

  // Bars.
  for (let i = 0; i < BIN_COUNT; i++) {
    const x0 = sx(i * binData.width);
    const x1 = sx((i + 1) * binData.width);
    const h = innerH - (sy(binData.bins[i]) - PAD_T);
    if (binData.bins[i] === 0) continue;
    root.appendChild(svg('rect', {
      x: x0 + 1, y: sy(binData.bins[i]),
      width: Math.max(1, x1 - x0 - 2), height: Math.max(0, h),
      fill: '#3a6f3a', stroke: '#7fff7f', 'stroke-width': '0.5',
    }));
  }

  // Log-normal MLE overlay. Sample 60 points across the visible domain.
  if (fit) {
    const samples = 60;
    const points = [];
    for (let i = 0; i <= samples; i++) {
      const x = (binData.max * i) / samples;
      const expected = logNormalPdf(x, fit.mu, fit.sigma) * N * binData.width;
      points.push(`${sx(x)},${sy(expected)}`);
    }
    root.appendChild(svg('polyline', {
      points: points.join(' '),
      fill: 'none', stroke: '#ffb84d', 'stroke-width': '1.4',
      'stroke-dasharray': '4,3',
    }));
    // Annotate fit parameters.
    const median = Math.exp(fit.mu);
    root.appendChild(svg('text', {
      x: W - PAD_R - 4, y: PAD_T + 12, fill: '#ffb84d', 'text-anchor': 'end',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(`log-normal · median ${formatMin(median)} · n=${N}`)]));
  } else {
    root.appendChild(svg('text', {
      x: W - PAD_R - 4, y: PAD_T + 12, fill: '#aac8aa', 'text-anchor': 'end',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(`n=${N}`)]));
  }
  return root;
}

// Public: returns an HTMLElement containing histograms for the three
// event types, or null if there are no events at all.
export function renderIntervalHistograms(state) {
  const events = state.events ?? [];
  if (events.length === 0) return null;
  const feedIntervals = intervalsForType(events, 'feed');
  const wetIntervals = intervalsForType(events, 'wet');
  const dirtyIntervals = intervalsForType(events, 'dirty');
  if (feedIntervals.length + wetIntervals.length + dirtyIntervals.length === 0) return null;

  const wrap = document.createElement('section');
  wrap.className = 'log-interval-charts';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;margin:0.6rem 0;';
  const heading = document.createElement('h2');
  heading.textContent = 'INTER-EVENT INTERVALS';
  wrap.appendChild(heading);

  if (feedIntervals.length > 0) wrap.appendChild(renderHistogramSvg(feedIntervals, 'Feed-to-feed'));
  if (wetIntervals.length > 0) wrap.appendChild(renderHistogramSvg(wetIntervals, 'Wet-to-wet'));
  if (dirtyIntervals.length > 0) wrap.appendChild(renderHistogramSvg(dirtyIntervals, 'Dirty-to-dirty'));

  const note = document.createElement('p');
  note.style.cssText = 'font-size:0.7rem;color:#aac8aa;margin:0;';
  note.textContent = 'Bars: observed gaps between consecutive events. Dashed orange: log-normal MLE fit (informational only).';
  wrap.appendChild(note);
  return wrap;
}
