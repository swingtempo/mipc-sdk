'use strict';

const crypto = require('crypto');
const CryptoJS = require('crypto-js');

// DH parameters (hardcoded, same as the MIPC gateway)
const PRIME = '791658605174853458830696113306796803';
const GENERATOR = 5;

// ---- BigInt modular exponentiation ----------------------------------------
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// ---- MD5 hex digest -------------------------------------------------------
function md5hex(s) {
  return crypto.createHash('md5').update(s, 'binary').digest('hex');
}

// ---- Base62 / Mining-Base64 encoding --------------------------------------
const S_BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const S_MINING64 = S_BASE62 + '_.-';

function fn_i2a(e, t) {
  let o, r, n, a = '', i = '' + e;
  if (i.indexOf('0x') === 0) {
    for (o = i.length - 1; o > 1;) {
      for (n = 0, r = 0; r < 8 && o > 1; --o, r += 4)
        n += hex2i(i.charCodeAt(o)) << r;
      a = String.fromCharCode(n) + a;
    }
  } else {
    for (o = 24; o >= 0; o -= 8)
      if (e >= (1 << o)) a += String.fromCharCode((e >> o) & 255);
  }
  while (a.length < (t || 0)) a = '\0' + a;
  return a;
}

function hex2i(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 71) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return 0;
}

function fn_str_2_b64(e, t) {
  let o, r, n, a, i = 0, l = '', s = e.length, c = t ? S_MINING64 : S_BASE62 + '+/=';
  while (i < s) {
    for (r = 0, o = 0; r < 24 && i < s; r += 8, ++i) o = (o << 8) + e.charCodeAt(i);
    for (a = 0; a < 24; a += 6, o &= (1 << (r - a)) - 1) {
      n = r - a - 6;
      l += a < r ? c.charAt(n < 0 ? o << -n : o >> n) : '';
    }
  }
  return l;
}

function fn_binary_2_b64(e, t) {
  let o, r, n, a, i = 0, l = '', s = e.length, c = t ? S_MINING64 : S_BASE62 + '+/=';
  while (i < s) {
    for (r = 0, o = 0; r < 24 && i < s; r += 8, i++) o = (o << 8) + e[i];
    for (a = 0; a < 24; a += 6, o &= (1 << (r - a)) - 1) {
      n = r - a - 6;
      l += a < r ? c.charAt(n < 0 ? o << -n : o >> n) : '';
    }
  }
  return l;
}

// ---- NID generation --------------------------------------------------------
/**
 * Generate a session nid matching the MIPC gateway's fn_nid function.
 * @param {number} seq - Request sequence number
 * @param {string} sid - Session ID (hex string like '0xf431c') or lid for login
 * @param {string} shareKey - DH shared secret
 * @param {number} [flag=0] - Request type flag: 2 for login, 0 for API calls
 * @returns {string} Encoded nid
 */
function createNid(seq, sid, shareKey, flag = 0) {
  const s = fn_i2a(seq);
  const c = sid ? fn_i2a(sid) : '';
  const d = (flag !== undefined && flag !== null) ? fn_i2a(flag) : '';
  const g = (s ? String.fromCharCode(64 + s.length) + s : '') +
            (c ? String.fromCharCode(96 + c.length) + c : '') +
            (d ? String.fromCharCode(128 + d.length) + d : '');
  const full = g + (shareKey ? String.fromCharCode(0 + shareKey.length) + shareKey : '');
  const nidHash = md5hex(full);
  const p = fn_i2a('0x' + nidHash);
  return fn_str_2_b64(String.fromCharCode(32 + p.length) + p + g, 1);
}

// ---- Object-to-URL-parameter flattening ------------------------------------
function obj2Url(obj) {
  const result = {};

  function flatten(current, prefix) {
    if (current === null || current === undefined) return;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      let name = key;
      if (('' + name).charAt(0) === '%') name = name.substr(1);
      const fullKey = prefix + ('0' !== name ? ('' === prefix ? 'd' : '_') + name : '');
      const val = current[key];
      if (typeof val !== 'function') {
        if (typeof val === 'object') {
          if (val.constructor === Uint8Array) {
            let hex = '';
            for (let i = 0; i < val.length; i++) hex += '%' + val[i].toString(16).padStart(2, '0');
            result[fullKey] = hex;
          } else if (Array.isArray(val)) {
            result[fullKey + '__x_countz_'] = val.length;
            for (let i = 0; i < val.length; i++) flatten({ [`_${i}`]: val[i] }, fullKey);
          } else {
            result[fullKey] = 1;
            flatten(val, fullKey);
          }
        } else {
          result[fullKey] = val;
        }
      }
    }
  }

  flatten(obj, '');
  return result;
}

