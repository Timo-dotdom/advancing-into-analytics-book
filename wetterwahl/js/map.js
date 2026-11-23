// Wetterwahl – Karte (Leaflet) mit Score-Heatmap
/* global L */
import { geodesicCircle } from './geo.js';

const STOPS = [
  [0, [178, 24, 43]], [30, [239, 101, 72]], [50, [253, 190, 105]],
  [65, [254, 240, 150]], [80, [145, 207, 96]], [100, [26, 152, 80]],
];
export function scoreColor(v, alpha = 1) {
  v = Math.max(0, Math.min(100, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [v1, c1] = STOPS[i];
    if (v <= v1) {
      const [v0, c0] = STOPS[i - 1];
      const t = (v - v0) / (v1 - v0);
      const c = c0.map((x, k) => Math.round(x + (c1[k] - x) * t));
      return alpha === 1 ? `rgb(${c})` : `rgba(${c},${alpha})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1]})`;
}
function scoreRGB(v) {
  return scoreColor(v).match(/\d+/g).map(Number);
}

/**
 * Heatmap-Layer: interpoliert die Scores der Rasterpunkte (IDW) auf ein Pixelraster
 * und zeichnet nur innerhalb des Umkreises und über Land.
 */
const HeatLayer = L.Layer.extend({
  initialize() { this._data = null; },
  setData(data) { this._data = data; if (this._map) this._redraw(); },
  onAdd(map) {
    this._canvas = L.DomUtil.create('canvas', 'ww-heat leaflet-zoom-hide');
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend resize', this._redraw, this);
    this._redraw();
  },
  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend resize', this._redraw, this);
  },
  _redraw() {
    const map = this._map, cv = this._canvas;
    if (!map || !cv) return;
    const size = map.getSize();
    cv.width = size.x; cv.height = size.y;
    cv.style.width = size.x + 'px'; cv.style.height = size.y + 'px';
    L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]));
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size.x, size.y);
    const d = this._data;
    if (!d || !d.points.length) return;

    // Pixelgröße des Rasterabstands
    const c0 = map.latLngToContainerPoint([d.center.lat, d.center.lon]);
    const c1 = map.latLngToContainerPoint([d.center.lat + d.spacing / 111.2, d.center.lon]);
    const pxSpacing = Math.max(2, Math.abs(c0.y - c1.y));
    const reach = pxSpacing * 1.25;
    const cell = Math.max(3, Math.min(10, Math.round(pxSpacing / 5)));

    // Punkte projizieren + Gitter-Index für schnelle Nachbarsuche
    const bin = reach;
    const bins = new Map();
    for (const p of d.points) {
      if (p.v == null) continue;
      const c = map.latLngToContainerPoint([p.lat, p.lon]);
      if (c.x < -reach || c.y < -reach || c.x > size.x + reach || c.y > size.y + reach) continue;
      const k = `${Math.floor(c.x / bin)},${Math.floor(c.y / bin)}`;
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push([c.x, c.y, p.v]);
    }

    const w = Math.ceil(size.x / cell), h = Math.ceil(size.y / cell);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    const r2 = reach * reach;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
        const bx = Math.floor(x / bin), by = Math.floor(y / bin);
        let sw = 0, sv = 0, dmin = Infinity;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const arr = bins.get(`${bx + a},${by + b}`);
          if (!arr) continue;
          for (const [px, py, v] of arr) {
            const dd = (px - x) ** 2 + (py - y) ** 2;
            if (dd > r2) continue;
            const wt = 1 / (dd + 1);
            sw += wt; sv += wt * v;
            if (dd < dmin) dmin = dd;
          }
        }
        if (!sw) continue;
        const [r, g, bl] = scoreRGB(sv / sw);
        const o = (j * w + i) * 4;
        const fade = Math.min(1, (reach - Math.sqrt(dmin)) / (reach * 0.35));
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bl;
        img.data[o + 3] = Math.round(165 * fade);
      }
    }
    octx.putImageData(img, 0, 0);

    // Clip: Umkreis ∩ Land
    ctx.save();
    ctx.beginPath();
    d.circle.forEach((p, i) => {
      const c = map.latLngToContainerPoint([p.lat, p.lon]);
      i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.clip();
    if (d.land) {
      const b = map.getBounds().pad(0.1);
      const vb = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      ctx.beginPath();
      for (const poly of d.land.polys) {
        const [x0, y0, x1, y1] = poly.bbox;
        if (x1 < vb[0] || x0 > vb[2] || y1 < vb[1] || y0 > vb[3]) continue;
        for (const ring of poly.rings) {
          for (let k = 0; k < ring.length; k += 2) {
            const c = map.latLngToContainerPoint([ring[k + 1], ring[k]]);
            k ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y);
          }
          ctx.closePath();
        }
      }
      // Bereiche außerhalb der Masken-BBox nicht abschneiden
      const [mx0, my0, mx1, my1] = d.land.bbox;
      if (vb[0] < mx0 || vb[2] > mx1 || vb[1] < my0 || vb[3] > my1) {
        const pts = [[my0, mx0], [my1, mx0], [my1, mx1], [my0, mx1]].map((ll) => map.latLngToContainerPoint(ll));
        ctx.moveTo(-1e4, -1e4); ctx.lineTo(size.x + 1e4, -1e4); ctx.lineTo(size.x + 1e4, size.y + 1e4); ctx.lineTo(-1e4, size.y + 1e4); ctx.closePath();
        pts.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
        ctx.closePath();
      }
      ctx.clip('evenodd');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, w * cell, h * cell);
    ctx.restore();
  },
});

