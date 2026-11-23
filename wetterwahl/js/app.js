// Wetterwahl – App-Steuerung
import { prepareLand, autoGrid, haversineKm, driveHours, formatDuration } from './geo.js';
import { ensembleConfidence } from './score.js';
import { scorePoints, clusterRegions } from './regions.js';
import { fetchForecast, fetchEnsemble, searchPlace, reverseName, pruneCache, clearCache } from './api.js';
import { loadSettings, saveSettings, loadSearch, saveSearch, defaultProfile, loadRecent, addRecent } from './store.js';
import { createMap, scoreColor } from './map.js';
import { createSheet } from './sheet.js';
import { park4nightUrl, park4nightWebUrl, appleMapsUrl, coordText, copyText } from './links.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

// ---------- Zustand ----------
let settings = loadSettings();
const saved = loadSearch() || {};
const state = {
  start: saved.start || null,
  radius: saved.radius || 400,
  days: saved.days || 4,
  earliest: saved.earliest || 0,
  profile: saved.profile && settings.profiles[saved.profile] ? saved.profile : 'wandern',
  lastRun: saved.lastRun || 0,
  picking: false,
  land: null,
  data: null,
  regions: [],
  scored: [],
  ensemble: new Map(),
  names: new Map(),
  busy: false,
  error: null,
  view: 'list',
  detail: null,     // aktuell gezeigter Punkt
  listScroll: 0,
};

// ---------- Theme ----------
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme === 'auto' && darkMQ.matches);
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || 'auto';
  document.documentElement.classList.toggle('dark', isDark());
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', isDark() ? '#0d1418' : '#f2f4f3'));
}
applyTheme();
pruneCache();

const ui = createMap($('#map'), { onClick: onMapClick, isDark });
darkMQ.addEventListener('change', () => { applyTheme(); ui.setTheme(isDark()); });

const sheet = createSheet($('#sheet'), $('#sheet-scroll'), {
  onChange: (s) => document.body.dataset.sheet = s,
});
ui.setPadding(() => sheet.isDesktop()
  ? { left: $('#sheet').getBoundingClientRect().right, top: 0, bottom: 0 }
  : { top: $('.top').getBoundingClientRect().bottom, bottom: sheet.visibleHeight(), left: 0 });

// ---------- Datum & Format ----------
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WDL = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
function dayDate(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}
const asDate = (d) => (typeof d === 'string' ? new Date(d + 'T12:00:00') : d);
const fmtDate = (d) => { d = asDate(d); return `${WD[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`; };
const fmtRange = (a, b) => { a = asDate(a); b = asDate(b); return `${WD[a.getDay()]} ${a.getDate()}.${a.getMonth() === b.getMonth() ? '' : a.getMonth() + 1 + '.'} – ${fmtDate(b)}`; };
function relDay(i) { return i === 0 ? 'Heute' : i === 1 ? 'Morgen' : fmtDate(dayDate(i)); }
const round = (x) => (x == null ? '–' : Math.round(x));
const hours = (s) => (s == null ? '–' : (s / 3600).toFixed(s >= 36000 ? 0 : 1).replace('.', ','));
const mm = (x) => (x == null ? '–' : x < 0.1 ? '0' : x.toFixed(x < 10 ? 1 : 0).replace('.', ','));
function weatherIcon(d) {
  if (d.precip != null && d.precip >= 1 && (d.precipProb ?? 60) >= 50) return d.precip >= 8 ? '🌧️' : '🌦️';
  const ratio = d.daylight ? (d.sunshine ?? 0) / d.daylight : 0;
  if (ratio > 0.6) return '☀️';
  if (ratio > 0.3) return '🌤️';
  if (ratio > 0.1) return '⛅';
  return '☁️';
}
function ratingLabel(s) {
  return s >= 85 ? 'Hervorragend' : s >= 70 ? 'Sehr gut' : s >= 55 ? 'Gut' : s >= 40 ? 'Durchwachsen' : 'Schlecht';
}
function bubbles(score) {
  const v = Math.round((score / 20) * 2) / 2;
  let h = '';
  for (let i = 1; i <= 5; i++) h += `<i class="${v >= i ? 'f' : v >= i - 0.5 ? 'h' : ''}"></i>`;
  return `<span class="bubbles" aria-label="${(v).toString().replace('.', ',')} von 5">${h}</span>`;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 250); }, ms);
}

function persist() {
  saveSearch({ start: state.start, radius: state.radius, days: state.days, earliest: state.earliest, profile: state.profile, lastRun: state.lastRun });
}

