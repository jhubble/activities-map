import express from 'express';
import {packageDirectorySync} from 'package-directory';
import { logger } from './loggerSetup.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callStravaAPI, TYPES, getAuthURL, getAuthToken, getCacheFileFromActivity, getStuff, outputFile } from './getStravaActivities.mjs';
import { getGeoJsonFromFile, getGeoJsonFromString } from './kmlToGeoJson.mjs';
import { getSpatialAnalysis } from './stravaToGeoJSONAndHull.mjs';
import config from './config.mjs';
import fs from 'fs';

logger.info("starting app");
const app = express();
const port = config.run_on_port || 8080;
const foot = config.activity_types.Foot; // Run, Walk, Hike
const __dirname = packageDirectorySync();

logger.trace("dirname:",__dirname);

const OPTIONS = {
	type: Object.keys(TYPES),
	checkForNewer: [true, false],
	includePrivate: [false, true],
	refresh: {values: [false, true], note: 'Re-read all metadata and reload those that are changed'},
	fromStamp: {default:'2024-01-15',note:"time parsable by JS in locale or unix timestamp (1694822400 is 2023-09-16)"},
	toStamp: '',
	center_lat: { name:"Center Latitude", key:"location_center_lat", default:config.default_latitude},
	center_lng: { name:"Center Longitude", key:"location_center_long", default:config.default_longitude},
	lat_dist: { name:"Latitude distance", key:"location_distance_lat", default:config.location_distance_lat},
	long_dist: { name:"Longitude distance", key:"location_distance_long", default:config.location_distance_long},
	tiles: ['osm','none'],
	tolerance: { default: config.tolerance, name:"Tolerance", key:"tolerance", note:"higher number=lower accuracy, smaller file. .5-1 is best, 10 is one city block, 0 is no smoothing"} 
};

const outputLabel = (optionKey, name) => {
	return `<label>${name || optionKey}</label>:`;
}

const outputArrayValues = (optionKey, optionValue, name) => {
	let html = outputLabel(optionKey,name);
	html +=`<select name="${optionKey}">`;
	html += optionValue.map(k => `<option value="${k}">${k}</option>`);
	html += "</select>";
	return html;
}
const processOption = (optionKey, optionValue) => {
	// If it is an array, it is list of values, default to first
	// name is key
	if (Array.isArray(optionValue)) {
		return outputArrayValues(optionKey, optionValue);
	}
	// If it is a string, it is an input field with value as default
	if (typeof optionValue === 'string') {
		let html = `<label>${optionKey}</label>: <input type="text" name="${optionKey}" value="${optionValue}"></input>`;
		return html;
	}
	// An opject has explicit name, value and default (and maybe values for list)
	if (typeof optionValue === 'object') {
		let html = ''
		if (Array.isArray(optionValue?.values)) {
			html += outputArrayValues(optionKey, optionValue.values, optionValue?.name);
		}
		else {
			html = outputLabel(optionKey, optionValue?.name);
			html += `<input type="text" name="${optionValue?.['key'] || optionKey}" value="${optionValue?.default}"></input>`;
		}
		html += `<span>${optionValue?.note || ''}</span>`;
		return html;
	}
}
		

const processOptions = (options) => {
	let html = Object.entries(options).map(o => processOption(o[0],o[1]));
	return html.join('<br>');

}





// default entry point - shows static page
app.get('/', (request, response) => {
	const auth_url = getAuthURL();
	response.send(`
<html>
        <head>
                <title>
                        Activities map
                </title>
        </head>
        <body>
                <p>
		<a href="${auth_url}">Auth with Strava (must do before calling any data) </a>
                </p>
                <p>
                <a href="/code">Go directly to options (to use cached data)</a>
                </p>
		<p>
		<a href="/map">View map</a>
		</p>
        </body>
</html>


		`);
})

// /code is where we paste the code after authentication with strava
// If we get here without authenticating, the "checkForNewer" default flag is flipped

