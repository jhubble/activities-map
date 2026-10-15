import { logger } from './loggerSetup.js';
import config from './config.js';
import printKml from './kmlExport.js';
import fs from 'fs';
import { readdir, stat, unlink, readFile, writeFile, rename, mkdir } from 'fs/promises';
import geoJSON from 'geojson';
import simplify from 'simplify-geojson';
import axios from 'axios';
import path from 'path';
import type { StravaActivity, StravaStream, ActivityFilterCounts, GetStuffOptions, GetStuffResult } from './types/index.js';

/*
 * StravaService
 * Encapsulates Strava API interactions, rate limiting, and activity cache management
 * to avoid global mutable state.
 */
export class StravaService {
	private maxTracks: number;
	private apiResetMinutes: number;
	private cacheDir: string;
	private outputDir: string;
	private tolerance: number;
	private called = 0;
	private skipped = 0;
	private calledTime = Date.now();
	private tokens: Record<string | number, string> = {};
	public readonly activityTypes = config.activity_types;

	constructor(customConfig = config) {
		this.maxTracks = customConfig.max_tracks_at_a_time || 550;
		this.apiResetMinutes = customConfig.API_RESET_TIME || 15;
		this.cacheDir = customConfig.cache_dir;
		this.outputDir = customConfig.output_dir;
		this.tolerance = customConfig.tolerance || 0.6;
	}

	public async ensureDirectories(): Promise<void> {
		if (!fs.existsSync(this.cacheDir)) {
			logger.info("Creating cache dir:", this.cacheDir);
			await mkdir(this.cacheDir, { recursive: true });
		}
		if (!fs.existsSync(this.outputDir)) {
			logger.info("Creating output dir:", this.outputDir);
			await mkdir(this.outputDir, { recursive: true });
		}
	}

	public checkAPIInterval(): void {
		const calledInterval = (Date.now() - this.calledTime) / (1000 * 60);
		logger.debug("Minutes since called count started ", calledInterval);
		if (calledInterval > this.apiResetMinutes) {
			logger.info("Restarting API call count");
			this.called = 0;
			this.calledTime = Date.now();
		}
	}

	public isRateLimitReached(): boolean {
		return this.called >= this.maxTracks;
	}

	public getCacheFileFromActivity(activity: { id: number | string }): string {
		return path.join(this.cacheDir, `${activity.id}.json`);
	}

	public getCacheListFilePath(): string {
		return path.join(this.cacheDir, "allActivities.json");
	}

	public async callStravaAPI(token: string | undefined, endpoint: string, opts?: Record<string, any>): Promise<any> {
		logger.debug("callStravaAPI with token:", token);
		const params = new URLSearchParams();
		if (opts) {
			for (const [key, value] of Object.entries(opts)) {
				if (value !== undefined && value !== null) {
					params.append(key, String(value));
				}
			}
		}

		const queryString = params.toString();
		const url = `https://www.strava.com/api/v3/${endpoint}${queryString ? `?${queryString}` : ''}`;

		try {
			const response = await axios.get(url, {
				headers: {
					'Authorization': `Bearer ${token}`,
				},
			});
			return response.data;
		} catch (error: any) {
			logger.error("Error in callStravaAPI", error?.message || error);
			if (axios.isAxiosError(error) && error.response && error.response.status === 401) {
				logger.error("Access token expired or invalid. Refresh token required.");
			}
			throw error;
		}
	}

	public async getTrackListPage({
		token,
		page = 1,
		trackList = [],
		fromStamp = 0,
		toStamp = Math.ceil(Date.now() / 1000),
		progress
	}: {
		token?: string;
		page?: number;
		trackList?: StravaActivity[];
		fromStamp?: number;
		toStamp?: number;
		progress?: (message: string) => void;
	} = {}): Promise<StravaActivity[]> {
		logger.debug("getTrackListPage, token:", token);
		logger.info("Page:", page, "activities:", trackList.length, "from:", fromStamp, "to:", toStamp);
		try {
			const payload = await this.callStravaAPI(token, "athlete/activities", {
				after: fromStamp,
				before: toStamp,
				per_page: 200,
				page: page
			});
			this.called += 1;
			if (payload && Array.isArray(payload) && payload.length) {
				trackList.push(...payload);
				progress?.(`Downloaded ${trackList.length} activities from Strava…`);
				trackList = await this.getTrackListPage({
					page: page + 1,
					trackList: trackList,
					fromStamp: fromStamp,
					toStamp: toStamp,
					token: token,
					progress
				});
			}
		} catch (e) {
			logger.error("ERROR getting activity list page:", e);
		}
		return trackList;
	}