// ---------- Kopfzeile & Chips ----------
function renderTop() {
  const st = $('#start-text');
  st.textContent = state.start ? (state.start.label || coordText(state.start.lat, state.start.lon)) : 'Wo startet ihr?';
  st.classList.toggle('placeholder', !state.start);
  const chips = Object.entries(settings.profiles).map(([id, p]) =>
    `<button class="chip${id === state.profile ? ' on' : ''}" data-profile="${id}" aria-pressed="${id === state.profile}">${p.icon || ''} ${esc(p.name)}</button>`);
  chips.splice(0, 0,
    `<button class="chip param" data-param="radius">◎ ${state.radius} km</button>`,
    `<button class="chip param" data-param="trip">📅 ${state.days} ${state.days === 1 ? 'Tag' : 'Tage'} · ab ${relDay(state.earliest)}</button>`);
  $('#chiprow').innerHTML = chips.join('');
}
$('#chiprow').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.profile) {
    if (state.profile === b.dataset.profile) return;
    state.profile = b.dataset.profile;
    persist(); renderTop(); rescore();
  } else openParam(b.dataset.param);
});

// ---------- Startpunkt ----------
function setStart(p, label, { search = true } = {}) {
  state.start = { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), label };
  state.picking = false;
  document.body.classList.remove('picking');
  ui.setStart(state.start);
  ui.setRadius(state.start, state.radius, true);
  renderTop();
  persist();
  if (label) addRecent(state.start);
  else {
    reverseName(state.start.lat, state.start.lon).then((n) => {
      if (n?.name && state.start && !state.start.label) {
        state.start.label = n.name.split(' · ')[0];
        addRecent(state.start);
        renderTop(); persist();
      }
    });
  }
  if (search) runSearch();
}

function useGps() {
  if (!navigator.geolocation) return toast('Standort wird von diesem Browser nicht unterstützt.');
  $('#btn-gps').classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => { $('#btn-gps').classList.remove('busy'); setStart({ lat: pos.coords.latitude, lon: pos.coords.longitude }, null); },
    (err) => {
      $('#btn-gps').classList.remove('busy');
      toast(err.code === 1
        ? 'Standort verweigert. iPhone: Einstellungen › Datenschutz › Ortungsdienste › Safari-Websites.'
        : 'Standort konnte nicht ermittelt werden.', 5000);
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
  );
}
function startPicking() {
  state.picking = true;
  document.body.classList.add('picking');
  sheet.setSnap('peek');
  toast('Tippe auf die Karte, um den Startpunkt zu setzen.', 4000);
}
$('#btn-gps').addEventListener('click', useGps);
$('#btn-settings').addEventListener('click', openSettings);

// ---------- Vollbild-Suche ----------
const searchDlg = $('#search');
let searchTimer = null, searchCtl = null, suggestions = [];
function renderSearchList(results = null, q = '') {
  const rows = [];
  if (!q) {
    rows.push(`<li><button data-act="gps"><span class="li-ico blue">${icon('loc')}</span><span class="li-t">Mein Standort</span></button></li>`);
    rows.push(`<li><button data-act="pick"><span class="li-ico teal">${icon('map')}</span><span class="li-t">Auf der Karte wählen</span></button></li>`);
    const recent = loadRecent();
    if (recent.length) {
      rows.push('<li class="li-head">Zuletzt</li>');
      recent.forEach((r, i) => rows.push(`<li><button data-recent="${i}"><span class="li-ico gray">${icon('clock')}</span><span class="li-t">${esc(r.label)}</span></button></li>`));
    }
  } else if (results) {
    if (!results.length) rows.push('<li class="li-empty">Nichts gefunden</li>');
    results.forEach((s, i) => rows.push(`<li><button data-i="${i}"><span class="li-ico gray">${icon('search')}</span><span class="li-t">${esc(s.name)}<small>${esc(s.detail)}</small></span></button></li>`));
  } else rows.push('<li class="li-empty">Suche …</li>');
  $('#search-list').innerHTML = rows.join('');
}
$('#btn-open-search').addEventListener('click', () => {
  $('#q').value = '';
  renderSearchList();
  searchDlg.showModal();
  setTimeout(() => $('#q').focus(), 60);
});
searchDlg.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return searchDlg.close();
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'gps') { searchDlg.close(); useGps(); }
  else if (b.dataset.act === 'pick') { searchDlg.close(); startPicking(); }
  else if (b.dataset.recent != null) { const r = loadRecent()[+b.dataset.recent]; searchDlg.close(); setStart(r, r.label); }
  else if (b.dataset.i != null) { const s = suggestions[+b.dataset.i]; searchDlg.close(); setStart(s, s.name); }
});
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { renderSearchList(); return; }
  renderSearchList(null, q);
  searchTimer = setTimeout(async () => {
    searchCtl?.abort();
    searchCtl = new AbortController();
    try {
      suggestions = await searchPlace(q, { signal: searchCtl.signal });
      renderSearchList(suggestions, q);
    } catch (err) { if (err.name !== 'AbortError') renderSearchList([], q); }
  }, 300);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && suggestions[0] && $('#q').value.trim().length >= 2) {
    e.preventDefault();
    const s = suggestions[0];
    searchDlg.close(); setStart(s, s.name);
  }
});