const getOptionForm = (token, athleteid, refresh=false) => {
	const auth_url = getAuthURL("coderefresh");
	logger.info("Token from options form:",token);
	let options = JSON.parse(JSON.stringify(OPTIONS));
	// Default to not use strava api if we don't have token
	if (!token) {
		options.checkForNewer = [false,true];
	}
	const htmlOptions = processOptions(options);
	let output = `<form id="myForm" action="/process" method="get">`;
	output += htmlOptions;
	output += `<br>Stava Athlete ID:<input type="text" name="athleteid" value="${athleteid}"</input>`;
	output += `<br>Strava token:<input type="text" name="token" value="${token || ''}"></input>`;
	output += `<a id="refresh" onclick="saveFormData()" href="${auth_url}">Auth with Strava</a>`;
	output += `<br>`;
	output += `<p>fromStamp and toStamp or minutes from epoch. (e.g. Date.now()/1000)</p>`;
	output += `<p>Distances are degrees from center (plus or minus)</p>`;
	output += `<p>Check For Newer will call strava for more, otherwise, cache will be used</p>`;
	output += `<input type="submit" value="Generate Map">`;
	output += `<input type="submit" formaction="/stats" value="Show Stats">`;
	output += `</form>`;
	output += `<p><strong>The first time run with "Check For Newer" it will download all track information. This can take a long time.</strong>. Later calls will just get items newer than available.</p>`; 

	output += `<script src="/formClient.js"></script>`;
	if (refresh) {
		output += `<script>restoreFormData()</script>`;
	}
	return output;
}
app.get('/formClient.js', (req, res) => {
	logger.info("serving form client");
  res.sendFile(path.join(__dirname, 'src/formClient.js'));
});
app.get('/code', (request, response) => {
	const code = request?.query?.code;
	logger.info("Calling /code with code",code);
	if (!code) {
		response.send(getOptionForm());
	}
	else {
		getAuthToken(code).then( ({access_token,athleteID})  => {
			logger.info("Got token",access_token, "athleteid",athleteID);
			response.send(getOptionForm(access_token,athleteID));
		})
		.catch( (e) => {
			response.send(getOptionForm());
		});
	}

});

app.get('/coderefresh', (request, response) => {
	const code = request?.query?.code;
	logger.info("Calling /coderefresh with code",code);
	if (!code) {
		logger.debug("No code, so direct to option form");
		response.send(getOptionForm());
	}
	else {
		logger.debug("code, so calling promise");
		getAuthToken(code).then( ({access_token,athleteID})  => {
			logger.info("Got token",access_token, "athleteid",athleteID);
			response.send(getOptionForm(access_token,athleteID,true));
		})
		.catch( (e) => {
			logger.error("error with token",e);
			response.send(getOptionForm());
		});
	}

});

const getMapHtml = ({kml = '', lat, long, tiles = 'osm', geoJson = '' } = {}) => {
	const osmTiles = `
                        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        }).addTo(map);
	`;

	const leaflet = `
               <link rel="stylesheet" type="text/css" href="/leaflet/leaflet.css" />
                <!-- Make sure you put this AFTER Leaflet's CSS -->
                <script src="/leaflet/leaflet.js"></script>
                <div id="mapinfo"></div>
                <div id="map" style="height: 800px; border: 1px solid black"></div>
                <script>
			const layers = [ '${kml}', '${geoJson}' ];
                        var map = L.map('map').setView([${lat}, ${long}], 13);
			${tiles === 'osm' ? osmTiles : '' }

			const colors = ['red','green','yellow'];
			let color = 0;
			layers.forEach( kml => {
				if (kml) {
					const colorToUse = colors[color];
					color++;
					fetch('/geojson/'+kml).then(function (response) {
						response.text().then((geojson) => {
							let highlighted = null;
							// todo: actually use the colors
							const geojsonJSON = JSON.parse(geojson);
							const mapinfo = document.getElementById('mapinfo').innerHTML;
							let header = 'Number of tracks: '+geojsonJSON.features.length+' <a href="javascript:history.back()">go back</a>';
							if (mapinfo) {
								header = mapinfo + " - " + header;
							}
							document.getElementById('mapinfo').innerHTML = header;
							var defaultStyle = { color: colors[color], weight: 2, fillOpacity: 0.2 };
							var highlightStyle = { color: "#ff0000", weight: 5, fillOpacity: 0.7 };
							let highlightedLayer;

							function highlightFeature(e) {
							    const layer = e.target;

							    if (highlightedLayer === layer) {
								// If already highlighted, remove it (toggle off)
								geoJsonLayer.resetStyle(layer);
								highlightedLayer = null;
							    } else {

								    // Reset previous highlight if it exists
								    if (highlightedLayer) {
									geoJsonLayer.resetStyle(highlightedLayer);
								    }

								    // Apply new highlight style
								    layer.setStyle({
									weight: 5,
									color: '#666',
									dashArray: '',
									fillOpacity: 0.7
								    });

								    layer.bringToFront();
								    highlightedLayer = layer; // Track current selection
							    }
							}

							// Attach the event to your GeoJSON data
							const geoJsonLayer = L.geoJson(geojsonJSON, {
							    onEachFeature: function (feature, layer) {
							        if (feature.properties && feature.properties.name) {
									layer.bindPopup(feature.properties.name);
								}
								layer.on({
								    click: highlightFeature
								});
							    }
							}).addTo(map);

						});
					}).catch(function (error) {
						// There was an error
						logger.error(error);
					});
				}
			})

	</script>
	`;
	return leaflet;
}


