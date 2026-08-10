'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { PRIME, GENERATOR, modPow, md5hex, createNid, buildQueryString, encryptUctx, encryptPassword, parseResponse } = require('./auth');

/**
 * Manages a MIPC session — authentication, sequence tracking, nid generation.
 */
class Session {
  /**
   * @param {object} options
   * @param {string} options.baseUrl - Base URL of the MIPC gateway (e.g., 'http://localhost:8080')
   * @param {string} [options.username] - MIPC username
   * @param {string} [options.password] - MIPC password
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.username = options.username;
    this.password = options.password;

    // Session state (populated after login)
    this.sid = null;       // session id
    this.seq = 0;          // request sequence counter
    this.shareKey = null;  // DH shared secret
    this.privKey = null;   // our private DH key (needed for share key computation)
    this.addr = null;      // gateway address from login response

    // Cached device list
    this.devices = [];
  }

  /**
   * Perform full authentication: DH exchange + login.
   * @returns {Promise<Session>} this (for chaining)
   */
  async authenticate() {
    if (!this.username || !this.password) {
      throw new Error('Username and password are required');
    }

    // Step 1: DH key exchange
    const dhResult = await this._dhExchange();
    console.log(`[MIPC] DH exchange: tid=${dhResult.tid}, lid=${dhResult.lid}`);

    // Compute shared secret
    this.shareKey = modPow(BigInt(dhResult.key_b2a), this.privKey, BigInt(PRIME)).toString();

    // Step 2: Login
    const loginResult = await this._login(dhResult);
    console.log(`[MIPC] Login successful: sid=${loginResult.sid}, seq=${loginResult.seq}`);

    this.sid = loginResult.sid;
    this.seq = loginResult.seq || 1;
    this.addr = loginResult.addr;

    return this;
  }

  /**
   * Perform DH key exchange with the gateway.
   */
  async _dhExchange() {
    const priv = BigInt('0x' + crypto.randomBytes(8).toString('hex'));
    this.privKey = priv;
    const pub = modPow(BigInt(GENERATOR), priv, BigInt(PRIME));

    const params = {
      bnum_prime: PRIME,
      root_num: GENERATOR,
      key_a2b: pub.toString(),
      tid: Math.floor(0xf8e92f9 * Math.random()),
    };

    const qs = buildQueryString(params);
    const url = `${this.baseUrl}/ccm/cacs_dh_req.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;

    const body = await this._get(url);
    const parsed = parseResponse(body);
    const data = parsed.data || parsed;

    if (data.result) {
      throw new Error(`DH exchange failed: ${JSON.stringify(data.result)}`);
    }

    return data;
  }

  /**
   * Authenticate with the gateway.
   */
  async _login(dhResult) {
    const pwdHex = md5hex(this.password);
    const uctx = encryptUctx(this.shareKey, { app: {} });
    // Login uses flag=2 (per fn_nid in explore.js)
    const nid = createNid(1, dhResult.lid, this.shareKey, 2);

    const params = {
      lid: dhResult.lid,
      nid: nid,
      user: this.username,
      pass: encryptPassword(this.shareKey, pwdHex),
      session_req: 1,
      param: [
        { name: 'spv', value: 'v1' },
        { name: 'uctx', value: uctx },
      ],
    };

    const qs = buildQueryString(params);
    const url = `${this.baseUrl}/ccm/cacs_login_req.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;

    const body = await this._get(url);
    const parsed = parseResponse(body);
    const data = parsed.data || parsed;

    if (data.result) {
      throw new Error(`Login failed: ${JSON.stringify(data.result)}`);
    }

    return data;
  }

