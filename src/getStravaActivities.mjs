import { logger } from './loggerSetup.mjs';
import config from './config.mjs';
import printKml from './kmlExport.js';
import fs from 'fs';
import {execSync} from 'child_process';
import geoJSON from 'geojson';
import simplify from 'simplify-geojson';
import axios from 'axios';
import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';

// Todo: have index of strava tokens to users (not yet implemented)
const stravaTokens = {};
/*
 * getStravaActvities
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
	logger.info("Creating cache dir:",CACHE_DIR);
	fs.mkdirSync(CACHE_DIR);
}
if (!fs.existsSync(OUTPUT_DIR)) {
	logger.info("Creating output dir:",OUTPUT_DIR);
	fs.mkdirSync(OUTPUT_DIR);
}
const MAX_TRACKS = config.max_tracks_at_a_time || 550;

const API_RESET_TIME = config.API_RESET_TIME || 15;
let called = 0;
let skipped = 0;
let calledTime = Date.now();

const checkAPIInterval = () => {
	const calledInterval = (Date.now() - calledTime)/(1000*60);
	logger.debug("Minutes since called count started ",calledInterval);
	if (calledInterval > API_RESET_TIME) {
		logger.info("restarting API count count");
		called = 0;
		calledTime = Date.now();
	}
}

export const TYPES = config.activity_types;

// Recursively get all activities within a time range
const getTrackListPage = async ({token, page=1, trackList=[], fromStamp=0, toStamp=Math.ceil(Date.now()/1000)} = {}) => {
	logger.debug("getTrackListPage, token:",token);
	logger.info("Page:",page,"activities:",trackList.length, "from:",fromStamp, "to:",toStamp);
	try {
		const payload = await callStravaAPI(token,"athlete/activities",{id:373707, after:fromStamp, before: toStamp, per_page: 200, page: page});
		called += 1;
		if (payload.length) {
			trackList.push(...payload);
			trackList = await getTrackListPage({page:page+1,trackList:trackList, fromStamp:fromStamp, toStamp: toStamp, token:token });
		}
	}
	catch (e) {
		logger.error("ERROR getting list:",e);
	}
	return trackList;
}

const compareTrackMetaData = (oldTrack, newTrack) => {
	// true means they are different
	const oldKeys = Object.keys(oldTrack);
	const newKeys = Object.keys(newTrack);
	if (oldKeys.length !== newKeys.length) {
		logger.info("different key length in track arrays",oldKeys.length, newKeys.length);
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
	});
}
export const getStuff = async ({ type = '', checkForNewer = false, location = {}, includePrivate=false, fromStamp, toStamp, token, tolerance, refresh = false } = {}) => {
	logger.debug(`getStuff: type: ${type}, checkForNewer: ${checkForNewer}, location: ${location}, includePrivate: ${includePrivate}, fromStamp: ${fromStamp}, toStamp: ${toStamp}, token: ${token}, tolerance: ${tolerance}, refresh: ${refresh}`);
	checkAPIInterval();
	logger.info("TOLERANCE",tolerance);
	if (!tolerance) {
		tolerance = null;
	}
	// If we have non-numeric in date, try to convert it
	if (fromStamp && /\D/.test(fromStamp.trim())) {
		fromStamp = (new Date(fromStamp))/1000;
		logger.info("fromStamp converted: ",fromStamp);
	}
	if (toStamp && /\D/.test(toStamp.trim())) {
		toStamp = (new Date(toStamp))/1000;
		logger.info("toStamp converted: ",toStamp);
	}
	logger.info("TOKEN:",token);
	// Now we just pass around the token

	// structure the lat/long in the format we use
	if (location?.center) {
		if (location?.dist) {
			if (!location?.min) {
				location.min=[ (location.center[0]-location.dist[0]),(location.center[1]-location.dist[1])];
			}
			if (!location?.max) {
				// convert any strings to floats to add
				location.max=[ (+location.center[0]+ +location.dist[0]),(+location.center[1]+ +location.dist[1])];
			}
		}
	}

	logger.info("Updated location:",location);
	logger.info(`Getting activities of type: ${type}`);
	logger.trace(`Cache File: ${ACTIVITY_LIST_CACHE_FILE}`);
	try {
		let payload = {};
		let last=0;

		// If we already have an activity list file and we are trying to get data, 
		// back up the file and try to find the most recent timestamp
		if (fs.existsSync(ACTIVITY_LIST_CACHE_FILE)) {
			logger.info("Already have cache file");
			try {
				payload = JSON.parse(fs.readFileSync(ACTIVITY_LIST_CACHE_FILE));
			}
			catch(e) {
				logger.error("Error processing activity list cache. Recreating.",e);
			}
		}

		// get new data
		
		// Refresh is similar, but different from check for newer
		if (refresh && refresh !== 'false') {
			logger.info("Refreshing from time range");
			const payloadMap = {};
			payload.forEach((el,index) => {
				payloadMap[el.id] = index;
			});

			const endTime = toStamp || Date.now()/1000;
			const newPayload = await getTrackListPage({token:token, fromStamp:fromStamp, toStamp: endTime});
			// Use for loop for async
			for (let i=0; i< newPayload.length; i++) {
				const activity = newPayload[i];
				logger.trace("Activity",activity);
				const id = activity.id;
				const oldActivityIndex = payloadMap[id];
				if (oldActivityIndex !== undefined) {
					const oldActivity = payload[oldActivityIndex];
					if (compareTrackMetaData(oldActivity, activity)) {
						logger.info("Changes, so updating metadata and redownloading");
						payload[oldActivityIndex] = activity;
						await processActivity(activity,token,true,tolerance);
					}
				}
				else {
					logger.info(`"${id}" Does not exist. Downloading and adding`);
					payload.push(activity);
					try {
						fullActivity = await processActivity(activity,token,true,tolerance);
					}
					catch (e) {
						logger.error(`Error with process activity for ${id}`,e);
					}
				}
			};
			// Properly sort and filter - since new ones will show up at end
			// We want newest first
			payload = payload.sort((a,b) => {
				return b['start_date_local'].localeCompare(a['start_date_local']);
			});
			payload = payload.filter((e,i,a) => e?.id !== a[i-1]?.id);
			try {
				fs.renameSync(ACTIVITY_LIST_CACHE_FILE,`${ACTIVITY_LIST_CACHE_FILE}.${Date.now()}`);
			}
			catch (e) {
				logger.error("unable to rename old file",ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE,JSON.stringify(payload,null,1));
			CleanupAllActivities();
		}
		else if (checkForNewer && checkForNewer !== 'false') {
			logger.info("Last timestamp:",last);
			try {
				last = Math.floor(new Date(payload[0].start_date)/1000);
			}
			catch(e) {
				logger.error("could not get date",e);
			}
			payload = await getTrackListPage({token:token, trackList:payload, fromStamp:last});
			// Properly sort and filter - since new ones will show up at end
			// We want newest first
			payload = payload.sort((a,b) => {
				return b['start_date_local'].localeCompare(a['start_date_local']);
			});
			payload = payload.filter((e,i,a) => e?.id !== a[i-1]?.id);
			try {
				fs.renameSync(ACTIVITY_LIST_CACHE_FILE,`${ACTIVITY_LIST_CACHE_FILE}.${Date.now()}`);
			}
			catch (e) {
				logger.error("unable to rename old file",ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE,JSON.stringify(payload,null,1));
		}
		logger.info("Number of activities:",payload.length);
		const {trackData,activities} = await processActivities({token:token, payload:payload, type:type, location:location, includePrivate:includePrivate, fromStamp: fromStamp,toStamp:toStamp, tolerance:tolerance});
		// return raw track data and kmlTrack
		const kmlTrack = printKml.head("tracks")+trackData+printKml.tail(config.default_latitude,config.default_longitude);
		return {activities, kmlTrack}
	}
	catch (e) {
		logger.error("error",e)
	};
}


const processActivities = async ({token, payload, type, location={}, includePrivate=false, fromStamp, toStamp, tolerance}) => {
	checkAPIInterval();
	let error = 0;
	let kmlTracks = '';
	let desiredActivities = payload;
	const searchType = TYPES[type];
	logger.info(`Initial activities: ${payload.length}`);

	// filter the activities
	if (searchType) {
		desiredActivities = desiredActivities.filter(activity => {
			return (searchType.indexOf(activity.type) !== -1);
		});
		logger.info(`Desired by type: ${desiredActivities.length}`);
	}
	if (!includePrivate || includePrivate === 'false') {
		desiredActivities = desiredActivities.filter(activity => {
			return (!activity.private);
		});
		logger.info(`Desired after excluding private: ${desiredActivities.length}`);
	}
	if (location.min) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((activity.start_latlng[0] > location.min[0]) && 
				(activity.start_latlng[1] > location.min[1]))
		})
		logger.info(`Desired by min latlng: ${desiredActivities.length}`);
	}
	if (location.max) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((activity.start_latlng[0] < location.max[0]) && 
				(activity.start_latlng[1] < location.max[1]))
		})
		logger.info(`Desired by max latlng: ${desiredActivities.length}`);
	}
	if (fromStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)/1000) >= fromStamp)
		})
		logger.info(`Desired by after fromStamp: ${desiredActivities.length}`);
	}
	if (toStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)/1000) <= toStamp)
		})
		logger.info(`Desired by after toStamp: ${desiredActivities.length}`);
	}

	// Get the track listing for each activity
	// May retrieve from cache or from API
	await Promise.all(desiredActivities.map(async (activity) => {
		if (!error) {
			try {
				logger.trace("Processing activity:",activity);
				const trackData = await processActivity(activity,token,false,tolerance);
				kmlTracks += trackData;
			}
			catch (e) {
				++skipped;
				if (e?.statusCode !== 404) {
					logger.error("process activity error. Aborting future requests:",e);
					++error;
				}
				else {
					logger.error("404 error:",activity.id,activity.name,e?.statusCode,e?.options);
				}
			}
		}
		else {
			logger.info("Not making request",error, "total skipped:",skipped);
		}
	}))
	console.info(`Skipped tracks: ${skipped}`);
	console.info(`API Calls: ${called}`);
	return {trackData:kmlTracks,activities:desiredActivities};
}

const processActivity = async (activity, token, force=false, tolerance=TOLERANCE) => {
	logger.trace("Activity:",activity);
	checkAPIInterval();
	// force will force redownload even if cache exists

	// Interesting fields:
	// name: name of activity
	// sport_type: Walk, Ride, Run, Hike
	// type: (mostly same as sport_type)
	// start_date_local: date in local timezone
	// start_date : in GMT
	// timezone: the timezone
	// start_latlng
	// end_latlng [lat,lng]
	// private: (boolean)
	const id = activity.id;
	const trackCacheFile = `${CACHE_DIR}/${id}.json`;
	logger.debug("track cache file",trackCacheFile);
	let stream = null;
	if (!force && fs.existsSync(trackCacheFile)) {
		logger.debug("reading cache file",trackCacheFile);
		const file = fs.readFileSync(trackCacheFile);
		stream = JSON.parse(file);
		logger.trace("FILE",file.toString());
	}
	else {
		if (called > MAX_TRACKS) {
			++skipped;
			logger.warn(`Not downloading ${id} because ${called} exceeds ${MAX_TRACKS}, skipped: ${skipped}`);
		}
		else if (!Object.hasOwn(activity,'start_latlng') || !activity.start_latlng.length) {
			++skipped
			logger.warn(`Not downloading ${id} because no start lat_lng (skipped: ${skipped})`);
		}
		else {
			++called;
			logger.debug(`API Calls: ${called}`);
			stream = await callStravaAPI(token,`activities/${activity.id}/streams`,{keys:"time,distance,latlng", resolution:"medium"});
			fs.writeFileSync(trackCacheFile,JSON.stringify(stream,null,1));
			logger.info("Wrote file",trackCacheFile);
		}
	}
	
	if (stream) {
		// The gpx contains an array of different type items. 
		// they can be in any order
		const latlngList = stream.find(list => list.type === 'latlng');
		if (!latlngList) {
			logger.warn(`no lat lng for activity: ${activity.id}: ${activity.name}`);
			return ;
		}

		const coordinates = tolerance ? simplifyTrack(latlngList.data, tolerance) :
			latlngList.data.map(latlng => {
				return `${latlng[1]},${latlng[0]},0`;
			})
			.join(' ');
		const trackTitle = `${activity.name} (${activity.type}) ${activity.start_date_local.replace(/T.*$/,'')}`;
		const kmlCoord = printKml.placemark(trackTitle,coordinates);
		return kmlCoord;
	}
	else {
		return "";
	}
}

export const outputFile = (data, fileName=`${OUTPUT_DIR}/output_${Date.now()}.kml`) => {
	fs.writeFileSync(fileName,data);
	logger.info("Wrote to :",fileName);
	return fileName;
}

export const getAuthURL = (post = "code") => {
	logger.info("getAuthURL post: ",post);
	const authURL = `https://www.strava.com/oauth/authorize?client_id=${config.client_id}&response_type=code&redirect_uri=${config.redirect_uri}/${post}&scope=read,activity:read_all`;
	logger.info(`Strava auth url: ${authURL}`);
	return authURL;
}

export const getAuthToken = async (code) => {
	logger.debug("setting up promise for auth token",code);
	return new Promise((resolve, reject) => {
		logger.info("Calling strava to get token for code:",code);
		logger.debug("calling axios");
		axios.post('https://www.strava.com/oauth/token', {
		  client_id: config.client_id,
		  client_secret: config.client_secret,
		  code: code,
		  grant_type: 'authorization_code'
		}).then(async response => {
			logger.trace("auth token response",response);
			const { access_token, refresh_token, expires_at } = response.data;
			const athleteID = await getCurrentAthleteId(access_token);
			logger.info("Athlete id",athleteID);
			logger.debug("access token",access_token);
			stravaTokens[athleteID] = access_token;
			resolve({access_token, athleteID});
		}).catch(error => {
			logger.debug("error");
			// Handle any errors
			logger.error("Error parsing api response from getAuthToken ",error);
			reject(error);
		});
	});
}

/**
 * Retrieves the current user's athlete ID from the Strava API.
 * @param {string} accessToken - The valid Strava API access token for the user.
 * @returns {Promise<number|null>} A promise that resolves with the athlete ID or null if an error occurs.
 */