	public async processActivity(
		activity: StravaActivity,
		token?: string,
		force: boolean = false,
		tolerance: number = this.tolerance,
		progress?: (message: string) => void
	): Promise<string> {
		logger.trace("Activity:", activity);
		this.checkAPIInterval();

		const id = activity.id;
		const trackCacheFile = this.getCacheFileFromActivity(activity);
		logger.debug("track cache file", trackCacheFile);
		let stream: StravaStream | null = null;

		if (!force && fs.existsSync(trackCacheFile)) {
			logger.debug("Reading cache file", trackCacheFile);
			progress?.(`Reading cached track for ${activity.name}…`);
			try {
				const fileData = await readFile(trackCacheFile, 'utf8');
				stream = JSON.parse(fileData);
			} catch (err) {
				logger.warn("Failed to read activity cache file, refetching:", err);
			}
		}

		if (!stream) {
			if (this.called >= this.maxTracks) {
				this.skipped++;
				logger.warn(`Skipping download for ${id} because calls (${this.called}) reached limit (${this.maxTracks})`);
			} else if (!activity.upload_id && (!activity.start_latlng || !activity.start_latlng.length)) {
				this.skipped++;
				logger.warn(`Not downloading ${id} (${activity.name}) because no start_latlng`);
			} else {
				progress?.(`Downloading GPS data for ${activity.name}…`);
				this.called++;
				logger.debug(`API Calls made: ${this.called}`);
				try {
					stream = await this.callStravaAPI(token, `activities/${activity.id}/streams`, {
						keys: "time,distance,latlng",
						resolution: "medium"
					});
					await writeFile(trackCacheFile, JSON.stringify(stream, null, 1), 'utf8');
					logger.info("Wrote stream cache file", trackCacheFile);
				} catch (err) {
					logger.error(`Failed to fetch stream for ${id}:`, err);
					throw err;
				}
			}
		}

		if (stream && Array.isArray(stream)) {
			const latlngList = stream.find((list: any) => list.type === 'latlng');
			if (!latlngList || !latlngList.data || !latlngList.data.length) {
				logger.warn(`No latlng points for activity: ${activity.id}: ${activity.name}`);
				return "NO DATA";
			}

			const coordinates = tolerance ? this.simplifyTrack(latlngList.data, tolerance) :
				latlngList.data.map((latlng: [number, number]) => `${latlng[1]},${latlng[0]},0`).join(' ');

			const trackTitle = `${activity.name} (${activity.type}) ${(activity.start_date_local || '').replace(/T.*$/, '')}`;
			return printKml.placemark(trackTitle, coordinates || '');
		}

		return "";
	}

	public simplifyTrack(data: [number, number][], tolerance: number): string | undefined {
		try {
			const toParse = [{ line: data.map(point => [point[1], point[0]]) }];
			const geoJsonTrack = geoJSON.parse(toParse, { 'LineString': 'line' });
			const simple = simplify(geoJsonTrack, tolerance / 10000);
			return simple.features[0].geometry.coordinates
				.map((point: [number, number]) => `${point[0]},${point[1]},0`)
				.join(' ');
		} catch (e) {
			logger.error("Error in simplifyTrack:", e);
		}
	}