// ---------- Parameter-Sheets ----------
const paramDlg = $('#param');
let paramBefore = null;
function openParam(kind) {
  paramBefore = { radius: state.radius, days: state.days, earliest: state.earliest, kind };
  renderParam(kind);
  paramDlg.showModal();
}
function renderParam(kind) {
  if (kind === 'radius') {
    const maxH = formatDuration(driveHours(state.radius, settings.detour, settings.speed));
    paramDlg.innerHTML = `
      <div class="ms-grip"></div>
      <div class="ms-head"><h3>Umkreis</h3><button class="text-btn strong" data-done>Fertig</button></div>
      <div class="big-value"><b id="rv">${state.radius}</b> km <span class="muted" id="rh">Luftlinie · bis ${maxH} Fahrt</span></div>
      <input type="range" id="r-range" min="50" max="1500" step="25" value="${state.radius}" aria-label="Umkreis in km">
      <div class="seg">${[100, 250, 400, 600, 1000, 1500].map((v) => `<button data-r="${v}" class="${v === state.radius ? 'on' : ''}">${v}</button>`).join('')}</div>`;
  } else {
    paramDlg.innerHTML = `
      <div class="ms-grip"></div>
      <div class="ms-head"><h3>Reise</h3><button class="text-btn strong" data-done>Fertig</button></div>
      <div class="stepper-row"><span>Reisedauer</span>
        <div class="stepper"><button data-d="-1" aria-label="weniger">−</button><b>${state.days} ${state.days === 1 ? 'Tag' : 'Tage'}</b><button data-d="1" aria-label="mehr">+</button></div></div>
      <div class="sub-label">Frühester Start</div>
      <div class="day-grid">${Array.from({ length: 15 }, (_, i) => {
        const d = dayDate(i);
        return `<button data-e="${i}" class="${i === state.earliest ? 'on' : ''}"><small>${i === 0 ? 'Heute' : i === 1 ? 'Morgen' : WD[d.getDay()]}</small><b>${d.getDate()}.</b></button>`;
      }).join('')}</div>
      <p class="fine">Die App sucht das beste Fenster ab diesem Tag innerhalb der 16-Tage-Prognose.</p>`;
  }
}
paramDlg.addEventListener('input', (e) => {
  if (e.target.id !== 'r-range') return;
  state.radius = +e.target.value;
  $('#rv').textContent = state.radius;
  $('#rh').textContent = `Luftlinie · bis ${formatDuration(driveHours(state.radius, settings.detour, settings.speed))} Fahrt`;
  paramDlg.querySelectorAll('[data-r]').forEach((b) => b.classList.toggle('on', +b.dataset.r === state.radius));
  ui.setRadius(state.start, state.radius);
});
paramDlg.addEventListener('click', (e) => {
  if (e.target === paramDlg || e.target.closest('[data-done]')) return paramDlg.close();
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.r) { state.radius = +b.dataset.r; renderParam('radius'); ui.setRadius(state.start, state.radius, true); }
  if (b.dataset.d) { state.days = Math.max(1, Math.min(10, state.days + +b.dataset.d)); renderParam('trip'); }
  if (b.dataset.e) { state.earliest = +b.dataset.e; renderParam('trip'); }
});
paramDlg.addEventListener('close', () => {
  const b = paramBefore;
  renderTop(); persist();
  if (b.radius !== state.radius) { ui.setRadius(state.start, state.radius, true); if (state.start) runSearch(); }
  else if (b.days !== state.days || b.earliest !== state.earliest) rescore();
});

// ---------- Karte ----------
function onMapClick(p) {
  if (state.picking || !state.start) { setStart(p, null); return; }
  if (!state.scored.length) return;
  let best = null, bd = Infinity;
  for (const s of state.scored) {
    const d = haversineKm(p, s);
    if (d < bd) { bd = d; best = s; }
  }
  if (best && bd <= state.data.spacing * 1.2) {
    const ri = state.regions.findIndex((r) => r.lat === best.lat && r.lon === best.lon);
    showDetail(ri >= 0 ? state.regions[ri] : best);
  } else if (state.view === 'detail') {
    closeDetail();
  } else {
    sheet.setSnap(sheet.snap === 'full' ? 'half' : 'peek');
  }
}

// ---------- Suche ----------
function setProgress(frac) {
  const p = $('#progress');
  p.hidden = frac == null;
  if (frac != null) p.firstElementChild.style.width = `${Math.max(4, Math.round(frac * 100))}%`;
}
async function ensureLand() {
  if (state.land) return state.land;
  try { state.land = prepareLand(await (await fetch('data/land.json')).json()); }
  catch { state.land = null; }
  return state.land;
}

async function runSearch({ silent = false } = {}) {
  if (state.busy || !state.start) return;
  state.busy = true;
  state.error = null;
  if (state.view === 'detail') closeDetail(false);
  const hadResults = !!state.regions.length;
  state.loadingText = 'Raster wird berechnet …';
  renderList();
  if (!silent && sheet.snap === 'peek') sheet.setSnap('half');
  setProgress(0.02);
  try {
    const land = await ensureLand();
    const center = { lat: state.start.lat, lon: state.start.lon };
    const { spacing, points } = autoGrid(center, state.radius, land, settings.maxPoints);
    const fc = await fetchForecast(points, {
      onProgress: (done, total) => {
        setProgress(done / total);
        state.loadingText = `Wetter für ${done} von ${total} Orten …`;
        const el = $('#loading-text');
        if (el) el.textContent = state.loadingText;
      },
    });
    state.data = { center, radius: state.radius, spacing, points: points.map((p, i) => ({ ...p, days: fc[i].days, elevation: fc[i].elevation })) };
    state.lastRun = Date.now();
    persist();
    state.busy = false;
    setProgress(null);
    rescore({ fit: !hadResults || !silent });
  } catch (err) {
    console.error(err);
    state.busy = false;
    state.error = err.message || String(err);
    setProgress(null);
    renderList();
  }
}

