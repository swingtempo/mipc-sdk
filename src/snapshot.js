'use strict';

const fs = require('fs');
const Session = require('./session');

/**
 * Snapshot and camera feed operations.
 */
class SnapshotManager {
  /**
   * @param {Session} session - Authenticated MIPC session
   */
  constructor(session) {
    if (!(session instanceof Session)) {
      throw new Error('SnapshotManager requires an authenticated Session instance');
    }
    this.session = session;
  }

  /**
   * Get a snapshot from a device.
   * Note: The MIPC gateway's ccm_pic_get endpoint often returns XML errors
   * (ccm.system.err) through the HTTP API. Real camera feeds use RTSP/HTTP
   * streaming via ccm_play — see PlaybackManager.getPlaybackUrl().
   *
   * @param {string} sn - Device serial number
   * @param {object} [options]
   * @param {'p0'|'p1'} [options.token='p0'] - Token for main (p0) or sub (p1) stream
   * @returns {Promise<Buffer|null>} JPEG image data, or null if endpoint unavailable
   */
  async get(sn, options = {}) {
    const token = options.token || 'p0';

    // Build the request with session nid
    this.session.seq++;
    const nid = require('./auth').createNid(this.session.seq, this.session.sid, this.session.shareKey, 0);

    let qs = `dsess=1&dsess_nid=${nid}&dsess_sn=${sn}&dtoken=${token}&dflag=2`;

    // Try gateway address first (snapshots may require direct access)
    if (this.session.addr) {
      try {
        const res = await this._getFromGateway(sn, nid, token);
        if (res.headers['content-type'] && res.headers['content-type'].includes('image')) {
          return res.body;
        }
      } catch (e) {
        // Fall through to proxy
      }
    }

    // Fallback: try via proxy
    const res = await this.session.apiRaw('/ccm/ccm_pic_get.jpg', {
      sn,
      token,
      dflag: 2,
    });

    if (res.headers['content-type'] && res.headers['content-type'].includes('image')) {
      return res.body;
    }

    // Not an image — the endpoint may not support snapshots via HTTP API.
    // Return null to indicate this, rather than throwing.
    return null;
  }

  /**
   * Get snapshot directly from gateway address (bypasses proxy).
   */
  _getFromGateway(sn, nid, token) {
    return new Promise((resolve, reject) => {
      const url = `http://${this.session.addr}/ccm/ccm_pic_get.jpg?dsess=1&dsess_nid=${nid}&dsess_sn=${sn}&dtoken=${token}&dflag=2`;
      require('http').get(url, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
      }).on('error', reject);
    });
  }

  /**
   * Get live stream URLs for a device (HTTP and RTSP).
   * This is the reliable way to access camera feeds.
   * @param {string} sn - Device serial number
   * @returns {Promise<{http: string, rtsp: string}>}
   */
  async getStreamUrls(sn) {
    const results = {};

    // ccm_play needs nested params: sess:{nid,sn}, setup:{stream,trans:{proto}}, token
    // explore.js uses obj_2_url({sess:{nid,sn},setup:{...},token:'p0'})
    for (const proto of ['http', 'rtsp']) {
      try {
        this.session.seq++;
        const nid = require('./auth').createNid(this.session.seq, this.session.sid, this.session.shareKey, 0);

        // Build nested params like explore.js does
        const params = { sess: { nid, sn }, setup: { stream: 'RTP_Unicast', trans: { proto } }, token: 'p0' };
        const qs = require('./auth').buildQueryString(params);

        const url = `${this.session.baseUrl}/ccm/ccm_play.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;
        const body = await this.session._get(url);

        // Parse response
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) {}
        if (!parsed && /^message\(/m.test(body)) {
          new Function('message', `${body.replace(/;\s*$/, '')}`)((o) => { parsed = o; });
        }

        const data = parsed?.data || parsed;
        // Response format: { MediaUri: { Uri: "..." }, ... }
        if (data.MediaUri && data.MediaUri.Uri) {
          results[proto] = data.MediaUri.Uri;
        } else if (data.uri && data.uri.url) {
          results[proto] = data.uri.url; // fallback for older format
        }
      } catch (e) {
        // Stream may not be available for this device
      }
    }

    return results;
  }

  /**
   * Get a snapshot as JSON metadata (instead of JPEG).
   * @param {string} sn - Device serial number
   * @param {object} [options]
   * @param {'p0'|'p1'} [options.token='p0']
   * @returns {Promise<object>} Snapshot metadata
   */
  async getJson(sn, options = {}) {
    const token = options.token || 'p0';

    this.session.seq++;
    // API calls use flag=0 (per fn_nid in explore.js)
    const nid = require('./auth').createNid(this.session.seq, this.session.sid, this.session.shareKey, 0);

    let qs = `dsess=1&dsess_nid=${nid}&dsess_sn=${sn}&dtoken=${token}&dencode_type=0&dpic_types_support=2&dflag=2`;
    const url = `${this.session.baseUrl}/ccm/ccm_pic_get.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;

    const body = await this.session._get(url);
    return require('./auth').parseResponse(body);
  }

  /**
   * Save a snapshot to disk.
   * @param {string} sn - Device serial number
   * @param {string} outputPath - File path to save the JPEG
   * @param {object} [options] - Options for get()
   */
  async save(sn, outputPath, options = {}) {
    const data = await this.get(sn, options);
    fs.writeFileSync(outputPath, data);
    return outputPath;
  }

  /**
   * Get snapshots from all devices.
   * @param {Array} devices - Array of device objects (from getDevices())
   * @param {object} [options]
   * @param {'p0'|'p1'} [options.token='p0']
   * @param {string} [options.outputDir='./snapshots'] - Directory to save snapshots
   * @returns {Promise<Array<object>>} Array of snapshot results
   */
  async saveAll(devices, options = {}) {
    const token = options.token || 'p0';
    const outputDir = options.outputDir || './snapshots';

    // Create output directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const results = [];
    for (const device of devices) {
      try {
        const sn = device.sn;
        const filename = `${outputDir}/snapshot_${sn}_${token}.jpg`;
        await this.save(sn, filename, options);
        results.push({ sn, token, path: filename, success: true });
      } catch (err) {
        results.push({ sn: device.sn, token, error: err.message, success: false });
      }
    }

    return results;
  }

  /**
   * Get the current snapshot URL for embedding in a browser.
   * Note: This generates a URL that requires authentication cookies/session.
   * For programmatic access, use get() instead.
   * @param {string} sn - Device serial number
   * @param {'p0'|'p1'} [token='p0']
   * @returns {string} Snapshot URL (for browser embedding)
   */
  snapshotUrl(sn, token = 'p0') {
    // This is a template — actual nid must be generated per-request
    return `${this.session.baseUrl}/ccm/ccm_pic_get.jpg?dtoken=${token}&dsess=1&dsess_sn=${sn}`;
  }
}

module.exports = SnapshotManager;
