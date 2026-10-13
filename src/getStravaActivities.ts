import { logger } from './loggerSetup.js';
import config from './config.js';
import printKml from './kmlExport.js';
import fs from 'fs';
import geoJSON from 'geojson';
import simplify from 'simplify-geojson';
import axios from 'axios';
import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import type { StravaActivity, ActivityFilterCounts, GetStuffOptions, GetStuffResult } from './types/index.js';

// Todo: have index of strava tokens to users (not yet implemented)
const stravaTokens: Record<string | number, string> = {};
/*
 * getStravaActivities
 * Gets all Strava Activities via Strava API and produces a kml
 * Google my Maps has 5 MB limit for kml size limit.
 * Simplifying the track helps reduce GPS "flutter" and reduce size
 * limiting the geography region also helps
 */

// usually overwritten by param value
const TOLERANCE = config.tolerance || .6;

const CACHE_DIR = config.cache_dir;
const OUTPUT_DIR = config.output_dir;
const ACTIVITY_LIST_CACHE_NAME = "allActivities.json";
const ACTIVITY_LIST_CACHE_FILE = `${CACHE_DIR}/${ACTIVITY_LIST_CACHE_NAME}`;
if (!fs.existsSync(CACHE_DIR)) {
	logger.info("Creating cache dir:", CACHE_DIR);
	fs.mkdirSync(CACHE_DIR);
}
if (!fs.existsSync(OUTPUT_DIR)) {
	logger.info("Creating output dir:", OUTPUT_DIR);
	fs.mkdirSync(OUTPUT_DIR);
}
const MAX_TRACKS = config.max_tracks_at_a_time || 550;

const API_RESET_TIME = config.API_RESET_TIME || 15;
let called = 0;
let skipped = 0;
let calledTime = Date.now();

const checkAPIInterval = (): void => {
	const calledInterval = (Date.now() - calledTime) / (1000 * 60);
	logger.debug("Minutes since called count started ", calledInterval);
	if (calledInterval > API_RESET_TIME) {
		logger.info("restarting API count count");
		called = 0;
		calledTime = Date.now();
	}
};

export const TYPES = config.activity_types;

interface TrackListPageParams {
	token?: string;
	page?: number;
	trackList?: StravaActivity[];
	fromStamp?: number;
	toStamp?: number;
}

// Recursively get all activities within a time range
const getTrackListPage = async ({
	token,
	page = 1,
	trackList = [],
	fromStamp = 0,
	toStamp = Math.ceil(Date.now() / 1000)
}: TrackListPageParams = {}): Promise<StravaActivity[]> => {
	logger.debug("getTrackListPage, token:", token);
	logger.info("Page:", page, "activities:", trackList.length, "from:", fromStamp, "to:", toStamp);
	try {
		const payload = await callStravaAPI(token, "athlete/activities", { id: 373707, after: fromStamp, before: toStamp, per_page: 200, page: page });
		called += 1;
		if (payload && Array.isArray(payload) && payload.length) {
			trackList.push(...payload);
			trackList = await getTrackListPage({ page: page + 1, trackList: trackList, fromStamp: fromStamp, toStamp: toStamp, token: token });
		}
	}
	catch (e) {
		logger.error("ERROR getting list:", e);
	}
	return trackList;
};

const compareTrackMetaData = (oldTrack: StravaActivity, newTrack: StravaActivity): boolean => {
	// true means they are different
	const oldKeys = Object.keys(oldTrack);
	const newKeys = Object.keys(newTrack);
	if (oldKeys.length !== newKeys.length) {
		logger.info("different key length in track arrays", oldKeys.length, newKeys.length);
		return true;
	}
	return oldKeys.some(oldKey => {
		// Don't update just because kudos changed
		if (oldKey === 'kudos_count' || oldKey === 'has_kudoed') {
			return false;
		}
		const oldVal = JSON.stringify(oldTrack[oldKey]);
		const newVal = JSON.stringify(newTrack[oldKey]);
		if (oldVal !== newVal) {
			logger.info(`${oldTrack.id} ${oldTrack.name} ${oldKey} is different: ${oldVal} != ${newVal}`);
			return true;
		}
		return false;
	});
};