/** Neu bewerten ohne neuen Abruf (Profil, Dauer, Startdatum). */
function rescore({ fit = false } = {}) {
  const d = state.data;
  if (!d || state.busy) return;
  const profile = settings.profiles[state.profile];
  const nDays = d.points[0]?.days.length || 16;
  const startMax = nDays - state.days;
  const startMin = Math.min(state.earliest, startMax);
  state.startClamped = startMin < state.earliest ? startMin : null;
  state.scored = scorePoints(d.points, { n: state.days, startMin, startMax, profile });
  state.regions = clusterRegions(state.scored, Math.max(80, 2 * d.spacing), 10);

  ui.setHeat({
    center: d.center, radius: d.radius, spacing: d.spacing, land: state.land,
    points: state.scored.map((p) => ({ lat: p.lat, lon: p.lon, v: p.window?.score ?? null })),
  });
  ui.setStart(state.start);
  ui.setRadius(d.center, d.radius, fit);
  ui.setRegions(state.regions, (r) => showDetail(r));
  document.body.classList.add('has-results');
  if (state.view === 'detail') {
    const ri = state.regions.findIndex((r) => r.lat === state.detail?.lat && r.lon === state.detail?.lon);
    if (ri >= 0) showDetail(state.regions[ri], { keepSnap: true, fly: false });
    else closeDetail(false);
  }
  renderList();
  loadRegionExtras();
}

// ---------- Liste ----------
function confBadge(p) {
  const c = p.confidence;
  const end = p.window.start + state.days - 1;
  const far = end >= 9 ? '<span class="tag dashed" title="Fenster reicht bis Tag 10 oder später">ab Tag 10</span>' : '';
  if (!c) return `<span class="tag loading">Sicherheit …</span>${far}`;
  const txt = { hoch: 'Sicherheit hoch', mittel: 'Sicherheit mittel', niedrig: 'Sicherheit niedrig', unbekannt: 'Sicherheit ?' }[c.level];
  return `<span class="tag conf-${c.level}"><i></i>${txt}</span>${far}`;
}
function dayStrip(p) {
  const w = p.window;
  let cells = '';
  for (let i = w.start; i < w.start + state.days; i++) {
    const d = p.days[i];
    if (!d) continue;
    cells += `<div class="dc" style="--c:${scoreColor(p.dayScores[i] ?? 0)}">
      <div class="dc-d">${WD[asDate(d.date).getDay()]}</div>
      <div class="dc-i">${weatherIcon(d)}</div>
      <div class="dc-t"><b>${round(d.tmax)}°</b> ${round(d.tmin)}°</div>
      <div class="dc-r">${mm(d.precip)} mm</div>
      <div class="dc-s">${hours(d.sunshine)} h ☀︎</div>
    </div>`;
  }
  return `<div class="strip">${cells}</div>`;
}
function nameOf(p) {
  return state.names.get(`${p.lat},${p.lon}`) || null;
}
function titleHtml(p) {
  const n = nameOf(p);
  if (!n?.name) return `<span class="muted">${p.lat.toFixed(2)}° N, ${p.lon.toFixed(2)}° O</span>`;
  const [place] = n.name.split(' · ');
  return esc(place);
}
function subHtml(p) {
  const n = nameOf(p);
  if (!n?.name) return '';
  const area = n.name.split(' · ')[1];
  return [area, n.country].filter(Boolean).map(esc).join(' · ');
}

