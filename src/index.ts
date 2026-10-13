import express from 'express';
import type { Request, Response } from 'express';
import { packageDirectorySync } from 'package-directory';
import { logger } from './loggerSetup.js';
import path from 'path';
import fs from 'fs';
import { defaultStravaService, outputFile, getAuthURL, getAuthToken, TYPES } from './getStravaActivities.js';
import { getGeoJsonFromFile } from './kmlToGeoJson.js';
import { getSpatialAnalysis } from './stravaToGeoJSONAndHull.js';
import config from './config.js';
import type { StravaActivity, GetStuffOptions, GetStuffResult } from './types/index.js';
import { escapeHtml } from './utils/html.js';
import { renderHomePage, renderOptionsForm, renderMapHtml, renderStatsHtml } from './views/templates.js';

logger.info("starting activities-map application");
const app = express();
const port = config.run_on_port || 8080;
const foot = config.activity_types.Foot || []; // Run, Walk, Hike
const __dirname = packageDirectorySync() || process.cwd();
const outDir = path.resolve(__dirname, 'out');

logger.trace("dirname:", __dirname);

function metersToMiles(meters: number): number {
  const miles = meters / 1609.344;
  return Math.floor(miles * 100) / 100;
}

const toHours = (seconds: number): string => {
	return (seconds / 60 / 60).toFixed(2);
};

interface OptionConfigObject {
	values?: any[];
	name?: string;
	key?: string;
	default?: any;
	note?: string;
}

type OptionConfig = any[] | string | OptionConfigObject;

const OPTIONS: Record<string, OptionConfig> = {
	type: Object.keys(TYPES),
	checkForNewer: [true, false],
	includePrivate: [false, true],
	refresh: { values: [false, true], note: 'Re-read all metadata and reload those that are changed' },
	fromStamp: { default: '2024-01-15', note: "time parsable by JS in locale or unix timestamp (1694822400 is 2023-09-16)" },
	toStamp: '',
	center_lat: { name: "Center Latitude", key: "location_center_lat", default: config.default_latitude },
	center_lng: { name: "Center Longitude", key: "location_center_long", default: config.default_longitude },
	lat_dist: { name: "Latitude distance", key: "location_distance_lat", default: config.location_distance_lat },
	long_dist: { name: "Longitude distance", key: "location_distance_long", default: config.location_distance_long },
	tiles: ['osm', 'none'],
	showHulls: { values: [true, false], note: 'Will draw convex hulls around connected regions. Can take a long time with large data sets' },
	dedup: { values: [true, false], note: 'Dedup duplicate activities. (If activities start at same time and Strava ideitifies multiple athletes)' },
	tolerance: { default: config.tolerance, name: "Tolerance", key: "tolerance", note: "higher number=lower accuracy, smaller file. .5-1 is best, 10 is one city block, 0 is no smoothing" } 
};

const outputLabel = (optionKey: string, name?: string): string => {
	return `<label>${escapeHtml(name || optionKey)}</label>:`;
};

const outputArrayValues = (optionKey: string, optionValue: any[], name?: string): string => {
	let html = outputLabel(optionKey, name);
	html += `<select name="${escapeHtml(optionKey)}">`;
	html += optionValue.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
	html += "</select>";
	return html;
};

const processOption = (optionKey: string, optionValue: OptionConfig): string => {
	if (Array.isArray(optionValue)) {
		return outputArrayValues(optionKey, optionValue);
	}
	if (typeof optionValue === 'string') {
		return `<label>${escapeHtml(optionKey)}</label>: <input type="text" name="${escapeHtml(optionKey)}" value="${escapeHtml(optionValue)}"></input>`;
	}
	if (typeof optionValue === 'object' && optionValue !== null) {
		let html = '';
		if (Array.isArray(optionValue.values)) {
			html += outputArrayValues(optionKey, optionValue.values, optionValue.name);
		} else {
			html = outputLabel(optionKey, optionValue.name);
			html += `<input type="text" name="${escapeHtml(optionValue.key || optionKey)}" value="${escapeHtml(optionValue.default)}"></input>`;
		}
		html += `<span> ${escapeHtml(optionValue.note || '')}</span>`;
		return html;
	}
	return '';
};

const processOptions = (options: Record<string, OptionConfig>): string => {
	const html = Object.entries(options).map(o => processOption(o[0], o[1]));
	return html.join('<br>');
};

// default entry point - shows static home page
app.get('/', (_request: Request, response: Response) => {
	const authUrl = getAuthURL();
	response.send(renderHomePage(authUrl));
});

const getOptionForm = (token?: string, athleteid?: number | string, refresh: boolean = false): string => {
	const authUrl = getAuthURL("coderefresh");
	logger.info("Token from options form:", token);
	const options: Record<string, OptionConfig> = JSON.parse(JSON.stringify(OPTIONS));
	if (!token) {
		options.checkForNewer = [false, true];
	}
	const htmlOptions = processOptions(options);
	return renderOptionsForm(htmlOptions, authUrl, token, athleteid, refresh);
};

app.get('/formClient.js', (_req: Request, res: Response) => {
	logger.info("serving form client");
	res.sendFile(path.join(__dirname, 'src/formClient.js'));
});

