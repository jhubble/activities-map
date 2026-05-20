import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

// TODO: Use the already simplified versions in KML so that we match
// This uses a higher number which does more simplification
// Other takes tolerance from form and divides by 10000
//const tol = 0.0005;
// const tol = 0.000006;

/**
 * High-speed track grouping via Union-Find and deferred Hull generation.
 * Eliminates iterative turf.union memory bloat and stack overflows.
 */
export function getSpatialAnalysis(fileList, intersectionFudgeMeters = 10, simplifyTolerance = 0.0003) {
    console.log(`\n🚀 Processing ${fileList.length} files with Fast Union-Find...`);
    console.time("⏱️ Total Execution Time");

    const fudgeKm = intersectionFudgeMeters / 1000;
    let items = [];

    // 1. Ingest, Lightweight Simplify, and Pre-calculate Footprints
    fileList.forEach((filePath, index) => {
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

            if (coords.length < 2) return;

            // Generate an approximate collision buffer to detect visual intersection gaps
            const rawLine = turf.lineString(coords);
            const simplified = turf.simplify(rawLine, { tolerance: simplifyTolerance, highQuality: false });
            const collisionPoly = turf.buffer(simplified, fudgeKm, { units: 'kilometers' });

            items.push({
                id: items.length,
                file: path.basename(filePath),
                rawPoints: coords,
                collisionPoly: collisionPoly,
                bbox: turf.bbox(collisionPoly)
            });

            if ((index + 1) % 100 === 0) console.log(`  📂 Loaded ${index + 1} files...`);
        } catch (err) {
            console.error(`  ❌ Error parsing file:`, err.message);
        }
    });

    const N = items.length;
    if (N === 0) return null;

    // 2. Initialize Union-Find (Disjoint-Set Forest)
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;

    function find(i) {
        let root = i;
        while (root !== parent[root]) {
            root = parent[root];
        }
        // Path compression
        let curr = i;
        while (curr !== root) {
            let nxt = parent[curr];
            parent[curr] = root;
            curr = nxt;
        }
        return root;
    }

    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            parent[rootI] = rootJ;
        }
    }

    // 3. Process Intersections Using Bounding Box Filtering
    console.log(`🔍 Mapping spatial intersections...`);
    for (let i = 0; i < N; i++) {
        const itemA = items[i];
        const bboxA = itemA.bbox;

        for (let j = i + 1; j < N; j++) {
            // Skip checking if they are already confirmed to be in the same network
            if (find(i) === find(j)) continue;

            const itemB = items[j];
            const bboxB = itemB.bbox;

            // Highly performant bounding box overlap check
            const overlapsBBox = !(bboxB[0] > bboxA[2] || bboxB[2] < bboxA[0] || 
                                   bboxB[1] > bboxA[3] || bboxB[3] < bboxA[1]);

            if (overlapsBBox) {
                if (turf.booleanIntersects(itemA.collisionPoly, itemB.collisionPoly)) {
                    union(i, j);
                }
            }
        }
    }

    // 4. Collect Point Aggregates via Compressed Groups
    console.log(`🧩 Aggregating structural clusters...`);
    const groupMap = new Map();
    for (let i = 0; i < N; i++) {
        const root = find(i);
        if (!groupMap.has(root)) {
            groupMap.set(root, []);
        }
        groupMap.get(root).push(...items[i].rawPoints);
    }

    // 5. Generate Final Hulls
    console.log(`📐 Constructing final hulls for ${groupMap.size} system(s)...`);
    let idx = 1;
    const hullFeatures = [];

    for (const [rootId, points] of groupMap.entries()) {
        if (points.length < 3) continue;

        const ptCollection = turf.featureCollection(points.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection);

        if (hull) {
            const areaSqMiles = (turf.area(hull) * 0.000000386102).toFixed(2);

            hull.properties = {
                name: `Area Component ${idx++} (${areaSqMiles} sq mi)`,
                stroke: "#FFFF00",
                color: "#FFFF00",
                fillColor: "#FFFF00",
                "fill-opacity": 0.4,
                weight: 3,
                fill: "#FFFF00",
                area_sq_mi: parseFloat(areaSqMiles)
            };
            hullFeatures.push(hull);
        }
    }

    console.timeEnd("⏱️ Total Execution Time");
    console.log(`✨ Success! Output contains ${hullFeatures.length} clean outlines.\n`);

    const finalFC = turf.featureCollection(hullFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