export const getStuff = async ({
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
}: GetStuffOptions = {}): Promise<GetStuffResult | undefined> => {
	let noDataTracks = 0;
	logger.debug(`getStuff: type: ${type}, checkForNewer: ${checkForNewer}, location: ${JSON.stringify(location)}, includePrivate: ${includePrivate}, fromStamp: ${fromStamp}, toStamp: ${toStamp}, token: ${token}, tolerance: ${tolerance}, refresh: ${refresh}`);
	checkAPIInterval();
	logger.info("TOLERANCE", tolerance);
	if (!tolerance) {
		tolerance = null;
	}
	// If we have non-numeric in date, try to convert it
	if (fromStamp && typeof fromStamp === 'string' && /\D/.test(fromStamp.trim())) {
		fromStamp = (new Date(fromStamp)).getTime() / 1000;
		logger.info("fromStamp converted: ", fromStamp);
	}
	if (toStamp && typeof toStamp === 'string' && /\D/.test(toStamp.trim())) {
		toStamp = (new Date(toStamp)).getTime() / 1000;
		logger.info("toStamp converted: ", toStamp);
	}
	logger.info("TOKEN:", token);
	// Now we just pass around the token

	// structure the lat/long in the format we use
	if (location?.center) {
		if (location?.dist) {
			if (!location?.min) {
				location.min = [(+location.center[0] - +location.dist[0]), (+location.center[1] - +location.dist[1])];
			}
			if (!location?.max) {
				// convert any strings to floats to add
				location.max = [(+location.center[0] + +location.dist[0]), (+location.center[1] + +location.dist[1])];
			}
		}
	}

	logger.info("Updated location:", location);
	logger.info(`Getting activities of type: ${type}`);
	logger.trace(`Cache File: ${ACTIVITY_LIST_CACHE_FILE}`);
	try {
		let payload: StravaActivity[] = [];
		let last = 0;

		// If we already have an activity list file and we are trying to get data, 
		// back up the file and try to find the most recent timestamp
		if (fs.existsSync(ACTIVITY_LIST_CACHE_FILE)) {
			logger.info("Already have cache file");
			try {
				payload = JSON.parse(fs.readFileSync(ACTIVITY_LIST_CACHE_FILE, 'utf8'));
			}
			catch (e) {
				logger.error("Error processing activity list cache. Recreating.", e);
			}
		}

		// get new data
		
		// Refresh is similar, but different from check for newer
		if (refresh && refresh !== 'false') {
			logger.info("Refreshing from time range");
			const payloadMap: Record<number, number> = {};
			payload.forEach((el, index) => {
				payloadMap[el.id] = index;
			});

			const endTime = (typeof toStamp === 'number' ? toStamp : Number(toStamp)) || Date.now() / 1000;
			const startTime = (typeof fromStamp === 'number' ? fromStamp : Number(fromStamp)) || 0;
			const newPayload = await getTrackListPage({ token: token, fromStamp: startTime, toStamp: endTime });
			// Use for loop for async
			for (let i = 0; i < newPayload.length; i++) {
				const activity = newPayload[i];
				logger.trace("Activity", activity);
				const id = activity.id;
				const oldActivityIndex = payloadMap[id];
				if (oldActivityIndex !== undefined) {
					const oldActivity = payload[oldActivityIndex];
					if (compareTrackMetaData(oldActivity, activity)) {
						logger.info("Changes, so updating metadata and redownloading");
						payload[oldActivityIndex] = activity;
						// Just update metadata? And throw away track redownload? or don't do it?
						await processActivity(activity, token, true, tolerance ?? undefined);
					}
				}
				else {
					logger.info(`"${id}" Does not exist. Downloading and adding`);
					payload.push(activity);
					try {
						const fullActivity = await processActivity(activity, token, true, tolerance ?? undefined);
						if (fullActivity === 'NO DATA') {
							noDataTracks++;
							logger.trace(`tracks with no data:`, noDataTracks);
						}
					}
					catch (e) {
						logger.error(`Error with process activity for ${id}`, e);
					}
				}
			}
			// Properly sort and filter - since new ones will show up at end
			// We want newest first
			payload = payload.sort((a, b) => {
				return b['start_date_local'].localeCompare(a['start_date_local']);
			});
			payload = payload.filter((e, i, a) => e?.id !== a[i - 1]?.id);
			try {
				fs.renameSync(ACTIVITY_LIST_CACHE_FILE, `${ACTIVITY_LIST_CACHE_FILE}.${Date.now()}`);
			}
			catch (e) {
				logger.error("unable to rename old file", ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE, JSON.stringify(payload, null, 1));
			CleanupAllActivities();
		}
		else if (checkForNewer && checkForNewer !== 'false') {
			logger.info("Last timestamp:", last);
			try {
				last = Math.floor(new Date(payload[0].start_date).getTime() / 1000);
			}
			catch (e) {
				logger.error("could not get date", e);
			}
			payload = await getTrackListPage({ token: token, trackList: payload, fromStamp: last });
			// Properly sort and filter - since new ones will show up at end
			// We want newest first
			payload = payload.sort((a, b) => {
				return b['start_date_local'].localeCompare(a['start_date_local']);
			});
			payload = payload.filter((e, i, a) => e?.id !== a[i - 1]?.id);
			try {
				fs.renameSync(ACTIVITY_LIST_CACHE_FILE, `${ACTIVITY_LIST_CACHE_FILE}.${Date.now()}`);
			}
			catch (e) {
				logger.error("unable to rename old file", ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE, JSON.stringify(payload, null, 1));
		}
		logger.info("Number of activities:", payload.length);
		const { trackData, activities, activityProcessCounts } = await processActivities({
			token: token,
			payload: payload,
			type: type,
			location: location,
			includePrivate: includePrivate,
			fromStamp: fromStamp ? Number(fromStamp) : undefined,
			toStamp: toStamp ? Number(toStamp) : undefined,
			tolerance: tolerance ?? undefined,
			dedup: dedup
		});
		// return raw track data and kmlTrack
		const kmlTrack = printKml.head("tracks") + trackData + printKml.tail(config.default_latitude, config.default_longitude);
		return { activities, kmlTrack, activityProcessCounts };
	}
	catch (e) {
		logger.error("error", e);
	}
};

interface ProcessActivitiesParams {
	token?: string;
	payload: StravaActivity[];
	type?: string;
	location?: GetStuffOptions['location'];
	includePrivate?: boolean | string;
	fromStamp?: number;
	toStamp?: number;
	tolerance?: number | null;
	dedup?: boolean | string;
}

const processActivities = async ({
	token,
	payload,
	type = '',
	location = {},
	includePrivate = false,
	fromStamp,
	toStamp,
	tolerance,
	dedup
}: ProcessActivitiesParams): Promise<{
	trackData: string;
	activities: StravaActivity[];
	activityProcessCounts: ActivityFilterCounts;
}> => {
	checkAPIInterval();
	let error = 0;
	let kmlTracks = '';
	let desiredActivities = payload;
	let noDataTracks = 0;
	const searchType = type ? TYPES[type] : null;
	const activityProcessCounts: ActivityFilterCounts = {};
	activityProcessCounts.totalActivities = payload.length;
	logger.info(`Initial activities: ${activityProcessCounts.totalActivities}`);

	// filter the activities
	if (searchType) {
		desiredActivities = desiredActivities.filter(activity => {
			return searchType.indexOf(activity.type) !== -1;
		});
		logger.info(`Desired by type: ${desiredActivities.length}`);
		activityProcessCounts.byType = desiredActivities.length;
	}
	if (!includePrivate || includePrivate === 'false') {
		desiredActivities = desiredActivities.filter(activity => {
			return !activity.private;
		});
		logger.info(`Desired after excluding private: ${desiredActivities.length}`);
		activityProcessCounts.nonPrivate = desiredActivities.length;
	}
	if (location.min) {
		desiredActivities = desiredActivities.filter(activity => {
			return Boolean(activity.start_latlng &&
				(activity.start_latlng[0] > location.min![0]) &&
				(activity.start_latlng[1] > location.min![1]));
		});
		logger.info(`Desired by min latlng: ${desiredActivities.length}`);
		activityProcessCounts.minlatlng = desiredActivities.length;
	}
	if (location.max) {
		desiredActivities = desiredActivities.filter(activity => {
			return Boolean(activity.start_latlng &&
				(activity.start_latlng[0] < location.max![0]) &&
				(activity.start_latlng[1] < location.max![1]));
		});
		logger.info(`Desired by max latlng: ${desiredActivities.length}`);
		activityProcessCounts.maxlatlng = desiredActivities.length;
	}
	if (fromStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)).getTime() / 1000) >= fromStamp;
		});
		logger.info(`Desired by after fromStamp: ${desiredActivities.length}`);
		activityProcessCounts.afterStartTime = desiredActivities.length;
	}
	if (toStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)).getTime() / 1000) <= toStamp;
		});
		logger.info(`Desired by after toStamp: ${desiredActivities.length}`);
		activityProcessCounts.afterEndTime = desiredActivities.length;
	}
	if (dedup && dedup !== 'false') {
		const { filteredList, removalLogs } = dedupStravaDuplicates(desiredActivities);
		logger.info("Logs of removal", JSON.stringify(removalLogs, null, 1));
		desiredActivities = filteredList;
		activityProcessCounts.afterDedup = desiredActivities.length;
		logger.info(`Activities after filtering out multiple athlete activities starting within 2 minutes of each other: ${desiredActivities.length}`);
	}

	// Get the track listing for each activity
	// May retrieve from cache or from API
	await Promise.all(desiredActivities.map(async (activity) => {
		if (!error) {
			try {
				logger.trace("Processing activity:", activity);
				let trackData: string | null = await processActivity(activity, token, false, tolerance ?? undefined);
				if (trackData === 'NO DATA') {
					noDataTracks++;
					trackData = null;
				}
				else if (trackData) {
					kmlTracks += trackData;
				}
			}
			catch (e: any) {
				++skipped;
				if (e?.statusCode !== 404) {
					logger.error("process activity error. Aborting future requests:", e);
					++error;
				}
				else {
					logger.error("404 error:", activity.id, activity.name, e?.statusCode, e?.options);
				}
			}
		}
		else {
			logger.info("Not making request", error, "total skipped:", skipped);
		}
	}));
	console.info(`Skipped tracks: ${skipped}`);
	console.info(`API Calls: ${called}`);
	activityProcessCounts.skipped = skipped;
	activityProcessCounts.noDataTracks = noDataTracks;
	return { trackData: kmlTracks, activities: desiredActivities, activityProcessCounts };
};