function renderList() {
  const v = $('#view-list');
  if (!state.start) {
    v.innerHTML = `
      <div class="hero">
        <div class="hero-emoji">🚐☀️</div>
        <h2>Wohin mit dem Camper?</h2>
        <p>Wir finden die Gegend mit dem besten Wetter in den nächsten 14 Tagen. Stellplätze sucht ihr dann in Park4Night.</p>
      </div>
      <ul class="list-group inset">
        <li><button data-act="gps"><span class="li-ico blue">${icon('loc')}</span><span class="li-t">Von meinem Standort</span>${icon('next', 'chev')}</button></li>
        <li><button data-act="search"><span class="li-ico gray">${icon('search')}</span><span class="li-t">Ort suchen</span>${icon('next', 'chev')}</button></li>
        <li><button data-act="pick"><span class="li-ico teal">${icon('map')}</span><span class="li-t">Auf der Karte tippen</span>${icon('next', 'chev')}</button></li>
      </ul>`;
    return;
  }
  const p = settings.profiles[state.profile];
  const head = (title, sub, refresh = true) => `
    <header class="list-head">
      <div><h2>${title}</h2><p>${sub}</p></div>
      ${refresh ? `<button class="icon-round soft" data-act="refresh" aria-label="Aktualisieren">${icon('refresh')}</button>` : ''}
    </header>`;
  if (state.busy) {
    v.innerHTML = head('Suche bestes Wetter …', `<span id="loading-text">${esc(state.loadingText || '')}</span>`, false) +
      `<ol class="cards">${'<li class="card skeleton"><div class="sk sk-rank"></div><div class="sk-lines"><div class="sk w60"></div><div class="sk w40"></div><div class="sk w80"></div></div><div class="sk sk-strip"></div></li>'.repeat(3)}</ol>`;
    return;
  }
  if (state.error) {
    v.innerHTML = head('Das hat nicht geklappt', '', false) +
      `<div class="error-box"><p>⚠️ ${esc(state.error)}</p><button class="btn primary" data-act="refresh">Erneut versuchen</button></div>`;
    return;
  }
  if (!state.data) {
    v.innerHTML = head(`Start: ${esc(state.start.label || 'gewählt')}`, 'Tippe auf Aktualisieren, um zu suchen.');
    return;
  }
  const age = Math.round((Date.now() - state.lastRun) / 60000);
  const ageTxt = age < 2 ? 'gerade aktualisiert' : age < 60 ? `vor ${age} min` : `vor ${Math.round(age / 60)} h`;
  const changed = state.data.radius !== state.radius || haversineKm(state.data.center, state.start) > 1;
  const notes = [];
  if (changed) notes.push('<div class="note warn">Start oder Umkreis geändert – zum Neuladen ↻ tippen.</div>');
  if (state.startClamped != null) notes.push(`<div class="note warn">Start auf ${relDay(state.startClamped)} vorgezogen, damit ${state.days} Tage in die Prognose passen.</div>`);
  if (!state.regions.length) {
    v.innerHTML = head('Keine Treffer', `${p.icon} ${esc(p.name)} · ${ageTxt}`) + notes.join('') +
      '<div class="error-box"><p>Kein passendes Fenster. Kürzere Reisedauer oder früheren Start probieren.</p></div>';
    return;
  }
  v.innerHTML = head(`Top ${state.regions.length} Regionen`, `${p.icon} ${esc(p.name)} · ${state.data.points.length} Orte geprüft · ${ageTxt}`) +
    notes.join('') +
    `<ol class="cards">${state.regions.map((r, i) => {
      const w = r.window;
      return `<li class="card" data-i="${i}" tabindex="0">
        <div class="card-top">
          <span class="rank" style="--c:${scoreColor(w.score)}">${i + 1}</span>
          <div class="card-main">
            <div class="card-title">${titleHtml(r)}</div>
            <div class="rating">${bubbles(w.score)}<b>${Math.round(w.score)}</b><span>${ratingLabel(w.score)}</span></div>
            <div class="card-meta">${fmtRange(r.days[w.start].date, r.days[w.start + state.days - 1].date)} · ${Math.round(r.distKm)} km · ${formatDuration(driveHours(r.distKm, settings.detour, settings.speed))}</div>
          </div>
        </div>
        ${dayStrip(r)}
        <div class="card-foot">
          <div class="tags">${confBadge(r)}</div>
          <a class="p4n-btn" href="${park4nightUrl(r.lat, r.lon)}" target="_blank" rel="noopener" data-stop>Park4Night ${icon('next')}</a>
        </div>
      </li>`;
    }).join('')}</ol>
    <p class="fine center">ℹ️ Prognosen ab Tag 10 sind unsicher – kurz vor der Abfahrt nochmal prüfen.</p>
    <p class="fine center attrib">Wetter: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> · Karte: © OpenStreetMap-Mitwirkende · Küsten: Natural Earth</p>`;
}

$('#view-list').addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]')) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'gps') return useGps();
  if (act === 'search') return $('#btn-open-search').click();
  if (act === 'pick') return startPicking();
  if (act === 'refresh') return runSearch();
  const li = e.target.closest('.card[data-i]');
  if (li) showDetail(state.regions[+li.dataset.i]);
});
$('#view-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) e.target.click();
});

/** Namen (Nominatim) und Ensemble-Sicherheit für die Top-Regionen nachladen. */
let extrasRun = 0;
async function loadRegionExtras() {
  const run = ++extrasRun;
  const regs = state.regions;
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
  refreshViews();
  for (const r of regs) {
    const k = `${r.lat},${r.lon}`;
    if (state.names.has(k)) continue;
    const n = await reverseName(r.lat, r.lon);
    if (run !== extrasRun) return;
    state.names.set(k, n);
    refreshViews();
  }
}
function refreshViews() {
  if (state.busy) return;
  const sc = $('#sheet-scroll').scrollTop;
  if (state.view === 'detail' && state.detail) renderDetail(state.detail);
  else renderList();
  $('#sheet-scroll').scrollTop = sc;
}
function confidenceFor(p) {
  const ens = state.ensemble.get(`${p.lat},${p.lon}`);
  if (!ens) return { level: 'unbekannt', coveredDays: 0 };
  const idx = [];
  for (let i = p.window.start; i < p.window.start + state.days; i++) {
    const j = ens.dates.indexOf(p.days[i]?.date);
    if (j >= 0) idx.push(j);
  }
  return ensembleConfidence(ens, idx);
}