	public async getStuff({
		type = '',
		checkForNewer = false,
		location = {},
		includePrivate = false,
		fromStamp,
		toStamp,
		token,
		tolerance,
		refresh = false,
		dedup = false
	}: GetStuffOptions = {}, progress?: (message: string) => void): Promise<GetStuffResult | undefined> {
		progress?.('Preparing cache directories…');
		await this.ensureDirectories();
		this.checkAPIInterval();
		let noDataTracks = 0;
		const effectiveTolerance = tolerance ?? null;

		if (fromStamp && typeof fromStamp === 'string' && /\D/.test(fromStamp.trim())) {
			fromStamp = (new Date(fromStamp)).getTime() / 1000;
			logger.info("fromStamp converted: ", fromStamp);
		}
		if (toStamp && typeof toStamp === 'string' && /\D/.test(toStamp.trim())) {
			toStamp = (new Date(toStamp)).getTime() / 1000;
			logger.info("toStamp converted: ", toStamp);
		}

		if (location?.center && location?.dist) {
			if (!location.min) {
				location.min = [(+location.center[0] - +location.dist[0]), (+location.center[1] - +location.dist[1])];
			}
			if (!location.max) {
				location.max = [(+location.center[0] + +location.dist[0]), (+location.center[1] + +location.dist[1])];
			}
		}

		const cacheListFile = this.getCacheListFilePath();
		try {
			let payload: StravaActivity[] = [];
			let last = 0;

			if (fs.existsSync(cacheListFile)) {
				try {
					progress?.('Reading the saved activity list…');
					const data = await readFile(cacheListFile, 'utf8');
					payload = JSON.parse(data);
				} catch (e) {
					logger.error("Error processing activity list cache. Initializing empty payload.", e);
				}
			}

			if (refresh && refresh !== 'false') {
				logger.info("Refreshing activities from time range");
				progress?.('Downloading the activity list from Strava…');
				const payloadMap: Record<number, number> = {};
				payload.forEach((el, index) => {
					payloadMap[el.id] = index;
				});

				const endTime = (typeof toStamp === 'number' ? toStamp : Number(toStamp)) || Date.now() / 1000;
				const startTime = (typeof fromStamp === 'number' ? fromStamp : Number(fromStamp)) || 0;
				const newPayload = await this.getTrackListPage({ token, fromStamp: startTime, toStamp: endTime, progress });

				for (let i = 0; i < newPayload.length; i++) {
					const activity = newPayload[i];
					const id = activity.id;
					const oldIndex = payloadMap[id];
					if (oldIndex !== undefined) {
						const oldActivity = payload[oldIndex];
						if (this.compareTrackMetaData(oldActivity, activity)) {
							logger.info(`Updating metadata & redownloading activity ${id}`);
							payload[oldIndex] = activity;
							await this.processActivity(activity, token, true, effectiveTolerance ?? undefined, progress);
						}
					} else {
						logger.info(`Activity "${id}" does not exist in cache. Downloading and adding.`);
						payload.push(activity);
						try {
							const full = await this.processActivity(activity, token, true, effectiveTolerance ?? undefined, progress);
							if (full === 'NO DATA') {
								noDataTracks++;
							}
						} catch (e) {
							logger.error(`Error processing activity ${id}:`, e);
						}
					}
				}

				payload.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
				payload = payload.filter((e, i, a) => e?.id !== a[i - 1]?.id);

				try {
					await rename(cacheListFile, `${cacheListFile}.${Date.now()}`);
				} catch (e) {
					logger.error("Unable to backup old cache file:", e);
				}
				await writeFile(cacheListFile, JSON.stringify(payload, null, 1), 'utf8');
				await this.cleanupOldActivityBackups();
			} else if (checkForNewer && checkForNewer !== 'false') {
				progress?.('Checking Strava for newer activities…');
				if (payload.length > 0 && payload[0].start_date) {
					try {
						last = Math.floor(new Date(payload[0].start_date).getTime() / 1000);
					} catch (e) {
						logger.error("Could not parse start_date for last timestamp", e);
					}
				}
				payload = await this.getTrackListPage({ token, trackList: payload, fromStamp: last, progress });
				payload.sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
				payload = payload.filter((e, i, a) => e?.id !== a[i - 1]?.id);

				try {
					await rename(cacheListFile, `${cacheListFile}.${Date.now()}`);
				} catch (e) {
					logger.error("Unable to backup old cache file:", e);
				}
				await writeFile(cacheListFile, JSON.stringify(payload, null, 1), 'utf8');
			}

			logger.info("Number of activities available:", payload.length);
			progress?.(`Filtering ${payload.length} activities and loading track data…`);
			const { trackData, activities, activityProcessCounts } = await this.filterAndProcessActivities({
				token,
				payload,
				type,
				location,
				includePrivate,
				fromStamp: fromStamp ? Number(fromStamp) : undefined,
				toStamp: toStamp ? Number(toStamp) : undefined,
				tolerance: effectiveTolerance ?? undefined,
				dedup,
				progress
			});

			activityProcessCounts.noDataTracks = (activityProcessCounts.noDataTracks || 0) + noDataTracks;
			const rateLimitReached = this.isRateLimitReached();
			progress?.('Activity data loaded. Preparing results…');
			activityProcessCounts.rateLimitReached = rateLimitReached;

			const kmlTrack = printKml.head("tracks") + trackData + printKml.tail(config.default_latitude, config.default_longitude);
			return { activities, kmlTrack, activityProcessCounts, rateLimitReached };
		} catch (e) {
			logger.error("Error in getStuff:", e);
		}
	}