export const getCacheFileFromActivity = (activity: { id: number | string }): string => {
	const id = activity.id;
	const trackCacheFile = `${CACHE_DIR}/${id}.json`;
	return trackCacheFile;
};

const processActivity = async (
	activity: StravaActivity,
	token?: string,
	force: boolean = false,
	tolerance: number = TOLERANCE
): Promise<string> => {
	logger.trace("Activity:", activity);
	checkAPIInterval();
	// force will force redownload even if cache exists

	const id = activity.id;
	const trackCacheFile = getCacheFileFromActivity(activity);
	logger.debug("track cache file", trackCacheFile);
	let stream: any = null;
	if (!force && fs.existsSync(trackCacheFile)) {
		logger.debug("reading cache file", trackCacheFile);
		const file = fs.readFileSync(trackCacheFile, 'utf8');
		stream = JSON.parse(file);
		logger.trace("FILE", file);
	}
	else {
		if (called > MAX_TRACKS) {
			++skipped;
			logger.warn(`Not downloading ${id} because ${called} exceeds ${MAX_TRACKS}, skipped: ${skipped}`);
		}
		else if (!activity.upload_id && (!Object.hasOwn(activity, 'start_latlng') || !activity.start_latlng?.length)) {
			++skipped;
			logger.warn(`Not downloading ${id} ${activity?.name} ${activity?.start_date_local} because no start lat_lng (skipped: ${skipped})`);
		}
		else {
			++called;
			logger.debug(`API Calls: ${called}`);
			stream = await callStravaAPI(token, `activities/${activity.id}/streams`, { keys: "time,distance,latlng", resolution: "medium" });
			fs.writeFileSync(trackCacheFile, JSON.stringify(stream, null, 1));
			logger.info("Wrote file", trackCacheFile);
		}
	}
	
	if (stream && Array.isArray(stream)) {
		// The gpx contains an array of different type items. 
		// they can be in any order
		const latlngList = stream.find((list: any) => list.type === 'latlng');
		if (!latlngList) {
			logger.warn(`no lat lng for activity: ${activity.id}: ${activity.name}`);
			return "NO DATA";
		}

		const coordinates = tolerance ? simplifyTrack(latlngList.data, tolerance) :
			latlngList.data.map((latlng: [number, number]) => {
				return `${latlng[1]},${latlng[0]},0`;
			})
			.join(' ');
		const trackTitle = `${activity.name} (${activity.type}) ${activity.start_date_local.replace(/T.*$/, '')}`;
		const kmlCoord = printKml.placemark(trackTitle, coordinates || '');
		return kmlCoord;
	}
	else {
		return "";
	}
};

