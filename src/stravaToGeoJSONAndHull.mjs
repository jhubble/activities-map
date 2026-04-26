import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * High-speed intersection-based hull generation.
 * Uses Bounding Box pruning and path simplification.
 */
export function getSpatialAnalysis(fileList) {
    let tracks = [];

    console.log(`\n🚀 High-speed analysis for ${fileList.length} files...`);
    console.time("⏱️ Total Logic Time");

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
                // OPTIMIZATION 1: Simplify paths. Reduces coordinate count by ~90% 
                // while maintaining the intersection "footprint".
                const simplified = turf.simplify(turf.lineString(coords), { tolerance: 0.0005, highQuality: false });
                
                // OPTIMIZATION 2: Pre-calculate Bounding Box (BBox)
                // Checking if two rectangles overlap is 100x faster than checking line intersections.
                simplified.properties = { 
                    bbox: turf.bbox(simplified),
                    id: tracks.length 
                };
                tracks.push(simplified);
            }
        } catch (err) {
            console.error(`  ❌ Error: ${path.basename(filePath)}`, err.message);
        }
    });

    if (tracks.length === 0) return null;

    // 2. Build Adjacency List with Spatial Pruning
    console.log(`🔍 Checking intersections with BBox pruning...`);
    const adj = Array.from({ length: tracks.length }, () => []);
    
    for (let i = 0; i < tracks.length; i++) {
        const bboxA = tracks[i].properties.bbox;

        for (let j = i + 1; j < tracks.length; j++) {
            const bboxB = tracks[j].properties.bbox;

            // OPTIMIZATION 3: BBox Overlap Check
            // Standard: [minX, minY, maxX, maxY]
            const intersectsBBox = !(bboxB[0] > bboxA[2] || 
                                     bboxB[2] < bboxA[0] || 
                                     bboxB[1] > bboxA[3] || 
                                     bboxB[3] < bboxA[1]);

            if (intersectsBBox) {
                // Only run the expensive intersection test if the "boxes" touch
                if (turf.booleanIntersects(tracks[i], tracks[j])) {
                    adj[i].push(j);
                    adj[j].push(i);
                }
            }
        }
        if ((i + 1) % 50 === 0) process.stdout.write('.'); 
    }

    // 3. Group Connected Components (BFS)
    console.log(`\n🧩 Grouping...`);
    const visited = new Set();
    const groups = [];

    for (let i = 0; i < tracks.length; i++) {
        if (!visited.has(i)) {
            const groupPoints = [];
            const queue = [i];
            visited.add(i);

            while (queue.length > 0) {
                const u = queue.shift();
                // We only need the points for the final hull
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

    // 4. Final Hull Generation
    console.log(`📐 Generating hulls for ${groups.length} groups...`);
    const hullFeatures = groups.map((points, idx) => {
        if (points.length < 3) return null;

        const ptCollection = turf.featureCollection(points.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection);

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

    console.timeEnd("⏱️ Total Logic Time");
    console.log(`✨ Success! Created ${hullFeatures.length} outlines.`);

    const finalFC = turf.featureCollection(hullFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