	public async filterAndProcessActivities({
		token,
		payload,
		type = '',
		location = {},
		includePrivate = false,
		fromStamp,
		toStamp,
		tolerance,
		dedup,
		progress
	}: {
		token?: string;
		payload: StravaActivity[];
		type?: string;
		location?: GetStuffOptions['location'];
		includePrivate?: boolean | string;
		fromStamp?: number;
		toStamp?: number;
		tolerance?: number | null;
		dedup?: boolean | string;
		progress?: (message: string) => void;
	}): Promise<{
		trackData: string;
		activities: StravaActivity[];
		activityProcessCounts: ActivityFilterCounts;
	}> {
		let error = 0;
		let kmlTracks = '';
		let desiredActivities = payload;
		let noDataTracks = 0;
		const searchType = type ? this.activityTypes[type] : null;
		const activityProcessCounts: ActivityFilterCounts = {};
		activityProcessCounts.totalActivities = payload.length;

		if (searchType) {
			desiredActivities = desiredActivities.filter(a => searchType.includes(a.type));
			activityProcessCounts.byType = desiredActivities.length;
		}
		if (!includePrivate || includePrivate === 'false') {
			desiredActivities = desiredActivities.filter(a => !a.private);
			activityProcessCounts.nonPrivate = desiredActivities.length;
		}
		if (location?.min) {
			desiredActivities = desiredActivities.filter(a =>
				Boolean(a.start_latlng && a.start_latlng[0] > location.min![0] && a.start_latlng[1] > location.min![1])
			);
			activityProcessCounts.minlatlng = desiredActivities.length;
		}
		if (location?.max) {
			desiredActivities = desiredActivities.filter(a =>
				Boolean(a.start_latlng && a.start_latlng[0] < location.max![0] && a.start_latlng[1] < location.max![1])
			);
			activityProcessCounts.maxlatlng = desiredActivities.length;
		}
		if (fromStamp) {
			desiredActivities = desiredActivities.filter(a =>
				((new Date(a.start_date)).getTime() / 1000) >= fromStamp
			);
			activityProcessCounts.afterStartTime = desiredActivities.length;
		}
		if (toStamp) {
			desiredActivities = desiredActivities.filter(a =>
				((new Date(a.start_date)).getTime() / 1000) <= toStamp
			);
			activityProcessCounts.afterEndTime = desiredActivities.length;
		}
		if (dedup && dedup !== 'false') {
			const { filteredList, removalLogs } = dedupStravaDuplicates(desiredActivities);
			logger.info("Duplicates removed:", removalLogs.length);
			desiredActivities = filteredList;
			activityProcessCounts.afterDedup = desiredActivities.length;
		}

		let processed = 0;
		await Promise.all(desiredActivities.map(async (activity) => {
			if (!error) {
				try {
					const activityNumber = ++processed;
					progress?.(`Processing activity ${activityNumber} of ${desiredActivities.length}: ${activity.name}`);
					let trackData = await this.processActivity(activity, token, false, tolerance ?? undefined, progress);
					if (trackData === 'NO DATA') {
						noDataTracks++;
					} else if (trackData) {
						kmlTracks += trackData;
					}
				} catch (e: any) {
					this.skipped++;
					if (e?.statusCode !== 404) {
						logger.error("Error processing activity; throttling future requests:", e);
						error++;
					}
				}
			}
		}));

		activityProcessCounts.skipped = this.skipped;
		activityProcessCounts.noDataTracks = noDataTracks;
		return { trackData: kmlTracks, activities: desiredActivities, activityProcessCounts };
	}

	public compareTrackMetaData(oldTrack: StravaActivity, newTrack: StravaActivity): boolean {
		const oldKeys = Object.keys(oldTrack);
		const newKeys = Object.keys(newTrack);
		if (oldKeys.length !== newKeys.length) return true;

		return oldKeys.some(key => {
			if (key === 'kudos_count' || key === 'has_kudoed') return false;
			const oldVal = JSON.stringify(oldTrack[key]);
			const newVal = JSON.stringify(newTrack[key]);
			return oldVal !== newVal;
		});
	}

	public async cleanupOldActivityBackups(): Promise<void> {
		const KEEP_COUNT = 10;
		const prefix = "allActivities.json.";
		try {
			const files = await readdir(this.cacheDir);
			const matching: Array<{ path: string; mtimeMs: number }> = [];

			for (const file of files) {
				if (file.startsWith(prefix)) {
					const fullPath = path.join(this.cacheDir, file);
					try {
						const fileStat = await stat(fullPath);
						if (fileStat.isFile()) {
							matching.push({ path: fullPath, mtimeMs: fileStat.mtimeMs });
						}
					} catch {}
				}
			}

			if (matching.length <= KEEP_COUNT) return;
			matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
			const toDelete = matching.slice(KEEP_COUNT);

			for (const f of toDelete) {
				try {
					await unlink(f.path);
				} catch {}
			}
		} catch (err) {
			logger.warn("Error cleaning up activity backups:", err);
		}
	}