// ---------- Detail (Ortskarte) ----------
function showDetail(p, { keepSnap = false, fly = true } = {}) {
  if (!p) return;
  if (state.view === 'list') state.listScroll = $('#sheet-scroll').scrollTop;
  state.view = 'detail';
  state.detail = p;
  const k = `${p.lat},${p.lon}`;
  if (!p.confidence && state.ensemble.has(k) && p.window) p.confidence = confidenceFor(p);
  renderDetail(p);
  $('#view-list').hidden = true;
  $('#view-detail').hidden = false;
  $('#sheet-scroll').scrollTop = 0;
  if (!keepSnap && sheet.snap === 'peek') sheet.setSnap('half');
  const ri = state.regions.indexOf(p);
  ui.select(ri >= 0 ? ri : null);
  if (fly) ui.flyTo(p);
  if (!state.names.has(k)) {
    reverseName(p.lat, p.lon).then((n) => { state.names.set(k, n); if (state.detail === p) refreshViews(); });
  }
  if (!p.confidence && p.window && !state.ensemble.has(k)) {
    fetchEnsemble([p]).then(([e]) => { state.ensemble.set(k, e); p.confidence = confidenceFor(p); if (state.detail === p) refreshViews(); })
      .catch(() => {});
  }
}
function closeDetail(restore = true) {
  state.view = 'list';
  state.detail = null;
  ui.select(null);
  $('#view-detail').hidden = true;
  $('#view-list').hidden = false;
  renderList();
  if (restore) $('#sheet-scroll').scrollTop = state.listScroll;
}

function forecastRows(p, from, to, scale) {
  let rows = '';
  for (let i = from; i < to; i++) {
    const d = p.days[i];
    if (!d) continue;
    const inWin = p.window && i >= p.window.start && i < p.window.start + state.days;
    const lo = ((d.tmin ?? scale.min) - scale.min) / (scale.max - scale.min) * 100;
    const hi = ((d.tmax ?? scale.max) - scale.min) / (scale.max - scale.min) * 100;
    const s = p.dayScores[i];
    rows += `<div class="fc-row${inWin ? ' win' : ''}">
      <span class="fc-day">${i === 0 ? 'Heute' : WD[asDate(d.date).getDay()]}<small>${asDate(d.date).getDate()}.${asDate(d.date).getMonth() + 1}.</small></span>
      <span class="fc-ico">${weatherIcon(d)}${d.precipProb != null && d.precipProb >= 30 ? `<small>${d.precipProb}%</small>` : ''}</span>
      <span class="fc-min">${round(d.tmin)}°</span>
      <span class="fc-bar"><i style="left:${lo}%;right:${100 - hi}%"></i></span>
      <span class="fc-max">${round(d.tmax)}°</span>
      <span class="fc-x">${mm(d.precip)} mm<br>${hours(d.sunshine)} h ☀︎</span>
      <span class="pill" style="--c:${scoreColor(s ?? 0)}">${s == null ? '–' : Math.round(s)}</span>
    </div>`;
  }
  return rows;
}

