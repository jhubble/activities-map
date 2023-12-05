import tj from '@mapbox/togeojson';
import fs from 'fs';
import { DOMParser } from 'xmldom';

export const getGeoJsonFromFile = (kmlfile) => {
	var kml = new DOMParser().parseFromString(fs.readFileSync(kmlfile, 'utf8'));

	var converted = tj.kml(kml);
	return converted;
}

export const getGeoJsonFromString = (kmlString) => {
	var kml = new DOMParser().parseFromString(kmlString);

	var converted = tj.kml(kml);
	return converted;
}

