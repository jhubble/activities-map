import tj from '@mapbox/togeojson';
import { logger } from './loggerSetup.mjs';
import fs from 'fs';
import { DOMParser } from 'xmldom';

export const getGeoJsonFromFile = (kmlfile) => {
	logger.debug("geoJson from file",kmlfile);
	var kml = new DOMParser().parseFromString(fs.readFileSync(kmlfile, 'utf8'));

	var converted = tj.kml(kml);
	return converted;
}

export const getGeoJsonFromString = (kmlString) => {
	logger.debug("geoJson from string", kmlString);
	var kml = new DOMParser().parseFromString(kmlString);

	var converted = tj.kml(kml);
	return converted;
}

