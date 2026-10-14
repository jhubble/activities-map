import { describe, it, expect } from 'vitest';
import { dedupStravaDuplicates } from '../src/getStravaActivities.js';
import { placemark, tail, head } from '../src/kmlExport.js';
import { escapeHtml } from '../src/utils/html.js';
import type { StravaActivity } from '../src/types/index.js';

describe('escapeHtml utility', () => {
  it('escapes dangerous HTML characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
  });

  it('handles null and undefined safely', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('kmlExport functions', () => {
  it('generates a valid placemark block', () => {
    const p = placemark('Morning Run', '-122.33,47.6,0');
    expect(p).toContain('<name>Morning Run</name>');
    expect(p).toContain('<coordinates>-122.33,47.6,0</coordinates>');
  });

  it('generates kml head and tail correctly', () => {
    const h = head('Test Title');
    expect(h).toContain('<name>Test Title</name>');
    expect(h).toContain('<?xml version="1.0" encoding="UTF-8"?>');

    const t = tail('47.6', '-122.33');
    expect(t).toContain('<latitude>47.6</latitude>');
    expect(t).toContain('<longitude>-122.33</longitude>');
    expect(t).toContain('</kml>');
  });
});

describe('dedupStravaDuplicates', () => {
  it('removes duplicate group activities within 5-minute window', () => {
    const baseDate = new Date('2024-05-01T10:00:00Z').toISOString();
    const closeDate = new Date('2024-05-01T10:02:00Z').toISOString();

    const activities: StravaActivity[] = [
      {
        id: 1,
        name: 'Group Ride 1',
        type: 'Ride',
        start_date: baseDate,
        start_date_local: baseDate,
        private: false,
        elapsed_time: 1200,
        moving_time: 1100,
        distance: 10000,
        total_elevation_gain: 100,
        athlete_count: 2
      },
      {
        id: 2,
        name: 'Group Ride 2 (Dupe)',
        type: 'Ride',
        start_date: closeDate,
        start_date_local: closeDate,
        private: true,
        elapsed_time: 1210,
        moving_time: 1100,
        distance: 10010,
        total_elevation_gain: 100,
        athlete_count: 2
      }
    ];

    const result = dedupStravaDuplicates(activities);
    expect(result.filteredList.length).toBe(1);
    expect(result.filteredList[0].id).toBe(1);
    expect(result.filteredList[0].removed_count).toBe(1);
    expect(result.removalLogs.length).toBe(1);
  });

  it('ignores short activities under 400 seconds', () => {
    const date = new Date('2024-05-01T10:00:00Z').toISOString();
    const activities: StravaActivity[] = [
      {
        id: 10,
        name: 'Super Short Test',
        type: 'Run',
        start_date: date,
        start_date_local: date,
        private: false,
        elapsed_time: 200,
        moving_time: 190,
        distance: 500,
        total_elevation_gain: 5
      }
    ];

    const result = dedupStravaDuplicates(activities);
    expect(result.filteredList.length).toBe(0);
  });
});