export function createMap(el, { onClick }) {
  const map = L.map(el, { zoomControl: true, attributionControl: true, worldCopyJump: true })
    .setView([50.5, 10], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    className: 'ww-tiles',
  }).addTo(map);
  map.attributionControl.setPrefix(false);

  const heat = new HeatLayer().addTo(map);
  const circleLayer = L.polygon([], { color: '#4aa3ff', weight: 2, fill: false, dashArray: '6 6', interactive: false }).addTo(map);
  const markers = L.layerGroup().addTo(map);
  let startMarker = null;

  map.on('click', (e) => onClick?.({ lat: e.latlng.lat, lon: L.Util.wrapNum(e.latlng.lng, [-180, 180], true) }));

  return {
    map,
    setStart(p) {
      if (!p) return;
      const icon = L.divIcon({ className: 'ww-start', html: '<span>🚐</span>', iconSize: [34, 34], iconAnchor: [17, 17] });
      if (startMarker) startMarker.setLatLng([p.lat, p.lon]);
      else startMarker = L.marker([p.lat, p.lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    },
    setRadius(center, km, fit = false) {
      if (!center) return;
      const ring = geodesicCircle(center, km);
      circleLayer.setLatLngs(ring.map((p) => [p.lat, p.lon]));
      if (fit) map.fitBounds(circleLayer.getBounds(), { padding: [12, 12] });
    },
    setHeat(data) {
      heat.setData(data && { ...data, circle: geodesicCircle(data.center, data.radius, 128) });
    },
    setRegions(regions, onSelect) {
      markers.clearLayers();
      regions.forEach((r, i) => {
        const icon = L.divIcon({
          className: 'ww-rank',
          html: `<span style="--c:${scoreColor(r.window.score)}">${i + 1}</span>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
        L.marker([r.lat, r.lon], { icon, zIndexOffset: 500 - i, keyboard: true, title: `Platz ${i + 1}` })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); onSelect(r, i); })
          .addTo(markers);
      });
    },
    focus(p, zoom) { map.setView([p.lat, p.lon], zoom ?? Math.max(map.getZoom(), 8)); },
    invalidate() { map.invalidateSize(); },
  };
}
