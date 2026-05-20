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
 * Optimally groups and merges connected tracks on-the-fly during parsing.
 * @param {string[]} fileList - Array of file paths.
 * @param {number} [intersectionFudgeMeters=10] - Distance tolerance to bridge visual intersections.
 * @param {number} [simplifyTolerance=0.0003] - Tolerance for simplifying paths before testing intersections.
 */
export function getSpatialAnalysis(fileList, intersectionFudgeMeters = 10, simplifyTolerance = 0.0003) {
    // Array of groups: each group contains { rawPoints: [lng,lat][], collisionPolygon: Feature }
    let groups = [];

    console.log(`\n🚀 Processing ${fileList.length} files with On-the-Fly Merging...`);
    console.time("⏱️ Total Execution Time");

    const fudgeKm = intersectionFudgeMeters / 1000;

    fileList.forEach((filePath, index) => {
        try {
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let coords = [];

            // 1. Standard Extraction
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

            // 2. Prepare the incoming track's collision footprint
            const rawLine = turf.lineString(coords);
            const simplified = turf.simplify(rawLine, { tolerance: simplifyTolerance, highQuality: false });
            const incomingCollision = turf.buffer(simplified, fudgeKm, { units: 'kilometers' });
            const incomingBbox = turf.bbox(incomingCollision);

            // Track indices of existing groups that this new track intersects with
            let matchingGroupIndices = [];

            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];

                // Fast Bounding Box check
                const overlapsBBox = !(incomingBbox[0] > group.bbox[2] || incomingBbox[2] < group.bbox[0] ||
                                       incomingBbox[1] > group.bbox[3] || incomingBbox[3] < group.bbox[1]);

                if (overlapsBBox) {
                    if (turf.booleanIntersects(incomingCollision, group.collisionPolygon)) {
                        matchingGroupIndices.push(i);
                    }
                }
            }

            // 3. Resolve Merging Logic
            if (matchingGroupIndices.length === 0) {
                // Scenario A: Fresh track doesn't touch anything. Create a new group.
                groups.push({
                    rawPoints: coords,
                    collisionPolygon: incomingCollision,
                    bbox: incomingBbox
                });
            } else if (matchingGroupIndices.length === 1) {
                // Scenario B: Touches exactly one group. Append points and fuse collision geometry.
                const targetIdx = matchingGroupIndices[0];
                groups[targetIdx].rawPoints.push(...coords);

                const unioned = turf.union(turf.featureCollection([groups[targetIdx].collisionPolygon, incomingCollision]));
                if (unioned) {
                    groups[targetIdx].collisionPolygon = unioned;
                    groups[targetIdx].bbox = turf.bbox(unioned);
                }
            } else {
                // Scenario C: The "Bridge" Track. It connects multiple previously separated groups.
                const targetIdx = matchingGroupIndices[0];
                let combinedPoints = [...groups[targetIdx].rawPoints, ...coords];
                let collisionCollection = [groups[targetIdx].collisionPolygon, incomingCollision];

                // Gather data from the other matching groups and mark them for deletion
                for (let k = 1; k < matchingGroupIndices.length; k++) {
                    const extraIdx = matchingGroupIndices[k];
                    combinedPoints.push(...groups[extraIdx].rawPoints);
                    collisionCollection.push(groups[extraIdx].collisionPolygon);
                }

                // Remove the merged groups from the main array (descending order to keep indices valid)
                for (let k = matchingGroupIndices.length - 1; k > 0; k--) {
                    groups.splice(matchingGroupIndices[k], 1);
                }

                // Update the root group with all combined assets
                groups[targetIdx].rawPoints = combinedPoints;
                const grandUnion = turf.union(turf.featureCollection(collisionCollection));
                if (grandUnion) {
                    groups[targetIdx].collisionPolygon = grandUnion;
                    groups[targetIdx].bbox = turf.bbox(grandUnion);
                }
            }

            if ((index + 1) % 25 === 0 || index === fileList.length - 1) {
                console.log(`  📂 Processed ${index + 1}/${fileList.length} files... Active groups: ${groups.length}`);
            }

        } catch (err) {
            console.error(`  ❌ Error processing file:`, err.message);
        }
    });

    // 4. Generate Polygons from final grouped points
    console.log(`\n📐 Constructing final convex hulls for ${groups.length} distinct system(s)...`);
    const hullFeatures = groups.map((group, idx) => {
        if (group.rawPoints.length < 3) return null;

        const ptCollection = turf.featureCollection(group.rawPoints.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection);

        if (hull) {
            const areaSqMiles = (turf.area(hull) * 0.000000386102).toFixed(2);

            hull.properties = {
                name: `Area Component ${idx + 1} (${areaSqMiles} sq mi)`,
                stroke: "#FFFF00",
                color: "#FFFF00",
                fillColor: "#FFFF00",
                "fill-opacity": 0.4,
                weight: 3,
                fill: "#FFFF00",
                area_sq_mi: parseFloat(areaSqMiles)
            };
        }
        return hull;
    }).filter(Boolean);

    console.timeEnd("⏱️ Total Execution Time");
    console.log(`✨ Success! Output contains ${hullFeatures.length} clean outlines.\n`);

    const finalFC = turf.featureCollection(hullFeatures);
    return {
        geoJSON: finalFC,
        kml: tokml(finalFC, { name: 'name' })
    };
}