app.get('/code', (request: Request, response: Response) => {
	const code = request.query?.code as string | undefined;
	logger.info("Calling /code with code", code);
	if (!code) {
		response.send(getOptionForm());
	} else {
		getAuthToken(code).then(({ access_token, athleteID }) => {
			logger.info("Got token", access_token, "athleteid", athleteID);
			response.send(getOptionForm(access_token, athleteID ?? undefined));
		}).catch(() => {
			response.send(getOptionForm());
		});
	}
});

app.get('/coderefresh', (request: Request, response: Response) => {
	const code = request.query?.code as string | undefined;
	logger.info("Calling /coderefresh with code", code);
	if (!code) {
		response.send(getOptionForm());
	} else {
		getAuthToken(code).then(({ access_token, athleteID }) => {
			logger.info("Got token", access_token, "athleteid", athleteID);
			response.send(getOptionForm(access_token, athleteID ?? undefined, true));
		}).catch((e) => {
			logger.error("error with token", e);
			response.send(getOptionForm());
		});
	}
});

// /map will load html with a map optionally substituted in
app.get('/map/:kml?', (request: Request, response: Response) => {
	const kmlfile = request.params?.kml as string | undefined;
	const tiles = (request.query?.tiles as string) || 'osm';
	const leaflet = renderMapHtml({ kml: kmlfile, lat: config.default_latitude, long: config.default_longitude, tiles: tiles });
	response.send(leaflet);
});

// takes in a kml or geojson file and returns its data with path traversal protection
app.get('/geojson/:outfile', (request: Request, response: Response) => {
	const rawOutfile = String(request.params.outfile || '');
	// Prevent path traversal by extracting only the basename
	const safeBaseName = path.basename(rawOutfile);
	const filePath = path.resolve(outDir, safeBaseName);

	// Ensure the file is strictly inside outDir
	if (!filePath.startsWith(outDir)) {
		logger.warn("Potential path traversal blocked:", rawOutfile);
		response.status(403).send("Forbidden");
		return;
	}

	if (!fs.existsSync(filePath)) {
		response.status(404).send("File not found");
		return;
	}

	if (/^output_\d+\.kml$/.test(safeBaseName)) {
		logger.info("Serving KML converted to GeoJSON:", safeBaseName);
		const geoJson = getGeoJsonFromFile(filePath);
		response.json(geoJson);
	} else if (/\.geojson$/.test(safeBaseName)) {
		logger.info("Serving GeoJSON file:", safeBaseName);
		response.sendFile(filePath);
	} else {
		response.sendFile(filePath);
	}
});

// all kml files produced served from out/
app.use(express.static('out'));

// leaflet source files
app.use('/leaflet', express.static('node_modules/leaflet/dist'));

// css and other misc
app.use('/assets', express.static('src/assets'));

interface InitialDataResult {
	data: GetStuffResult;
	opts: GetStuffOptions;
	lat: string;
	long: string;
}

const _getInitialData = async (request: Request, response: Response): Promise<InitialDataResult | false> => {
	const opts: GetStuffOptions = { ...request.query };
	if (opts.location_distance_lat && opts.location_distance_long) {
		opts.location = {
			center: [opts.location_center_lat || config.default_latitude, opts.location_center_long || config.default_longitude],
			dist: [opts.location_distance_lat, opts.location_distance_long]
		};
	}
	const lat = opts.location_center_lat || config.default_latitude;
	const long = opts.location_center_long || config.default_longitude;
	logger.debug("options: ", opts);
	const data = await defaultStravaService.getStuff(opts);
	logger.trace("DATA", data);
	if (!data) {
		response.send('No data found <a href="javascript:history.back()">go back</a>');
		return false;
	} else {
		return { data, opts, lat, long };
	}
};

// process will take options from query string
app.get('/process', async (request: Request, response: Response) => {
	const result = await _getInitialData(request, response);
	if (result) {
		const { data, opts, lat, long } = result;
		const tolerance = opts.tolerance ? opts.tolerance / 10000 : 0.00006;
		logger.info("TOLERANCE", opts.tolerance, " - adjusted value used:", tolerance);
		
		const activities = data.activities;
		const showHulls = opts?.showHulls === 'true';
		const fileList = activities.map(activity => defaultStravaService.getCacheFileFromActivity(activity));
		const hulls = showHulls ? getSpatialAnalysis(fileList, 0.11, tolerance) : null;
		const hullsGeoJson = hulls?.geoJSON;
		const kmlTrack = data.kmlTrack;

		if (!kmlTrack) {
			response.send('No data found <a href="javascript:history.back()">go back</a>');
		} else {
			const outputDate = `output_${Date.now()}`;
			const kmlFileName = `${outputDate}.kml`;
			const hullGeoJsonFileName = showHulls ? `hull_${outputDate}.geojson` : null;

			const hullGeoJsonFullPath = hullGeoJsonFileName ? path.join(outDir, hullGeoJsonFileName) : null;
			const tracksFullPath = path.join(outDir, kmlFileName);

			await outputFile(kmlTrack, tracksFullPath);
			if (hullsGeoJson && hullGeoJsonFullPath) {
				await outputFile(JSON.stringify(hullsGeoJson, null, 2), hullGeoJsonFullPath);
			}

			let html = `Download tracks: <a href="/${escapeHtml(kmlFileName)}">${escapeHtml(kmlFileName)}</a>`;
			html += renderMapHtml({
				kml: kmlFileName,
				lat: lat,
				long: long,
				tiles: opts.tiles,
				geoJson: hullGeoJsonFileName,
				rateLimitReached: data.rateLimitReached
			});
			response.send(html);
		}
	}
});

