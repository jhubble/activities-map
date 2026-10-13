import tj from '@mapbox/togeojson';
import { logger } from './loggerSetup.js';
import fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';
export const getGeoJsonFromFile = (kmlfile: string): GeoJSON.FeatureCollection => {
	logger.debug("geoJson from file", kmlfile);
	const kml = new DOMParser().parseFromString(fs.readFileSync(kmlfile, 'utf8'));

	const converted = tj.kml(kml);
	return converted;
};

export const getGeoJsonFromString = (kmlString: string): GeoJSON.FeatureCollection => {
	logger.debug("geoJson from string", kmlString);
	const kml = new DOMParser().parseFromString(kmlString);

	const converted = tj.kml(kml);
	return converted;
};