function renderDetail(p) {
  const w = p.window;
  const ri = state.regions.indexOf(p);
  const region = ri >= 0 ? p : null;
  const km = p.distKm ?? haversineKm(state.data.center, p);
  const temps = p.days.flatMap((d) => [d.tmin, d.tmax]).filter((x) => x != null);
  const scale = { min: Math.floor(Math.min(...temps)) - 1, max: Math.ceil(Math.max(...temps)) + 1 };
  const winEnd = w ? w.start + state.days : 0;
  const sub = subHtml(p);
  $('#view-detail').innerHTML = `
    <div class="detail-nav">
      <button class="back-btn" data-act="back">${icon('back')} Regionen</button>
      ${region ? `<div class="pager">
        <button class="icon-round soft" data-act="prev" ${ri === 0 ? 'disabled' : ''} aria-label="Vorherige">${icon('back')}</button>
        <span>${ri + 1} / ${state.regions.length}</span>
        <button class="icon-round soft" data-act="next" ${ri === state.regions.length - 1 ? 'disabled' : ''} aria-label="Nächste">${icon('next')}</button>
      </div>` : ''}
    </div>
    <div class="detail-head">
      <h2>${titleHtml(p)}</h2>
      <p class="muted">${sub || 'Region'}${region?.members > 1 ? ` · ${region.members} Rasterpunkte` : ''}</p>
      ${w ? `<div class="rating big">${bubbles(w.score)}<b>${Math.round(w.score)}</b><span>${ratingLabel(w.score)}</span></div>` : ''}
    </div>
    <div class="actions">
      <a class="act primary" href="${park4nightUrl(p.lat, p.lon)}" target="_blank" rel="noopener"><span class="act-ico p">P</span><span>Park4Night</span></a>
      <a class="act" href="${appleMapsUrl(p.lat, p.lon)}" target="_blank" rel="noopener"><span class="act-ico">${icon('route')}</span><span>Route</span></a>
      <button class="act" data-act="copy"><span class="act-ico">${icon('copy')}</span><span>Kopieren</span></button>
      <button class="act" data-act="share"><span class="act-ico">${icon('share')}</span><span>Teilen</span></button>
    </div>
    <div class="tiles">
      ${w ? `<div class="tile"><small>Bestes Fenster</small><b>${fmtRange(p.days[w.start].date, p.days[winEnd - 1].date)}</b><span>${WDL[asDate(p.days[w.start].date).getDay()]} los</span></div>` : ''}
      <div class="tile"><small>Anfahrt</small><b>${formatDuration(driveHours(km, settings.detour, settings.speed))}</b><span>${Math.round(km)} km Luftlinie</span></div>
      ${w ? `<div class="tile"><small>Prognose</small><b class="conf-txt-${p.confidence?.level || 'x'}">${p.confidence ? { hoch: 'Sicher', mittel: 'Mittel', niedrig: 'Unsicher', unbekannt: '–' }[p.confidence.level] : '…'}</b><span>${winEnd - 1 >= 9 ? 'reicht bis Tag 10+' : 'Ensemble-Streuung'}</span></div>` : ''}
      ${p.elevation != null ? `<div class="tile"><small>Höhe</small><b>${Math.round(p.elevation)} m</b><span>über Meer</span></div>` : ''}
    </div>
    ${w ? `<section class="block">
      <h3>Wetter im Fenster <span class="muted">Ø ${Math.round(w.mean)} · schlechtester Tag ${Math.round(w.min)}</span></h3>
      <div class="forecast">${forecastRows(p, w.start, winEnd, scale)}</div>
    </section>` : ''}
    <details class="block" ${w ? '' : 'open'}>
      <summary><h3>Alle 16 Tage</h3></summary>
      <div class="forecast">${forecastRows(p, 0, p.days.length, scale)}</div>
    </details>
    <p class="fine">${coordText(p.lat, p.lon)} · <a href="${park4nightWebUrl(p.lat, p.lon)}" target="_blank" rel="noopener">Park4Night im Browser</a></p>`;
}
$('#view-detail').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const p = state.detail;
  if (!act || !p) return;
  if (act === 'back') closeDetail();
  if (act === 'prev' || act === 'next') {
    const ri = state.regions.indexOf(p) + (act === 'next' ? 1 : -1);
    if (state.regions[ri]) showDetail(state.regions[ri], { keepSnap: true });
  }
  if (act === 'copy') {
    const ok = await copyText(coordText(p.lat, p.lon));
    toast(ok ? `Koordinaten kopiert: ${coordText(p.lat, p.lon)}` : 'Kopieren nicht möglich');
  }
  if (act === 'share') {
    const name = nameOf(p)?.name?.split(' · ')[0] || coordText(p.lat, p.lon);
    const w = p.window;
    const text = `Wetterwahl: ${name}${w ? ` – ${ratingLabel(w.score)} (${Math.round(w.score)}) ${fmtRange(p.days[w.start].date, p.days[w.start + state.days - 1].date)}` : ''}`;
    if (navigator.share) {
      try { await navigator.share({ title: name, text, url: park4nightUrl(p.lat, p.lon) }); } catch { /* abgebrochen */ }
    } else {
      const ok = await copyText(`${text}\n${park4nightUrl(p.lat, p.lon)}`);
      toast(ok ? 'Link kopiert' : 'Teilen nicht möglich');
    }
  }
});
// Wischen zwischen Regionen in der Detailansicht
(() => {
  let x0 = null, y0 = 0;
  const el = $('#view-detail');
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('.tiles, .forecast')) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null || !state.detail) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const ri = state.regions.indexOf(state.detail);
    if (ri < 0) return;
    const next = state.regions[ri + (dx < 0 ? 1 : -1)];
    if (next) showDetail(next, { keepSnap: true });
  });
})();

// ---------- Einstellungen ----------
const FIELDS = [
  ['tempMin', 'Wohlfühlen ab', '°C', 1],
  ['tempMax', 'Wohlfühlen bis', '°C', 1],
  ['heatLimit', 'Hitzegrenze', '°C', 1],
  ['coldMargin', 'Kälte-Toleranz', '°C', 1],
  ['rainBadMm', 'Regen zählt voll ab', 'mm', 0.5],
  ['gustOk', 'Böen ok bis', 'km/h', 5],
  ['gustBad', 'Böen zu stark ab', 'km/h', 5],
];
const WEIGHTS = [['sun', '☀️ Sonne'], ['temp', '🌡️ Temperatur'], ['rain', '💧 Trockenheit'], ['wind', '💨 Wind']];
let settingsTab = null;
const settingsDlg = $('#settings');

