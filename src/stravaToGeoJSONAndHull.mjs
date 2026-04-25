import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * High-performance spatial processor using simplification and clustering.
 * @param {string[]} fileList - Array of file paths.
 * @param {number} [bufferKm=0.01] - Connectivity threshold.
 * @param {number} [simplifyTolerance=0.005] - Tolerance for simplifying paths.
 * 0.001: High detail, slower.
 * 0.01: Very fast, slight loss of precision (perfect for hulls).
 */
export function getSpatialAnalysis(fileList, bufferKm = 0.01, simplifyTolerance = 0.005) {
    let allPaths = [];
    let pointCloud = [];

    console.time("⏱️ Total Execution Time");
    console.log(`\n🚀 Processing ${fileList.length} files...`);

    // 1. Optimized Parsing & Simplification
    fileList.forEach((filePath, index) => {
        try {
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let coords = [];

            // Extract coordinates based on format
            if (Array.isArray(rawData)) {
                const latLngObj = rawData.find(i => i.type === 'latlng');
                if (latLngObj?.data) {
                    coords = latLngObj.data.map(c => [c[1], c[0]]);
                    const nameObj = rawData.find(i => i.type === 'name');
                    allPaths.push(turf.lineString(coords, { name: nameObj ? nameObj.data : path.basename(filePath) }));
                }
            } else if (rawData.type === 'FeatureCollection' || rawData.type === 'Feature') {
                const fc = rawData.type === 'FeatureCollection' ? rawData : turf.featureCollection([rawData]);
                fc.features.forEach(f => {
                    if (f.geometry.type === 'LineString') {
                        coords = f.geometry.coordinates;
                        allPaths.push(f);
                    }
                });
            }

            if (coords.length > 0) {
                // THE SPEED FIX: Simplify the path before adding to point cloud
                // This removes redundant points on straight lines without changing the hull shape.
                const line = turf.lineString(coords);
                const simplified = turf.simplify(line, { tolerance: simplifyTolerance, highQuality: false });
                
                simplified.geometry.coordinates.forEach(c => {
                    pointCloud.push(turf.point(c));
                });
            }
        } catch (err) {
            console.error(`  ❌ Error: ${filePath}`, err.message);
        }
    });

    console.log(`  📉 Simplified point cloud from ~${allPaths.reduce((a, b) => a + b.geometry.coordinates.length, 0)} to ${pointCloud.length} points.`);

    // 2. Fast Clustering
    console.log(`🧩 Clustering groups...`);
    const pointsFC = turf.featureCollection(pointCloud);
    const clustered = turf.clustersDbscan(pointsFC, bufferKm, { units: 'kilometers', minPoints: 1 });

    // 3. Efficient Hull Generation
    const clusterMap = {};
    clustered.features.forEach(f => {
        const id = f.properties.cluster;
        if (id === undefined) return;
        if (!clusterMap[id]) clusterMap[id] = [];
        clusterMap[id].push(f.geometry.coordinates);
    });

    console.log(`📐 Drawing hulls for ${Object.keys(clusterMap).length} areas...`);
    const hullFeatures = Object.keys(clusterMap).map(id => {
        const coords = clusterMap[id];
        if (coords.length < 3) return null;
        
        const hull = turf.convex(turf.featureCollection(coords.map(c => turf.point(c))));
        if (hull) {
            hull.properties = { name: `Area ${parseInt(id) + 1}`, fill: "#ff7800", "fill-opacity": 0.25 };
        }
        return hull;
    }).filter(Boolean);

    // 4. Wrap up
    const finalGeoJSON = turf.featureCollection([...allPaths, ...hullFeatures]);
    const result = {
        geoJSON: finalGeoJSON,
        kml: tokml(finalGeoJSON, { name: 'name' })
    };

    console.timeEnd("⏱️ Total Execution Time");
    return result;
}
