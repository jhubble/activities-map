import express from 'express';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { TYPES, getAuthURL, getAuthToken, getStuff, outputFile } from './getStravaActivities.mjs';
import { getGeoJsonFromFile, getGeoJsonFromString } from './kmlToGeoJson.mjs';
import config from './config.mjs';
import fs from 'fs';

const app = express();
const port = config.run_on_port || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));

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
	tiles: ['osm','none']
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

const getOptionForm = (token) => {
	console.log("Token:",token);
	let options = JSON.parse(JSON.stringify(OPTIONS));
	// Default to not use strava api if we don't have token
	if (!token) {
		options.checkForNewer = [false,true];
	}
	const htmlOptions = processOptions(options);
	let output = `<form action="/process" method="get">`;
	output += htmlOptions;
	output += `<br>Strava token:<input type="text" name="token" value="${token || ''}"></input><br>`;
	output += `<p>fromStamp and toStamp or minutes from epoch. (e.g. Date.now()/1000)</p>`;
	output += `<p>Distances are degrees from center (plus or minus)</p>`;
	output += `<p>Check For Newer will call strava for more, otherwise, cache will be used</p>`;
	output += `<input type="submit"></form>`;
	output += `<p><strong>The first time run with "Check For Newer" it will download all track information. This can take a long time.</strong>. Later calls will just get items newer than available.</p>`; 

	return output;
}
app.get('/code', (request, response) => {
	const code = request?.query?.code;
	if (!code) {
		response.send(getOptionForm());
	}
	else {
		getAuthToken(code).then( token => {
			response.send(getOptionForm(token));
		})
		.catch( (e) => {
			response.send(getOptionForm());
		});
	}

});

const getMapHtml = ({kml = '', lat, long, tiles = 'osm' } = {}) => {
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
                        const kml = '${kml}';
                        var map = L.map('map').setView([${lat}, ${long}], 13);
			${tiles === 'osm' ? osmTiles : '' }

                        if (kml) {

                                fetch('/geojson/'+kml).then(function (response) {
                                        response.text().then((geojson) => {
                                                const geojsonJSON = JSON.parse(geojson);
						const header = 'Number of tracks: '+geojsonJSON.features.length+' <a href="javascript:history.back()">go back</a>';
                                                document.getElementById('mapinfo').innerHTML = header;
                                                function onEachFeature(feature, layer) {
                                                    if (feature.properties && feature.properties.name) {
                                                        layer.bindPopup(feature.properties.name);
                                                    }
                                                }

                                                L.geoJSON(geojsonJSON, {
                                                    onEachFeature: onEachFeature
                                                }).addTo(map);
                                                //L.geoJSON(JSON.parse(geojson)).addTo(map);
                                        });
                                }).catch(function (error) {
                                        // There was an error
                                        console.warn(error);
                                });
                        }

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
		console.log("outfile:",outfile);
		outfile = `${__dirname}/out/${outfile}`;
		const geoJson = getGeoJsonFromFile(outfile);
		response.send(geoJson);
	}
	else {
		response.send(outfile);
	}
});

// all kml files produced served from out/ (url will just be root)
app.use(express.static('out'));

// leaflet source files
app.use('/leaflet', express.static('node_modules/leaflet/dist'))


// process will take lines from query string
app.get('/process', async (request, response) => {

	let opts = request.query;
	if (opts.location_distance_lat && opts.location_distance_long) {
		opts.location = { center : [opts.location_center_lat, opts.location_center_long],
			dist: [opts.location_distance_lat,opts.location_distance_long]
		}
	}
	const lat = opts.location_center_lat || config.default_latitude;
	const long = opts.location_center_long || config.default_longitude;
	console.log("options: ",opts);
	const data = await getStuff(opts);
	if (!data) {
		response.send('No data  found <a href="javascript:history.back()">go back</a>');
	}
	else {
		const kmlFileName =  `output_${Date.now()}.kml`;
		const fname = `${__dirname}/out/${kmlFileName}`;
		let outputFilePath = outputFile(data, fname);
		let html = `Download <a href="${kmlFileName}">${kmlFileName}</a>`;
		html += getMapHtml({kml:kmlFileName, lat:lat, long: long, tiles:opts.tiles});
		response.send(html);
	}
});

app.listen(port, () => {
  console.log(`activities-map listening at http://localhost:${port}`)
})
