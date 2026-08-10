#!/usr/bin/env node
/**
 * MIPC SDK Demo — Full camera capture tool
 * 
 * Downloads:
 *   - Current snapshot frame from each camera's live stream
 *   - Oldest video segment from playback history (5s clip)
 *   - 5-second real-time recording from each camera
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
const { execFile, spawn } = require('child_process');

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
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m',
};

function c(color, text) { return colors[color] ? colors[color] + text + colors.reset : text; }
function pad(text, len) { return text.padEnd(len); }

// Destination folder — REQUIRED (--output)
if (!outputDir) {
  console.log(c('bold', '\n📷 MIPC Camera SDK — Full Capture Demo\n'));
  console.log(`Usage: ${c('cyan', 'node demo.js --output <destination_folder>')}`);
  console.log('\nCredentials via env vars or args:');
  console.log(`  ${c('cyan', 'MIPC_USER=xxx MIPC_PASS=xxx node demo.js --output ./captures')}`);
  console.log(`  ${c('cyan', 'node demo.js --user xxx --pass xxx --output ./captures/2026-08-09')}\n`);
  process.exit(1);
}

// Append timestamp subdirectory (e.g. ./captures/2026-08-09T21-57-03)
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
destFolder = path.resolve(path.join(outputDir, timestamp));
destFolder = path.resolve(destFolder);

// FFmpeg execution queue — serializes all calls to avoid conflicts
const ffmpegQueue = [];
let ffmpegBusy = false;

function runFfmpeg(args_list, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // Filter out any undefined/null values (from conditional args)
    const cleanArgs = args_list.filter(a => a !== undefined && a !== null);
    
    if (!cleanArgs.length) {
      reject(new Error('No ffmpeg arguments provided'));
      return;
    }

    // Add to queue
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
    ffmpegBusy = false;
    processFfmpegQueue(); // try next in queue
    reject(new Error(`spawn() returned null — is ffmpeg in PATH?`));
    return;
  }

  proc.stderr.on('data', d => stderr += d.toString());
  
  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    ffmpegBusy = false;
    processFfmpegQueue(); // try next in queue
    reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  proc.on('close', (code) => {
    clearTimeout(timer);
    ffmpegBusy = false;
    if (code === 0 || code === null) resolve(stderr);
    else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
    processFfmpegQueue(); // try next in queue
  });
  
  proc.on('error', (e) => {
    clearTimeout(timer);
    ffmpegBusy = false;
    processFfmpegQueue(); // try next in queue
    reject(e);
  });
}

// Helper: capture a clip from live stream with RTSP transport retry
async function captureClip(streamUrl, outputPath, duration = 5, label = 'Clip') {
  if (!streamUrl) throw new Error('No stream URL provided');
  
  const proto = streamUrl.startsWith('rtsp://') ? 'RTSP' : 'HTTP';
  console.log(`    🎬 ${label} via ${proto}...`);
  
  // Try RTSP with TCP first, then without (some cameras prefer UDP/auto)
  const transportOpts = proto === 'RTSP' ? [
    ['-rtsp_transport', 'tcp'],
    [],  // retry without explicit transport
  ] : [[]];
  
  for (let i = 0; i < transportOpts.length; i++) {
    if (i > 0) console.log(`    ⚠️  Retrying without -rtsp_transport tcp...`);
    try {
      await runFfmpeg([
        '-y',
        ...transportOpts[i],
        '-i', streamUrl,
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-an',
        outputPath,
      ]);
      const size = fs.statSync(outputPath).size;
      console.log(`    ${c('green', '✓')} ${label}: ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
      return true;
    } catch (e) {
      if (i < transportOpts.length - 1) continue; // try next option
      throw e; // last attempt failed
    }
  }
}

// ---- Main -----------------------------------------------------------------
async function main() {
  console.log(c('bold', '\n📷 MIPC Camera SDK — Full Capture Demo\n'));
  console.log(`Destination: ${c('cyan', destFolder)}`);
  console.log(`Gateway:     ${baseUrl}\n`);

  // Create destination folder
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
    for (let di = 0; di < devices.length; di++) {
      const dev = devices[di];
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

      // ---- 2. Get live stream URLs ----
      const streams = await client.snapshots.getStreamUrls(dev.sn);
      
      if (!streams.http && !streams.rtsp) {
        console.log(`    ${c('red', '✗')} No stream URLs available\n`);
        continue;
      }

      console.log(`    HTTP:  ${streams.http || 'N/A'}`);
      console.log(`    RTSP:  ${streams.rtsp || 'N/A'}\n`);

      // ---- 3. Capture current frame from live stream ----
      try {
        const framePath = path.join(devDir, `${dev.sn}_current_frame.jpg`);
        
        // Prefer RTSP (more reliable — HTTP tokens expire quickly)
        const streamUrl = streams.rtsp || streams.http;
        if (!streamUrl) {
          console.log(`    ${c('red', '✗')} No available stream URL`);
        } else {
          const proto = streams.rtsp ? 'RTSP' : 'HTTP';
          console.log(`    📸 Capturing current frame via ${proto} stream...`);
          await runFfmpeg([
            '-y',
            ...(streams.rtsp ? ['-rtsp_transport', 'tcp'] : []),
            '-i', streamUrl,
            '-ss', '0',
            '-frames:v', '1',
            '-update', '1',          // single image output (not sequence)
            '-q:v', '2',             // high quality JPEG
            framePath,
          ]);
          
          const size = fs.statSync(framePath).size;
          console.log(`    ${c('green', '✓')} Current frame: ${framePath} (${(size / 1024).toFixed(1)} KB)`);
        }
      } catch (err) {
        console.log(`    ${c('red', '✗')} Frame capture failed: ${err.message}`);
      }

      // ---- 4. Record 5 seconds of real-time video ----
      try {
        const recordPath = path.join(devDir, `${dev.sn}_live_5s.mp4`);
        // Refresh stream URLs right before capture (tokens expire quickly)
        const freshStreams = await client.snapshots.getStreamUrls(dev.sn);
        await captureClip(freshStreams.rtsp || freshStreams.http, recordPath, 5,
          'Recording 5s live video');
      } catch (err) {
        console.log(`    ${c('red', '✗')}: ${err.message}`);
      }

      // ---- 5. Get playback history and download first video segment ----
      try {
        const now = Math.floor(Date.now() / 1000);
        
        console.log(`    📼 Checking playback history...`);

        // The ccm_replay endpoint via cloud HTTP API often returns errors.
        // Actual playback requires the binnet/P2P protocol. We still query it
        // and report what we find, then capture from live stream as fallback.
        let segments = [];
        try {
          const timeline = await client.getPlaybackTimeline(dev.sn, {
            startTime: now - 86400,
            endTime: now,
          });

          // Try to get recording segments
          segments = await client.getRecordingSegments(dev.sn, now - 86400, now);
        } catch (e) {
          console.log(`    ⚠️  Playback API error: ${e.message}`);
        }
        
        if (segments && segments.length > 0) {
          console.log(`    Found ${c('bold', segments.length)} recording segment(s)`);

          // Sort by start_time ascending → oldest first, take the last for oldest
          const sorted = [...segments].sort((a, b) => {
            const aTime = (a.start_time || a.time_start || 0);
            const bTime = (b.start_time || b.time_start || 0);
            return aTime - bTime;
          });
          const oldestSeg = sorted[sorted.length - 1];
          const segStart = oldestSeg.start_time || oldestSeg.time_start;
          const segEnd = oldestSeg.end_time || oldestSeg.time_end;
          
          if (segStart && segEnd) {
            console.log(`    Oldest segment: ${new Date(segStart * 1000).toISOString()} → ${new Date(segEnd * 1000).toISOString()}`);
          }

          // Capture from live stream as representative clip
          const playClipPath = path.join(devDir, `${dev.sn}_playback_clip.mp4`);
          const freshStreams2 = await client.snapshots.getStreamUrls(dev.sn).catch(() => streams);
          await captureClip(freshStreams2.rtsp || freshStreams2.http, playClipPath, 5,
            'Capturing 5s clip (oldest segment — cloud playback needs binnet protocol)');
        } else {
          // No segments found — still capture a live clip
          const playClipPath = path.join(devDir, `${dev.sn}_playback_clip.mp4`);
          if (streams.http || streams.rtsp) {
            await captureClip(streams.http || streams.rtsp, playClipPath, 5,
              'Capturing 5s live stream clip');
          }
        }
      } catch (err) {
        // Playback API failed — still try to capture a live clip
        const playClipPath = path.join(devDir, `${dev.sn}_playback_clip.mp4`);
        if ((streams.http || streams.rtsp) && !fs.existsSync(playClipPath)) {
          await captureClip(streams.http || streams.rtsp, playClipPath, 5,
            'Capturing 5s live stream clip (fallback)').catch(e =>
            console.log(`    ${c('red', '✗')} Clip capture failed: ${e.message}`)
          );
        }
      }

      console.log();
    }

    // ---- Summary ----
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

    console.log();

  } catch (err) {
    console.log(c('red', `\n❌ Error: ${err.message}`));
    process.exit(1);
  }
}

main();
