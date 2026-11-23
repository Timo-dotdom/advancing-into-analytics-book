// Wetterwahl – App-Steuerung
import { prepareLand, autoGrid, haversineKm, driveHours, formatDuration } from './geo.js';
import { ensembleConfidence } from './score.js';
import { scorePoints, clusterRegions } from './regions.js';
import { fetchForecast, fetchEnsemble, searchPlace, reverseName, pruneCache, clearCache } from './api.js';
import { loadSettings, saveSettings, loadSearch, saveSearch, defaultProfile } from './store.js';
import { createMap, scoreColor } from './map.js';
import { park4nightUrl, park4nightWebUrl, appleMapsUrl, coordText, copyText } from './links.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Zustand ----------
let settings = loadSettings();
const saved = loadSearch() || {};
const state = {
  start: saved.start || null,          // { lat, lon, label }
  radius: saved.radius || 400,
  days: saved.days || 4,
  earliest: saved.earliest || 0,
  profile: saved.profile && settings.profiles[saved.profile] ? saved.profile : 'wandern',
  lastRun: saved.lastRun || 0,
  picking: !saved.start,
  land: null,
  data: null,       // { key, center, radius, spacing, points:[{lat,lon,distKm,days,elevation}] }
  regions: [],
  scored: [],
  ensemble: new Map(),
  names: new Map(),
  busy: false,
};

applyTheme();
pruneCache();

const ui = createMap($('#map'), { onClick: onMapClick });