export const outputFile = (data: string, fileName: string = `${OUTPUT_DIR}/output_${Date.now()}.kml`): string => {
	fs.writeFileSync(fileName, data);
	logger.info("Wrote to :", fileName);
	return fileName;
};

export const getAuthURL = (post: string = "code"): string => {
	logger.info("getAuthURL post: ", post);
	const authURL = `https://www.strava.com/oauth/authorize?client_id=${config.client_id}&response_type=code&redirect_uri=${config.redirect_uri}/${post}&scope=read,activity:read_all`;
	logger.info(`Strava auth url: ${authURL}`);
	return authURL;
};

export const getAuthToken = async (code: string): Promise<{ access_token: string; athleteID: number | null }> => {
	logger.debug("setting up promise for auth token", code);
	return new Promise((resolve, reject) => {
		logger.info("Calling strava to get token for code:", code);
		logger.debug("calling axios");
		axios.post('https://www.strava.com/oauth/token', {
		  client_id: config.client_id,
		  client_secret: config.client_secret,
		  code: code,
		  grant_type: 'authorization_code'
		}).then(async response => {
			logger.trace("auth token response", response);
			const { access_token } = response.data;
			const athleteID = await getCurrentAthleteId(access_token);
			logger.info("Athlete id", athleteID);
			logger.debug("access token", access_token);
			if (athleteID) {
				stravaTokens[athleteID] = access_token;
			}
			resolve({ access_token, athleteID });
		}).catch(error => {
			logger.debug("error");
			// Handle any errors
			logger.error("Error parsing api response from getAuthToken ", error);
			reject(error);
		});
	});
};