function buildQueryString(params) {
  const flat = obj2Url(params);
  return Object.entries(flat).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ---- DES encryption helpers ------------------------------------------------
/**
 * MIPC's bytes_align: converts string to array of hex word strings.
 * This is the EXACT implementation from explore.js — do NOT change.
 */
function bytesAlign(str) {
  const words = [];
  for (let o = 0; o < str.length; o++) words.push(str.charCodeAt(o).toString(16));
  const padLen = 8 * (parseInt(str.length / 8) + 1) - str.length;
  const parts = [];
  let hexAccum = '';
  for (let s = 0; s < words.length; s++) {
    hexAccum += words[s];
    if (hexAccum.length === 8) { parts.push('0x' + hexAccum); hexAccum = ''; }
  }
  // Padding: first byte = padLen, rest = 0xff
  const padFirst = '0' + padLen.toString(16).padStart(2, '0');
  let padHex = padFirst;
  for (let p = 1; p < padLen; p++) padHex += 'ff';
  while (padHex.length > 8) { parts.push('0x' + padHex.substring(0, 8)); padHex = padHex.substring(8); }
  if (padHex.length > 0) parts.push('0x' + padHex.padEnd(8, '0'));
  return parts;
}

function strTo16bytes(hexStr) {
  const t = hexStr.length / 2;
  const o = [];
  for (let r = 0; r < t; r++) {
    o.push(parseInt('0x' + hexStr.charAt(2 * r) + hexStr.charAt(2 * r + 1)) & 255);
  }
  return o;
}

function encryptUctx(shareKey, obj) {
  const plaintext = JSON.stringify(obj);
  const keyWA = CryptoJS.MD5(shareKey);

  // Use explore.js's exact bytes_align approach: returns hex word strings
  const words = bytesAlign(plaintext);
  const sigBytes = 8 * (parseInt(plaintext.length / 8) + 1);
  const plainWA = CryptoJS.lib.WordArray.create(words.map(w => parseInt(w)), sigBytes);

  const enc = CryptoJS.DES.encrypt(plainWA, keyWA, {
    iv: CryptoJS.enc.Hex.parse('0000000000000000'),
    padding: CryptoJS.pad.NoPadding,
  });

  // Convert to byte-array base64 format MIPC expects (same as explore.js)
  const hex = enc.ciphertext.toString();
  return 'data:application/octet-stream;base64,' + fn_binary_2_b64(strTo16bytes(hex));
}

function encryptPassword(shareKey, passwordHex) {
  const keyWA = CryptoJS.enc.Hex.parse(md5hex(shareKey));
  const enc = CryptoJS.DES.encrypt(
    CryptoJS.enc.Hex.parse(passwordHex),
    keyWA,
    { iv: CryptoJS.enc.Hex.parse('0000000000000000'), padding: CryptoJS.pad.NoPadding }
  );
  return enc.ciphertext.toString();
}

// ---- Response parser -------------------------------------------------------
function parseResponse(body) {
  const trimmed = body.trim();

  // Try JSON first
  try { return JSON.parse(trimmed); } catch (e) {}

  // Try message(...) wrapper
  if (/^message\(/m.test(trimmed)) {
    let captured = null;
    try {
      const fn = new Function('message', `"use strict"; ${trimmed.replace(/;\s*$/, '')};`);
      fn((o) => { captured = o; });
      if (captured) return captured;
    } catch (e2) {}
  }

  return { __raw: body };
}

module.exports = {
  PRIME,
  GENERATOR,
  modPow,
  md5hex,
  createNid,
  obj2Url,
  buildQueryString,
  encryptUctx,
  encryptPassword,
  parseResponse,
};
