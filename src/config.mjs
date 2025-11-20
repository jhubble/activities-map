import fs from 'fs';
import { logger } from './loggerSetup.mjs';
import {packageDirectorySync} from 'package-directory';
import { fileURLToPath } from 'url';

// Log level is defined in loggerSetup.mjs

// This is the public config file
// Config parameters can be added here
// However, any credentials should only be added to stravaCreds (and not checked in)

const dirname = packageDirectorySync();
logger.trace("dirname",dirname);
const CREDS = `${dirname}/stravaCreds.json`;
let stravaCreds = {};
logger.info("Creds file:",CREDS);
if (fs.existsSync(CREDS)) {
	logger.debug("Reading Strava Creds from:",CREDS);
	stravaCreds = JSON.parse(fs.readFileSync(CREDS));
}
	

export default {
  // Port the local service runs on (default 8080)
  "run_on_port": 8080,

  // where to redirect after performing strava auth
  "redirect_uri"  : "http://localhost:8080",

  // default centering of map and filter range
  "default_latitude": "47.6",
  "default_longitude": "-122.33",
  // default in form for degrees from center to filter
  "location_distance_lat": "2",
  "location_distance_long":"2",

  // Tolerance is divided by 10,000
  // 10 is about one city block   
  // higher number is more smoothing (smaller file, lower accuracy)
  // 2 - simplest. Gets most locations with some smoothing
  //
  // .3 - gets GPS gitters
  // .5 - some curves without many gitters
  // 1 - good layout. Eliminates most jitters, but also misses some curves
  // .5 - 1 seem the best range
  // set to null to not simplify
  "tolerance":  .6,

  // directories - relative to current directory or absolute
  "cache_dir" : `${dirname}/cache`,
  "output_dir" : `${dirname}/out`,

  // maximum number of tracks to download at a time from strava
  // should be under maximum 15 minute Strava limit
  // will need to rerun 15 minutes later to continue building cache
  "max_tracks_at_a_time" : 550,

  // interval in minutes when the API counter resets
  API_RESET_TIME : 15,

  // Different types of activities to download
  // Key is the name that will appear in form
  // The value is an array of different strava event types
  // null will get all activity types
  activity_types: {
        Foot: ["Run","Walk","Hike"],
        Bike: ["Ride"],
        Run: ["Run"],
        Hike: ["Hike"],
        Walk: ["Walk"],
        All: null,
	Bike_Foot: ["Run","Walk","Hike","Ride"]
  },
  
  ...stravaCreds,
}