  /**
   * Make an authenticated API request.
   * @param {string} endpoint - Endpoint name (without .js extension, e.g., 'ccm_devs_get')
   * @param {object} params - Additional query parameters
   * @returns {Promise<object>} Parsed response data
   */
  async api(endpoint, params = {}) {
    this.seq++;
    // API calls use flag=0 (per fn_nid in explore.js)
    const nid = createNid(this.seq, this.sid, this.shareKey, 0);

    // Wrap session info in sess object (matching UI pattern)
    const sessParams = Object.assign({ nid }, params);
    const qs = buildQueryString({ sess: sessParams });

    const url = `${this.baseUrl}/ccm/${endpoint}.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;
    const body = await this._get(url);
    return parseResponse(body);
  }

  /**
   * Make a raw authenticated request (for binary responses like snapshots).
   * @param {string} path - Full path including extension (e.g., '/ccm/ccm_pic_get.jpg')
   * @param {object} params - Query parameters
   * @returns {Promise<{body: Buffer|string, headers: object}>}
   */
  async apiRaw(path, params = {}) {
    this.seq++;
    // API calls use flag=0 (per fn_nid in explore.js)
    const nid = createNid(this.seq, this.sid, this.shareKey, 0);

    // Build query string manually for raw requests
    let qs = `dsess=1&dsess_nid=${nid}&dsess_sn=`;
    if (params.sn) qs += params.sn;
    delete params.sn;
    for (const [k, v] of Object.entries(params)) {
      qs += `&d${k}=${encodeURIComponent(v)}`;
    }

    const url = `${this.baseUrl}${path}?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;
    return this._getRaw(url);
  }

  /**
   * Make an HTTP GET request and return body as string.
   */
  _get(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 mipc-sdk' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
    });
  }

  /**
   * Make an HTTP GET request and return body as Buffer.
   */
  _getRaw(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 mipc-sdk' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on('error', reject);
    });
  }

  /**
   * Get the list of devices. Caches result for subsequent calls.
   * @param {number} [start=0] - Offset for pagination
   * @param {number} [counts=1024] - Max results
   * @returns {Promise<Array>} Array of device objects
   */
  async getDevices(start = 0, counts = 1024) {
    if (this.devices.length > 0) return this.devices;

    // Try ccm_devs_get first (used by the UI)
    let res = await this.api('ccm_devs_get', { start, counts });
    if (res.data && res.data.devs) {
      this.devices = res.data.devs;
      return this.devices;
    }

    // Fallback to ccm_exdev_get
    res = await this.api('ccm_exdev_get', { start, counts });
    if (res.data && res.data.ret) {
      this.devices = res.data.ret;
      return this.devices;
    }

    // Last resort: try data directly
    if (res.data && Array.isArray(res.data)) {
      this.devices = res.data;
      return this.devices;
    }

    throw new Error(`Could not fetch devices. Response: ${JSON.stringify(res).slice(0, 500)}`);
  }

  /**
   * Get detailed info for a specific device.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} Device info
   */
  async getDeviceInfo(sn) {
    const res = await this.api('ccm_dev_info_get', { sn });
    return res.data || res;
  }

  /**
   * Get video source configuration for a device.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} Video sources
   */
  async getVideoSources(sn) {
    const res = await this.api('ccm_video_srcs_get', { sn });
    return res.data || res;
  }

  /**
   * Get camera connection/streaming info.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} IPCS info
   */
  async getIpcsInfo(sn) {
    // API calls use flag=0 (per fn_nid in explore.js)
    const nid = createNid(++this.seq, this.sid, this.shareKey, 0);
    const qs = buildQueryString({ sess: { nid, sn } });
    const url = `${this.baseUrl}/ccm/ccm_ipcs_get.js?hfrom_handle=${Math.floor(Math.random() * 1000000)}&hqid=&${qs}`;
    const body = await this._get(url);
    return parseResponse(body);
  }

  /**
   * Get current date/time from the gateway.
   * @param {string} [sn] - Optional device serial number
   * @returns {Promise<object>} Date/time info
   */
  async getDate(sn) {
    const params = sn ? { sn } : {};
    const res = await this.api('ccm_date_get', params);
    return res.data || res;
  }

  /**
   * Get NTP configuration for a device.
   * @param {string} sn - Device serial number
   * @returns {Promise<object>} NTP info
   */
  async getNtp(sn) {
    const res = await this.api('ccm_ntp_get', { sn });
    return res.data || res;
  }

  /**
   * Subscribe to device events/notifications.
   * @returns {Promise<object>} Subscription info
   */
  async subscribe() {
    const res = await this.api('ccm_subscribe');
    return res.data || res;
  }

  /**
   * Create a message queue for async communication.
   * @param {number} [timeout=30000] - Timeout in ms
   * @returns {Promise<object>} MQ info with mqid
   */
  async createMessageQueue(timeout = 30000) {
    const res = await this.api('mmq_create', { timeout });
    return res.data || res;
  }

  /**
   * Get server info.
   * @returns {Promise<object>} Server info
   */
  async getInfo() {
    const res = await this.api('ccm_info_get');
    return res.data || res;
  }
}

module.exports = Session;
