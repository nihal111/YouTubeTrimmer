const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  credentials: false
}));
app.use(express.json());

// Add security headers to allow YouTube iframe embedding
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('X-Frame-Options', 'ALLOWALL');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Content-Security-Policy', "script-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://youtube.com; connect-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; default-src 'self'");
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const DOWNLOADS_DIR = path.join(__dirname, '../downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR);
}

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Track active stitch jobs for persistence
const activeJobs = new Map();

// Helper to notify all interested sockets about a job's progress
function notifyJob(jobId, type, data) {
  const job = activeJobs.get(jobId);
  if (!job) return;
  
  // Update internal job state
  if (type === 'stitch:progress') job.progress = data;
  if (type === 'stitch:log') {
    job.logs.push(data);
    if (job.logs.length > 200) job.logs.shift();
  }
  if (type === 'stitch:complete') job.result = data;
  if (type === 'stitch:error') job.error = data;

  // Emit to all sockets registered for this jobId
  job.sockets.forEach(sid => {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit(type, { jobId, ...data });
  });

  if (type === 'stitch:complete' || type === 'stitch:error') {
    // Keep job around for a bit so client can "collect" it if they reconnect late
    setTimeout(() => activeJobs.delete(jobId), 600000); // 10 minutes
  }
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 }
});

// Serve static files from downloads directory
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Get video info
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  console.log(`[API] Info request for URL: ${url}`);
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const process = spawn('yt-dlp', ['-j', url]);
    let output = '';
    let errorOutput = '';

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (code !== 0) {
        console.error(`[API] yt-dlp info failed with code ${code}: ${errorOutput}`);
        return res.status(500).json({ error: 'Failed to fetch video info', details: errorOutput });
      }
      try {
        const info = JSON.parse(output);
        console.log(`[API] Successfully fetched info for: ${info.title}`);
        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          formats: (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
            .map(f => ({
              format_id: f.format_id,
              ext: f.ext,
              resolution: f.resolution,
              filesize: f.filesize
            }))
        });
      } catch (e) {
        console.error(`[API] JSON parse error: ${e.message}`);
        res.status(500).json({ error: 'Failed to parse video info' });
      }
    });
  } catch (err) {
    console.error(`[API] Exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Stitch file upload endpoint (single file)
app.post('/api/stitch/upload-file', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file' });
  }
  console.log(`[STITCH] File uploaded: ${req.file.path}`);
  res.json({ uploadedPath: req.file.path });
});

// Stitch start endpoint (initiate stitching with mixed sources)
app.post('/api/stitch/start', express.json(), (req, res) => {
  const { socketId, clips } = req.body;

  if (!clips || !Array.isArray(clips) || clips.length < 2) {
    return res.status(400).json({ error: 'At least 2 clips are required' });
  }

  const jobId = `stitch_${Date.now()}`;
  const job = {
    id: jobId,
    clips,
    sockets: [socketId],
    progress: { percent: 0, etc: 'Calculating...' },
    logs: [],
    startTime: Date.now()
  };
  activeJobs.set(jobId, job);

  console.log(`[STITCH] Start request for ${jobId}: ${clips.length} clips`);
  res.json({ ok: true, jobId });

  // Process asynchronously
  setImmediate(() => runStitch(jobId, clips));
});

io.on('connection', (socket) => {
  const socketId = socket.id;
  console.log(`[Socket] Client connected: ${socketId}`);

  socket.on('stitch:attach', (jobId) => {
    const job = activeJobs.get(jobId);
    if (job) {
      if (!job.sockets.includes(socketId)) job.sockets.push(socketId);
      socket.emit('stitch:attached', {
        jobId,
        progress: job.progress,
        logs: job.logs,
        result: job.result,
        error: job.error
      });
    }
  });

  socket.on('start-download', (data) => {
    const { url, start, end, format, resolution } = data;
    console.log(`[Socket] Download started by ${socketId}: ${url} [${start}-${end}] (${format}/${resolution})`);
    const isAudio = format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const fileName = `clip_${Date.now()}.${ext}`;
    const outputPath = path.join(DOWNLOADS_DIR, fileName);

    let args = [
      '--download-sections', `*${start}-${end}`,
      '--force-keyframes-at-cuts',
      '-o', outputPath,
      url
    ];

    if (isAudio) {
      args.push('-x', '--audio-format', 'mp3');
    } else {
      // Handle resolution
      let formatSelection = 'bestvideo+bestaudio/best';
      if (resolution !== 'best') {
        formatSelection = `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${resolution}][ext=mp4]/best`;
      } else {
        formatSelection = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      }
      args.push('-f', formatSelection);
      args.push('--merge-output-format', 'mp4');
    }

    console.log('Running yt-dlp with args:', args.join(' '));
    const child = spawn('yt-dlp', args);

    child.stdout.on('data', (data) => {
      const message = data.toString();
      socket.emit('log', message);
      
      if (message.includes('%')) {
        const match = message.match(/(\d+\.\d+)%/);
        if (match) {
          socket.emit('progress', parseFloat(match[1]));
        }
      }
    });

    child.stderr.on('data', (data) => {
      const message = data.toString();
      // Only emit significant errors or progress updates from stderr
      if (message.includes('ERROR') || message.includes('ffmpeg')) {
        socket.emit('log', message);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        socket.emit('complete', {
          url: `/downloads/${fileName}`,
          fileName: fileName
        });
      } else {
        socket.emit('error', `Process exited with code ${code}`);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Run a child process and pipe stdout/stderr to job logs
function runCommand(jobId, cmd, args) {
  return new Promise((resolve, reject) => {
    let errorOutput = '';
    const child = spawn(cmd, args);
    child.stdout.on('data', (data) => notifyJob(jobId, 'stitch:log', data.toString()));
    child.stderr.on('data', (data) => {
      const msg = data.toString();
      errorOutput += msg;
      notifyJob(jobId, 'stitch:log', msg);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (code ${code}): ${errorOutput.slice(-200)}`));
    });
    child.on('error', (err) => reject(err));
  });
}

