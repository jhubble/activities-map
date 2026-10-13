import { escapeHtml } from '../utils/html.js';
import config from '../config.js';
import type { StravaActivity, ActivityFilterCounts } from '../types/index.js';

export function renderHomePage(authUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Activities map</title>
</head>
<body>
    <p><a href="${escapeHtml(authUrl)}">Auth with Strava (must do before calling any data)</a></p>
    <p><a href="/code">Go directly to options (to use cached data)</a></p>
    <p><a href="/map">View map</a></p>
</body>
</html>`;
}

export function renderOptionsForm(
  htmlOptions: string,
  authUrl: string,
  token?: string,
  athleteid?: number | string,
  refresh: boolean = false
): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Activities Map Options</title>
</head>
<body>
<form id="myForm" action="/process" method="get">
  ${htmlOptions}
  <br>Strava Athlete ID:<input type="text" name="athleteid" value="${escapeHtml(athleteid || '')}"></input>
  <br>Strava token:<input type="text" name="token" value="${escapeHtml(token || '')}"></input>
  <a id="refresh" onclick="saveFormData()" href="${escapeHtml(authUrl)}">Auth with Strava</a>
  <br>
  <p>fromStamp and toStamp are dates parsable by JS or unix timestamp in seconds (e.g. Date.now()/1000)</p>
  <p>Distances are degrees from center (plus or minus)</p>
  <p>Check For Newer will call Strava for new activities, otherwise local cache will be used</p>
  <input type="submit" value="Generate Map">
  <input type="submit" formaction="/stats" value="Show Stats">
</form>
<p><strong>The first time run with "Check For Newer", it will download all track information. This can take several minutes.</strong> Subsequent runs will only query activities newer than the cache.</p>
<script src="/formClient.js"></script>
${refresh ? '<script>restoreFormData()</script>' : ''}
</body>
</html>`;
}

