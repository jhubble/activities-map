# activities-map
Show activities from Strava (or others...) on a map

## Getting started

1. Install dependencies

    npm install

2. To use with Strava, set up a [Strava App](https://developers.strava.com/docs/getting-started/#account). 

3. Copy the configuration from [https://www.strava.com/settings/api](https://www.strava.com/settings/api)

4. copy straveCreds.json.example to stravaCreds.json

5. Enter the strava token client_id and client_secret in straveCreds.json

6. Start the app

    npm start

7. Starting the app will open in the browser. You can open on your own at http://localhost:8080

8. On the first screen, select "Auth with Strava". This will bring you to Strava Auth.

9. After authenticating, you will get to form to select options and render map.

## Usage notes

The app will download activities to the cache directory. allActivities.json will have a list of all activities. Each individual activity will be saved with #.json, with the number being the Strava activity number. Removing the track from the cache will allow it to be redownloaded later.

If you have a large number of activities, you may need to run multiple times to build up the cache. (Srava has limits to API calls within 15 minutes, so you will need to wait about 15 minutes between runs.

You can also generate maps solely from cached data without hiting Strava.

config.mjs has additional configuration parameters that can be modified.

## Viewing map

The kml file can be viewed directly in this app, using Open Street Map tiles or without a base map layer.  Other tile layers could be added in code.

The kml can also be imported to [Google my maps](https://www.google.com/mymaps).
Google allows a maximum of 2.5 MB for kml size. Hoewver, you can add multiple.
This allows you to browse google maps and see where you have gone, as well as click on a track to see the name and date.

## Background

I wanted to have a portable map available of where I've been. Some existing solutions helped, but I wanted to have something fully local.

[Strava heatmaps](https://support.strava.com/hc/en-us/articles/216918467-Personal-Heatmaps)
Strava requires a premium membership for heatmaps. There is no ability to export. 

[Jonathan O'Keeffe Multiple Ride Mapper](https://www.jonathanokeeffe.com/strava/map.php)
This is a great tool. I had used it to generate maps.
However, it had some trouble with kml export. I worked around it by copying the internal map structure and generating kml. However, it is also subject to API limits.