	public setToken(athleteId: number | string, token: string): void {
		this.tokens[athleteId] = token;
	}

	public getToken(athleteId: number | string): string | undefined {
		return this.tokens[athleteId];
	}
}

// Default singleton instance for simple exports
export const defaultStravaService = new StravaService();
export const TYPES = defaultStravaService.activityTypes;

export const getStuff = (opts: GetStuffOptions) => defaultStravaService.getStuff(opts);
export const callStravaAPI = (token: string | undefined, endpoint: string, opts?: Record<string, any>) =>
	defaultStravaService.callStravaAPI(token, endpoint, opts);
export const getCacheFileFromActivity = (activity: { id: number | string }) =>
	defaultStravaService.getCacheFileFromActivity(activity);

export const outputFile = async (data: string, fileName?: string): Promise<string> => {
	const outDir = config.output_dir;
	if (!fs.existsSync(outDir)) {
		await mkdir(outDir, { recursive: true });
	}
	const targetPath = fileName || path.join(outDir, `output_${Date.now()}.kml`);
	await writeFile(targetPath, data, 'utf8');
	logger.info("Wrote file:", targetPath);
	return targetPath;
};

export const getAuthURL = (post: string = "code"): string => {
	const authURL = `https://www.strava.com/oauth/authorize?client_id=${config.client_id}&response_type=code&redirect_uri=${config.redirect_uri}/${post}&scope=read,activity:read_all`;
	logger.info(`Strava auth url: ${authURL}`);
	return authURL;
};

export const getAuthToken = async (code: string): Promise<{ access_token: string; athleteID: number | null }> => {
	logger.info("Exchanging auth code with Strava");
	const response = await axios.post('https://www.strava.com/oauth/token', {
		client_id: config.client_id,
		client_secret: config.client_secret,
		code: code,
		grant_type: 'authorization_code'
	});

	const { access_token } = response.data;
	const athleteID = await getCurrentAthleteId(access_token);
	if (athleteID) {
		defaultStravaService.setToken(athleteID, access_token);
	}
	return { access_token, athleteID };
};

export async function getCurrentAthleteId(accessToken: string): Promise<number | null> {
	const athleteEndpoint = 'https://www.strava.com/api/v3/athlete';
	try {
		const response = await fetch(athleteEndpoint, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data: any = await response.json();
		return data.id || null;
	} catch (error) {
		logger.error('Failed to retrieve current athlete ID:', error);
		return null;
	}
}

export const dedupStravaDuplicates = (arr: StravaActivity[]): { filteredList: StravaActivity[]; removalLogs: any[] } => {
	const validItems = arr.filter(item => item.elapsed_time >= 400);
	const sorted = [...validItems].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

	const clusters: StravaActivity[][] = [];
	let currentCluster: StravaActivity[] = [];

	sorted.forEach((item) => {
		const itemTime = new Date(item.start_date).getTime();
		if (currentCluster.length === 0) {
			currentCluster.push(item);
		} else {
			const firstInClusterTime = new Date(currentCluster[0].start_date).getTime();
			if (itemTime - firstInClusterTime <= 300000) {
				currentCluster.push(item);
			} else {
				clusters.push(currentCluster);
				currentCluster = [item];
			}
		}
	});
	if (currentCluster.length > 0) clusters.push(currentCluster);

	const filteredList: StravaActivity[] = [];
	const removalLogs: any[] = [];

	clusters.forEach((cluster) => {
		const exemptItems = cluster.filter(item => (item.athlete_count ?? 1) <= 1);
		const candidateItems = cluster.filter(item => (item.athlete_count ?? 1) > 1);

		if (candidateItems.length > 0) {
			candidateItems.sort((a, b) => Number(a.private) - Number(b.private));
			const bestCandidate = candidateItems[0];
			const removedItems = candidateItems.slice(1);

			const keptItem: StravaActivity = {
				...bestCandidate,
				removed_count: removedItems.length
			};

			filteredList.push(keptItem);

			if (removedItems.length > 0) {
				removalLogs.push({
					kept: {
						name: keptItem.name,
						start_date: keptItem.start_date,
						private: keptItem.private,
						elapsed_time: keptItem.elapsed_time,
						removed_count: keptItem.removed_count
					},
					removed: removedItems.map(item => ({
						name: item.name,
						start_date: item.start_date,
						private: item.private,
						elapsed_time: item.elapsed_time
					}))
				});
			}
		}

		filteredList.push(...exemptItems);
	});

	filteredList.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
	return { filteredList, removalLogs };
};
