import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * Groups tracks based on physical intersection and generates a single hull per group.
 * @param {string[]} fileList - Array of file paths.
 */
export function getSpatialAnalysis(fileList) {
    let tracks = [];

    console.log(`\n🚀 Analyzing intersections for ${fileList.length} files...`);

    // 1. Load and Parse Tracks
    fileList.forEach((filePath) => {
        try {
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let coords = [];

            if (Array.isArray(rawData)) {
                const latLngObj = rawData.find(i => i.type === 'latlng');
                if (latLngObj?.data) coords = latLngObj.data.map(c => [c[1], c[0]]);
            } else if (rawData.type === 'FeatureCollection' || rawData.type === 'Feature') {
                const fc = rawData.type === 'FeatureCollection' ? rawData : turf.featureCollection([rawData]);
                fc.features.forEach(f => {
                    if (f.geometry?.type === 'LineString') coords.push(...f.geometry.coordinates);
                });
            }

            if (coords.length > 1) {
                // We keep the full LineString for intersection testing
                tracks.push(turf.lineString(coords, { id: tracks.length, file: path.basename(filePath) }));
            }
        } catch (err) {
            console.error(`  ❌ Error: ${path.basename(filePath)}`, err.message);
        }
    });

    if (tracks.length === 0) return null;

    // 2. Build Adjacency List (Who touches whom?)
    console.log(`🔍 Checking intersections (this may take a moment for large sets)...`);
    const adj = Array.from({ length: tracks.length }, () => []);
    
    for (let i = 0; i < tracks.length; i++) {
        for (let j = i + 1; j < tracks.length; j++) {
            // Check if Line i intersects Line j
            // Note: booleanIntersects is much faster than lineIntersect
            if (turf.booleanIntersects(tracks[i], tracks[j])) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
        if ((i + 1) % 20 === 0) process.stdout.write('.'); 
    }

    // 3. Find Connected Components (Grouping)
    console.log(`\n🧩 Grouping connected tracks...`);
    const visited = new Set();
    const groups = [];

    for (let i = 0; i < tracks.length; i++) {
        if (!visited.has(i)) {
            const group = [];
            const queue = [i];
            visited.add(i);

            while (queue.length > 0) {
                const u = queue.shift();
                group.push(tracks[u]);
                for (const v of adj[u]) {
                    if (!visited.has(v)) {
                        visited.add(v);
                        queue.push(v);
                    }
                }
            }
            groups.push(group);
        }
    }

    // 4. Create one Hull per Group
    console.log(`📐 Generating hulls for ${groups.length} connected group(s)...`);
    const hullFeatures = groups.map((group, idx) => {
        // Collect every single point from every track in this group
        const allCoords = group.reduce((acc, track) => acc.concat(track.geometry.coordinates), []);
        
        if (allCoords.length < 3) return null;

        const points = turf.featureCollection(allCoords.map(c => turf.point(c)));
        const hull = turf.convex(points);

        if (hull) {
            hull.properties = {
                name: `Connected System ${idx + 1}`,
                stroke: "#FFFF00",
                color: "#FFFF00",
                fillColor: "#FFFF00",
                "fill-opacity": 0.4,
                weight: 3,
                fill: "#FFFF00"
            };
        }
        return hull;
    }).filter(Boolean);

    console.log(`✨ Success! Created ${hullFeatures.length} outlines.`);

    const finalFC = turf.featureCollection(hullFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