export function renderMapHtml({
  kml = '',
  lat = config.default_latitude,
  long = config.default_longitude,
  tiles = 'osm',
  geoJson = '',
  rateLimitReached = false
}: {
  kml?: string;
  lat?: string | number;
  long?: string | number;
  tiles?: string;
  geoJson?: string | null;
  rateLimitReached?: boolean;
}): string {
  const safeKml = encodeURIComponent(kml);
  const safeGeoJson = geoJson ? encodeURIComponent(geoJson) : '';
  const rateLimitNotice = rateLimitReached
    ? `<div style="background:#fff3cd;color:#856404;padding:12px;margin:8px 0;border:1px solid #ffeeba;border-radius:4px;">
        <strong>Notice:</strong> Strava 15-minute API rate limit reached. Downloaded tracks were cached. Re-run after 15 minutes to continue downloading additional tracks.
       </div>`
    : '';

  const osmTiles = `
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  `;

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Track Map</title>
    <link rel="stylesheet" type="text/css" href="/leaflet/leaflet.css" />
    <script src="/leaflet/leaflet.js"></script>
</head>
<body>
    ${rateLimitNotice}
    <div id="mapinfo"></div>
    <div id="map" style="height: 800px; border: 1px solid black"></div>
    <script>
      const layers = [ '${safeKml}', '${safeGeoJson}' ];
      var map = L.map('map').setView([${Number(lat)}, ${Number(long)}], 13);
      ${tiles === 'osm' ? osmTiles : ''}

      const colors = ['red', 'green', 'yellow'];
      let color = 0;
      layers.forEach(layerFile => {
        if (layerFile && layerFile !== 'null') {
          const colorToUse = colors[color] || 'blue';
          color++;
          fetch('/geojson/' + layerFile).then(function (response) {
            return response.json();
          }).then(geojsonJSON => {
            const mapinfoEl = document.getElementById('mapinfo');
            let header = 'Number of tracks: ' + geojsonJSON.features.length + ' <a href="javascript:history.back()">go back</a>';
            if (mapinfoEl.innerHTML) {
              header = mapinfoEl.innerHTML + " - " + header;
            }
            mapinfoEl.innerHTML = header;

            var defaultStyle = { color: colorToUse, weight: 2, fillOpacity: 0.2 };
            var highlightStyle = { color: "#ff0000", weight: 5, fillOpacity: 0.7 };
            let highlightedLayer = null;

            function highlightFeature(e) {
              const target = e.target;
              if (highlightedLayer === target) {
                geoJsonLayer.resetStyle(target);
                target.bringToBack();
                highlightedLayer = null;
              } else {
                if (highlightedLayer) {
                  geoJsonLayer.resetStyle(highlightedLayer);
                }
                target.setStyle(highlightStyle);
                target.bringToFront();
                highlightedLayer = target;
              }
            }

            const geoJsonLayer = L.geoJson(geojsonJSON, {
              style: function (feature) {
                return {
                  color: feature.properties.color,
                  fillColor: feature.properties.fillColor,
                  fillOpacity: feature.properties['fill-opacity'],
                  weight: feature.properties.weight,
                  dashArray: feature.properties.dashArray
                };
              },
              onEachFeature: function (feature, layer) {
                if (feature.properties && feature.properties.name) {
                  layer.bindPopup(feature.properties.name);
                }
                layer.setStyle(defaultStyle);
                layer.on({ click: highlightFeature });
              }
            }).addTo(map);
          }).catch(function (error) {
            console.error("Error loading geojson layer:", error);
          });
        }
      });
    </script>
</body>
</html>`;
}

interface StatsTemplateData {
  activities: StravaActivity[];
  activityProcessCounts: ActivityFilterCounts;
  elapsed: number;
  moving: number;
  earliest: number | null;
  latest: number | null;
  tracksHtml: string;
  badGPS: string[];
  badGear: StravaActivity[];
  types: Record<string, number>;
  buckets: Record<string, any>;
  dayBuckets: Record<string, any>;
  rateLimitReached?: boolean;
}

export function renderStatsHtml(data: StatsTemplateData, getDaysInMonth: (m: string) => number, metersToMiles: (m: number) => number): string {
  const { activities, activityProcessCounts, elapsed, moving, earliest, latest, tracksHtml, badGPS, badGear, types, buckets, dayBuckets, rateLimitReached } = data;
  const days = earliest && latest ? (latest - earliest) / 1000 / 60 / 60 / 24 : 1;
  const hours = elapsed / 60 / 60;
  const moving_hours = moving / 60 / 60;

  const rateLimitNotice = rateLimitReached
    ? `<div style="background:#fff3cd;color:#856404;padding:12px;margin:8px 0;border:1px solid #ffeeba;border-radius:4px;">
        <strong>Notice:</strong> Strava 15-minute API rate limit reached. Re-run after 15 minutes to continue fetching activities.
       </div>`
    : '';

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Strava Stats</title>
  <link rel="stylesheet" href="/assets/basic.css">
</head>
<body>
  ${rateLimitNotice}
  <h1>Stats</h1>
  <a href="javascript:history.back()">go back</a>

  <table class="styled-table">
    <thead><tr><th>Description</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>Total time</td><td>${hours.toFixed(2)} hours</td></tr>
      <tr><td>Activities</td><td>${activities.length}</td></tr>
      <tr><td>First</td><td>${earliest ? new Date(earliest).toLocaleString() : 'N/A'}</td></tr>
      <tr><td>Last</td><td>${latest ? new Date(latest).toLocaleString() : 'N/A'}</td></tr>
      <tr><td>Days</td><td>${days.toFixed(2)} days</td></tr>
      <tr><td>Hours/Day</td><td>${(hours / days).toFixed(2)} hours</td></tr>
      <tr><td>Moving Hours/Day</td><td>${(moving_hours / days).toFixed(2)}</td></tr>
      <tr><td>Moving Hours</td><td>${moving_hours.toFixed(2)}</td></tr>
      <tr><td>Activities/Day</td><td>${(activities.length / days).toFixed(2)} activities</td></tr>
      <tr><td>Hours/Activity</td><td>${activities.length ? (hours / activities.length).toFixed(2) : '0'} hours</td></tr>
      <tr><td>Yearly Estimate</td><td>${((hours / days) * 365).toFixed(2)} hours</td></tr>
      <tr><td>Yearly Moving Estimate</td><td>${((moving_hours / days) * 365).toFixed(2)} hours</td></tr>
    </tbody>
  </table>

  <h2>Tracks with missing gear (${badGear.length})</h2>
  ${badGear.length ? badGear.map(t => `<a target="_blank" href="https://www.strava.com/activities/${t.id}">${escapeHtml(t.name)}</a><br />`).join('\n') : 'None'}

  <h2>Types</h2>
  <table class="styled-table">
    <thead><tr><th>type</th><th>activities</th></tr></thead>
    <tbody>
      ${Object.keys(types).sort((a, b) => types[a] - types[b]).map(t => `<tr><td>${escapeHtml(t)}</td><td>${types[t]}</td></tr>`).join('\n')}
    </tbody>
  </table>

  <h2>Activity Filter Counts</h2>
  <table class="styled-table">
    <thead><tr><th>filter</th><th>count</th></tr></thead>
    <tbody>
      ${Object.keys(activityProcessCounts).map(k => `<tr><td>${escapeHtml(k)}</td><td>${activityProcessCounts[k]}</td></tr>`).join('\n')}
    </tbody>
  </table>

  <h2>Monthly stats (hours elapsed time)</h2>
  <table class="styled-table">
    <thead><tr><th>Month</th><th>Total</th><th>Daily Average*</th><th>distance (miles)</th><th>climb (feet)</th></tr></thead>
    <tbody>
      ${Object.keys(buckets).sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).map(b => {
        const item = buckets[b];
        return `<tr>
          <td>${escapeHtml(b)}</td>
          <td>${(item.elapsed / 3600).toFixed(2)}</td>
          <td>${((item.elapsed / 3600) / getDaysInMonth(b)).toFixed(2)}</td>
          <td>${metersToMiles(item.distance).toFixed(2)}</td>
          <td>${(item.climb * 3.28084).toFixed(0)}</td>
        </tr>`;
      }).join('\n')}
    </tbody>
  </table>
  <small>* current month is average daily to date</small>

  <h2>Daily stats</h2>
  <table class="styled-table">
    <thead><tr><th>Date</th><th>Daily elapsed</th><th>YTD Elapsed</th><th>Daily moving</th><th>YTD moving</th><th>non moving</th><th>distance</th><th>climb</th></tr></thead>
    <tbody>
      ${(() => {
        let year = 0;
        let yearCount = 0;
        let yearCountMoving = 0;
        return Object.keys(dayBuckets).sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).map(bucket => {
          const currentYear = new Date(bucket).getFullYear();
          if (year !== currentYear) {
            year = currentYear;
            yearCount = 0;
            yearCountMoving = 0;
          }
          yearCount += dayBuckets[bucket].elapsed;
          yearCountMoving += dayBuckets[bucket].moving;
          return `<tr>
            <td>${escapeHtml(bucket)}</td>
            <td>${(dayBuckets[bucket].elapsed / 3600).toFixed(2)}</td>
            <td>${(yearCount / 3600).toFixed(2)}</td>
            <td>${(dayBuckets[bucket].moving / 3600).toFixed(2)}</td>
            <td>${(yearCountMoving / 3600).toFixed(2)}</td>
            <td>${((dayBuckets[bucket].elapsed - dayBuckets[bucket].moving) / 3600).toFixed(2)}</td>
            <td>${metersToMiles(dayBuckets[bucket].distance).toFixed(2)}</td>
            <td>${(dayBuckets[bucket].climb * 3.28084).toFixed(0)}</td>
          </tr>`;
        }).join('\n');
      })()}
    </tbody>
  </table>

  <h2>All tracks</h2>
  ${tracksHtml}

  <h2>Tracks with missing GPS (${badGPS.length})</h2>
  ${badGPS.join('<br />\n')}

</body>
</html>`;

  return html;
}
