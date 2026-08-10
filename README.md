# mipc-sdk

Node.js SDK for the **MIPC / Vimtag cloud camera platform**. Provides programmatic access to:

- **Device enumeration** — list all registered cameras with details
- **Snapshots** — capture JPEG images from live feeds (main & sub streams)
- **Playback history** — query recording timelines and segments
- **Camera info** — video sources, NTP, device configuration

## Installation

```bash
npm install ./mipc-sdk   # or publish to npm first
```

Or clone and link:

```bash
cd mipc-sdk && npm install
```

## Quick Start

```javascript
const { MipcClient } = require('mipc-sdk');

// Create client (use local server.js proxy or direct gateway URL)
const client = new MipcClient({
  baseUrl: 'http://localhost:8080',  // proxies to live MIPC gateway
  username: 'your_mipc_username',
  password: 'your_mipc_password',
});

// Connect (DH key exchange + login)
await client.connect();

// List devices
const devices = await client.getDevices();
for (const dev of devices) {
  console.log(`${dev.sn} — ${dev.model} (${dev.nick})`);
}

// Take a snapshot
const jpeg = await client.takeSnapshot('DEVICE_SERIAL_NUMBER', { token: 'p0' });
require('fs').writeFileSync('camera.jpg', jpeg);

// Check playback history (last 24h)
const timeline = await client.getPlaybackTimeline('DEVICE_SERIAL_NUMBER');
console.log(timeline);
```

## API Reference

### `new MipcClient(options)`

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | string | Gateway URL (e.g., `http://localhost:8080`) |
| `username` | string | MIPC account username |
| `password` | string | MIPC account password |

### `client.connect()`

Performs DH key exchange and login. Must be called before any other method.

### `client.getDevices([start], [counts])` → `Promise<Array>`

Returns array of device objects: `{ sn, model, stat, nick, ... }`.

### `client.takeSnapshot(sn, options)` → `Promise<Buffer>`

Capture a JPEG snapshot from the camera.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `'p0' \| 'p1'` | `'p0'` | Main stream (`p0`) or sub stream (`p1`) |

### `client.saveSnapshot(sn, outputPath, [options])` → `Promise<string>`

Save a snapshot directly to disk.

### `client.getPlaybackTimeline(sn, options)` → `Promise<object>`

Get recording timeline for the last N hours.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startTime` | number | 24h ago | Start time (Unix epoch seconds) |
| `endTime` | number | now | End time (Unix epoch seconds) |

### `client.getRecordingSegments(sn, startTime, endTime)` → `Promise<Array>`

Get recording segments with start/end times.

### `client.getRecordingDays(sn, [monthsBack])` → `Promise<string[]>`

List dates that have recordings (YYYY-MM-DD format).

### Advanced: Raw API access

```javascript
// Access underlying session for custom endpoints
const session = client.getSession();
const result = await session.api('ccm_dev_info_get', { sn: 'DEVICE_SN' });

// Or use the raw api() method
const info = await client.api('ccm_dev_info_get', { sn: 'DEVICE_SN' });
```

## Architecture

The SDK mirrors the MIPC web app's authentication flow:

1. **DH Key Exchange** — Diffie-Hellman with hardcoded prime/generator parameters
2. **Login** — DES-CBC encrypted credentials with session nid generation
3. **Authenticated API** — Each request includes a sequence-based nid derived from (seq, sid, shareKey)

## Using the Local Proxy

For development, run `server.js` in the parent directory to proxy requests:

```bash
cd .. && node server.js
# Then use baseUrl: 'http://localhost:8080'
```

The server proxies `/ccm/*`, `/cmipcgw/*`, etc. to the live MIPC gateway (`ovca22.mipcm.com:7443`).

## License

MIT
