#!/usr/bin/env node
/**
 * MIPC SDK Demo — Camera enumeration & capture tool
 * 
 * For each camera:
 *   1. Enumerates ALL available video sources and their URLs (names, types, endpoints)
 *   2. Downloads a current snapshot frame from the live stream
 *   3. Records a 5-second clip from the live stream
 * 
 * Note: Cloud HTTP API does NOT support downloading recorded playback clips.
 * Playback requires binnet/P2P protocol (direct device connection).
 * 
 * Usage:
 *   node demo.js --output <destination_folder>
 *   
 * Examples:
 *   MIPC_USER=xxx MIPC_PASS=xxx node demo.js --output ./my-captures
 *   node demo.js --user xxx --pass xxx --output ./captures/2026-08-09
 */

const { MipcClient } = require('./src/index');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---- Parse args -----------------------------------------------------------
const args = process.argv.slice(2);
let username, password, outputDir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user' && args[i + 1]) { username = args[++i]; }
  else if (args[i] === '--pass' && args[i + 1]) { password = args[++i]; }
  else if (args[i] === '--output' && args[i + 1]) { outputDir = args[++i]; }
}

const baseUrl = process.env.MIPC_BASE || 'http://localhost:8080';
username = username || process.env.MIPC_USER;
password = password || process.env.MIPC_PASS;

// ---- Helpers --------------------------------------------------------------
const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m',
};

function c(color, text) { return colors[color] ? colors[color] + text + colors.reset : text; }

// Destination folder — REQUIRED (--output)
if (!outputDir) {
  console.log(c('bold', '\n📷 MIPC Camera SDK — Enumeration & Capture Demo\n'));
  console.log(`Usage: ${c('cyan', 'node demo.js --output <destination_folder>')}`);
  console.log('\nCredentials via env vars or args:');
  console.log(`  ${c('cyan', 'MIPC_USER=xxx MIPC_PASS=xxx node demo.js --output ./captures')}`);
  console.log(`  ${c('cyan', 'node demo.js --user xxx --pass xxx --output ./captures/2026-08-09')}\n`);
  process.exit(1);
}

// Append timestamp subdirectory (e.g. ./captures/2026-08-09T21-57-03)
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destFolder = path.resolve(path.join(outputDir, timestamp));

// ---- FFmpeg queue (serializes calls to avoid conflicts) --------------------
const ffmpegQueue = [];
let ffmpegBusy = false;

function runFfmpeg(args_list, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const cleanArgs = args_list.filter(a => a !== undefined && a !== null);
    if (!cleanArgs.length) { reject(new Error('No ffmpeg arguments provided')); return; }

    ffmpegQueue.push({ args: cleanArgs, timeoutMs, resolve, reject });
    processFfmpegQueue();
  });
}

function processFfmpegQueue() {
  if (ffmpegBusy || !ffmpegQueue.length) return;
  
  ffmpegBusy = true;
  const { args, timeoutMs, resolve, reject } = ffmpegQueue.shift();
  
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'pipe'] });
  let stderr = '';
  
  if (!proc) {
    ffmpegBusy = false; processFfmpegQueue();
    reject(new Error(`spawn() returned null — is ffmpeg in PATH?`));
    return;
  }

  proc.stderr.on('data', d => stderr += d.toString());
  
  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    ffmpegBusy = false; processFfmpegQueue();
    reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  proc.on('close', (code) => {
    clearTimeout(timer);
    ffmpegBusy = false; processFfmpegQueue();
    if (code === 0 || code === null) resolve(stderr);
    else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
  });
  
  proc.on('error', (e) => {
    clearTimeout(timer);
    ffmpegBusy = false; processFfmpegQueue();
    reject(e);
  });
}

