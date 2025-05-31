import stravaApi from "strava-v3";
import config from './config.mjs';
import printKml from './kmlExport.js';
import fs from 'fs';
import {execSync} from 'child_process';
import geoJSON from 'geojson';
import simplify from 'simplify-geojson';
/*
 * getStravaActvities
 * Gets all Strava Activities via Strava API and produces a kml
 * Google my Maps has 5 MB limit for kml size limit.
 * Simplifying the track helps reduce GPS "flutter" and reduce size
 * limiting the geography region also helps
 */
	

// usually overwritten by param value
const TOLERANCE = config.tolerance || .6;

stravaApi.config({client_id:config.client_id, client_secret:config.client_secret, redirect_uri:config.redirect_uri});
let strava = new stravaApi.client({});
const CACHE_DIR = config.cache_dir;
const OUTPUT_DIR = config.output_dir;
const ACTIVITY_LIST_CACHE_FILE = `${CACHE_DIR}/allActivities.json`;
if (!fs.existsSync(CACHE_DIR)) {
	console.log("Creating cache dir:",CACHE_DIR);
	fs.mkdirSync(CACHE_DIR);
}
if (!fs.existsSync(OUTPUT_DIR)) {
	console.log("Creating output dir:",OUTPUT_DIR);
	fs.mkdirSync(OUTPUT_DIR);
}
const MAX_TRACKS = config.max_tracks_at_a_time || 550;

let called = 0;
let skipped = 0;

export const TYPES = config.activity_types;

// Recursively get all activities within a time range
const getTrackListPage = async ({page=1, trackList=[], fromStamp=0, toStamp=Math.ceil(Date.now()/1000)} = {}) => {
	console.log("Page:",page,"activities:",trackList.length, "from:",fromStamp, "to:",toStamp);
	try {
		const payload = await strava.athlete.listActivities({id:373707, after:fromStamp, before: toStamp, per_page: 200, page: page})
		if (payload.length) {
			trackList.push(...payload);
			trackList = await getTrackListPage({page:page+1,trackList:trackList, fromStamp:fromStamp, toStamp: toStamp });
		}
	}
	catch (e) {
		console.error("ERROR getting list:",e);
	}
	return trackList;
}

