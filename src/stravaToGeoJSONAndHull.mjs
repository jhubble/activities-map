import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * Groups tracks by intersection and generates hulls named with their size in sq miles.
 * @param {string[]} fileList - Array of file paths.
 */
export function getSpatialAnalysis(fileList) {
    let tracks = [];

    console.log(`\n🚀 High-speed analysis for ${fileList.length} files...`);
    console.time("⏱️ Execution Time");

    // 1. Load, Simplify, and Cache Bounding Boxes
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
                // Simplify to speed up intersection math without losing hull integrity
                const simplified = turf.simplify(turf.lineString(coords), { tolerance: 0.0005, highQuality: false });
                
                simplified.properties = { 
                    bbox: turf.bbox(simplified),
                    id: tracks.length 
                };
                tracks.push(simplified);
            }
        } catch (err) {
            console.error(`  ❌ Error reading ${path.basename(filePath)}:`, err.message);
        }
    });

    if (tracks.length === 0) return null;

    // 2. Build Adjacency List using BBox Pruning
    console.log(`🔍 Calculating intersections...`);
    const adj = Array.from({ length: tracks.length }, () => []);
    
    for (let i = 0; i < tracks.length; i++) {
        const bboxA = tracks[i].properties.bbox;

        for (let j = i + 1; j < tracks.length; j++) {
            const bboxB = tracks[j].properties.bbox;

            // Fast BBox Overlap Check
            const overlaps = !(bboxB[0] > bboxA[2] || bboxB[2] < bboxA[0] || 
                               bboxB[1] > bboxA[3] || bboxB[3] < bboxA[1]);

            if (overlaps && turf.booleanIntersects(tracks[i], tracks[j])) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
        if ((i + 1) % 50 === 0) process.stdout.write('.'); 
    }

    // 3. Find Connected Components
    console.log(`\n🧩 Grouping connected tracks...`);
    const visited = new Set();
    const groups = [];

    for (let i = 0; i < tracks.length; i++) {
        if (!visited.has(i)) {
            const groupPoints = [];
            const queue = [i];
            visited.add(i);

            while (queue.length > 0) {
                const u = queue.shift();
                groupPoints.push(...tracks[u].geometry.coordinates);
                for (const v of adj[u]) {
                    if (!visited.has(v)) {
                        visited.add(v);
                        queue.push(v);
                    }
                }
            }
            groups.push(groupPoints);
        }
    }

    // 4. Generate Hulls with Area Calculation
    console.log(`📐 Generating final hulls and measuring area...`);
    const hullFeatures = groups.map((points, idx) => {
        if (points.length < 3) return null;

        const ptCollection = turf.featureCollection(points.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection);

        if (hull) {
		// Calculate area in square miles
		const areaSqMeters = turf.area(hull);
		// Use the precise conversion factor
		const areaSqMiles = (areaSqMeters * 0.000000386102).toFixed(4); 

		// Safety check: If it's a tiny area, display in sq ft, otherwise sq miles
		let nameString = "";
		if (areaSqMiles < 0.001) {
		    const areaSqFt = (areaSqMeters * 10.7639).toFixed(1);
		    nameString = `Area ${idx + 1} (${areaSqFt} sq ft)`;
		} else {
		    nameString = `Area ${idx + 1} (${areaSqMiles} sq mi)`;
		}

            hull.properties = {
                name: nameString,
                stroke: "#CCCC00",
                color: "#CCCC00",
                fillColor: "#CCCC00",
                "fill-opacity": 0.4,
                weight: 3,
                fill: "#CCCC00",
                area_sq_mi: parseFloat(areaSqMiles)
            };
        }
        return hull;
    }).filter(Boolean);

    console.timeEnd("⏱️ Execution Time");
    console.log(`✨ Success! Created ${hullFeatures.length} yellow hulls.\n`);

    const finalFC = turf.featureCollection(hullFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
