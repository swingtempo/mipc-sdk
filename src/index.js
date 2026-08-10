'use strict';

const Session = require('./session');
const SnapshotManager = require('./snapshot');
const PlaybackManager = require('./playback');
const auth = require('./auth');

/**
 * MIPC / Vimtag Cloud Camera SDK
 *
 * Provides a clean interface to:
 * - Authenticate with the MIPC cloud gateway
 * - Enumerate connected devices
 * - Capture snapshots from camera feeds
 * - Query playback history and recordings
 *
 * @example
 * const { MipcClient } = require('mipc-sdk');
 *
 * const client = new MipcClient({
 *   baseUrl: 'http://localhost:8080',  // or direct gateway URL
 *   username: 'myuser',
 *   password: 'mypassword',
 * });
 *
 * await client.connect();
 *
 * // List devices
 * const devices = await client.getDevices();
 * console.log(devices);
 *
 * // Get a snapshot
 * const snapshot = await client.takeSnapshot('DEVICE_SERIAL_NUMBER');
 * fs.writeFileSync('camera.jpg', snapshot);
 *
 * // Check playback history
 * const timeline = await client.getPlaybackTimeline('DEVICE_SERIAL_NUMBER');
 * console.log(timeline);
 */
class MipcClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - Base URL of the MIPC gateway/proxy
   * @param {string} options.username - MIPC account username
   * @param {string} options.password - MIPC account password
   */
  constructor(options) {
    if (!options || !options.baseUrl || !options.username || !options.password) {
      throw new Error('MipcClient requires baseUrl, username, and password');
    }

    this.session = new Session({
      baseUrl: options.baseUrl,
      username: options.username,
      password: options.password,
    });

    this.snapshots = new SnapshotManager(this.session);
    this.playback = new PlaybackManager(this.session);
  }

  /**
   * Authenticate with the MIPC gateway.
   * Must be called before any other operations.
   * @returns {Promise<MipcClient>} this (for chaining)
   */
  async connect() {
    await this.session.authenticate();
    return this;
  }

  // ---- Device enumeration --------------------------------------------------

  /**
   * Get the list of registered devices.
   * @param {number} [start=0] - Pagination offset
   * @param {number} [counts=1024] - Max results
   * @returns {Promise<Array>} Array of device objects with properties: sn, model, stat, nick, etc.
   */
  async getDevices(start = 0, counts = 1024) {
    return this.session.getDevices(start, counts);
  }

  /**
   * Get detailed information about a specific device.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} Device info object
   */
  async getDeviceInfo(sn) {
    return this.session.getDeviceInfo(sn);
  }

  /**
   * Get video source configuration for a device.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} Video sources config
   */
  async getVideoSources(sn) {
    return this.session.getVideoSources(sn);
  }

  // ---- Snapshots / Camera feeds --------------------------------------------

  /**
   * Capture a snapshot from a device's camera.
   * @param {string} sn - Device serial number
   * @param {object} [options]
   * @param {'p0'|'p1'} [options.token='p0'] - 'p0' for main stream, 'p1' for sub stream
   * @returns {Promise<Buffer>} JPEG image data
   */
  async takeSnapshot(sn, options = {}) {
    return this.snapshots.get(sn, options);
  }

  /**
   * Save a snapshot directly to disk.
   * @param {string} sn - Device serial number
   * @param {string} outputPath - File path to save the JPEG
   * @param {object} [options] - Options for takeSnapshot()
   */
  async saveSnapshot(sn, outputPath, options = {}) {
    return this.snapshots.save(sn, outputPath, options);
  }

  // ---- Playback history ----------------------------------------------------

  /**
   * Get playback timeline for a device.
   * @param {string} sn - Device serial number
   * @param {object} [options]
   * @param {number} [options.startTime] - Start time (Unix epoch seconds, default: 24h ago)
   * @param {number} [options.endTime] - End time (Unix epoch seconds, default: now)
   * @returns {Promise<object>} Playback timeline data
   */
  async getPlaybackTimeline(sn, options = {}) {
    return this.playback.getTimeline(sn, options);
  }

  /**
   * Get recording segments for a device.
   * @param {string} sn - Device serial number
   * @param {number} startTime - Start time (Unix epoch seconds)
   * @param {number} endTime - End time (Unix epoch seconds)
   * @returns {Promise<Array>} Recording segments
   */
  async getRecordingSegments(sn, startTime, endTime) {
    return this.playback.getSegments(sn, startTime, endTime);
  }

  /**
   * Get list of days with recordings for a device.
   * @param {string} sn - Device serial number
   * @param {number} [monthsBack=1] - Months to look back
   * @returns {Promise<Array<string>>} Dates in YYYY-MM-DD format
   */
  async getRecordingDays(sn, monthsBack = 1) {
    return this.playback.getRecordingDays(sn, monthsBack);
  }

  // ---- Utilities -----------------------------------------------------------

  /**
   * Get the current session state.
   * @returns {object} Session info (sid, seq, addr)
   */
  getSessionInfo() {
    return {
      sid: this.session.sid,
      seq: this.session.seq,
      addr: this.session.addr,
    };
  }

  /**
   * Make a raw authenticated API call.
   * @param {string} endpoint - Endpoint name (e.g., 'ccm_devs_get')
   * @param {object} [params={}] - Query parameters
   * @returns {Promise<object>} Parsed response
   */
  async api(endpoint, params = {}) {
    return this.session.api(endpoint, params);
  }

  /**
   * Get the underlying Session instance for advanced usage.
   * @returns {Session}
   */
  getSession() {
    return this.session;
  }
}

// Export everything
module.exports = {
  MipcClient,
  Session,
  SnapshotManager,
  PlaybackManager,
  auth,
};
