'use strict';

/**
 * Example usage of the MIPC SDK.
 *
 * Set environment variables:
 *   MIPC_BASE=http://localhost:8080
 *   MIPC_USER=your_username
 *   MIPC_PASS=your_password
 */

const { MipcClient } = require('./src/index');
const fs = require('fs');
const path = require('path');

async function main() {
  const baseUrl = process.env.MIPC_BASE || 'http://localhost:8080';
  const username = process.env.MIPC_USER;
  const password = process.env.MIPC_PASS;

  if (!username || !password) {
    console.log('Usage: MIPC_USER=xxx MIPC_PASS=xxx node test.js');
    console.log(`Current BASE: ${baseUrl}`);
    return;
  }

  // Create client and connect
  const client = new MipcClient({ baseUrl, username, password });

  try {
    console.log('Connecting to MIPC gateway...');
    await client.connect();
    console.log('Connected! Session:', client.getSessionInfo());

    // List devices
    console.log('\n--- Devices ---');
    const devices = await client.getDevices();
    for (const dev of devices) {
      console.log(`  ${dev.sn} | ${dev.model} | status: ${dev.stat} | nick: "${dev.nick || '(none)'}"`);
    }

    // Take snapshots from each device
    if (devices.length > 0) {
      console.log('\n--- Snapshots ---');
      const outputDir = path.join(__dirname, 'test-snapshots');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      for (const dev of devices) {
        try {
          // Main stream snapshot
          const snapPath = path.join(outputDir, `snapshot_${dev.sn}_p0.jpg`);
          await client.saveSnapshot(dev.sn, snapPath, { token: 'p0' });
          console.log(`  Snapshot [${dev.sn} p0]: ${snapPath}`);

          // Sub stream snapshot (if available)
          try {
            const subPath = path.join(outputDir, `snapshot_${dev.sn}_p1.jpg`);
            await client.saveSnapshot(dev.sn, subPath, { token: 'p1' });
            console.log(`  Snapshot [${dev.sn} p1]: ${subPath}`);
          } catch (e) {
            console.log(`  Snapshot [${dev.sn} p1]: not available (${e.message})`);
          }
        } catch (e) {
          console.log(`  Snapshot [${dev.sn}]: error - ${e.message}`);
        }
      }
    }

    // Get playback timeline for first device
    if (devices.length > 0) {
      const dev = devices[0];
      console.log('\n--- Playback Timeline ---');
      try {
        const now = Math.floor(Date.now() / 1000);
        const timeline = await client.getPlaybackTimeline(dev.sn, {
          startTime: now - 86400, // last 24 hours
          endTime: now,
        });
        console.log('  Timeline data:', JSON.stringify(timeline).slice(0, 500));

        // Get recording segments
        const segments = await client.getRecordingSegments(dev.sn, now - 86400, now);
        if (segments.length > 0) {
          console.log(`  Found ${segments.length} recording segment(s)`);
          for (const seg of segments.slice(0, 5)) {
            const start = new Date((seg.start_time || seg.time_start) * 1000).toISOString();
            const end = new Date((seg.end_time || seg.time_end) * 1000).toISOString();
            console.log(`    ${start} → ${end}`);
          }
        } else {
          console.log('  No recordings found in the last 24 hours');
        }

        // Get recording days
        const days = await client.getRecordingDays(dev.sn, 1);
        if (days.length > 0) {
          console.log(`  Recording days: ${days.join(', ')}`);
        }
      } catch (e) {
        console.log('  Playback error:', e.message);
      }
    }

    // Get device info for first device
    if (devices.length > 0) {
      const dev = devices[0];
      console.log('\n--- Device Info ---');
      try {
        const info = await client.getDeviceInfo(dev.sn);
        console.log('  ', JSON.stringify(info, null, 2).slice(0, 500));
      } catch (e) {
        console.log('  Device info error:', e.message);
      }

      // Get video sources
      console.log('\n--- Video Sources ---');
      try {
        const vs = await client.getVideoSources(dev.sn);
        console.log('  ', JSON.stringify(vs, null, 2).slice(0, 500));
      } catch (e) {
        console.log('  Video sources error:', e.message);
      }
    }

    // Test raw API call
    console.log('\n--- Raw API ---');
    try {
      const dateInfo = await client.api('ccm_date_get', {});
      console.log('  Date/time:', JSON.stringify(dateInfo, null, 2).slice(0, 300));
    } catch (e) {
      console.log('  Raw API error:', e.message);
    }

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
