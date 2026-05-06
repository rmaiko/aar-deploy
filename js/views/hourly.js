// js/views/hourly.js — Mission Log hour-of-day distribution charts.
//
// Two 24-bar histograms (one bucket per hour of local clock time).
// Renders for feeds and dirty events; "what time of day does this
// usually happen" — useful for spotting circadian patterns at a
// glance. Wet/jettison events deliberately excluded.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}
function txt(s) { return document.createTextNode(s); }

function hourlyDistribution(events, type) {
  const counts = new Array(24).fill(0);
  for (const e of events) {
    if (e.type !== type) continue;
    const h = new Date(e.timestamp).getHours();
    if (h >= 0 && h < 24) counts[h] += 1;
  }
  return counts;
}

function renderHourlyChart(counts, title) {
  const N = counts.reduce((a, b) => a + b, 0);
  const W = 560, H = 180;
  const PAD_L = 32, PAD_R = 12, PAD_T = 22, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%', height: H,
    role: 'img',
    'aria-label': `${title} by hour of day`,
    style: 'background:#0a0d0a;border:1px solid #1f2a1f;display:block;',
  });

  // Title.
  root.appendChild(svg('text', {
    x: PAD_L, y: 14, fill: '#7fff7f',
    'font-family': 'ui-monospace,Menlo,monospace',
    'font-size': '11', 'letter-spacing': '0.1em',
  }, [txt(title.toUpperCase())]));

  if (N === 0) {
    root.appendChild(svg('text', {
      x: W / 2, y: H / 2 + 4, fill: '#aac8aa',
      'text-anchor': 'middle',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '11',
    }, [txt('insufficient data')]));
    return root;
  }

  const yMaxRaw = Math.max(...counts);
  const yMax = Math.max(1, Math.ceil(yMaxRaw * 1.15));
  const sx = (h) => PAD_L + (h / 24) * innerW;
  const sy = (n) => PAD_T + innerH - (n / yMax) * innerH;

  // Y-axis ticks.
  const yStep = yMax <= 4 ? 1 : (yMax <= 10 ? 2 : Math.ceil(yMax / 5));
  for (let n = 0; n <= yMax; n += yStep) {
    const y = sy(n);
    root.appendChild(svg('line', { x1: PAD_L, x2: W - PAD_R, y1: y, y2: y, stroke: '#1f2a1f' }));
    root.appendChild(svg('text', {
      x: PAD_L - 4, y: y + 3, fill: '#aac8aa', 'text-anchor': 'end',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(String(n))]));
  }

  // X-axis ticks every 3h (00, 03, 06, 09, 12, 15, 18, 21, 24).
  for (let h = 0; h <= 24; h += 3) {
    const x = sx(h);
    root.appendChild(svg('line', { x1: x, x2: x, y1: PAD_T, y2: H - PAD_B, stroke: '#1f2a1f' }));
    root.appendChild(svg('text', {
      x, y: H - PAD_B + 12, fill: '#aac8aa', 'text-anchor': 'middle',
      'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
    }, [txt(`${String(h % 24).padStart(2, '0')}h`)]));
  }

  // Night-shading band: 22:00 — 06:00. Helps eyes spot night-vs-day
  // distribution without reading numbers.
  const nightStart = sx(22);
  const nightEnd = sx(24);
  const earlyEnd = sx(6);
  root.appendChild(svg('rect', {
    x: nightStart, y: PAD_T, width: nightEnd - nightStart, height: innerH,
    fill: '#13201a', stroke: 'none',
  }));
  root.appendChild(svg('rect', {
    x: PAD_L, y: PAD_T, width: earlyEnd - PAD_L, height: innerH,
    fill: '#13201a', stroke: 'none',
  }));

  // Frame.
  root.appendChild(svg('rect', {
    x: PAD_L, y: PAD_T, width: innerW, height: innerH,
    fill: 'none', stroke: '#2c3a2c', 'stroke-width': '1',
  }));

  // Bars.
  for (let h = 0; h < 24; h++) {
    const c = counts[h];
    if (c === 0) continue;
    const x0 = sx(h);
    const x1 = sx(h + 1);
    const y = sy(c);
    const barH = (PAD_T + innerH) - y;
    root.appendChild(svg('rect', {
      x: x0 + 1, y, width: Math.max(1, x1 - x0 - 2), height: Math.max(0, barH),
      fill: '#3a6f3a', stroke: '#7fff7f', 'stroke-width': '0.5',
    }));
  }

  // Footer annotation.
  root.appendChild(svg('text', {
    x: W - PAD_R - 4, y: PAD_T + 12, fill: '#aac8aa', 'text-anchor': 'end',
    'font-family': 'ui-monospace,Menlo,monospace', 'font-size': '9',
  }, [txt(`n=${N}`)]));

  return root;
}

// Public: returns a section element with hour-of-day histograms for
// feeds and dirty events, or null if there are zero of either.
export function renderHourlyHistograms(state) {
  const events = state.events ?? [];
  const feedCounts = hourlyDistribution(events, 'feed');
  const dirtyCounts = hourlyDistribution(events, 'dirty');
  const feedTotal = feedCounts.reduce((a, b) => a + b, 0);
  const dirtyTotal = dirtyCounts.reduce((a, b) => a + b, 0);
  if (feedTotal + dirtyTotal === 0) return null;

  const wrap = document.createElement('section');
  wrap.className = 'log-hourly-charts';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;margin:0.6rem 0;';
  const heading = document.createElement('h2');
  heading.textContent = 'BY HOUR OF DAY';
  wrap.appendChild(heading);

  if (feedTotal > 0) wrap.appendChild(renderHourlyChart(feedCounts, 'Feeds'));
  if (dirtyTotal > 0) wrap.appendChild(renderHourlyChart(dirtyCounts, 'Ordnance'));

  const note = document.createElement('p');
  note.style.cssText = 'font-size:0.7rem;color:#aac8aa;margin:0;';
  note.textContent = 'Bars: count of events whose timestamp falls in that local-clock hour. Shaded area = 22:00 – 06:00.';
  wrap.appendChild(note);
  return wrap;
}