async function getCurrentAthleteId(accessToken) {
  const athleteEndpoint = 'https://www.strava.com/api/v3/athlete';

  try {
    const response = await fetch(athleteEndpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`, // Include the access token in the Authorization header
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    // The response body contains the athlete details, including the 'id'
    const athleteId = data.id;
    console.log('Current Athlete ID:', athleteId);
    return athleteId;

  } catch (error) {
    console.error('Failed to retrieve athlete details:', error);
    return null;
  }
}

// Example Usage (replace 'YOUR_ACCESS_TOKEN' with the actual token)
// This should be called after your application successfully completes the OAuth flow.
// getCurrentAthleteId('YOUR_ACCESS_TOKEN');


const simplifyTrack = (data, tolerance) => {
	try {
		// must flip lat/lng before geojsoning
		const toParse = [{line: data.map(point => [point[1],point[0]])}];
		const geoJsonTrack = geoJSON.parse(toParse, {'LineString': 'line'});
		const simple = simplify(geoJsonTrack, tolerance / 10000 );
		const coordinates = simple.features[0].geometry.coordinates
			.map((point) => { // only have lat and long
				return `${point[0]},${point[1]},0`
				}
			)
			.join(' ');
		return coordinates;
		}
	catch(e) {
		logger.error("Error with simplifyTrack",e);
	}
}

export const callStravaAPI = async (token, endpoint,opts) => {
	// TODO: Whitelist certain APIs
	logger.debug("callStravaAPI with token:",token);
	const params = new URLSearchParams(opts);

	// Convert the instance to a string
	const queryString = params.toString();
	const url = `https://www.strava.com/api/v3/${endpoint}?${queryString}`;

	try {
	    const response = await axios.get(url, {
	      headers: {
		// Use the access token received during OAuth
		'Authorization': `Bearer ${token}`,
	      },
	    });

	    return response.data;
	  } catch (error) {
	    // Check if the error is due to an expired token (HTTP 401 Unauthorized)
	    if (axios.isAxiosError(error) && error.response && error.response.status === 401) {
	      logger.error("Access token expired or invalid. Refresh token required.");
	      // TODO: trigger the token refresh logic here.
	    }
		  logger.error(error);
	    throw error;
  }
}

const CleanupAllActivities = () => {

const DIRECTORY_PATH = CACHE_DIR;
const FILE_PREFIX = `${ACTIVITY_LIST_CACHE_NAME}.`;
const KEEP_COUNT = 10;

	async function maintainRecentFiles(dirPath, prefix, keepCount) {
		logger.info(`Clean up activities: dirPath:${dirPath},prefix: ${prefix}, keepCount: ${keepCount}`);
		if (!dirPath || !prefix) {
			logger.error("invalid directory or prefix, not cleaning up");
			return;
		}
	  try {
	    const files = await readdir(dirPath);

	    const matchingFiles = [];
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

		  logger.info("Files matching path:",matchingFiles.length);
	    if (matchingFiles.length === 0) {
	      return;
	    }

	    matchingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

	    const filesToDelete = matchingFiles.slice(keepCount);
		  logger.info("Files to delete",filesToDelete.length,filesToDelete);

	    if (filesToDelete.length === 0) {
	    } else {
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
}

