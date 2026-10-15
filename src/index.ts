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
import { renderUnifiedForm, renderMapHtml, renderStatsHtml } from './views/templates.js';

logger.info("starting activities-map application");
const app = express();
const port = config.run_on_port || 8080;
const foot = config.activity_types.Foot || []; // Run, Walk, Hike
const __dirname = packageDirectorySync() || process.cwd();
const outDir = path.resolve(__dirname, 'out');
const jobProgress = new Map<string, string>();
app.use((request: Request, response: Response, next) => {
	response.on('finish', () => {
		const jobId = typeof request.query.jobId === 'string' ? request.query.jobId : undefined;
		if (jobId) jobProgress.delete(jobId);
	});
	next();
});

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
	fromStamp: { default: `${new Date().getFullYear()}-01-01`, note: "time parsable by JS in locale or unix timestamp (1694822400 is 2023-09-16)" },
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
	return `<label for="${escapeHtml(optionKey)}">${escapeHtml(name || optionKey)}</label>`;
};

const outputArrayValues = (optionKey: string, optionValue: any[], name?: string, note?: string): string => {
	let html = `<div class="form-group">`;
	html += outputLabel(optionKey, name);
	html += `<select id="${escapeHtml(optionKey)}" class="form-control" name="${escapeHtml(optionKey)}">`;
	html += optionValue.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
	html += "</select>";
	if (note) {
		html += `<span class="note">${escapeHtml(note)}</span>`;
	}
	html += "</div>";
	return html;
};

const processOption = (optionKey: string, optionValue: OptionConfig): string => {
	if (Array.isArray(optionValue)) {
		return outputArrayValues(optionKey, optionValue);
	}
	if (typeof optionValue === 'string') {
		return `<div class="form-group">
			<label for="${escapeHtml(optionKey)}">${escapeHtml(optionKey)}</label>
			<input type="text" id="${escapeHtml(optionKey)}" class="form-control" name="${escapeHtml(optionKey)}" value="${escapeHtml(optionValue)}">
		</div>`;
	}
	if (typeof optionValue === 'object' && optionValue !== null) {
		if (Array.isArray(optionValue.values)) {
			return outputArrayValues(optionKey, optionValue.values, optionValue.name, optionValue.note);
		} else {
			const inputKey = optionValue.key || optionKey;
			return `<div class="form-group">
				<label for="${escapeHtml(inputKey)}">${escapeHtml(optionValue.name || optionKey)}</label>
				<input type="text" id="${escapeHtml(inputKey)}" class="form-control" name="${escapeHtml(inputKey)}" value="${escapeHtml(optionValue.default || '')}">
				${optionValue.note ? `<span class="note">${escapeHtml(optionValue.note)}</span>` : ''}
			</div>`;
		}
	}
	return '';
};

const processOptions = (options: Record<string, OptionConfig>): string => {
	const html = Object.entries(options).map(o => processOption(o[0], o[1]));
	return html.join('\n');
};

const getOptionForm = (token?: string, athleteid?: number | string, refresh: boolean = false, authError?: string): string => {
	const authUrl = getAuthURL("coderefresh");
	logger.info("Rendering option form with token:", token ? "(present)" : "(none)");
	const options: Record<string, OptionConfig> = JSON.parse(JSON.stringify(OPTIONS));
	if (!token) {
		options.checkForNewer = [false, true];
	}
	const htmlOptions = processOptions(options);
	return renderUnifiedForm({ htmlOptions, authUrl, token, athleteid, refresh, authError });
};

const getAuthErrorMessage = (error: unknown): string => {
	const responseData = (error as { response?: { data?: { message?: string; errors?: unknown } }; message?: string })?.response?.data;
	const details = Array.isArray(responseData?.errors)
		? responseData.errors.map((item: unknown) => {
			const detail = item as { field?: string; code?: string; resource?: string };
			return [detail.resource, detail.field, detail.code].filter(Boolean).join(' ');
		}).filter(Boolean).join('; ')
		: responseData?.errors && typeof responseData.errors === 'object'
			? Object.entries(responseData.errors).map(([field, reason]) => `${field}: ${String(reason)}`).join('; ')
			: '';
	const stravaMessage = [responseData?.message, details].filter(Boolean).join(' — ');
	if (stravaMessage) return `Strava rejected the authorization: ${stravaMessage}`;
	const status = (error as { response?: { status?: number } })?.response?.status;
	return status ? `Strava token exchange failed (HTTP ${status}). Please reconnect with Strava and try again.` : 'Could not complete Strava authorization. Please reconnect with Strava and try again.';
};

// default entry point - shows unified main form with integrated auth status
app.get('/', (request: Request, response: Response) => {
	const token = request.query?.token as string | undefined;
	const athleteid = request.query?.athleteid as string | undefined;
	response.send(getOptionForm(token, athleteid));
});

app.get('/formClient.js', (_req: Request, res: Response) => {
	logger.info("serving form client");
	// TypeScript builds the browser client into dist, while `npm start` serves
	// the plain JavaScript source directly.
	const sourceClient = path.join(__dirname, 'src/formClient.js');
	const builtClient = path.join(__dirname, 'dist/formClient.js');
	// Prefer the source client so a stale build cannot silently omit form
	// persistence changes when running the app from the repository.
	res.sendFile(fs.existsSync(sourceClient) ? sourceClient : builtClient);
});

