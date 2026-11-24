# ☀️ Wetterwahl

PWA für Camper-Touren: **Wo im Umkreis X km ist in den nächsten 14 Tagen für N Tage am Stück das beste Wetter?**
Statisch, ohne Build-Schritt, ohne API-Keys, ohne Kosten.

## Modi
| Modus | Frage | Daten | Ergebnis | Link |
|---|---|---|---|---|
| 🚐 Van-Tour | Wo sind N Tage am Stück gut? (50–1500 km) | Tageswerte 16 Tage | bestes Startdatum | Park4Night |
| 🥾 Tagestour | Welcher Tag + Ort für eine Wanderung? (10–250 km) | Stundenwerte, Wanderzeit 9–17 Uhr | bester Tag, trockenes Zeitfenster | Komoot |
| ⛺ Overnighter | Welche Nacht + Ort? (10–400 km) | Stundenwerte: Nachmittag 14–20, Nacht 20–7, Morgen 7–11 | beste Nacht, Tiefstwert vs. Schlafsack | Komoot + Park4Night |

- Profile Tagestour: Wandern, ⛰️ Bergtour (kühler, windempfindlicher, starke Gewitter-/Neuschnee-Abwertung), Hauptsache trocken
- Overnighter-Schlafplatz: ⛺ Zelt, 🌳 Hängematte (zählt 4 °C kälter, windempfindlich), 🚐 Van (6 °C wärmer, Regen fast egal)
- 🐕 Hund-Schalter: Wohlfühlen bis 25 °C, ab 28 °C starkes Veto (nicht bei „Sonne & Baden“)
- ⛰️ Höhenfilter: egal / ab 500 m / ab 1000 m
- Suchzeitraum: Wochenende (Sa+So bzw. Nächte Fr→Sa, Sa→So), 3, 7 oder 14 Tage
- Kälte wird beim Wandern nur moderat abgewertet (kein Veto), Hitze stark; Gewitter ×0,3 (Bergtour ×0,2)
- Komoot-Link: `komoot.com/de-de/discover/<Name>/@lat,lon/tours?sport=hike&map=true&max_distance=…` (Universal Link `/discover/*`)
- Stundendaten werden in IndexedDB zwischengespeichert (3 h)

## Bedienung (App-Layout)
- Vollbild-Karte, oben Suchleiste + Filter-Chips (Umkreis, Reise, Wetterprofil), Änderungen wirken sofort
- Bottom-Sheet zum Wischen (klein / halb / voll) mit Top-10-Bewertungskarten; auf dem Desktop feste Seitenleiste
- Region antippen → Ortskarte mit Park4Night, Route, Kopieren, Teilen, Wetter je Tag; seitlich wischen = nächste Region
- Karte: OpenStreetMap-Kacheln (ohne Key), Darkmode per Filter

## Nutzung
1. Startpunkt: 📍 Standort, Ortssuche oder auf die Karte tippen
2. Umkreis (50–1500 km), Reisedauer (1–10 Tage), frühester Start, Wetterprofil wählen
3. „Beste Regionen finden“ → Heatmap + Top-10-Regionen mit bestem Startdatum
4. Region antippen → Tagesdetails, **In Park4Night öffnen**, Koordinaten kopieren, Route

Profil, Dauer und Startdatum lassen sich nach der Suche ohne neuen Abruf ändern.
Alle Profil-Parameter sind unter ⚙︎ anpassbar.

**Auf den Home-Bildschirm (iPhone):** Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“.
Auf dem Mac: Safari → Ablage → „Zum Dock hinzufügen“ (oder Chrome → Installieren).

## Hosting (GitHub Pages)
Repo → Settings → Pages → „Deploy from a branch“ → `main` / `/ (root)`.
Die App liegt dann unter `https://<user>.github.io/advancing-into-analytics-book/wetterwahl/`.
Lokal testen: `python3 -m http.server` im Ordner `wetterwahl/` (GPS/Service Worker brauchen HTTPS oder localhost).

## Daten
| Zweck | Quelle |
|---|---|
| Tageswerte 16 Tage | Open-Meteo Forecast API (gebündelt je 50 Orte, 3 h Cache) |
| Prognose-Sicherheit | Open-Meteo Ensemble API, ECMWF IFS 0.25° (51 Member, 15 Tage), nur Top-10 |
| Ortssuche | Open-Meteo Geocoding |
| Regionsnamen | Nominatim (OSM), max. 1 Anfrage/s, 90 Tage Cache |
| Land/Meer | Natural Earth 1:50m (Europa + Nordafrika, Seen ausgeschnitten), `data/land.json` |

Rasterabstand: 15–25 km bei kleinem Radius, wird vergrößert bis max. 400 Orte (einstellbar 200/400/700).
Das Raster ist global ausgerichtet, damit benachbarte Suchen den Cache wiederverwenden.

## Score
Pro Tag vier Teilwerte 0–1:
- **Temperatur** (Tageshöchstwert): 1 im Wohlfühlbereich, linear auf 0 über `coldMargin` darunter;
  oberhalb bis zur Hitzegrenze sanft auf 0,6, danach −0,2 pro °C (Wandern mit Hund: 28 °C → 0,6, 31 °C → 0)
- **Sonne**: Sonnenstunden / Tageslänge, 80 % = 1
- **Regen**: 1 − (½·√(mm/rainBadMm) + ½·Wahrscheinlichkeit)
- **Wind**: Böen ≤ gustOk → 1, ≥ gustBad → 0

Tagesscore = 100 × gewichteter Mittelwert × Veto-Faktoren (Teilwert unter Schwelle drückt den Tag auf bis zu 35 %).
Fensterscore = 0,6 × Mittelwert + 0,4 × schlechtester Tag. Sliding Window über alle erlaubten Starttage.
Regionen: Greedy – bester Punkt wird Region, Punkte im Umkreis max(80 km, 2 × Raster) werden ihr zugeordnet.
Sicherheit: Mittel über die Fenstertage aus Temperatur-Streuung (σ/4 °C) und Regen-Uneinigkeit 4·p·(1−p) → hoch < 0,3 ≤ mittel < 0,55 ≤ niedrig.

## Park4Night
`https://park4night.com/de/map/?lat=…&lng=…&z=11` – der Pfad `/map/*` ist in Park4Nights
`apple-app-site-association` als Universal Link für die iOS-App registriert; im Browser leitet der Server
auf die Suchkarte an diesen Koordinaten weiter. Zusätzlich: Web-Link und „Koordinaten kopieren“.

## Tests
```
cd wetterwahl && node --test test/*.test.js
```

## Entwicklung
Nach Änderungen an App-Dateien `VERSION` in `sw.js` hochzählen, damit installierte Apps aktualisieren.
