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

// Stitch files upload endpoint
app.post('/api/stitch/upload', (req, res, next) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next();
  });
}, (req, res) => {
  const { socketId } = req.body;
  const targetSocket = io.sockets.sockets.get(socketId);

  if (!targetSocket) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: 'Socket connection not found' });
  }

  if (!req.files || req.files.length < 2) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: 'At least 2 files are required' });
  }

  console.log(`[STITCH] Upload received from ${socketId}: ${req.files.length} files`);
  res.json({ ok: true });

  // Process asynchronously
  setImmediate(() => runStitch(targetSocket, req.files, io));
});

io.on('connection', (socket) => {
  const socketId = socket.id;
  console.log(`[Socket] Client connected: ${socketId}`);

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

// Stitch function - concatenates multiple video/audio files
function runStitch(socket, uploadedFiles, ioServer) {
  const jobId = `stitch_${Date.now()}`;
  const concatListPath = path.join(UPLOADS_DIR, `${jobId}_list.txt`);
  const outputFileName = `${jobId}.mp4`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFileName);

  // Write ffmpeg concat list
  const listContent = uploadedFiles
    .map(f => `file '${f.path}'`)
    .join('\n');

  try {
    fs.writeFileSync(concatListPath, listContent);
  } catch (err) {
    socket.emit('stitch:error', `Failed to write concat list: ${err.message}`);
    cleanup(uploadedFiles, concatListPath);
    return;
  }

  socket.emit('stitch:log', `Starting stitch of ${uploadedFiles.length} files...`);
  socket.emit('stitch:log', `Output: ${outputFileName}`);

  const doRun = (extraArgs, label) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      ...extraArgs,
      outputPath
    ];

    socket.emit('stitch:log', `[ffmpeg] ${label}`);
    console.log(`[STITCH] Running: ffmpeg ${args.join(' ')}`);

    const child = spawn('ffmpeg', args);

    child.stderr.on('data', (data) => {
      const msg = data.toString();
      socket.emit('stitch:log', msg);
    });

    child.on('close', (code) => {
      if (code === 0) {
        // Success - cleanup and emit complete
        uploadedFiles.forEach(f => {
          fs.unlink(f.path, (err) => {
            if (err) console.error(`Failed to delete upload: ${err.message}`);
          });
        });
        fs.unlink(concatListPath, (err) => {
          if (err) console.error(`Failed to delete concat list: ${err.message}`);
        });

        socket.emit('stitch:complete', {
          url: `/downloads/${outputFileName}`,
          fileName: outputFileName
        });
        console.log(`[STITCH] Completed: ${outputFileName}`);
      } else if (label === 'stream copy') {
        // First attempt failed - retry with re-encode
        socket.emit('stitch:log', 'Stream copy failed; retrying with re-encode (slower)...');
        doRun(['-c:v', 'libx264', '-c:a', 'aac', '-preset', 'fast'], 're-encode');
      } else {
        // Re-encode also failed
        uploadedFiles.forEach(f => {
          fs.unlink(f.path, (err) => {
            if (err) console.error(`Failed to delete upload: ${err.message}`);
          });
        });
        fs.unlink(concatListPath, (err) => {
          if (err) console.error(`Failed to delete concat list: ${err.message}`);
        });

        socket.emit('stitch:error', `ffmpeg exited with code ${code}`);
        console.error(`[STITCH] Failed with code ${code}`);
      }
    });
  };

  // Start with stream copy (fast, no re-encoding)
  doRun(['-c', 'copy'], 'stream copy');
}

function cleanup(files, concatListPath) {
  files.forEach(f => {
    fs.unlink(f.path, (err) => {
      if (err) console.error(`Failed to delete file: ${err.message}`);
    });
  });
  if (concatListPath) {
    fs.unlink(concatListPath, (err) => {
      if (err) console.error(`Failed to delete concat list: ${err.message}`);
    });
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