const getDaysInMonth = (monthYearStr: string): number => {
  const [monthStr, yearStr] = monthYearStr.split(' ');
  const month = new Date(`${monthStr} 1, ${yearStr}`).getMonth();
  const year = parseInt(yearStr, 10);

  const now = new Date();
  const currentYear = `${now.getFullYear()}`;
  const currentMonth = now.toLocaleString('default', { month: 'short' });
  if (monthStr === currentMonth && String(yearStr) === currentYear) {
	return now.getDate();
  }
  return new Date(year, month + 1, 0).getDate();
};

interface BucketStats {
	elapsed: number;
	moving: number;
	distance: number;
	climb: number;
	steps?: number;
}

app.get('/stats', async (request: Request, response: Response) => {
	logger.info("Generating stats page");
	const req = { ...request } as Request;
	req.query = { ...request.query, stats: 'true' };
	const result = await _getInitialData(req, response);
	const badGear: StravaActivity[] = [];
	const types: Record<string, number> = {};
	const buckets: Record<string, BucketStats> = {};
	const dayBuckets: Record<string, BucketStats> = {};

	if (result) {
		const { data } = result;
		const { activities, activityProcessCounts } = data;
		let elapsed = 0;
		let moving = 0;
		let earliest: number | null = null;
		let latest: number | null = null;
		let tracksHtml = `<table class="styled-table"><thead><tr><td>date</td><td>moving time</td><td>elapsed time</td><td>distance</td><td>elevation</td><td>track name</td></tr></thead><tbody>`;
		const trackArray: string[] = [];
		const badGPS: string[] = [];

		activities.forEach(track => {
			elapsed += track.elapsed_time;
			moving += track.moving_time;
			const startDate = Date.parse(track.start_date);
			const trackName = `<a target="_blank" href="https://www.strava.com/activities/${track.id}">${escapeHtml(track.name)}</a>`;
			let goodGPS = true;
			if (!track.start_latlng && !track.upload_id) {
				goodGPS = false;
			}
			const title = track.removed_count ? `title="${track.removed_count} duplicate similar tracks removed"` : '';
			trackArray.push(`<tr class="${goodGPS ? 'goodgps' : 'badgps'} ${track.removed_count ? 'removed-items' : ''}" ${title} ><td>${new Date(startDate).toLocaleString()}</td><td>${toHours(track.moving_time)}</td><td>${toHours(track.elapsed_time)}</td><td>${metersToMiles(track.distance)}</td><td>${Math.trunc(track.total_elevation_gain * 3.28084)}</td><td>${trackName}</td></tr>`);

			if (!goodGPS) {
				badGPS.push(trackName);
			}
			const bucket = new Date(track.start_date).toLocaleString('default', { month: 'short', year: 'numeric' });
			const dayBucket = new Date(track.start_date).toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' });
			if (!Object.prototype.hasOwnProperty.call(buckets, bucket)) {
				buckets[bucket] = { elapsed: 0, moving: 0, distance: 0, climb: 0 };
			}
			buckets[bucket].elapsed += track.elapsed_time;
			buckets[bucket].moving += track.moving_time;

			if (!Object.prototype.hasOwnProperty.call(dayBuckets, dayBucket)) {
				dayBuckets[dayBucket] = { elapsed: 0, moving: 0, distance: 0, climb: 0 };
			}
			dayBuckets[dayBucket].elapsed += track.elapsed_time;
			dayBuckets[dayBucket].moving += track.moving_time;

			if (foot.includes(track.type)) {
				buckets[bucket].steps = (buckets[bucket].steps || 0) + (track.steps || 0);
				dayBuckets[dayBucket].steps = (dayBuckets[dayBucket].steps || 0) + (track.steps || 0);
			}

			buckets[bucket].distance += track.distance;
			buckets[bucket].climb += track.total_elevation_gain;
			dayBuckets[dayBucket].distance += track.distance;
			dayBuckets[dayBucket].climb += track.total_elevation_gain;

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

		tracksHtml += trackArray.reverse().join('\n');
		tracksHtml += '</tbody></table>';

		const html = renderStatsHtml({
			activities,
			activityProcessCounts,
			elapsed,
			moving,
			earliest,
			latest,
			tracksHtml,
			badGPS,
			badGear,
			types,
			buckets,
			dayBuckets,
			rateLimitReached: data.rateLimitReached
		}, getDaysInMonth, metersToMiles);

		response.send(html);
	}
});

app.listen(port, () => {
  logger.info(`activities-map listening at http://localhost:${port}`);
});
