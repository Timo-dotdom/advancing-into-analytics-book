// Wetterwahl – externe Links (Park4Night, Karten) und Zwischenablage

/**
 * Park4Night: Der Pfad /de/map/ ist in der apple-app-site-association von park4night.com
 * als Universal Link für die App registriert ("*/map/*"). Im Browser leitet der Server
 * auf die Suchkarte /de/search?lat=…&lng=…&z=… an diesen Koordinaten weiter.
 * (geprüft 11/2026)
 */
export function park4nightUrl(lat, lon, zoom = 11) {
  return `https://park4night.com/de/map/?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&z=${zoom}`;
}
/** Direkte Web-Suchkarte (öffnet immer im Browser). */
export function park4nightWebUrl(lat, lon, zoom = 11) {
  return `https://park4night.com/de/search?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&z=${zoom}`;
}
export function appleMapsUrl(lat, lon) {
  return `https://maps.apple.com/?daddr=${lat.toFixed(5)},${lon.toFixed(5)}&dirflg=d`;
}
export function coordText(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* egal */ }
    ta.remove();
    return ok;
  }
}