/**
 * Retrieves the current user's athlete ID from the Strava API.
 */
async function getCurrentAthleteId(accessToken: string): Promise<number | null> {
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
    const athleteId = data.id;
    logger.trace('Current Athlete ID:', athleteId);
    return athleteId;

  } catch (error) {
    console.error('Failed to retrieve athlete details:', error);
    return null;
  }
}

const simplifyTrack = (data: [number, number][], tolerance: number): string | undefined => {
	try {
		// must flip lat/lng before geojsoning
		const toParse = [{ line: data.map(point => [point[1], point[0]]) }];
		const geoJsonTrack = geoJSON.parse(toParse, { 'LineString': 'line' });
		const simple = simplify(geoJsonTrack, tolerance / 10000);
		const coordinates = simple.features[0].geometry.coordinates
			.map((point: [number, number]) => { // only have lat and long
				return `${point[0]},${point[1]},0`;
			})
			.join(' ');
		return coordinates;
	}
	catch (e) {
		logger.error("Error with simplifyTrack", e);
	}
};

export const callStravaAPI = async (token: string | undefined, endpoint: string, opts?: Record<string, any>): Promise<any> => {
	logger.debug("callStravaAPI with token:", token);
	const params = new URLSearchParams(opts as Record<string, string>);

	const queryString = params.toString();
	const url = `https://www.strava.com/api/v3/${endpoint}?${queryString}`;

	try {
	    const response = await axios.get(url, {
	      headers: {
		    'Authorization': `Bearer ${token}`,
	      },
	    });

	    return response.data;
	} catch (error: any) {
	    logger.error("found error in axios");
	    if (axios.isAxiosError(error) && error.response && error.response.status === 401) {
	      logger.error("Access token expired or invalid. Refresh token required.");
	    }
		logger.error("UNKNOWN ERROR", error);
		logger.error("throwing");
	    throw error;
    }
};

