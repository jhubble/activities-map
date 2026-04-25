import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * Processes Strava-style JSON or standard GeoJSON files to produce 
 * convex hulls around connected paths.
 * * @param {string[]} fileList - Array of absolute or relative file paths.
 * @param {number} [bufferKm=0] - Distance to bridge gaps between separate paths.
 * * Appropriate bufferKm values:
 * - 0: (Default) No bridging. Only perfectly touching paths are grouped.
 * - 0.001 to 0.003: (1-3 meters) Ideal for bridging GPS drift on the same trail.
 * - 0.01: (10 meters) Bridges gaps across standard two-lane roads.
 * - 0.05: (50 meters) Group activities within the same small park or block.
 * * @returns {Object|null} { geoJSON: Object, kml: string } or null if no data found.
 */
export function getSpatialAnalysis(fileList, bufferKm = 0) {
    let allFeatures = [];

    fileList.forEach(filePath => {
        try {
            const rawContent = fs.readFileSync(filePath, 'utf8');
            const rawData = JSON.parse(rawContent);
            
            // --- 1. Identify and Parse Data Type ---
            
            // Case A: Strava internal stream format (Array of objects)
            if (Array.isArray(rawData)) {
                const latLngObj = rawData.find(i => i.type === 'latlng');
                const nameObj = rawData.find(i => i.type === 'name');
                
                if (latLngObj && latLngObj.data) {
                    const activityName = nameObj ? nameObj.data : path.basename(filePath);
                    // Standardize: [lat, lng] -> [lng, lat]
                    const coords = latLngObj.data.map(c => [c[1], c[0]]);
                    
                    allFeatures.push(turf.lineString(coords, { 
                        name: activityName, 
                        source: 'strava_json' 
                    }));
                }
            } 
            // Case B: Standard GeoJSON
            else if (rawData.type === 'FeatureCollection' || rawData.type === 'Feature') {
                const fc = rawData.type === 'FeatureCollection' ? rawData : turf.featureCollection([rawData]);
                allFeatures.push(...fc.features);
            }
        } catch (err) {
            console.error(`Error processing file ${filePath}:`, err.message);
        }
    });

    if (allFeatures.length === 0) return null;

    // --- 2. Connectivity Logic ---
    
    // We create a temporary set of geometries to determine "connectedness"
    // If bufferKm > 0, we expand paths so they overlap even if they are slightly apart.
    let discoveryFeatures = allFeatures;
    if (bufferKm > 0) {
        discoveryFeatures = allFeatures.map(f => turf.buffer(f, bufferKm, { units: 'kilometers' }));
    }

    // Combine all (potentially buffered) paths and flatten them into distinct "islands"
    const combined = turf.combine(turf.featureCollection(discoveryFeatures));
    const flattened = turf.flatten(combined);

    // --- 3. Hull Generation ---
    
    const hullFeatures = flattened.features.map(f => {
        const hull = turf.convex(f);
        if (hull) {
            hull.properties = {
                name: "Activity Boundary",
                fill: "#ff7800",
                "fill-opacity": 0.2,
                stroke: "#ff7800",
                "stroke-width": 2
            };
        }
        return hull;
    }).filter(h => h !== null);

    // --- 4. Package Results ---
    
    const finalGeoJSON = turf.featureCollection([...allFeatures, ...hullFeatures]);

    return {
        geoJSON: finalGeoJSON,
        kml: tokml(finalGeoJSON, { name: 'name' })
    };
}
