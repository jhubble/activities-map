import fs from 'fs';
import * as turf from '@turf/turf';
import tokml from 'tokml';
import RBush from 'rbush';

export interface SpatialAnalysisResult {
    geoJSON: GeoJSON.FeatureCollection;
    kml: string;
}

interface TrackItem {
    id: number;
    rawPoints: GeoJSON.Position[];
    trackMiles: number;
    collisionPoly: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    bbox: GeoJSON.BBox;
}

interface RBushItem {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    id: number;
}

interface GroupData {
    points: GeoJSON.Position[];
    totalTrackMiles: number;
    trackCount: number;
}

/**
 * Advanced track analyzer with visual style differentiation for nested/intersecting components
 * and automated relational tracking output logs.
 * Uses RBush spatial index for fast intersection testing.
 */
export async function getSpatialAnalysis(
    fileList: string[],
    intersectionFudgeMeters: number = 10,
    simplifyTolerance: number = 0.0003,
    progress?: (message: string) => void
): Promise<SpatialAnalysisResult | null> {
    console.log(`\n🚀 Processing ${fileList.length} files...`);
    progress?.(`Spatial analysis starting for ${fileList.length} track files…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    console.time("⏱️ Total Execution Time");

    const fudgeKm = intersectionFudgeMeters / 1000;
    const items: TrackItem[] = [];

    // 1. Ingest, Simplify, and Calculate Track Lengths
    for (const [index, filePath] of fileList.entries()) {
        try {
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let coords: GeoJSON.Position[] = [];

            if (Array.isArray(rawData)) {
                const latLngObj = rawData.find((i: any) => i.type === 'latlng');
                if (latLngObj?.data) coords = latLngObj.data.map((c: [number, number]) => [c[1], c[0]]);
            } else if (rawData.type === 'FeatureCollection' || rawData.type === 'Feature') {
                const fc: GeoJSON.FeatureCollection = rawData.type === 'FeatureCollection' ? rawData : turf.featureCollection([rawData]);
                fc.features.forEach((f: GeoJSON.Feature) => {
                    if (f.geometry?.type === 'LineString') {
                        coords.push(...(f.geometry as GeoJSON.LineString).coordinates);
                    }
                });
            }

            if (coords.length < 2) continue;

            const rawLine = turf.lineString(coords);
            const trackMiles = turf.length(rawLine, { units: 'miles' });
            const simplified = turf.simplify(rawLine, { tolerance: simplifyTolerance, highQuality: false });
            const collisionPoly = turf.buffer(simplified, fudgeKm, { units: 'kilometers' }) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | undefined;

            if (!collisionPoly) continue;

            items.push({
                id: items.length,
                rawPoints: coords,
                trackMiles: trackMiles,
                collisionPoly: collisionPoly,
                bbox: turf.bbox(collisionPoly)
            });

            if ((index + 1) % 100 === 0) {
                console.log(`  📂 Loaded ${index + 1} files...`);
                progress?.(`Spatial analysis: loaded ${index + 1} of ${fileList.length} files…`);
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        } catch (err: any) {
            console.error(`  ❌ Error parsing file:`, err.message);
        }
    }

    const N = items.length;
    progress?.(`Spatial analysis: loaded ${fileList.length} files; analyzing ${N} tracks…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    if (N === 0) return null;

    // 2. Union-Find Setup
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;

    function find(i: number): number {
        let root = i;
        while (root !== parent[root]) root = parent[root];
        let curr = i;
        while (curr !== root) {
            const nxt = parent[curr];
            parent[curr] = root;
            curr = nxt;
        }
        return root;
    }

    function union(i: number, j: number): void {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    // 3. Process Intersections using RBush Spatial Index
    console.log(`🔍 Mapping spatial intersections with RBush spatial index...`);
    progress?.(`Spatial analysis: mapping track intersections…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const tree = new RBush<RBushItem>();
    const treeItems: RBushItem[] = items.map(item => ({
        minX: item.bbox[0],
        minY: item.bbox[1],
        maxX: item.bbox[2],
        maxY: item.bbox[3],
        id: item.id
    }));
    tree.load(treeItems);

    for (let i = 0; i < N; i++) {
        if (i > 0 && i % 100 === 0) {
            progress?.(`Spatial analysis: checking intersections for track ${i + 1} of ${N}…`);
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        const itemA = items[i];
        const bboxA = itemA.bbox;

        // Query spatial index for candidate bounding boxes
        const candidates = tree.search({
            minX: bboxA[0],
            minY: bboxA[1],
            maxX: bboxA[2],
            maxY: bboxA[3]
        });

        for (const candidate of candidates) {
            const j = candidate.id;
            // Only test upper triangle pairs to avoid duplicate checks
            if (j <= i) continue;
            if (find(i) === find(j)) continue;

            const itemB = items[j];
            if (turf.booleanIntersects(itemA.collisionPoly, itemB.collisionPoly)) {
                union(i, j);
            }
        }
    }

    // 4. Aggregate Points, Track Mileage, and Track Counts
    console.log(`🧩 Aggregating data into clusters...`);
    progress?.(`Spatial analysis: aggregating connected track clusters…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const groupMap = new Map<number, GroupData>();
    for (let i = 0; i < N; i++) {
        const root = find(i);
        if (!groupMap.has(root)) {
            groupMap.set(root, { points: [], totalTrackMiles: 0, trackCount: 0 });
        }
        const data = groupMap.get(root)!;
        data.points.push(...items[i].rawPoints);
        data.totalTrackMiles += items[i].trackMiles;
        data.trackCount += 1;
    }

    // 5. Generate Initial Hulls
    console.log(`📐 Constructing base hulls...`);
    progress?.(`Spatial analysis: constructing area hulls…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    let tempHulls: Array<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> & { bbox?: GeoJSON.BBox }> = [];
    let idx = 1;

    for (const [, data] of groupMap.entries()) {
        if (data.points.length < 3) continue;

        const ptCollection = turf.featureCollection(data.points.map(p => turf.point(p)));
        const hull = turf.convex(ptCollection) as (GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> & { bbox?: GeoJSON.BBox }) | null;

        if (hull) {
            const areaSqMiles = turf.area(hull) * 0.000000386102;

            hull.properties = {
                id: idx++,
                area_sq_mi: parseFloat(areaSqMiles.toFixed(2)),
                total_track_mi: parseFloat(data.totalTrackMiles.toFixed(2)),
                track_count: data.trackCount,
                relationship: "Independent",
                related_to: [] as string[]
            };

            hull.bbox = turf.bbox(hull);
            tempHulls.push(hull);
        }
    }

    // 6. Cross-Hull Relationship Identification
    console.log(`📡 Analyzing relationships between hulls...`);
    progress?.(`Spatial analysis: analyzing relationships between hulls…`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const relationshipLog: string[] = [];

    for (let i = 0; i < tempHulls.length; i++) {
        for (let j = 0; j < tempHulls.length; j++) {
            if (i === j) continue;

            const hullA = tempHulls[i];
            const hullB = tempHulls[j];
            const bboxA = hullA.bbox!;
            const bboxB = hullB.bbox!;

            // Evaluate if Hull B is strictly larger in area than Hull A
            if (hullA.properties && hullB.properties && hullB.properties.area_sq_mi <= hullA.properties.area_sq_mi) continue;

            const overlaps = !(bboxB[0] > bboxA[2] || bboxB[2] < bboxA[0] ||
                               bboxB[1] > bboxA[3] || bboxB[3] < bboxA[1]);

            if (overlaps && hullA.properties && hullB.properties) {
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
    tempHulls.sort((a, b) => b.properties!.area_sq_mi - a.properties!.area_sq_mi);

    // 8. Final Naming and Specific Visual Style Formats
    const finalFeatures = tempHulls.map(hull => {
        const props = hull.properties!;
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
    progress?.(`Spatial analysis complete: ${finalFeatures.length} area hulls generated.`);

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
