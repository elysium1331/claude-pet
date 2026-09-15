const card = document.getElementById('card');
const rows = document.getElementById('rows');
const footer = document.getElementById('footer');

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// A mini version of the pet's orb: progress ring plus the same 1/2/3 dot mark.
function ring(meter) {
  const root = svg('svg', { class: 'ring', viewBox: '0 0 26 26' });
  root.style.setProperty('--circ', RING_CIRC);
  root.style.setProperty('--offset', RING_CIRC * (1 - meter.percent / 100));
  root.append(
    svg('circle', { class: 'track', cx: 13, cy: 13, r: RING_R }),
    svg('circle', { class: 'fill', cx: 13, cy: 13, r: RING_R }),
  );
  const count = Math.min(3, meter.mark);
  for (let i = 0; i < count; i += 1) {
    // dots sit in a row across the center; the svg is rotated -90deg, so lay them out along y
    const offset = (i - (count - 1) / 2) * 4;
    root.append(svg('circle', { class: 'mark', cx: 13, cy: 13 + offset, r: 1.3 }));
  }
  return root;
}

function resetLine(m) {
  if (m.resetPassed) return 'Reset since the last check';
  if (!m.resetText) return '';
  return m.countdown === 'now' ? 'Resetting now' : `Resets ${m.resetText} · in ${m.countdown}`;
}

function render(view) {
  if (!view.meters.length) {
    rows.replaceChildren(el('div', 'empty', view.status === 'loading' ? 'Checking usage…' : 'No usage data yet'));
  } else {
    rows.replaceChildren(...view.meters.map((m) => {
      const row = el('div', `row ${m.level}`);
      row.style.setProperty('--color', m.color);
      const body = el('div');
      const top = el('div', 'top');
      top.append(el('span', 'name', m.label), el('span', 'pct', `${m.percent}%`));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.setProperty('--pct', `${m.percent}%`);
      bar.append(fill);
      body.append(top, bar, el('div', 'when', resetLine(m)));
      row.append(ring(m), body);
      return row;
    }));
  }
  footer.textContent = [
    view.message,
    view.updatedAgo && `Updated ${view.updatedAgo}`,
    !view.claudeRunning && 'Claude is closed, napping',
  ].filter(Boolean).join(' · ');
}

window.panelHost.onView(render);

window.panelHost.onOpen((side) => {
  document.body.classList.remove('open', 'above', 'below');
  document.body.classList.add(side);
  void card.offsetWidth; // restart the grow animation
  document.body.classList.add('open');
});

window.panelHost.onClose(() => {
  document.body.classList.remove('open');
});

card.addEventListener('click', () => window.panelHost.clicked());

new ResizeObserver(() => {
  window.panelHost.reportSize({ width: card.offsetWidth, height: card.offsetHeight });
}).observe(card);
