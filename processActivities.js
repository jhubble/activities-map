let gpxParser = require('gpxparser');
let simplify = require('simplify-geojson');

let fs = require('fs');
let printKml = require('./kmlExport');

// Tolerance is divided by 10,000
// 10 is about one city block
// higher number is more smoothing (smaller file, lower accuracy)
// 2 - simplest. Gets most locations with some smoothing
//
// .3 - gets GPS gitters
// .5 - some curves without many gitters
// 1 - good layout. Eliminates most jitters, but also misses some curves
// .5 - 1 seem the best range
const tolerance = .6;

const processGpx = (fname) => {
	const gpxData = fs.readFileSync(fname).toString();
	var gpx = new gpxParser(); //Create gpxParser Object

	gpx.parse(gpxData); //parse gpx file from string data

	var totalDistance = gpx.tracks[0].distance.total;

	const time = gpx.metadata.time;
	const track = gpx.tracks[0];
	const type = track.type;

	console.error(time, type);


	const name = track.name;
	const points = track.points;
	//console.log(printKml.head(name));

	let geoJSON = gpx.toGeoJSON();
	//console.log(geoJSON.features[0].geometry);


	const simple = simplify(geoJSON,tolerance / 10000);

	//console.log("SIMPLE",simple.features[0].geometry);
	coordinates = simple.features[0].geometry.coordinates
		.map((point) => { // only have lat and long
			return `${point[0]},${point[1]},0`
		}
	)
	.join(' ');
	return (printKml.placemark(track.name,coordinates));
}

if (process.argv.length > 2) {
	let out = printKml.head("tracks");
	for (let i=2;i<process.argv.length; i++) {
		out += processGpx(process.argv[i]);	
        }
	out += printKml.tail();
	process.stdout.write(out);
}

else {
	console.error("Usage: node gpxToJson.js gpx...");
}