// Stitch function - concatenates multiple clips (file or YouTube) with per-clip trimming
async function runStitch(jobId, clips) {
  const outputFileName = `${jobId}.mp4`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFileName);
  const intermediates = [];
  const filesToCleanup = [];
  const startTime = Date.now();

  try {
    notifyJob(jobId, 'stitch:log', `Processing ${clips.length} clips...`);

    const NORMALIZE_VF = 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,setpts=PTS-STARTPTS';

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const intermediatePath = path.join(UPLOADS_DIR, `${jobId}_clip_${i}.mp4`);
      intermediates.push(intermediatePath);

      notifyJob(jobId, 'stitch:log', `[${i + 1}/${clips.length}] Processing ${clip.type}...`);
      
      // Calculate progress and ETC
      const percent = Math.round((i / (clips.length + 0.5)) * 100); 
      const elapsed = Date.now() - startTime;
      const avgTimePerClip = i > 0 ? elapsed / i : 0;
      const remainingClips = clips.length - i;
      let etc = 'Calculating...';
      if (i > 0) {
        const remainingTimeMs = (avgTimePerClip * remainingClips) + (avgTimePerClip * 0.2); 
        const remainingSecs = Math.ceil(remainingTimeMs / 1000);
        etc = remainingSecs > 60 
          ? `${Math.floor(remainingSecs / 60)}m ${remainingSecs % 60}s`
          : `${remainingSecs}s`;
      }
      
      notifyJob(jobId, 'stitch:progress', { percent, etc });

      if (clip.type === 'file') {
        await runCommand(jobId, 'ffmpeg', [
          '-y',
          '-ss', String(clip.trimStart),
          '-to', String(clip.trimEnd),
          '-i', clip.uploadedPath,
          '-c:v', 'libx264', '-preset', 'fast',
          '-c:a', 'aac',
          '-pix_fmt', 'yuv420p',
          '-vf', NORMALIZE_VF,
          '-af', 'asetpts=PTS-STARTPTS',
          intermediatePath
        ]);
      } else {
        const rawPath = path.join(UPLOADS_DIR, `${jobId}_clip_${i}_raw.mp4`);
        filesToCleanup.push(rawPath);

        await runCommand(jobId, 'yt-dlp', [
          '--download-sections', `*${clip.trimStart}-${clip.trimEnd}`,
          '--force-keyframes-at-cuts',
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '--merge-output-format', 'mp4',
          '-o', rawPath,
          clip.youtubeUrl
        ]);

        notifyJob(jobId, 'stitch:log', `[${i + 1}/${clips.length}] Normalizing (scale + timestamps)...`);
        await runCommand(jobId, 'ffmpeg', [
          '-y',
          '-i', rawPath,
          '-c:v', 'libx264', '-preset', 'fast',
          '-c:a', 'aac',
          '-pix_fmt', 'yuv420p',
          '-vf', NORMALIZE_VF,
          '-af', 'asetpts=PTS-STARTPTS',
          intermediatePath
        ]);
      }
    }

    notifyJob(jobId, 'stitch:progress', { percent: 95, etc: 'Finishing...' });
    notifyJob(jobId, 'stitch:log', 'Concatenating clips...');

    const concatListPath = path.join(UPLOADS_DIR, `${jobId}_list.txt`);
    const concatContent = intermediates.map((p) => `file '${p}'`).join('\n');

    fs.writeFileSync(concatListPath, concatContent);
    filesToCleanup.push(concatListPath);

    await runCommand(jobId, 'ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath
    ]);

    notifyJob(jobId, 'stitch:progress', { percent: 100, etc: 'Done!' });
    notifyJob(jobId, 'stitch:complete', {
      url: `/downloads/${outputFileName}`,
      fileName: outputFileName
    });
    console.log(`[STITCH] Completed: ${outputFileName}`);
  } catch (err) {
    console.error(`[STITCH] Error: ${err.message}`);
    notifyJob(jobId, 'stitch:error', { error: err.message });
  } finally {
    const toDelete = [
      ...intermediates,
      ...clips.filter((c) => c.type === 'file').map((c) => c.uploadedPath),
      ...filesToCleanup
    ];

    toDelete.forEach((p) => {
      fs.unlink(p, (err) => {
        if (err) console.error(`Failed to delete ${p}: ${err.message}`);
      });
    });
  }
}


const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