app.get('/code', (request: Request, response: Response) => {
	const code = request.query?.code as string | undefined;
	logger.info("Calling /code with authorization code", code ? "(present)" : "(missing)");
	if (!code) {
		response.send(getOptionForm());
	} else {
		getAuthToken(code).then(({ access_token, athleteID }) => {
			logger.info("Got token", access_token, "athleteid", athleteID);
			response.send(getOptionForm(access_token, athleteID ?? undefined));
		}).catch((e) => {
			logger.error("Strava authorization failed", e?.message || e);
			response.send(getOptionForm(undefined, undefined, false, getAuthErrorMessage(e)));
		});
	}
});

app.get('/coderefresh', (request: Request, response: Response) => {
	const code = request.query?.code as string | undefined;
	logger.info("Calling /coderefresh with authorization code", code ? "(present)" : "(missing)");
	if (!code) {
		response.send(getOptionForm());
	} else {
		getAuthToken(code).then(({ access_token, athleteID }) => {
			logger.info("Got token", access_token, "athleteid", athleteID);
			response.send(getOptionForm(access_token, athleteID ?? undefined, true));
		}).catch((e) => {
			logger.error("Strava authorization failed", e?.message || e);
			response.send(getOptionForm(undefined, undefined, false, getAuthErrorMessage(e)));
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
	const jobId = typeof request.query.jobId === 'string' ? request.query.jobId : undefined;
	const data = await defaultStravaService.getStuff(opts, jobId ? (message) => jobProgress.set(jobId, message) : undefined);
	logger.trace("DATA", data);
	if (!data) {
		response.send('No data found <a href="javascript:history.back()">go back</a>');
		return false;
	} else {
		return { data, opts, lat, long };
	}
};

app.get('/progress/:jobId', (request: Request, response: Response) => {
	const jobId = String(request.params.jobId || '');
	response.json({ message: jobProgress.get(jobId) || 'Starting…' });
});

// process will take options from query string
app.get('/process', async (request: Request, response: Response) => {
	const jobId = typeof request.query.jobId === 'string' ? request.query.jobId : undefined;
	logger.info("Generating map", jobId ? `job ${jobId}` : "without job id");
	try {
		const result = await _getInitialData(request, response);
		if (!result) return;
		const { data, opts, lat, long } = result;
		const tolerance = opts.tolerance ? opts.tolerance / 10000 : 0.00006;
		logger.info("TOLERANCE", opts.tolerance, " - adjusted value used:", tolerance);
		
		const activities = data.activities;
		const showHulls = opts?.showHulls === 'true';
		const fileList = activities.map(activity => defaultStravaService.getCacheFileFromActivity(activity));
		if (jobId) jobProgress.set(jobId, showHulls ? 'Calculating activity hulls and spatial relationships…' : 'Preparing the map and track files…');
		const hulls = showHulls ? await getSpatialAnalysis(fileList, 0.11, tolerance, jobId ? (message) => jobProgress.set(jobId, message) : undefined) : null;
		const hullsGeoJson = hulls?.geoJSON;
		const kmlTrack = data.kmlTrack;

		if (!kmlTrack) {
			response.send('No track data was produced. <a href="javascript:history.back()">Go back</a>');
			return;
		}

		const outputDate = `output_${Date.now()}`;
		const kmlFileName = `${outputDate}.kml`;
		const hullGeoJsonFileName = showHulls ? `hull_${outputDate}.geojson` : null;
		const hullGeoJsonFullPath = hullGeoJsonFileName ? path.join(outDir, hullGeoJsonFileName) : null;
		const tracksFullPath = path.join(outDir, kmlFileName);

		if (jobId) jobProgress.set(jobId, 'Writing map and GeoJSON files…');
		await outputFile(kmlTrack, tracksFullPath);
		if (hullsGeoJson && hullGeoJsonFullPath) {
			await outputFile(JSON.stringify(hullsGeoJson, null, 2), hullGeoJsonFullPath);
		}

		let html = `Download tracks: <a href="/${escapeHtml(kmlFileName)}">${escapeHtml(kmlFileName)}</a>`;
		const statsParams = new URLSearchParams();
		for (const [key, value] of Object.entries(request.query)) {
			if (key === 'jobId' || typeof value !== 'string') continue;
			statsParams.set(key, value);
		}
		const statsUrl = `/stats?${statsParams.toString()}`;
		html += renderMapHtml({
			kml: kmlFileName,
			lat,
			long,
			tiles: opts.tiles,
			geoJson: hullGeoJsonFileName,
			rateLimitReached: data.rateLimitReached,
			statsUrl
		});
		response.send(html);
	} catch (error) {
		logger.error("Map generation failed", error);
		if (!response.headersSent) {
			response.status(500).send(`<h1>Map generation failed</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><p><a href="javascript:history.back()">Go back</a></p>`);
		}
	} finally {
		if (jobId) jobProgress.delete(jobId);
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
		const jobId = typeof request.query.jobId === 'string' ? request.query.jobId : undefined;
		if (jobId) jobProgress.set(jobId, 'Calculating statistics and building the activity table…');
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
		if (jobId) jobProgress.delete(jobId);
	}
});

app.listen(port, () => {
  logger.info(`activities-map listening at http://localhost:${port}`);
});
