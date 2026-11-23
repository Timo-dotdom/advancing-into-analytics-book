// Wetterwahl – Bottom-Sheet mit drei Rastpunkten (wie Apple Karten)
// peek: nur Kopf sichtbar · half: halbe Höhe · full: fast ganzer Bildschirm
// Auf breiten Bildschirmen (≥ 900 px) wird das Sheet zur festen Seitenleiste.

const DESKTOP = window.matchMedia('(min-width: 900px)');

export function createSheet(el, scroller, { onChange } = {}) {
  let snap = el.dataset.snap || 'half';
  let y = 0;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const safeTop = () => parseFloat(getComputedStyle(probe).paddingTop) || 0;
  const safeBottom = () => parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  function positions() {
    const h = window.innerHeight;
    return {
      full: Math.round((document.querySelector('.top')?.getBoundingClientRect().bottom ?? safeTop() + 100) + 2),
      half: Math.round(h * 0.52),
      peek: h - 132 - safeBottom(),
    };
  }
  function apply(animate) {
    if (DESKTOP.matches) { el.style.transform = ''; return; }
    el.classList.toggle('anim', !!animate);
    el.style.transform = `translate3d(0, ${y}px, 0)`;
  }
  function setSnap(s, animate = true) {
    snap = s;
    el.dataset.snap = s;
    y = positions()[s];
    apply(animate);
    if (s !== 'full') scroller.scrollTop = Math.min(scroller.scrollTop, 0);
    onChange?.(s);
  }
  /** Sichtbare Höhe des Sheets über dem Kartenrand (für Kartenausschnitt). */
  function visibleHeight() {
    if (DESKTOP.matches) return 0;
    return window.innerHeight - positions()[snap];
  }

  // ---- Touch-Gesten ----
  let sy = 0, sx = 0, base = 0, t0 = 0, mode = null, lastY = 0, lastT = 0, vel = 0;
  el.addEventListener('touchstart', (e) => {
    if (DESKTOP.matches) return;
    const t = e.touches[0];
    sy = lastY = t.clientY; sx = t.clientX; base = y; t0 = lastT = performance.now(); mode = null; vel = 0;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (DESKTOP.matches || mode === 'none') return;
    const t = e.touches[0];
    const dy = t.clientY - sy, dx = t.clientX - sx;
    if (mode === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const inScroll = e.target.closest('.sheet-scroll');
      if (horizontal) { mode = 'none'; return; }
      if (snap === 'full' && inScroll && !e.target.closest('.grip') && !(scroller.scrollTop <= 0 && dy > 0)) { mode = 'none'; return; }
      mode = 'drag';
    }
    e.preventDefault();
    const pos = positions();
    let ny = base + dy;
    if (ny < pos.full) ny = pos.full - Math.sqrt(pos.full - ny) * 2; // Gummiband
    if (ny > pos.peek) ny = pos.peek + Math.sqrt(ny - pos.peek) * 2;
    y = ny;
    const now = performance.now();
    vel = (t.clientY - lastY) / Math.max(1, now - lastT);
    lastY = t.clientY; lastT = now;
    apply(false);
  }, { passive: false });

  el.addEventListener('touchend', () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    const pos = positions();
    const projected = y + vel * 220;
    const order = ['full', 'half', 'peek'];
    let best = 'half', bd = Infinity;
    for (const k of order) { const d = Math.abs(pos[k] - projected); if (d < bd) { bd = d; best = k; } }
    setSnap(best);
  });

  // Maus (schmales Fenster am Mac): Griff ziehen bzw. antippen
  el.querySelector('.grip')?.addEventListener('click', () => {
    if (DESKTOP.matches) return;
    setSnap(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half');
  });

  window.addEventListener('resize', () => setSnap(snap, false));
  DESKTOP.addEventListener('change', () => setSnap(snap, false));
  setSnap(snap, false);

  return {
    get snap() { return snap; },
    setSnap,
    visibleHeight,
    isDesktop: () => DESKTOP.matches,
  };
}
