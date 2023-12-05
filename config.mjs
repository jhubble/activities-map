import fs from 'fs';

// This is the public config file
// Config parameters can be added here
// However, any credentials should only be added to stravaCreds (and not checked in)

const CREDS = 'stravaCreds.json';
let stravaCreds = {};
if (fs.existsSync(CREDS)) {
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
  "cache_dir" : "cache",
  "output_dir" : "out",

  // maximum number of tracks to download at a time from strava
  // should be under maximum 15 minute Strava limit
  // will need to rerun 15 minutes later to continue building cache
  "max_tracks_at_a_time" : 550,

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
        All: null
  },
  ...stravaCreds,
}
