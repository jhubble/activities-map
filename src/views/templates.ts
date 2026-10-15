import { escapeHtml } from '../utils/html.js';
import config from '../config.js';
import type { StravaActivity, ActivityFilterCounts } from '../types/index.js';

export function renderUnifiedForm({
  htmlOptions,
  authUrl,
  token = '',
  athleteid = '',
  refresh = false
}: {
  htmlOptions: string;
  authUrl: string;
  token?: string;
  athleteid?: number | string;
  refresh?: boolean;
}): string {
  const hasToken = Boolean(token);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Activities Map - Strava Route Visualizer</title>
  <link rel="stylesheet" href="/assets/basic.css">
</head>
<body>
  <div class="container">
    <header class="app-header">
      <h1 class="app-title">
        <span>🗺️</span> Activities Map
      </h1>
      <p class="app-subtitle">Generate interactive maps, spatial hulls, and detailed statistics from your Strava workouts</p>
    </header>

    <!-- Navigation / Quick status -->
    <nav class="quick-nav">
      <a class="quick-nav-link primary" id="refresh" onclick="saveFormData()" href="${escapeHtml(authUrl)}">
        <span>⚡</span> ${hasToken ? 'Re-authenticate with Strava' : 'Connect with Strava'}
      </a>
      <a class="quick-nav-link" href="/map">
        <span>📍</span> View Current Map
      </a>
      <a class="quick-nav-link" href="/stats" onclick="saveFormData()">
        <span>📊</span> View Statistics
      </a>
    </nav>

    ${!hasToken ? `
      <div class="alert alert-info">
        <strong>Not authenticated yet?</strong> You can click <strong>Connect with Strava</strong> above to fetch new activities, or continue below to generate maps from previously cached data.
      </div>
    ` : `
      <div class="alert alert-info">
        <strong>Connected:</strong> Token is loaded. You can tweak the filters below and generate your map or view workout metrics.
      </div>
    `}

    <div class="card">
      <form id="myForm" action="/process" method="get">
        
        <h2 class="form-section-title">
          <span>⚙️</span> Authentication &amp; Athlete Details
        </h2>
        <div class="form-grid">
          <div class="form-group">
            <label for="athleteid">Strava Athlete ID</label>
            <input type="text" id="athleteid" class="form-control" name="athleteid" value="${escapeHtml(athleteid)}" placeholder="e.g. 12345678">
            <span class="note">Automatically filled after OAuth</span>
          </div>
          <div class="form-group">
            <label for="token">Strava API Token</label>
            <input type="text" id="token" class="form-control" name="token" value="${escapeHtml(token)}" placeholder="Bearer access token">
            <span class="note">Cached access token from Strava login</span>
          </div>
        </div>

        <h2 class="form-section-title">
          <span>🔍</span> Filtering &amp; Generation Options
        </h2>
        
        <div class="form-grid">
          ${htmlOptions}
        </div>

        <div class="actions-bar">
          <button type="submit" class="btn btn-primary">
            <span>🗺️</span> Generate Map
          </button>
          <button type="submit" formaction="/stats" class="btn btn-secondary">
            <span>📈</span> Show Detailed Stats
          </button>
        </div>
      </form>
    </div>

    <div class="alert alert-warning">
      <strong>Pro Tip:</strong> When running with <em>Check For Newer</em> for the first time, all activity stream tracks are downloaded and cached. Subsequent requests use the local cache for lightning-fast map generation.
    </div>
  </div>

  <script src="/formClient.js"></script>
  <script>initializeFormState()</script>
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
    ? `<div class="alert alert-warning" style="margin: 16px;">
        <strong>Notice:</strong> Strava 15-minute API rate limit reached. Downloaded tracks were cached. Re-run after 15 minutes to continue downloading additional tracks.
       </div>`
    : '';

  const osmTiles = `
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Track Map - Activities Map</title>
    <link rel="stylesheet" href="/assets/basic.css">
    <link rel="stylesheet" type="text/css" href="/leaflet/leaflet.css" />
    <script src="/leaflet/leaflet.js"></script>
    <style>
      #map-container {
        padding: 16px;
        max-width: 1400px;
        margin: 0 auto;
      }
      #mapinfo {
        margin-bottom: 12px;
        font-weight: 600;
        color: var(--text-main);
      }
      #map {
        height: 82vh;
        width: 100%;
        border-radius: var(--radius);
        box-shadow: var(--shadow-lg);
        border: 1px solid var(--border);
      }
      .nav-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
      }
    </style>
</head>
<body>
    <div id="map-container">
      <div class="nav-bar">
        <a href="/" class="btn btn-secondary">← Back to Options</a>
        <a href="/stats" class="btn btn-secondary">View Stats</a>
      </div>
      ${rateLimitNotice}
      <div id="mapinfo">Loading tracks...</div>
      <div id="map"></div>
    </div>
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
            let header = 'Loaded ' + (geojsonJSON.features ? geojsonJSON.features.length : 0) + ' tracks/features.';
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
    ? `<div class="alert alert-warning">
        <strong>Notice:</strong> Strava 15-minute API rate limit reached. Re-run after 15 minutes to continue fetching activities.
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strava Workout Stats - Activities Map</title>
  <link rel="stylesheet" href="/assets/basic.css">
</head>
<body>
  <div class="container" style="max-width: 1100px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
      <h1 class="app-title" style="margin: 0;">📊 Workout Statistics</h1>
      <a href="/" class="btn btn-secondary">← Back to Options</a>
    </div>

    ${rateLimitNotice}

    <div class="card">
      <h2 class="form-section-title"><span>📈</span> Overall Summary</h2>
      <table class="styled-table">
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Total Time</td><td><strong>${hours.toFixed(2)}</strong> hours</td></tr>
          <tr><td>Total Activities</td><td><strong>${activities.length}</strong></td></tr>
          <tr><td>First Recorded</td><td>${earliest ? new Date(earliest).toLocaleDateString() : 'N/A'}</td></tr>
          <tr><td>Latest Recorded</td><td>${latest ? new Date(latest).toLocaleDateString() : 'N/A'}</td></tr>
          <tr><td>Total Days Span</td><td>${days.toFixed(1)} days</td></tr>
          <tr><td>Average Hours / Day</td><td>${(hours / days).toFixed(2)} hrs/day</td></tr>
          <tr><td>Moving Hours / Day</td><td>${(moving_hours / days).toFixed(2)} hrs/day</td></tr>
          <tr><td>Total Moving Hours</td><td>${moving_hours.toFixed(2)} hrs</td></tr>
          <tr><td>Activities / Day</td><td>${(activities.length / days).toFixed(2)}</td></tr>
          <tr><td>Hours / Activity</td><td>${activities.length ? (hours / activities.length).toFixed(2) : '0'} hrs</td></tr>
          <tr><td>Yearly Projection</td><td>${((hours / days) * 365).toFixed(1)} hrs/yr</td></tr>
          <tr><td>Yearly Moving Projection</td><td>${((moving_hours / days) * 365).toFixed(1)} hrs/yr</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="form-section-title"><span>👟</span> Activity Types</h2>
      <table class="styled-table">
        <thead><tr><th>Sport Type</th><th>Total Activities</th></tr></thead>
        <tbody>
          ${Object.keys(types).sort((a, b) => types[a] - types[b]).map(t => `<tr><td>${escapeHtml(t)}</td><td><strong>${types[t]}</strong></td></tr>`).join('\n')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="form-section-title"><span>🎯</span> Activity Filter Counts</h2>
      <table class="styled-table">
        <thead><tr><th>Filter Stage</th><th>Activities Retained</th></tr></thead>
        <tbody>
          ${Object.keys(activityProcessCounts).map(k => `<tr><td>${escapeHtml(k)}</td><td>${activityProcessCounts[k]}</td></tr>`).join('\n')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="form-section-title"><span>📅</span> Monthly Breakdown</h2>
      <table class="styled-table">
        <thead><tr><th>Month</th><th>Total Elapsed (hrs)</th><th>Daily Avg (hrs)</th><th>Distance (mi)</th><th>Climb (ft)</th></tr></thead>
        <tbody>
          ${Object.keys(buckets).sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).map(b => {
            const item = buckets[b];
            return `<tr>
              <td><strong>${escapeHtml(b)}</strong></td>
              <td>${(item.elapsed / 3600).toFixed(2)}</td>
              <td>${((item.elapsed / 3600) / getDaysInMonth(b)).toFixed(2)}</td>
              <td>${metersToMiles(item.distance).toFixed(2)}</td>
              <td>${(item.climb * 3.28084).toFixed(0)}</td>
            </tr>`;
          }).join('\n')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="form-section-title"><span>📆</span> Daily History</h2>
      <table class="styled-table">
        <thead><tr><th>Date</th><th>Daily Elapsed</th><th>YTD Elapsed</th><th>Daily Moving</th><th>YTD Moving</th><th>Non-moving</th><th>Distance (mi)</th><th>Climb (ft)</th></tr></thead>
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
    </div>

    <div class="card">
      <h2 class="form-section-title"><span>🏃</span> All Track Records</h2>
      ${tracksHtml}
    </div>

    ${badGear.length ? `
      <div class="card">
        <h2 class="form-section-title"><span>⚠️</span> Tracks With Missing Gear (${badGear.length})</h2>
        ${badGear.map(t => `<a target="_blank" href="https://www.strava.com/activities/${t.id}">${escapeHtml(t.name)}</a><br />`).join('\n')}
      </div>
    ` : ''}

    ${badGPS.length ? `
      <div class="card">
        <h2 class="form-section-title"><span>⚠️</span> Tracks With Missing GPS (${badGPS.length})</h2>
        ${badGPS.join('<br />\n')}
      </div>
    ` : ''}

  </div>
</body>
</html>`;
}