// /map will load html with a map optionally substituted in
app.get('/map/:kml?', (request, response) => {
	const kmlfile = request.params?.kml;
	const tiles = request.params?.tiles || 'osm';
	if (/^output_\d+\.kml$/.test(outfile)) {
		const leaflet = getMapHtml({kml:kmlfile,latitude:config.default_latitude,longitude:config.default.longitude, tiles:tiles});
		response.send(leaflet);
	}
	else {
		const leaflet = getMapHtml({kml:kmlfile,latitude:config.default_latitude,longitude:config.default.longitude, tiles:tiles});
		response.send(leaflet);
	}
});


// takes in a kml file and returns geojson of that file
app.get('/geojson/:outfile', (request, response) => {
	let outfile = request.params.outfile;
	if (/^output_\d+\.kml$/.test(outfile)) {
		logger.info("outfile:",outfile);
		outfile = `${__dirname}/out/${outfile}`;
		const geoJson = getGeoJsonFromFile(outfile);
		response.send(geoJson);
	}
	else if (/\d+\.geojson$/.test(outfile)) {
		logger.info("outfile:",outfile);
		outfile = `${__dirname}/out/${outfile}`;
		response.sendFile(outfile);
	}
	else {
		response.send(outfile);
	}
});

// all kml files produced served from out/ (url will just be root)
app.use(express.static('out'));

// leaflet source files
app.use('/leaflet', express.static('node_modules/leaflet/dist'));

// css and other misc
app.use('/assets', express.static('src/assets'));


const _getInitialData = async (request,response) => {
	let opts = request.query;
	if (opts.location_distance_lat && opts.location_distance_long) {
		opts.location = { center : [opts.location_center_lat, opts.location_center_long],
			dist: [opts.location_distance_lat,opts.location_distance_long]
		}
	}
	const lat = opts.location_center_lat || config.default_latitude;
	const long = opts.location_center_long || config.default_longitude;
	logger.debug("options: ",opts);
	const data = await getStuff(opts);
	logger.trace("DATA",data);
	if (!data) {
		response.send('No data  found <a href="javascript:history.back()">go back</a>');
		return false;
	}
	else {
		return { data, opts, lat, long };
	}
}

// process will take lines from query string
app.get('/process', async (request, response) => {
	const result = await _getInitialData(request, response);
	if (result) {
		const {data,opts,lat,long} = result;
		const activities = data.activities;
		// get hulls
		// use 0 buffer zone (they must touch)
		const fileList = activities.map(activity => getCacheFileFromActivity(activity));
		const hulls = getSpatialAnalysis(fileList);
		//const hulls = getSpatialAnalysis(fileList, 0);
		const hullsKml = hulls.kml;
		const hullsGeoJson = hulls.geoJSON;
		const kmlTrack = data.kmlTrack;
		if (!kmlTrack) {
			response.send('No data  found <a href="javascript:history.back()">go back</a>');
		}
		else {
			const outputDate = `output_${Date.now()}`;
			const kmlFileName =  `${outputDate}.kml`;
			const hullGeoJsonFileName = `hull_${outputDate}.geojson`;

			const hullGeoJsonFullPath = `${__dirname}/out/${hullGeoJsonFileName}`;
			const tracksFullPath = `${__dirname}/out/${kmlFileName}`;
			outputFile(kmlTrack, tracksFullPath);
			outputFile(JSON.stringify(hullsGeoJson,null,2), hullGeoJsonFullPath);
			let html = `Download tracks: <a href="${kmlFileName}">${kmlFileName}</a>`;
			html += getMapHtml({kml:kmlFileName, lat:lat, long: long, tiles:opts.tiles, geoJson:hullGeoJsonFileName});
			response.send(html);
		}
	}
});