const CleanupAllActivities = (): void => {
	const DIRECTORY_PATH = CACHE_DIR;
	const FILE_PREFIX = `${ACTIVITY_LIST_CACHE_NAME}.`;
	const KEEP_COUNT = 10;

	async function maintainRecentFiles(dirPath: string, prefix: string, keepCount: number): Promise<void> {
		logger.info(`Clean up activities: dirPath:${dirPath},prefix: ${prefix}, keepCount: ${keepCount}`);
		if (!dirPath || !prefix) {
			logger.error("invalid directory or prefix, not cleaning up");
			return;
		}
	  try {
	    const files = await readdir(dirPath);

	    const matchingFiles: Array<{ name: string; path: string; mtimeMs: number }> = [];
	    for (const file of files) {
	      if (file.startsWith(prefix)) {
		    const fullPath = path.join(dirPath, file);
		    try {
		      const fileStat = await stat(fullPath);
		      if (fileStat.isFile()) {
		        matchingFiles.push({
		          name: file,
		          path: fullPath,
		          mtimeMs: fileStat.mtimeMs,
		        });
		      }
		    } catch (err) {
		    }
	      }
	    }

		logger.info("Files matching path:", matchingFiles.length);
	    if (matchingFiles.length === 0) {
	      return;
	    }

	    matchingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

	    const filesToDelete = matchingFiles.slice(keepCount);
		logger.info("Files to delete", filesToDelete.length, filesToDelete);

	    if (filesToDelete.length > 0) {
	      for (const file of filesToDelete) {
		    try {
		      await unlink(file.path);
		    } catch (err) {
		    }
	      }
	    }

	  } catch (error) {
	  }
	}

	maintainRecentFiles(DIRECTORY_PATH, FILE_PREFIX, KEEP_COUNT);
};

// sometimes multiple versions of same activity are recorded by different means. Only take the first one
const dedupStravaDuplicates = (arr: StravaActivity[]): { filteredList: StravaActivity[]; removalLogs: any[] } => {
  // 1. Filter out items with elapsed_time < 400
  const validItems = arr.filter(item => item.elapsed_time >= 400);

  // 2. Sort chronologically
  const sorted = [...validItems].sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  const clusters: StravaActivity[][] = [];
  let currentCluster: StravaActivity[] = [];

  // 3. Cluster within 5-minute (300,000 ms) windows
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

  // 4. Resolve clusters & build the removal report
  const filteredList: StravaActivity[] = [];
  const removalLogs: any[] = [];

  clusters.forEach((cluster) => {
    const exemptItems = cluster.filter(item => (item.athlete_count ?? 1) <= 1);
    const candidateItems = cluster.filter(item => (item.athlete_count ?? 1) > 1);

    if (candidateItems.length > 0) {
      // Prioritize keeping private: false
      candidateItems.sort((a, b) => Number(a.private) - Number(b.private));

      const bestCandidate = candidateItems[0];
      const removedItems = candidateItems.slice(1);

      // Add removed_count property to the kept object
      const keptItem: StravaActivity = {
        ...bestCandidate,
        removed_count: removedItems.length
      };

      filteredList.push(keptItem);

      // Log if duplicates were removed
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

  // Final chronological sort
  filteredList.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());

  return { filteredList, removalLogs };
};