// Helper: capture a clip from live stream with RTSP transport retry
async function captureClip(streamUrl, outputPath, duration = 5, label = 'Clip') {
  if (!streamUrl) throw new Error('No stream URL provided');
  
  const proto = streamUrl.startsWith('rtsp://') ? 'RTSP' : 'HTTP';
  console.log(`    🎬 ${label} via ${proto}...`);
  
  const transportOpts = proto === 'RTSP' ? [
    ['-rtsp_transport', 'tcp'],
    [],  // retry without explicit transport
  ] : [[]];
  
  for (let i = 0; i < transportOpts.length; i++) {
    if (i > 0) console.log(`    ⚠️  Retrying without -rtsp_transport tcp...`);
    try {
      await runFfmpeg([
        '-y', ...transportOpts[i], '-i', streamUrl,
        '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-an', outputPath,
      ]);
      const size = fs.statSync(outputPath).size;
      console.log(`    ${c('green', '✓')} ${label}: ${(size / 1024).toFixed(1)} KB`);
      return true;
    } catch (e) {
      if (i < transportOpts.length - 1) continue;
      throw e;
    }
  }
}

// ---- Main -----------------------------------------------------------------
async function main() {
  console.log(c('bold', '\n📷 MIPC Camera SDK — Enumeration & Capture Demo\n'));
  console.log(`Destination: ${c('cyan', destFolder)}`);
  console.log(`Gateway:     ${baseUrl}\n`);

  fs.mkdirSync(destFolder, { recursive: true });

  const client = new MipcClient({ baseUrl, username, password });

  try {
    // ---- Connect ----
    await client.connect();
    console.log(c('green', '✓') + ` Connected — Session ${c('bold', client.getSessionInfo().sid)}\n`);

    // ---- List devices ----
    const devices = await client.getDevices();
    
    if (devices.length === 0) {
      console.log(c('yellow', 'No devices registered.'));
      return;
    }

    console.log(`Found ${c('bold', devices.length)} device(s):\n`);
    for (const dev of devices) {
      const statusIcon = dev.stat === 'Online' ? c('green', '●') : c('red', '○');
      const nick = dev.nick ? ` "${dev.nick}"` : '';
      console.log(`  ${statusIcon} ${c('bold', dev.sn)} — ${dev.model}${nick}`);
    }
    console.log();

    // ---- Process each device ----
    for (const dev of devices) {
      const devDir = path.join(destFolder, dev.sn);
      fs.mkdirSync(devDir, { recursive: true });

      console.log(c('bold', `─── ${dev.sn} (${dev.nick || 'no nick'}) ───`));

      // ---- 1. Get device info & video sources ----
      const [info, vs] = await Promise.all([
        client.getDeviceInfo(dev.sn),
        client.getVideoSources(dev.sn),
      ]);

      console.log(`    Model: ${info.Model || 'N/A'} | Firmware: ${info.FirmwareVersion || 'N/A'}`);
      console.log(`    Sensor: ${info.Sensor?.trim() || 'N/A'} | WiFi: ${info.Wifi || 'N/A'}`);

      // ---- 2. ENUMERATE ALL VIDEO SOURCES & URLs --------------------------
      console.log(c('bold', `\n    📡 Video Sources:`));
      
      const allStreams = [];
      
      if (vs && vs.VideoSources) {
        for (const src of vs.VideoSources) {
          const name = src.Name || src.name || 'Unnamed';
          const token = src.Token || src.token || '?';
          console.log(`       ${c('magenta', `• ${name}`)} [token: ${token}]`);
        }
      }

      // Get live stream URLs (HTTP + RTSP) for each token
      const streams = await client.snapshots.getStreamUrls(dev.sn);
      
      if (streams.http) {
        allStreams.push({ name: 'Live Stream (HTTP)', type: 'live', proto: 'http', url: streams.http, token: 'p0' });
        console.log(`       ${c('cyan', `• Live Stream`)} [token: p0] → ${streams.http}`);
      }
      if (streams.rtsp) {
        allStreams.push({ name: 'Live Stream (RTSP)', type: 'live', proto: 'rtsp', url: streams.rtsp, token: 'p0' });
        console.log(`       ${c('cyan', `• Live Stream`)} [token: p0] → ${streams.rtsp}`);
      }

      // Try to get stream URLs for other tokens (p1, etc.)
      try {
        const extraStreams = await client.snapshots.getStreamUrls(dev.sn, 'p1');
        if (extraStreams.http) {
          allStreams.push({ name: 'Live Stream (HTTP)', type: 'live', proto: 'http', url: extraStreams.http, token: 'p1' });
          console.log(`       ${c('cyan', `• Live Stream`)} [token: p1] → ${extraStreams.http}`);
        }
        if (extraStreams.rtsp) {
          allStreams.push({ name: 'Live Stream (RTSP)', type: 'live', proto: 'rtsp', url: extraStreams.rtsp, token: 'p1' });
          console.log(`       ${c('cyan', `• Live Stream`)} [token: p1] → ${extraStreams.rtsp}`);
        }
      } catch (e) { /* ignore */ }

      // Check snapshot endpoints
      try {
        const snapRes = await client.api('ccm_pic_get.jpg', { sn: dev.sn, token: 'p0' });
        if (snapRes && typeof snapRes === 'object') {
          allStreams.push({ name: 'Snapshot (HTTP)', type: 'snapshot', proto: 'http', url: `${baseUrl}/ccm/ccm_pic_get.jpg?sn=${dev.sn}&token=p0`, token: 'p0' });
        }
      } catch (e) { /* ignore */ }

      // Check playback endpoints — ccm_box_get for calendar & metadata
      console.log(`\n    📼 Playback History:`);
      
      try {
        // Step 1: Get recording calendar (which days have recordings)
        const calRes = await client.playback.getRecordingCalendar(dev.sn);
        const calData = calRes?.data || calRes;
        const dateInfos = calData?.date_infos;
        
        let allDaysWithClips = [];
        
        if (dateInfos && Array.isArray(dateInfos) && dateInfos.length > 0) {
          console.log(`       ${c('green', `✓ Found recordings on ${dateInfos.length} time slots`)}\n`);
          // Group by day
          const days = new Map();
          for (const info of dateInfos) {
            if (info.date) {
              const d = new Date(info.date * 1000);
              const dayKey = d.toISOString().split('T')[0];
              if (!days.has(dayKey)) days.set(dayKey, []);
              days.get(dayKey).push(info);
            }
          }
          
          allDaysWithClips = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
        } else {
          console.log(`       ${c('yellow', '⚠ No recording calendar data found')}`);
        }

        // Step 2: Get detailed clip metadata for each day (flag=4, ms timestamps)
        if (allDaysWithClips.length > 0) {
          console.log(`       ${c('bold', `🎞️ Clip Metadata:`)}\n`);
          
          const maxFetchDays = Math.min(allDaysWithClips.length, 30);
          let totalClipCount = 0;
          
          for (let di = 0; di < maxFetchDays; di++) {
            const [dayKey] = allDaysWithClips[di];
            const dayStartMs = new Date(dayKey + 'T00:00:00').getTime();
            const dayEndMs = new Date(dayKey + 'T23:59:59.999').getTime();
            
            try {
              const metaRes = await client.playback.getClipMetadata(dev.sn, dayStartMs, dayEndMs);
              // flag=4 response: {ret:{...}, segs:[{cid,sid,stm:"0x...",etm:"0x...",f}]}
              const metaData = metaRes?.data || metaRes;
              const segList = Array.isArray(metaData?.segs) ? metaData.segs : null;
              
              if (segList && segList.length > 0) {
                totalClipCount += segList.length;
                
                // Determine clip flags: f=0 normal, f=8 motion-triggered start, f=10 special
                const flagCounts = {};
                for (const clip of segList) {
                  const fv = clip.f ?? 0;
                  flagCounts[fv] = (flagCounts[fv] || 0) + 1;
                }
                
                // Show first and last clip metadata as samples
                const first = segList[0];
                const last = segList[segList.length - 1];
                
                console.log(`       ${c('bold', c('cyan', `📅 ${dayKey}`))} (${segList.length.toLocaleString()} clips)`);
                console.log(`         ${c('dim', '├─')} cid=${first.cid}, sid range: ${first.sid} → ${last.sid}`);
                
                // Show flag breakdown
                const flagLabels = Object.entries(flagCounts).map(([f, count]) => {
                  const label = f === '0' ? 'continuous' : f === '8' ? 'motion-start' : f === '10' ? 'special' : `flag=${f}`;
                  return `${label}: ${count.toLocaleString()}`;
                });
                console.log(`         ${c('dim', '├─')} flags: ${flagLabels.join(', ')}`);
                
                // Show first/last hex timestamps
                console.log(`         ${c('dim', `└─ stm: ${first.stm} → ${last.stm}`)}`);
              } else {
                const totalCounts = metaData?.total_segs_counts || 0;
                if (totalCounts > 0) {
                  console.log(`       ${c('bold', c('cyan', `📅 ${dayKey}`))} (~${totalCounts} recordings, no detail list)`);
                } else {
                  console.log(`       ${c('bold', c('cyan', `📅 ${dayKey}`))} (no clips found)`);
                }
              }
            } catch (e) {
              console.log(`       ${c('yellow', `⚠ Failed to fetch metadata for ${dayKey}: ${e.message}`)}`);
            }
          }
          
          if (allDaysWithClips.length > maxFetchDays) {
            console.log(`\n         ${c('dim', `... (${allDaysWithClips.length - maxFetchDays} more days not shown)`)}\n`);
          }
          
          console.log(`\n       ${c('green', `Total clips across fetched days: ${totalClipCount}`)}`);
        }
      } catch (e) {
        console.log(`       ${c('red', `✗ Playback check failed: ${e.message}`)}`);
      }

      // Summary of available streams
      const liveStreams = allStreams.filter(s => s.type === 'live');
      if (!liveStreams.length) {
        console.log(`    ${c('red', '✗')} No stream URLs available\n`);
        continue;
      }

      // ---- 3. Download current snapshot frame -------------------------------
      try {
        const framePath = path.join(devDir, `${dev.sn}_current_frame.jpg`);
        const bestStream = liveStreams.find(s => s.proto === 'rtsp') || liveStreams[0];
        
        console.log(`    📸 Capturing current frame...`);
        await runFfmpeg([
          '-y',
          ...(bestStream.proto === 'rtsp' ? ['-rtsp_transport', 'tcp'] : []),
          '-i', bestStream.url,
          '-ss', '0', '-frames:v', '1', '-update', '1', '-q:v', '2', framePath,
        ]);
        
        const size = fs.statSync(framePath).size;
        console.log(`    ${c('green', '✓')} Frame: ${(size / 1024).toFixed(1)} KB`);
      } catch (err) {
        console.log(`    ${c('red', '✗')} Frame capture failed: ${err.message}`);
      }

      // ---- 4. Record 5-second live clip ------------------------------------
      try {
        const recordPath = path.join(devDir, `${dev.sn}_live_5s.mp4`);
        // Refresh stream URLs (tokens expire quickly)
        const freshStreams = await client.snapshots.getStreamUrls(dev.sn);
        const bestUrl = freshStreams.rtsp || freshStreams.http;
        
        if (bestUrl) {
          await captureClip(bestUrl, recordPath, 5, 'Recording 5s live video');
        } else {
          console.log(`    ${c('red', '✗')} No stream URL available for recording`);
        }
      } catch (err) {
        console.log(`    ${c('red', '✗')}: ${err.message}`);
      }

      // ---- 5. Try to download a playback clip ------------------------------
      // Note: Cloud HTTP API does NOT support downloading recorded clips.
      // The binnet/P2P protocol is required for actual playback downloads.
      // We attempt it anyway and report the result.
      try {
        const playClipPath = path.join(devDir, `${dev.sn}_playback_attempt.mp4`);
        
        // Try ccm_play with time range (playback mode) — usually fails via cloud API
        console.log(`    📼 Attempting playback download...`);
        const nowSec = Math.floor(Date.now() / 1000);
        const replayRes = await client.api('ccm_replay', { sn: dev.sn, start_time: nowSec - 3600, end_time: nowSec });
        
        if (replayRes.data && replayRes.data.Result) {
          const result = replayRes.data.Result;
          if (result.SubCode === 'ccms.system.err') {
            console.log(`    ${c('yellow', '⚠ Cloud API does not support playback downloads')}: recorded clips require binnet/P2P protocol`);
          } else {
            // If we get actual segment data, try to download
            const segments = result.Segments || result.segments || [];
            if (segments.length > 0) {
              console.log(`    Found ${c('bold', segments.length)} recording segment(s)`);
              for (const seg of segments) {
                const st = seg.start_time || seg.time_start;
                const et = seg.end_time || seg.time_end;
                if (st && et) {
                  console.log(`       Segment: ${new Date(st * 1000).toISOString()} → ${new Date(et * 1000).toISOString()}`);
                  
                  // Try to get a playback URL for this segment
                  const playUrl = await client.api('ccm_play', {
                    sn: dev.sn, start_time: st, end_time: et,
                    setup: { stream: 'RTP_Unicast', trans: { proto: 'http' } }, token: 'p0',
                  });
                  
                  if (playUrl.data && playUrl.data.MediaUri && playUrl.data.MediaUri.Uri) {
                    const clipPath = path.join(devDir, `${dev.sn}_clip_${Math.floor(st)}.mp4`);
                    await captureClip(playUrl.data.MediaUri.Uri, clipPath, Math.min(et - st, 30), 'Downloading playback clip');
                  } else {
                    console.log(`       ${c('yellow', '⚠ No download URL for segment')}: ${JSON.stringify(playUrl).slice(0,200)}`);
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.log(`    ${c('yellow', '⚠ Playback download failed')}: ${err.message}`);
      }

      console.log();
    }

    // ---- Summary ----------------------------------------------------------
    const allFiles = [];
    function walkDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else allFiles.push({ path: full, size: fs.statSync(full).size });
      }
    }
    walkDir(destFolder);

    console.log(c('bold', '📊 Summary'));
    console.log(`   Destination folder: ${c('cyan', destFolder)}`);
    console.log(`   Total files:        ${allFiles.length}`);
    const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    console.log(`   Total size:         ${(totalSize / 1024).toFixed(1)} KB`);
    
    // Group by device
    const byDevice = {};
    for (const f of allFiles) {
      const devName = path.basename(path.dirname(f.path));
      if (!byDevice[devName]) byDevice[devName] = [];
      byDevice[devName].push(f);
    }

    console.log(`\n   Files per device:`);
    for (const [dev, files] of Object.entries(byDevice)) {
      const devSize = files.reduce((s, f) => s + f.size, 0);
      console.log(`     ${c('bold', dev)}: ${files.length} file(s), ${(devSize / 1024).toFixed(1)} KB`);
      for (const f of files) {
        const ext = path.extname(f.path);
        const icon = ext === '.jpg' ? '🖼️' : ext === '.mp4' ? '🎬' : '📄';
        console.log(`       ${icon} ${path.basename(f.path)} (${(f.size / 1024).toFixed(1)} KB)`);
      }
    }

    // ---- Available streams summary ----------------------------------------
    console.log(c('bold', '\n   ℹ️  Note: Recording metadata is available via ccm_box_get'));
    console.log(`   However, downloading actual recorded video segments requires the`);
    console.log(`   binnet/P2P protocol (used by official MIPC/Vimtag apps).\n`);

  } catch (err) {
    console.log(c('red', `\n❌ Error: ${err.message}`));
    process.exit(1);
  }
}

main();