// ---------- Hilfen: Datum & Format ----------
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function dayDate(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
function fmtDate(d) {
  if (typeof d === 'string') d = new Date(d + 'T12:00:00');
  return `${WD[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}
function earliestLabel(i) {
  if (i === 0) return `Heute (${fmtDate(dayDate(0))})`;
  if (i === 1) return `Morgen (${fmtDate(dayDate(1))})`;
  return `${fmtDate(dayDate(i))} (Tag ${i + 1})`;
}
const round = (x) => (x == null ? '–' : Math.round(x));
const hours = (s) => (s == null ? '–' : (s / 3600).toFixed(s >= 36000 ? 0 : 1).replace('.', ','));
function weatherIcon(d) {
  if (d.precip != null && d.precip >= 1 && (d.precipProb ?? 60) >= 50) return d.precip >= 8 ? '🌧️' : '🌦️';
  const ratio = d.daylight ? (d.sunshine ?? 0) / d.daylight : 0;
  if (ratio > 0.6) return '☀️';
  if (ratio > 0.3) return '🌤️';
  if (ratio > 0.1) return '⛅';
  return '☁️';
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Formular ----------
function renderProfiles() {
  $('#profiles').innerHTML = Object.entries(settings.profiles).map(([id, p]) =>
    `<button type="button" role="radio" class="chip" data-id="${id}" aria-checked="${id === state.profile}">${p.icon || ''} ${esc(p.name)}</button>`).join('');
}
function renderEarliest() {
  const sel = $('#earliest');
  sel.innerHTML = Array.from({ length: 15 }, (_, i) => `<option value="${i}">${earliestLabel(i)}</option>`).join('');
  sel.value = String(Math.min(state.earliest, 14));
}
function syncOutputs() {
  $('#radius-out').textContent = `${state.radius} km`;
  $('#days-out').textContent = state.days === 1 ? '1 Tag' : `${state.days} Tage`;
  $('#start-label').textContent = state.start
    ? `🚐 ${state.start.label || coordText(state.start.lat, state.start.lon)}`
    : 'Noch kein Startpunkt gewählt';
  $('#start-label').classList.toggle('muted', !state.start);
  $('#btn-pick').setAttribute('aria-pressed', String(state.picking));
  $('#map').classList.toggle('picking', state.picking);
}
function persist() {
  saveSearch({
    start: state.start, radius: state.radius, days: state.days,
    earliest: state.earliest, profile: state.profile, lastRun: state.lastRun,
  });
}
function updateSummary() {
  const s = $('#summary');
  if (!state.regions.length || !state.start) { s.hidden = true; return; }
  const p = settings.profiles[state.profile];
  s.innerHTML = `<span>🚐 ${esc(state.start.label || 'Start')} · ${state.radius} km · ${state.days} ${state.days === 1 ? 'Tag' : 'Tage'} · ${p.icon} ${esc(p.name)}</span><span class="edit">Ändern</span>`;
  s.hidden = false;
}

$('#radius').value = state.radius;
$('#days').value = state.days;
renderProfiles();
renderEarliest();
syncOutputs();
if (state.start) {
  ui.setStart(state.start);
  ui.setRadius(state.start, state.radius, true);
}

$('#radius').addEventListener('input', (e) => {
  state.radius = +e.target.value;
  syncOutputs();
  ui.setRadius(state.start, state.radius);
});
$('#radius').addEventListener('change', () => { ui.setRadius(state.start, state.radius, true); persist(); });
$('#days').addEventListener('input', (e) => { state.days = +e.target.value; syncOutputs(); });
$('#days').addEventListener('change', () => { persist(); rescore(); });
$('#earliest').addEventListener('change', (e) => { state.earliest = +e.target.value; persist(); rescore(); });
$('#profiles').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.profile = b.dataset.id;
  renderProfiles();
  persist();
  rescore();
});
$('#summary').addEventListener('click', () => {
  $('#panel').classList.remove('collapsed');
  setTimeout(() => ui.invalidate(), 50);
});

function setStart(p, label) {
  state.start = { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), label };
  state.picking = false;
  ui.setStart(state.start);
  ui.setRadius(state.start, state.radius, true);
  syncOutputs();
  persist();
  if (!label) {
    reverseName(state.start.lat, state.start.lon).then((n) => {
      if (n?.name && state.start && !state.start.label) {
        state.start.label = n.name;
        syncOutputs();
        persist();
      }
    });
  }
}

$('#btn-gps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Standort wird von diesem Browser nicht unterstützt.');
  const btn = $('#btn-gps');
  btn.disabled = true;
  btn.textContent = '📍 Suche …';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false; btn.textContent = '📍 Mein Standort';
      setStart({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    },
    (err) => {
      btn.disabled = false; btn.textContent = '📍 Mein Standort';
      toast(err.code === 1
        ? 'Standortzugriff verweigert. Auf dem iPhone: Einstellungen › Datenschutz › Ortungsdienste › Safari-Websites.'
        : 'Standort konnte nicht ermittelt werden.', 5000);
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
  );
});
$('#btn-pick').addEventListener('click', () => {
  state.picking = !state.picking;
  syncOutputs();
  if (state.picking) toast('Tippe auf die Karte, um den Startpunkt zu setzen.');
});

// Ortssuche
let searchTimer = null, searchCtl = null, suggestions = [];
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#suggest').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    searchCtl?.abort();
    searchCtl = new AbortController();
    try {
      suggestions = await searchPlace(q, { signal: searchCtl.signal });
      const ul = $('#suggest');
      ul.innerHTML = suggestions.length
        ? suggestions.map((s, i) => `<li><button type="button" data-i="${i}"><b>${esc(s.name)}</b> <span class="muted">${esc(s.detail)}</span></button></li>`).join('')
        : '<li class="muted empty">Nichts gefunden</li>';
      ul.hidden = false;
    } catch (err) { if (err.name !== 'AbortError') console.warn(err); }
  }, 350);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (suggestions[0] && !$('#suggest').hidden) pickSuggestion(0);
  }
});
$('#suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) pickSuggestion(+b.dataset.i);
});
function pickSuggestion(i) {
  const s = suggestions[i];
  if (!s) return;
  $('#suggest').hidden = true;
  $('#q').value = '';
  $('#q').blur();
  setStart(s, s.name);
}
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#suggest').hidden = true; });

$('#form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });

// ---------- Karte ----------
function onMapClick(p) {
  if (state.picking || !state.data) {
    setStart(p);
    return;
  }
  if (!state.scored.length) return;
  // nächster Rasterpunkt → Details
  let best = null, bd = Infinity;
  for (const s of state.scored) {
    const d = haversineKm(p, s);
    if (d < bd) { bd = d; best = s; }
  }
  if (best && bd <= state.data.spacing * 1.2) {
    showDetails(best);
  } else {
    toast('Außerhalb des Suchgebiets. Neuen Startpunkt? „Auf Karte tippen“ nutzen.');
  }
}

// ---------- Suche ----------
function loader(on, text, frac) {
  $('#loader').hidden = !on;
  if (text) $('#loader-text').textContent = text;
  if (frac != null) $('#loader-bar').style.width = `${Math.round(frac * 100)}%`;
}
function setStatus(html, kind = '') {
  const s = $('#status');
  s.className = `status ${kind}`;
  s.innerHTML = html;
}

async function ensureLand() {
  if (state.land) return state.land;
  try {
    const res = await fetch('data/land.json');
    state.land = prepareLand(await res.json());
  } catch {
    state.land = null; // ohne Maske weitermachen
  }
  return state.land;
}

async function runSearch({ silent = false } = {}) {
  if (state.busy) return;
  if (!state.start) {
    toast('Bitte zuerst einen Startpunkt wählen (Standort, Suche oder Karte).');
    return;
  }
  state.busy = true;
  $('#btn-search').disabled = true;
  try {
    loader(true, 'Raster wird berechnet …', 0);
    const land = await ensureLand();
    const center = { lat: state.start.lat, lon: state.start.lon };
    const { spacing, points } = autoGrid(center, state.radius, land, settings.maxPoints);
    loader(true, `Lade Wetterdaten für ${points.length} Orte …`, 0);
    const fc = await fetchForecast(points, {
      onProgress: (done, total) => loader(true, `Wetterdaten: ${done} von ${total} Orten …`, done / total),
    });
    state.data = {
      center, radius: state.radius, spacing,
      points: points.map((p, i) => ({ ...p, days: fc[i].days, elevation: fc[i].elevation })),
    };
    state.lastRun = Date.now();
    persist();
    loader(false);
    rescore({ fit: true });
    if (!silent && window.matchMedia('(max-width: 899px)').matches) {
      $('#panel').classList.add('collapsed');
      setTimeout(() => ui.invalidate(), 50);
    }
  } catch (err) {
    loader(false);
    console.error(err);
    setStatus(`⚠️ ${esc(err.message || err)}`, 'error');
  } finally {
    state.busy = false;
    $('#btn-search').disabled = false;
  }
}

/** Neu bewerten ohne neuen Abruf (Profil, Dauer, Startdatum geändert). */
function rescore({ fit = false } = {}) {
  const d = state.data;
  if (!d) return;
  const profile = settings.profiles[state.profile];
  const nDays = d.points[0]?.days.length || 16;
  const startMax = nDays - state.days;
  const startMin = Math.min(state.earliest, startMax);
  state.scored = scorePoints(d.points, { n: state.days, startMin, startMax, profile });
  const minDist = Math.max(80, 2 * d.spacing);
  state.regions = clusterRegions(state.scored, minDist, 10);

  ui.setHeat({
    center: d.center, radius: d.radius, spacing: d.spacing, land: state.land,
    points: state.scored.map((p) => ({ lat: p.lat, lon: p.lon, v: p.window?.score ?? null })),
  });
  ui.setStart(state.start);
  ui.setRadius(d.center, d.radius, fit);
  ui.setRegions(state.regions, (r) => showDetails(r));
  $('#legend').hidden = false;

  const changed = d.radius !== state.radius || haversineKm(d.center, state.start) > 1;
  const age = Math.round((Date.now() - state.lastRun) / 60000);
  const ageTxt = age < 2 ? 'gerade eben' : age < 60 ? `vor ${age} min` : `vor ${Math.round(age / 60)} h`;
  setStatus(
    `<div><b>${state.regions.length} Regionen</b> aus ${d.points.length} Orten (Raster ~${Math.round(d.spacing)} km) · Stand ${ageTxt}</div>` +
    (changed ? '<div class="warn">Startpunkt oder Radius geändert – „Beste Regionen finden“ tippen, um neu zu laden.</div>' : '') +
    '<div class="hint">ℹ️ Prognosen für Tag 10–14 sind unsicher. Vor der Abfahrt nochmal prüfen.</div>',
  );
  if (startMin < state.earliest) {
    setStatus($('#status').innerHTML + `<div class="warn">Frühester Start auf ${fmtDate(dayDate(startMin))} vorgezogen, damit ${state.days} Tage in die Prognose passen.</div>`);
  }
  renderResults();
  updateSummary();
  loadRegionExtras();
}

// ---------- Ergebnisliste ----------
function confBadge(r) {
  const c = r.confidence;
  const end = r.window.start + state.days - 1;
  const far = end >= 9 ? '<span class="badge far" title="Fenster reicht bis Tag 10 oder später">Tag 10+</span>' : '';
  if (!c) return `<span class="badge conf-load">Sicherheit …</span>${far}`;
  const label = { hoch: 'hoch', mittel: 'mittel', niedrig: 'niedrig', unbekannt: '?' }[c.level];
  return `<span class="badge conf-${c.level}" title="Prognose-Sicherheit aus ${c.coveredDays} Ensemble-Tagen">Sicherheit ${label}</span>${far}`;
}
function dayStrip(p, start, n, compact = true) {
  const cells = [];
  for (let i = start; i < start + n; i++) {
    const d = p.days[i];
    if (!d) continue;
    cells.push(`<div class="dc" style="--c:${scoreColor(p.dayScores[i] ?? 0)}">
      <div class="dc-d">${fmtDate(d.date)}</div>
      <div class="dc-i">${weatherIcon(d)}</div>
      <div class="dc-t"><b>${round(d.tmax)}°</b><span>${round(d.tmin)}°</span></div>
      <div class="dc-r">${d.precip == null ? '–' : (d.precip < 0.1 ? 0 : d.precip.toFixed(d.precip < 10 ? 1 : 0)).toString().replace('.', ',')} mm</div>
      <div class="dc-s">${hours(d.sunshine)} h</div>
    </div>`);
  }
  return `<div class="strip${compact ? '' : ' big'}">${cells.join('')}</div>`;
}
function regionName(r) {
  const n = state.names.get(`${r.lat},${r.lon}`);
  return n?.name ? `${esc(n.name)}${n.country ? ` <span class="cc">${esc(n.country)}</span>` : ''}` : `<span class="muted">${r.lat.toFixed(2)}° N, ${r.lon.toFixed(2)}° O</span>`;
}
function renderResults() {
  const ol = $('#results');
  if (!state.regions.length) {
    ol.innerHTML = '<li class="empty">Keine passenden Fenster gefunden. Kürzere Reisedauer oder früheren Start probieren.</li>';
    return;
  }
  ol.innerHTML = state.regions.map((r, i) => {
    const w = r.window;
    const km = r.distKm;
    const end = r.days[w.start + state.days - 1].date;
    return `<li class="card" data-i="${i}" tabindex="0">
      <div class="card-head">
        <span class="rank" style="--c:${scoreColor(w.score)}">${i + 1}</span>
        <div class="card-title">
          <div class="name">${regionName(r)}</div>
          <div class="meta">${fmtDate(r.days[w.start].date)} – ${fmtDate(end)} · ${Math.round(km)} km · ${formatDuration(driveHours(km, settings.detour, settings.speed))}</div>
        </div>
        <span class="score" style="--c:${scoreColor(w.score)}">${Math.round(w.score)}</span>
      </div>
      ${dayStrip(r, w.start, state.days)}
      <div class="card-foot">
        <div class="badges">${confBadge(r)}</div>
        <a class="btn p4n" href="${park4nightUrl(r.lat, r.lon)}" target="_blank" rel="noopener" data-stop>🅿️ Park4Night</a>
      </div>
    </li>`;
  }).join('');
}
$('#results').addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]')) return;
  const li = e.target.closest('.card');
  if (!li) return;
  const r = state.regions[+li.dataset.i];
  ui.focus(r);
  showDetails(r);
});
$('#results').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) e.target.click();
});

/** Namen (Nominatim) und Ensemble-Sicherheit für die Top-Regionen nachladen. */
let extrasRun = 0;
async function loadRegionExtras() {
  const run = ++extrasRun;
  const regs = state.regions;
  // Ensemble für alle Regionen in einem Request
  const need = regs.filter((r) => !state.ensemble.has(`${r.lat},${r.lon}`));
  if (need.length) {
    try {
      const ens = await fetchEnsemble(need);
      need.forEach((r, i) => state.ensemble.set(`${r.lat},${r.lon}`, ens[i]));
    } catch (err) {
      console.warn('Ensemble nicht verfügbar', err);
      need.forEach((r) => state.ensemble.set(`${r.lat},${r.lon}`, null));
    }
  }
  if (run !== extrasRun) return;
  for (const r of regs) r.confidence = confidenceFor(r);
  renderResults();
  // Namen nacheinander (1/s)
  for (const r of regs) {
    const k = `${r.lat},${r.lon}`;
    if (state.names.has(k)) continue;
    const n = await reverseName(r.lat, r.lon);
    if (run !== extrasRun) return;
    state.names.set(k, n);
    renderResults();
  }
}
function confidenceFor(p) {
  const ens = state.ensemble.get(`${p.lat},${p.lon}`);
  if (!ens) return { level: 'unbekannt', coveredDays: 0 };
  // Ensemble-Tage über das Datum zuordnen
  const idx = [];
  for (let i = p.window.start; i < p.window.start + state.days; i++) {
    const j = ens.dates.indexOf(p.days[i]?.date);
    if (j >= 0) idx.push(j);
  }
  return ensembleConfidence(ens, idx);
}

// ---------- Details ----------
async function showDetails(p) {
  const dlg = $('#details');
  const k = `${p.lat},${p.lon}`;
  const w = p.window;
  const region = state.regions.find((r) => r.lat === p.lat && r.lon === p.lon);
  const rank = region ? state.regions.indexOf(region) + 1 : null;
  if (!p.confidence && state.ensemble.has(k)) p.confidence = confidenceFor(p);

  const rows = p.days.map((d, i) => {
    const inWin = w && i >= w.start && i < w.start + state.days;
    const s = p.dayScores[i];
    return `<tr class="${inWin ? 'win' : ''}">
      <td>${fmtDate(d.date)}</td><td>${weatherIcon(d)}</td>
      <td><b>${round(d.tmax)}°</b> / ${round(d.tmin)}°</td>
      <td>${d.precip == null ? '–' : d.precip.toFixed(1).replace('.', ',')} mm${d.precipProb != null ? ` <span class="muted">${d.precipProb}%</span>` : ''}</td>
      <td>${hours(d.sunshine)} h</td>
      <td>${round(d.gust)}</td>
      <td><span class="pill" style="--c:${scoreColor(s ?? 0)}">${s == null ? '–' : Math.round(s)}</span></td>
    </tr>`;
  }).join('');

  const km = p.distKm ?? haversineKm(state.data.center, p);
  dlg.innerHTML = `
    <div class="sheet-head">
      <div>
        <div class="sheet-title">${rank ? `<span class="rank" style="--c:${scoreColor(w.score)}">${rank}</span>` : ''}<span id="dname">${regionName(p)}</span></div>
        <div class="meta">${coordText(p.lat, p.lon)}${p.elevation != null ? ` · ${Math.round(p.elevation)} m ü. M.` : ''} · ${Math.round(km)} km · ${formatDuration(driveHours(km, settings.detour, settings.speed))}</div>
      </div>
      <button class="icon-btn" data-close aria-label="Schließen">✕</button>
    </div>
    ${w ? `<div class="sheet-sum">
      <span class="score big" style="--c:${scoreColor(w.score)}">${Math.round(w.score)}</span>
      <div><b>Bestes Fenster: ${fmtDate(p.days[w.start].date)} – ${fmtDate(p.days[w.start + state.days - 1].date)}</b>
      <div class="muted">Ø ${Math.round(w.mean)} · schlechtester Tag ${Math.round(w.min)}${region?.members > 1 ? ` · Region aus ${region.members} Rasterpunkten` : ''}</div>
      <div class="badges">${p.confidence ? confBadge(p) : ''}</div></div>
    </div>` : '<p class="muted">Kein passendes Fenster.</p>'}
    <div class="actions">
      <a class="btn primary" href="${park4nightUrl(p.lat, p.lon)}" target="_blank" rel="noopener">🅿️ In Park4Night öffnen</a>
      <a class="btn" href="${park4nightWebUrl(p.lat, p.lon)}" target="_blank" rel="noopener">🌐 Park4Night Web</a>
      <button class="btn" data-copy>📋 Koordinaten kopieren</button>
      <a class="btn" href="${appleMapsUrl(p.lat, p.lon)}" target="_blank" rel="noopener">🧭 Route</a>
    </div>
    <div class="table-wrap"><table class="days">
      <thead><tr><th>Tag</th><th></th><th>Max/Min</th><th>Regen</th><th>Sonne</th><th title="Windböen km/h">Böen</th><th>Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">Markiert: bestes ${state.days}-Tage-Fenster. Tage ab Tag 10 sind unsicher.</p>`;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-copy]').onclick = async () => {
    const ok = await copyText(coordText(p.lat, p.lon));
    toast(ok ? `Kopiert: ${coordText(p.lat, p.lon)}` : 'Kopieren nicht möglich');
  };
  if (!dlg.open) dlg.showModal();
  if (!state.names.has(k)) {
    const n = await reverseName(p.lat, p.lon);
    state.names.set(k, n);
    const el = dlg.querySelector('#dname');
    if (el && dlg.open) el.innerHTML = regionName(p);
  }
}
for (const dlg of [$('#details'), $('#settings')]) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // Tipp auf Hintergrund
}

