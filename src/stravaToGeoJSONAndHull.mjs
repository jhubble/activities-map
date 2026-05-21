// TODO: Use the already simplified versions in KML so that we match
// This uses a higher number which does more simplification
// Other takes tolerance from form and divides by 10000
//const tol = 0.0005;
// const tol = 0.000006;
import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import tokml from 'tokml';

/**
 * Advanced track analyzer with visual style differentiation for nested/intersecting components
 * and automated relational tracking output logs.
 */
export function getSpatialAnalysis(fileList, intersectionFudgeMeters = 10, simplifyTolerance = 0.0003) {
    console.log(`\n🚀 Processing ${fileList.length} files...`);
    console.time("⏱️ Total Execution Time");

    const fudgeKm = intersectionFudgeMeters / 1000;
    let items = [];

    // 1. Ingest, Simplify, and Calculate Track Lengths
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

            const rawLine = turf.lineString(coords);
            const trackMiles = turf.length(rawLine, { units: 'miles' });
            const simplified = turf.simplify(rawLine, { tolerance: simplifyTolerance, highQuality: false });
            const collisionPoly = turf.buffer(simplified, fudgeKm, { units: 'kilometers' });

            items.push({
                id: items.length,
                rawPoints: coords,
                trackMiles: trackMiles,
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

    // 2. Union-Find Setup
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;

    function find(i) {
        let root = i;
        while (root !== parent[root]) root = parent[root];
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
        if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    // 3. Process Intersections
    console.log(`🔍 Mapping spatial intersections...`);
    for (let i = 0; i < N; i++) {
        const itemA = items[i];
        const bboxA = itemA.bbox;

        for (let j = i + 1; j < N; j++) {
            if (find(i) === find(j)) continue;

            const itemB = items[j];
            const bboxB = itemB.bbox;

            const overlapsBBox = !(bboxB[0] > bboxA[2] || bboxB[2] < bboxA[0] || 
                                   bboxB[1] > bboxA[3] || bboxB[3] < bboxA[1]);

            if (overlapsBBox && turf.booleanIntersects(itemA.collisionPoly, itemB.collisionPoly)) {
                union(i, j);
            }
        }
    }

    // 4. Aggregate Points, Track Mileage, and Track Counts
    console.log(`🧩 Aggregating data into clusters...`);
    const groupMap = new Map();
    for (let i = 0; i < N; i++) {
        const root = find(i);
        if (!groupMap.has(root)) {
            groupMap.set(root, { points: [], totalTrackMiles: 0, trackCount: 0 });
        }
        const data = groupMap.get(root);
        data.points.push(...items[i].rawPoints);
        data.totalTrackMiles += items[i].trackMiles;
        data.trackCount += 1;
    }

    // 5. Generate Initial Hulls
    console.log(`📐 Constructing base hulls...`);
    let tempHulls = [];
    let idx = 1;

    for (const [rootId, data] of groupMap.entries()) {
        if (data.points.length < 3) continue;

        const ptCollection = turf.featureCollection(data.points.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection);

        if (hull) {
            const areaSqMiles = turf.area(hull) * 0.000000386102;
            
            hull.properties = {
                id: idx++,
                area_sq_mi: parseFloat(areaSqMiles.toFixed(2)),
                total_track_mi: parseFloat(data.totalTrackMiles.toFixed(2)),
                track_count: data.trackCount,
                relationship: "Independent", 
                related_to: []
            };
            
            hull.bbox = turf.bbox(hull); 
            tempHulls.push(hull);
        }
    }

    // 6. Cross-Hull Relationship Identification
    console.log(`📡 Analyzing relationships between hulls...`);
    let relationshipLog = [];

    for (let i = 0; i < tempHulls.length; i++) {
        for (let j = 0; j < tempHulls.length; j++) {
            if (i === j) continue;

            const hullA = tempHulls[i];
            const hullB = tempHulls[j];

            // Evaluate if Hull B is strictly larger in area than Hull A
            if (hullB.properties.area_sq_mi <= hullA.properties.area_sq_mi) continue;

            const overlaps = !(hullB.bbox[0] > hullA.bbox[2] || hullB.bbox[2] < hullA.bbox[0] || 
                               hullB.bbox[1] > hullA.bbox[3] || hullB.bbox[3] < hullA.bbox[1]);

            if (overlaps) {
                if (turf.booleanContains(hullB, hullA)) {
                    hullA.properties.relationship = "Fully Contained";
                    hullA.properties.related_to.push(`Area Component ${hullB.properties.id}`);
                    relationshipLog.push(`  🔹 Area Component ${hullA.properties.id} is fully contained within Area Component ${hullB.properties.id}`);
                } else if (turf.booleanIntersects(hullA, hullB)) {
                    if (hullA.properties.relationship !== "Fully Contained") {
                        hullA.properties.relationship = "Intersects";
                    }
                    hullA.properties.related_to.push(`Area Component ${hullB.properties.id}`);
                    relationshipLog.push(`  🔸 Area Component ${hullA.properties.id} intersects with Area Component ${hullB.properties.id}`);
                }
            }
        }
    }

    // 7. Sort Hulls by Area (Descending) for Layer Stacking in Leaflet
    tempHulls.sort((a, b) => b.properties.area_sq_mi - a.properties.area_sq_mi);

    // 8. Final Naming and Specific Visual Style Formats
    const finalFeatures = tempHulls.map(hull => {
        const props = hull.properties;
        let relationshipContext = "";
        
        if (props.relationship !== "Independent") {
            relationshipContext = ` [${props.relationship} inside ${props.related_to.join(', ')}]`;
        }

        props.name = `Area Component ${props.id} (${props.area_sq_mi} sq mi) - Tracks: ${props.track_count}, Distance: ${props.total_track_mi} mi${relationshipContext}`;
        
        // DIFFERENTIATED TREATMENT FOR NESTED/INTERSECTING HULLS
        if (props.relationship !== "Independent") {
            // Treatment for smaller sub-hulls: Thick dashed green outline with high opacity
            props.stroke = "#00FF00";         // Green border
            props.color = "#00FF00";          // Leaflet mapping property
            props.fillColor = "#00FF00";      // Leaflet interior fill color
            props["fill-opacity"] = 0.25;     // Lighter fill density so underlying tracks show
            props.weight = 4;                 // Thicker stroke weight
            props.dashArray = "5, 10";        // Dashed border styling for Leaflet
            props.fill = "#00FF00";           // KML Property
        } else {
            // Treatment for independent/large parent hulls: Solid Yellow
            props.stroke = "#FFFF00";
            props.color = "#FFFF00";
            props.fillColor = "#FFFF00";
            props["fill-opacity"] = 0.4;
            props.weight = 2;
            props.dashArray = null;           // Solid border line
            props.fill = "#FFFF00";
        }

        delete hull.bbox; 
        return hull;
    });

    console.timeEnd("⏱️ Total Execution Time");
    console.log(`✨ Success! Output contains ${finalFeatures.length} structured hulls.`);
    
    // Print the requested intersection/containment relationship log to the console
    if (relationshipLog.length > 0) {
        console.log(`\n📋 Cross-Hull Relationship Inventory:`);
        console.log(relationshipLog.join('\n'));
        console.log("");
    } else {
        console.log(`\n📋 Cross-Hull Relationship Inventory: No overlapping components detected.\n`);
    }

    const finalFC = turf.featureCollection(finalFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