const getDaysInMonth = (monthYearStr) => {
  const [monthStr, yearStr] = monthYearStr.split(' ');
  const month = new Date(`${monthStr} 1, ${yearStr}`).getMonth(); // convert month name to month index
  const year = parseInt(yearStr, 10);

  const now = new Date();
  const currentYear = `${now.getFullYear()}`;
  const currentMonth = now.toLocaleString('default', { month: 'short' });
  // use single equals, because one is number and the other is string
  if (monthStr === currentMonth && yearStr == currentYear) {
	// If we are in the current month, return days to today
        const dayBucket = new Date(now).toLocaleString('default',{day: 'numeric', month: 'short', year: 'numeric'});
	return now.getDate();
  }

  // Create a date for the first day of the next month, then subtract 1 day
  return new Date(year, month + 1, 0).getDate();
}

app.get('/stats', async (request, response) => {
	logger.info("STATS");
	const req = {...request};
	req.query.stats = true;
	const result = await _getInitialData(req, response);
	const badGear = [];
	const types = {};
	const buckets = {};
	const dayBuckets = {};
	const dayBucketsMoving = {};
	if (result) {
		const {data,opts,lat,long} = result;
		const {activities} = data;
		let elapsed = 0;
		let moving = 0;
		let earliest = null;
		let latest = null;
		activities.forEach(track => {
			elapsed += track.elapsed_time;
			moving += track.moving_time;
			const startDate = Date.parse(track.start_date);
			const bucket = new Date(track.start_date).toLocaleString('default',{month: 'short', year: 'numeric'});
			const dayBucket = new Date(track.start_date).toLocaleString('default',{day: 'numeric', month: 'short', year: 'numeric'});
			buckets[bucket] = buckets.hasOwnProperty(bucket) ? buckets[bucket] : { elapsed: 0, moving : 0 };
			buckets[bucket].elapsed = (buckets[bucket]?.elapsed || 0) + track.elapsed_time;
			buckets[bucket].moving = (buckets[bucket]?.moving || 0) + track.moving_time;
			dayBuckets[dayBucket] = dayBuckets.hasOwnProperty(dayBucket) ? dayBuckets[dayBucket] : { elapsed: 0, movine: 0};
			dayBuckets[dayBucket].elapsed = (dayBuckets[dayBucket]?.elapsed || 0) + track.elapsed_time;
			dayBuckets[dayBucket].moving = (dayBuckets[dayBucket]?.moving || 0) + track.moving_time;

			if (foot.indexOf(track.type) !== -1) {
				buckets[bucket].steps = (buckets[bucket].moving || 0) + track.steps;
				dayBuckets[dayBucket].steps = (dayBuckets[dayBucket].moving || 0) + track.steps;

				buckets[bucket].distance = (buckets[bucket].distance || 0) + track.distance;
				buckets[bucket].climb = (buckets[bucket].climb || 0) + track.elevation_gain;
				dayBuckets[dayBucket].distance = (dayBuckets[dayBucket].distance || 0) + track.distance;
				dayBuckets[dayBucket].climb = (dayBuckets[dayBucket].climb || 0) + track.elevation_gain;
			}

			types[track.type] = (types[track.type] || 0) + 1;
			if (earliest === null || startDate < earliest) {
				earliest = startDate;
			}
			if (latest === null || startDate > latest) {
				latest = startDate;
			}
			if (track.gear_id === 'b11740548' || track.gear_id === 'g8082193') {
				badGear.push(track);
			}

		});
		logger.trace("DATA",data);
		logger.trace("OPTS",opts);
		const days = (latest-earliest)/1000/60/60/24;
		const hours = elapsed/60/60;
		const moving_hours = moving/60/60;
		let html='';
		html += `<html><head><title>Strava Stats</title><link rel="stylesheet" href="/assets/basic.css"></head>`;
		html += `<body>`;
		html +=  "<h1>Stats</h1>";
		html += '<a href="javascript:history.back()">go back</a>';

		html += `<table class="styled-table"><thead><tr><th>Description</th><th>Value</th></tr></thead>`;
		html += `<tbody>`;
		html += `<tr><td>Total time</td><td> ${Number.parseFloat(hours).toFixed(2)} hours</td></tr>`;
		html += `<tr><td>Activites </td><td> ${activities.length}</td></tr>`;
		html += `<tr><td>First     </td><td> ${new Date(earliest).toLocaleString()}</td></tr>`;
		html += `<tr><td>Last      </td><td> ${new Date(latest).toLocaleString()}</td></tr>`;
		html += `<tr><td>Days      </td><td> ${Number.parseFloat(days).toFixed(2)} days</td></tr>`
		html += `<tr><td>Hours/Day </td><td> ${Number.parseFloat(hours/days).toFixed(2)} hours</td></tr>`
		html += `<tr><td>Moving Hours/Day </td><td> ${Number.parseFloat(moving_hours/days).toFixed(2)}</td></tr>`;
		html += `<tr><td>Moving Hours</td><td>${Number.parseFloat(moving_hours).toFixed(2)}</td></tr>`;
		html += `<tr><td>Activities/Day </td><td> ${Number.parseFloat(activities.length/days).toFixed(2)} activities</td></tr>`
		html += `<tr><td>Hours/Activity </td><td> ${Number.parseFloat(hours/activities.length).toFixed(2)} activities</td></tr>`
		html += `<tr><td>Yearly Estimate</td><td> ${Number.parseFloat((hours/days)*365).toFixed(2)} hours</td></tr>`;
		html += `<tr><td>Yearly Moving Estimate</td><td> ${Number.parseFloat((moving_hours/days)*365).toFixed(2)} hours</td></tr>`;
		html += `</tbody></table>`;
		const tracksWithMissingGear = badGear.map(track => {return `<a target="_blank" href="https://www.strava.com/activities/${track.id}">${track.name}</a><br />`; }).join('') || 'None';
		html += `\n<h2>Tracks with missing gear:</h2>\n ${tracksWithMissingGear}`;
		html += `\n<h2>Types</h2>\n<table class="styled-table"><thead><tr><th>type</th><th>activities</th></tr></thead><tbody>`;
		html += Object.keys(types)
			.sort((a,b) => { return types[a] - types[b]})
			.map(type => {
				return `<tr><td>${type}</td><td>${types[type]}</td></tr>`;
			})
			.join('\n');
		html += `</tbody></table>`;
		html += `\n<h2>Monthly stats (hours elapsed time)</h2>`;
		html += `\n<table class="styled-table"><thead><tr><th>Month</th><th>Total</th><th>Daily Average*</th></tr></thead><tbody>`;
		html += Object.keys(buckets)
			.sort((a,b) => { return new Date(a) - new Date(b)})
			.map(bucket => {
				return `<tr><td>${bucket}</td>`
					+`<td>${Number.parseFloat(buckets[bucket].elapsed/60/60).toFixed(2)}</td>`
					+`<td>${Number.parseFloat((buckets[bucket].elapsed/60/60) / getDaysInMonth(bucket)).toFixed(2)}</td></tr>`;
			})
			.join('\n');
		html += `</tbody></table>`;
		html += `* current month is average daily to date`;
		html += `\n<h2>Daily stats</h2>`;
	html += `\n<table class="styled-table"><thead><tr><th>Date</th><th>Daily elapsed</th><th>YTD Elapsed</th><th>Daily moving</th><th>YTD moving</th><th>non moving</th></tr></thead><tbody>`;
		let year =0;
		let yearCount = 0;
		let yearCountMoving = 0;
		html += Object.keys(dayBuckets)
			.sort((a,b) => { return new Date(a) - new Date(b)})
			.map(bucket => {
				const currentYear = new Date(bucket).getFullYear();
				if (year != currentYear) {
					year = currentYear;
					yearCount = 0;
					yearCountMoving = 0;
				}
				yearCount += dayBuckets[bucket].elapsed;
				yearCountMoving += dayBuckets[bucket].moving;
				return `<tr><td>${bucket}</td>`
					+`<td>${Number.parseFloat(dayBuckets[bucket].elapsed/60/60).toFixed(2)}</td>`
					+`<td>${Number.parseFloat(yearCount/60/60).toFixed(2)}</td>`
					+`<td>${Number.parseFloat(dayBuckets[bucket].moving/60/60).toFixed(2)}</td>`
					+`<td>${Number.parseFloat(yearCountMoving/60/60).toFixed(2)}</td>`
					+`<td>${Number.parseFloat(dayBuckets[bucket].elapsed/60/60 - dayBuckets[bucket].moving/60/60).toFixed(2)}</td>`
					+`</tr>`;
			})
			.join('\n');
		html += `</tbody></table>`;
		html += `</body></html>`;
		response.send(html);
	}
});




app.listen(port, () => {
  logger.info(`activities-map listening at http://localhost:${port}`)
})