// ---------- Einstellungen ----------
const FIELDS = [
  ['tempMin', 'Wohlfühl-Temperatur ab', '°C', 1],
  ['tempMax', 'Wohlfühl-Temperatur bis', '°C', 1],
  ['heatLimit', 'Hitzegrenze (darüber stark abwerten)', '°C', 1],
  ['coldMargin', 'Kälte-Toleranz unter Wohlfühlbereich', '°C', 1],
  ['rainBadMm', 'Regenmenge, die voll zählt', 'mm', 0.5],
  ['gustOk', 'Böen ok bis', 'km/h', 5],
  ['gustBad', 'Böen inakzeptabel ab', 'km/h', 5],
];
const WEIGHTS = [['sun', 'Sonne'], ['temp', 'Temperatur'], ['rain', 'Trockenheit'], ['wind', 'Wind']];
let settingsTab = null;

function renderSettings() {
  settingsTab = settingsTab || state.profile;
  const p = settings.profiles[settingsTab];
  const dlg = $('#settings');
  dlg.innerHTML = `
    <div class="sheet-head"><div class="sheet-title">Einstellungen</div><button class="icon-btn" data-close aria-label="Schließen">✕</button></div>
    <h3>Wetterprofile</h3>
    <div class="chips">${Object.entries(settings.profiles).map(([id, pr]) =>
      `<button type="button" class="chip" data-tab="${id}" aria-checked="${id === settingsTab}">${pr.icon} ${esc(pr.name)}</button>`).join('')}</div>
    <div class="set-grid">
      <h4>Gewichtung</h4>
      ${WEIGHTS.map(([k, l]) => `<label class="set-row"><span>${l}</span>
        <input type="range" min="0" max="100" step="5" data-w="${k}" value="${Math.round((p.weights[k] || 0) * 100)}">
        <output>${Math.round((p.weights[k] || 0) * 100)}</output></label>`).join('')}
      <h4>Grenzwerte</h4>
      ${FIELDS.map(([k, l, u, st]) => `<label class="set-row num"><span>${l}</span>
        <span><input type="number" step="${st}" data-f="${k}" value="${p[k]}" inputmode="decimal"> ${u}</span></label>`).join('')}
      <label class="set-row"><span>Strenge bei schlechten Einzeltagen</span>
        <input type="range" min="0" max="80" step="5" data-f="worstWeight" data-scale="100" value="${Math.round((p.worstWeight ?? 0.4) * 100)}">
        <output>${Math.round((p.worstWeight ?? 0.4) * 100)}%</output></label>
      <button type="button" class="btn small" data-reset-profile>Profil „${esc(p.name)}“ zurücksetzen</button>
    </div>
    <h3>Allgemein</h3>
    <div class="set-grid">
      <label class="set-row num"><span>Rasterdichte (max. Orte)</span>
        <select data-g="maxPoints">${[[200, 'grob (200)'], [400, 'normal (400)'], [700, 'fein (700)']].map(([v, l]) =>
          `<option value="${v}" ${+settings.maxPoints === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="set-row num"><span>Umwegfaktor Straße</span><span><input type="number" step="0.05" min="1" max="2" data-g="detour" value="${settings.detour}"> ×</span></label>
      <label class="set-row num"><span>Ø Tempo Camper</span><span><input type="number" step="5" min="30" max="120" data-g="speed" value="${settings.speed}"> km/h</span></label>
      <label class="set-row num"><span>Darstellung</span>
        <select data-g="theme">${[['auto', 'System'], ['dark', 'Dunkel'], ['light', 'Hell']].map(([v, l]) =>
          `<option value="${v}" ${settings.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button type="button" class="btn small" data-clear>Wetter-Cache leeren</button>
    </div>
    <p class="hint">Mehr Orte = feinere Karte, aber mehr Abfragen (Open-Meteo erlaubt ca. 10.000 pro Tag und IP). Daten werden 3 h zwischengespeichert.</p>`;
}

$('#btn-settings').addEventListener('click', () => {
  settingsTab = state.profile;
  renderSettings();
  $('#settings').showModal();
});
$('#settings').addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-close]')) return $('#settings').close();
  const tab = t.closest('[data-tab]');
  if (tab) { settingsTab = tab.dataset.tab; renderSettings(); return; }
  if (t.closest('[data-reset-profile]')) {
    settings.profiles[settingsTab] = defaultProfile(settingsTab);
    saveSettings(settings); renderSettings(); renderProfiles(); rescore();
    return;
  }
  if (t.closest('[data-clear]')) { clearCache(); state.ensemble.clear(); state.names.clear(); toast('Cache geleert'); }
});
$('#settings').addEventListener('input', (e) => {
  const t = e.target;
  const p = settings.profiles[settingsTab];
  if (t.dataset.w) {
    p.weights[t.dataset.w] = +t.value / 100;
    t.nextElementSibling.textContent = t.value;
  } else if (t.dataset.f) {
    const v = parseFloat(String(t.value).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    p[t.dataset.f] = t.dataset.scale ? v / +t.dataset.scale : v;
    if (t.dataset.scale) t.nextElementSibling.textContent = `${t.value}%`;
  } else if (t.dataset.g) {
    const v = t.dataset.g === 'theme' ? t.value : parseFloat(t.value);
    settings[t.dataset.g] = v;
    if (t.dataset.g === 'theme') applyTheme();
  } else return;
  saveSettings(settings);
  clearTimeout(renderSettings._t);
  renderSettings._t = setTimeout(() => { rescore(); }, 250);
});

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || 'auto';
}

// ---------- Start ----------
if (state.start && state.lastRun && Date.now() - state.lastRun < 3 * 3600e3) {
  runSearch({ silent: true }); // Daten liegen noch im Cache → sofort wieder anzeigen
} else if (!state.start) {
  setStatus('Wähle einen Startpunkt: <b>📍 Mein Standort</b>, Ortssuche oder auf die Karte tippen.');
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