const compareTrackMetaData = (oldTrack, newTrack) => {
	// true means they are different
	const oldKeys = Object.keys(oldTrack);
	const newKeys = Object.keys(newTrack);
	if (oldKeys.length !== newKeys.length) {
		console.log("different key length in track arrays",oldKeys.length, newKeys.length);
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
			console.log(`${oldTrack.id} ${oldTrack.name} ${oldKey} is different: ${oldVal} != ${newVal}`);
			return true;
		}
	});
}
export const getStuff = async ({ type = '', checkForNewer = false, location = {}, includePrivate=false, fromStamp, toStamp, token, tolerance, refresh = false } = {}) => {
	console.log("TOLERANCE",tolerance);
	if (!tolerance) {
		tolerance = null;
	}
	// If we have non-numeric in date, try to convert it
	if (fromStamp && /\D/.test(fromStamp.trim())) {
		fromStamp = (new Date(fromStamp))/1000;
		console.log("fromStamp converted: ",fromStamp);
	}
	if (toStamp && /\D/.test(toStamp.trim())) {
		toStamp = (new Date(toStamp))/1000;
		console.log("toStamp converted: ",toStamp);
	}
	console.log("TOKEN:",token);
	if (token) {
		// This was initially initialized in module scope
		strava = new stravaApi.client(token);
	}

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

	console.log("Updated location:",location);
	console.log(`Getting activities of type: ${type}`);
	try {
		let payload = {};
		let last=0;

		// If we already have an activity list file and we are trying to get data, 
		// back up the file and try to find the most recent timestamp
		if (fs.existsSync(ACTIVITY_LIST_CACHE_FILE)) {
			console.log("Already have cache file");
			try {
				payload = JSON.parse(fs.readFileSync(ACTIVITY_LIST_CACHE_FILE));
			}
			catch(e) {
				console.error("Error processing activity list cache. Recreating.",e);
			}
		}

		// get new data
		
		// Refresh is similar, but different from check for newer
		if (refresh && refresh !== 'false') {
			console.log("Refreshing from time range");
			const payloadMap = {};
			payload.forEach((el,index) => {
				payloadMap[el.id] = index;
			});

			const endTime = toStamp || Date.now()/1000;
			const newPayload = await getTrackListPage({fromStamp:fromStamp, toStamp: endTime});
			// Use for loop for async
			for (let i=0; i< newPayload.length; i++) {
				const activity = newPayload[i];
				const id = activity.id;
				const oldActivityIndex = payloadMap[id];
				if (oldActivityIndex !== undefined) {
					const oldActivity = payload[oldActivityIndex];
					if (compareTrackMetaData(oldActivity, activity)) {
						console.log("Changes, so updating metadata and redownloading");
						payload[oldActivityIndex] = activity;
						await processActivity(activity,true,tolerance);
					}
				}
				else {
					console.log(`"${id}" Does not exist. Downloading and adding`);
					payload.push(activity);
					try {
						fullActivity = await processActivity(activity,true,tolerance);
					}
					catch (e) {
						console.error(`Error with process activity for ${id}`,e);
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
				console.error("unable to rename old file",ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE,JSON.stringify(payload,null,1));
		}
		else if (checkForNewer && checkForNewer !== 'false') {
			console.log("Last timestamp:",last);
			try {
				last = Math.floor(new Date(payload[0].start_date)/1000);
			}
			catch(e) {
				console.error("could not get date",e);
			}
			payload = await getTrackListPage({trackList:payload, fromStamp:last});
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
				console.error("unable to rename old file",ACTIVITY_LIST_CACHE_FILE);
			}
			fs.writeFileSync(ACTIVITY_LIST_CACHE_FILE,JSON.stringify(payload,null,1));
		}
		console.log("Number of activities:",payload.length);
		const {trackData,activities} = await processActivities({payload:payload, type:type, location:location, includePrivate:includePrivate, fromStamp: fromStamp,toStamp:toStamp, tolerance:tolerance});
		// return raw track data and kmlTrack
		const kmlTrack = printKml.head("tracks")+trackData+printKml.tail(config.default_latitude,config.default_longitude);
		return {activities, kmlTrack}
	}
	catch (e) {
		console.error("error",e)
	};
}

const processActivities = async ({payload, type, location={}, includePrivate=false, fromStamp, toStamp, tolerance}) => {
	let error = 0;
	let kmlTracks = '';
	let desiredActivities = payload;
	const searchType = TYPES[type];
	console.error(`Initial activities: ${payload.length}`);

	// filter the activities
	if (searchType) {
		desiredActivities = desiredActivities.filter(activity => {
			return (searchType.indexOf(activity.type) !== -1);
		});
		console.error(`Desired by type: ${desiredActivities.length}`);
	}
	if (!includePrivate || includePrivate === 'false') {
		desiredActivities = desiredActivities.filter(activity => {
			return (!activity.private);
		});
		console.log(`Desired after excluding private: ${desiredActivities.length}`);
	}
	if (location.min) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((activity.start_latlng[0] > location.min[0]) && 
				(activity.start_latlng[1] > location.min[1]))
		})
		console.log(`Desired by min latlng: ${desiredActivities.length}`);
	}
	if (location.max) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((activity.start_latlng[0] < location.max[0]) && 
				(activity.start_latlng[1] < location.max[1]))
		})
		console.log(`Desired by max latlng: ${desiredActivities.length}`);
	}
	if (fromStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)/1000) >= fromStamp)
		})
		console.log(`Desired by after fromStamp: ${desiredActivities.length}`);
	}
	if (toStamp) {
		desiredActivities = desiredActivities.filter(activity => {
			return ((new Date(activity.start_date)/1000) <= toStamp)
		})
		console.log(`Desired by after toStamp: ${desiredActivities.length}`);
	}

	// Get the track listing for each activity
	// May retrieve from cache or from API
	await Promise.all(desiredActivities.map(async (activity) => {
		if (!error) {
			try {
				//console.error("Processing activity:",activity);
				const trackData = await processActivity(activity,false,tolerance);
				kmlTracks += trackData;
			}
			catch (e) {
				++skipped;
				if (e?.statusCode !== 404) {
					console.error("process activity error. Aborting future requests:",e);
					++error;
				}
				else {
					console.error("404 error:",activity.id,activity.name,e?.statusCode,e?.options);
				}
			}
		}
		else {
			console.error("Not making request",error, "total skipped:",skipped);
		}
	}))
	return {trackData:kmlTracks,activities:desiredActivities};
}

const processActivity = async (activity, force=false, tolerance=TOLERANCE) => {
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
	let stream = null;
	if (!force && fs.existsSync(trackCacheFile)) {
		const file = fs.readFileSync(trackCacheFile);
		stream = JSON.parse(file);
		//console.error("FILE",file.toString());
	}
	else {
		if (called > MAX_TRACKS) {
			++skipped;
			console.error(`Not downloading ${id} because ${called} exceeds ${MAX_TRACKS}, skipped: ${skipped}`);
		}
		else if (!activity.hasOwnProperty('start_latlng') || !activity.start_latlng.length) {
			++skipped
			console.error(`Not downloading ${id} because no start lat_lng (skipped: ${skipped})`);
		}
		else {
			++called;
			stream = await strava.streams.activity({id:activity.id, types:'time,distance,latlng', resolution:'medium'});
			fs.writeFileSync(trackCacheFile,JSON.stringify(stream,null,1));
			console.warn("Wrote file",trackCacheFile);
		}
	}
	
	if (stream) {
		// The gpx contains an array of different type items. 
		// they can be in any order
		const latlngList = stream.find(list => list.type === 'latlng');
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
	console.log("Wrote to :",fileName);
	return fileName;
}

export const getAuthURL = () => {
	stravaApi.config({client_id:config.client_id, redirect_uri: `${config.redirect_uri}/code`});
	const authURL = stravaApi.oauth.getRequestAccessURL({scope:"read,activity:read_all"});
	return authURL;
}

export const getAuthToken = (code) => {
	console.log("getting token for code",code);
	return new Promise((resolve, reject) => {
		stravaApi.oauth.getToken(code, (err,data) => {
			if (err) {
				reject(err);
			}
			try {
				const token = data.body.access_token;
				resolve(token);
			}
			catch (e) {
				console.error("Error parsing token api results",e);
				reject(e);
			}
		});
	});
}

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
		console.error("Error with simplifyTrack",e);
	}
}

