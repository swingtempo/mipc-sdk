'use strict';

const Session = require('./session');

/**
 * Playback history and recording operations.
 */
class PlaybackManager {
  /**
   * @param {Session} session - Authenticated MIPC session
   */
  constructor(session) {
    if (!(session instanceof Session)) {
      throw new Error('PlaybackManager requires an authenticated Session instance');
    }
    this.session = session;
  }

  /**
   * Get playback timeline for a device.
   * @param {string} sn - Device serial number
   * @param {object} [options]
   * @param {number} [options.startTime] - Start time in Unix epoch seconds (default: 24h ago)
   * @param {number} [options.endTime] - End time in Unix epoch seconds (default: now)
   * @returns {Promise<object>} Playback timeline data with recording segments
   */
  async getTimeline(sn, options = {}) {
    const now = Math.floor(Date.now() / 1000);
    const startTime = options.startTime || (now - 86400); // default: last 24 hours
    const endTime = options.endTime || now;

    const res = await this.session.api('ccm_replay', {
      sn,
      start_time: startTime,
      end_time: endTime,
    });

    // Response format varies — check multiple paths for data
    if (res.data && res.data.ret) return res.data.ret;
    if (res.data && res.data.Result) return res.data.Result;
    if (res.ret) return res.ret;
    if (res.Result) return res.Result;
    return res;
  }

  /**
   * Get playback segments (recording blocks) for a device within a time range.
   * @param {string} sn - Device serial number
   * @param {number} startTime - Start time in Unix epoch seconds
   * @param {number} endTime - End time in Unix epoch seconds
   * @returns {Promise<Array>} Array of recording segments with start/end times
   */
  async getSegments(sn, startTime, endTime) {
    const timeline = await this.getTimeline(sn, { startTime, endTime });

    // Extract segments from the response
    // The exact structure depends on the gateway response format
    if (timeline.data && timeline.data.ret) {
      return timeline.data.ret;
    }
    if (Array.isArray(timeline.data)) {
      return timeline.data;
    }
    if (timeline.ret) {
      return timeline.ret;
    }

    // Return raw data for inspection
    return [timeline];
  }

  /**
   * Check if a device has recordings at a specific time.
   * @param {string} sn - Device serial number
   * @param {number} timestamp - Unix epoch seconds to check
   * @returns {Promise<boolean>} Whether recordings exist at that time
   */
  async hasRecording(sn, timestamp) {
    const segments = await this.getSegments(sn, timestamp - 3600, timestamp + 3600);
    return segments.length > 0;
  }

  /**
   * Get playback URL for a specific time range.
   * Note: Actual video streaming uses P2P/binnet protocol which requires
   * additional setup beyond HTTP API calls.
   * @param {string} sn - Device serial number
   * @param {number} startTime - Start time in Unix epoch seconds
   * @param {number} endTime - End time in Unix epoch seconds
   * @returns {Promise<object>} Playback info including stream URLs if available
   */
  async getPlaybackUrl(sn, startTime, endTime) {
    const res = await this.session.api('ccm_play', {
      sn,
      start_time: startTime,
      end_time: endTime,
      setup: {
        stream: 'RTP_Unicast',
        trans: { proto: 'http' },
      },
      token: 'p0',
    });

    return res.data || res;
  }

  /**
   * List available recording days for a device.
   * @param {string} sn - Device serial number
   * @param {number} monthsBack - Number of months to look back (default: 1)
   * @returns {Promise<Array<string>>} Array of dates with recordings (YYYY-MM-DD format)
   */
  async getRecordingDays(sn, monthsBack = 1) {
    const now = new Date();
    const startTime = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1).getTime() / 1000;
    const endTime = now.getTime() / 1000;

    const segments = await this.getSegments(sn, startTime, endTime);

    // Extract unique dates from segments
    const days = new Set();
    for (const seg of segments) {
      if (seg.start_time) {
        const d = new Date(seg.start_time * 1000);
        days.add(d.toISOString().split('T')[0]);
      }
    }

    return [...days].sort();
  }

  /**
   * Get detailed playback info for a specific recording segment.
   * @param {string} sn - Device serial number
   * @param {object} segment - Recording segment object (from getSegments)
   * @returns {Promise<object>} Detailed playback info
   */
  async getSegmentInfo(sn, segment) {
    const res = await this.session.api('ccm_replay', {
      sn,
      start_time: segment.start_time || segment.time_start,
      end_time: segment.end_time || segment.time_end,
    });

    return res.data || res;
  }

  /**
   * Get recording calendar — days that have recordings.
   * Uses ccm_box_get with flag=2 and zero time range.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} Calendar data with recording days
   */
  async getRecordingCalendar(sn) {
    const res = await this.session.boxGet({
      sn,
      flag: 2,
      start_time: 0,
      end_time: 0,
      search_type: 0,
      cid: -1,
      sid: -1,
      direction: 0,
      max_counts: 15000,
    });

    return res.data || res;
  }

  /**
   * Get detailed clip metadata for a specific date range.
   * Uses ccm_box_get with flag=8 and millisecond timestamps.
   * @param {string} sn - Device serial number
   * @param {number} startTimeMs - Start time in milliseconds (inclusive)
   * @param {number} endTimeMs - End time in milliseconds (exclusive)
   * @returns {Promise<object>} Clip metadata with segments
   */
  async getClipMetadata(sn, startTimeMs, endTimeMs) {
    const res = await this.session.boxGet({
      sn,
      flag: 8,
      start_time: startTimeMs,
      end_time: endTimeMs,
      search_type: 0,
      cid: -1,
      sid: -1,
      direction: 0,
      max_counts: 15000,
    });

    return res.data || res;
  }

  /**
   * Get all recording clips for the last N days.
   * @param {string} sn - Device serial number
   * @param {number} [daysBack=7] - Number of days to look back
   * @returns {Promise<Array>} Array of clip metadata objects
   */
  async getAllClips(sn, daysBack = 7) {
    const now = Date.now();
    const startTimeMs = now - (daysBack * 24 * 60 * 60 * 1000);
    return this.getClipMetadata(sn, startTimeMs, now);
  }
}

module.exports = PlaybackManager;