function openSettings() {
  settingsTab = state.profile;
  renderSettings();
  settingsDlg.showModal();
}
function renderSettings() {
  const p = settings.profiles[settingsTab];
  const sc = settingsDlg.scrollTop;
  settingsDlg.innerHTML = `
    <div class="ms-grip"></div>
    <div class="ms-head"><h3>Einstellungen</h3><button class="text-btn strong" data-done>Fertig</button></div>
    <div class="seg wide">${Object.entries(settings.profiles).map(([id, pr]) =>
      `<button data-tab="${id}" class="${id === settingsTab ? 'on' : ''}">${pr.icon} ${esc(pr.name.split(' ')[0])}</button>`).join('')}</div>
    <div class="group-label">Gewichtung · ${esc(p.name)}</div>
    <div class="group">
      ${WEIGHTS.map(([k, l]) => `<label class="row"><span>${l}</span>
        <input type="range" min="0" max="100" step="5" data-w="${k}" value="${Math.round((p.weights[k] || 0) * 100)}">
        <output>${Math.round((p.weights[k] || 0) * 100)}</output></label>`).join('')}
    </div>
    <div class="group-label">Grenzwerte</div>
    <div class="group">
      ${FIELDS.map(([k, l, u, st]) => `<label class="row num"><span>${l}</span>
        <span class="val"><input type="number" step="${st}" data-f="${k}" value="${p[k]}" inputmode="decimal"><em>${u}</em></span></label>`).join('')}
      <label class="row"><span>Strenge bei Ausreißern</span>
        <input type="range" min="0" max="80" step="5" data-f="worstWeight" data-scale="100" value="${Math.round((p.worstWeight ?? 0.4) * 100)}">
        <output>${Math.round((p.worstWeight ?? 0.4) * 100)}%</output></label>
    </div>
    <div class="group"><button class="row link danger-soft" data-reset-profile>Profil „${esc(p.name)}“ zurücksetzen</button></div>
    <div class="group-label">Allgemein</div>
    <div class="group">
      <label class="row num"><span>Rasterdichte</span>
        <select data-g="maxPoints">${[[200, 'Grob · 200 Orte'], [400, 'Normal · 400 Orte'], [700, 'Fein · 700 Orte']].map(([v, l]) =>
          `<option value="${v}" ${+settings.maxPoints === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row num"><span>Umwegfaktor Straße</span><span class="val"><input type="number" step="0.05" min="1" max="2" data-g="detour" value="${settings.detour}"><em>×</em></span></label>
      <label class="row num"><span>Ø Tempo Camper</span><span class="val"><input type="number" step="5" min="30" max="120" data-g="speed" value="${settings.speed}"><em>km/h</em></span></label>
      <label class="row num"><span>Darstellung</span>
        <select data-g="theme">${[['auto', 'Automatisch'], ['dark', 'Dunkel'], ['light', 'Hell']].map(([v, l]) =>
          `<option value="${v}" ${settings.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="group"><button class="row link" data-clear>Wetter-Cache leeren</button></div>
    <p class="fine">Mehr Orte = feinere Karte, aber mehr Abfragen (Open-Meteo: ca. 10.000 pro Tag und Gerät). Wetterdaten werden 3 h zwischengespeichert.</p>`;
  settingsDlg.scrollTop = sc;
}
settingsDlg.addEventListener('click', (e) => {
  const t = e.target;
  if (t === settingsDlg || t.closest('[data-done]')) return settingsDlg.close();
  const tab = t.closest('[data-tab]');
  if (tab) { settingsTab = tab.dataset.tab; renderSettings(); return; }
  if (t.closest('[data-reset-profile]')) {
    settings.profiles[settingsTab] = defaultProfile(settingsTab);
    saveSettings(settings); renderSettings(); renderTop(); rescore();
    toast('Profil zurückgesetzt');
    return;
  }
  if (t.closest('[data-clear]')) { clearCache(); state.ensemble.clear(); state.names.clear(); toast('Cache geleert'); }
});
settingsDlg.addEventListener('input', (e) => {
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
    settings[t.dataset.g] = t.dataset.g === 'theme' ? t.value : parseFloat(t.value);
    if (t.dataset.g === 'theme') { applyTheme(); ui.setTheme(isDark()); }
  } else return;
  saveSettings(settings);
  clearTimeout(renderSettings._t);
  renderSettings._t = setTimeout(() => rescore(), 250);
});
settingsDlg.addEventListener('close', () => renderTop());

// Dialoge schließen sich bei Tipp auf den Hintergrund; Wischen nach unten schließt Modal-Sheets
for (const dlg of [paramDlg, settingsDlg]) {
  let y0 = null;
  dlg.addEventListener('touchstart', (e) => { y0 = (dlg.scrollTop <= 0 && e.target.closest('.ms-grip, .ms-head')) ? e.touches[0].clientY : null; }, { passive: true });
  dlg.addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 60) dlg.close(); y0 = null; });
}

// ---------- Start ----------
renderTop();
renderList();
if (state.start) {
  ui.setStart(state.start);
  ui.setRadius(state.start, state.radius, true);
  if (state.lastRun && Date.now() - state.lastRun < 3 * 3600e3) runSearch({ silent: true });
} else {
  document.body.dataset.sheet = sheet.snap;
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
