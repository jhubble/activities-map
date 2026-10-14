declare module '@mapbox/togeojson' {
  export function kml(doc: any, options?: object): GeoJSON.FeatureCollection;
  export function gpx(doc: any, options?: object): GeoJSON.FeatureCollection;
}

declare module 'tokml' {
  interface TokmlOptions {
    documentName?: string;
    documentDescription?: string;
    name?: string;
    description?: string;
    simplestyle?: boolean;
    timestamp?: string;
  }
  function tokml(geojson: GeoJSON.Feature | GeoJSON.FeatureCollection | GeoJSON.Geometry, options?: TokmlOptions): string;
  export default tokml;
}

declare module 'simplify-geojson' {
  function simplify<T extends GeoJSON.Feature | GeoJSON.FeatureCollection | GeoJSON.Geometry>(
    geojson: T,
    tolerance?: number
  ): T;
  export default simplify;
}

// Augment the npm 'geojson' library
declare module 'geojson' {
  export * from 'geojson';
  export function parse(
    data: any[],
    properties: Record<string, any>,
    callback?: (result: any) => void
  ): any;
}

declare module 'package-directory' {
  export function packageDirectorySync(options?: { cwd?: string }): string | undefined;
  export function packageDirectory(options?: { cwd?: string }): Promise<string | undefined>;
}
