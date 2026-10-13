export interface AppConfig {
  run_on_port: number;
  redirect_uri: string;
  default_latitude: string;
  default_longitude: string;
  location_distance_lat: string;
  location_distance_long: string;
  tolerance: number | null;
  cache_dir: string;
  output_dir: string;
  max_tracks_at_a_time: number;
  API_RESET_TIME: number;
  activity_types: Record<string, string[] | null>;
  client_id?: string | number;
  client_secret?: string;
  [key: string]: any;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type?: string;
  start_date: string;
  start_date_local: string;
  timezone?: string;
  start_latlng?: [number, number];
  end_latlng?: [number, number];
  private: boolean;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  athlete_count?: number;
  upload_id?: number | null;
  gear_id?: string;
  steps?: number;
  removed_count?: number;
  [key: string]: any;
}

export interface ActivityFilterCounts {
  totalActivities?: number;
  byType?: number;
  nonPrivate?: number;
  minlatlng?: number;
  maxlatlng?: number;
  afterStartTime?: number;
  afterEndTime?: number;
  afterDedup?: number;
  skipped?: number;
  noDataTracks?: number;
  [key: string]: number | undefined;
}

export interface GetStuffOptions {
  type?: string;
  checkForNewer?: boolean | string;
  location?: {
    center?: [number | string, number | string];
    dist?: [number | string, number | string];
    min?: [number, number];
    max?: [number, number];
  };
  includePrivate?: boolean | string;
  fromStamp?: number | string;
  toStamp?: number | string;
  token?: string;
  tolerance?: number | null;
  refresh?: boolean | string;
  dedup?: boolean | string;
  stats?: boolean;
  tiles?: string;
  showHulls?: boolean | string;
  location_center_lat?: string;
  location_center_long?: string;
  location_distance_lat?: string;
  location_distance_long?: string;
  [key: string]: any;
}

export interface GetStuffResult {
  activities: StravaActivity[];
  kmlTrack: string;
  activityProcessCounts: ActivityFilterCounts;
}
