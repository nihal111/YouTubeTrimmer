import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Film, Terminal, Play, Pause, X } from 'lucide-react';
import './App.css';

interface ClipItem {
  id: string;
  type: 'file' | 'youtube';
  file?: File;
  objectUrl?: string;
  uploadedPath?: string;
  youtubeUrl?: string;
  videoId?: string;
  title: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
}

const secondsToHMS = (secs: number) => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return { h, m, s };
};

const hmsToSeconds = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

const formatTimestamp = (secs: number): string => {
  const { h, m, s } = secondsToHMS(secs);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2)}`;
};

const extractYouTubeId = (url: string): string => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
};

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function StitchPage() {
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [ytInput, setYtInput] = useState('');
  const [ytLoading, setYtLoading] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [isStitching, setIsStitching] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [youtubeReady, setYoutubeReady] = useState(false);

  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const ytPlayerRefs = useRef<Record<string, any>>({});
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewYtPlayerRef = useRef<any>(null);
  const previewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clipsRef = useRef<ClipItem[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalDuration = clips.reduce((sum, c) => sum + Math.max(0, c.trimEnd - c.trimStart), 0);

  // Load YouTube IFrame API
  useEffect(() => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      setYoutubeReady(true);
    };
  }, []);

  // Socket setup
  useEffect(() => {
    const newSocket = io({
      path: '/socket.io',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });
    setSocket(newSocket);

    newSocket.on('stitch:log', (msg: string) => {
      setLogs((prev) => [...prev.slice(-100), msg]);
    });

    newSocket.on('stitch:progress', (p: number) => {
      setProgress(p);
    });

    newSocket.on('stitch:complete', (data: { url: string; fileName: string }) => {
      setIsStitching(false);
      setProgress(100);
      setLogs((prev) => [...prev, 'STITCH COMPLETE! Opening in new tab...']);
      window.open(data.url, '_blank');
    });

    newSocket.on('stitch:error', (err: string) => {
      setIsStitching(false);
      setLogs((prev) => [...prev, `ERROR: ${err}`]);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Keep clipsRef in sync for preview interval
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const addFileClip = (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    const id = `${Date.now()}_${Math.random()}`;

    const video = document.createElement('video');
    video.src = objectUrl;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const newClip: ClipItem = {
        id,
        type: 'file',
        file,
        objectUrl,
        title: file.name,
        duration,
        trimStart: 0,
        trimEnd: duration
      };
      setClips((prev) => [...prev, newClip]);
      URL.revokeObjectURL(objectUrl);
    };
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      addFileClip(file);
      e.target.value = '';
    }
  };

  const addYouTubeClip = async () => {
    if (!ytInput.trim()) return;
    setYtLoading(true);
    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(ytInput)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const videoId = extractYouTubeId(ytInput);
      if (!videoId) throw new Error('Invalid YouTube URL');

      const newClip: ClipItem = {
        id: `${Date.now()}_${Math.random()}`,
        type: 'youtube',
        youtubeUrl: ytInput,
        videoId,
        title: data.title || 'YouTube Video',
        duration: data.duration,
        trimStart: 0,
        trimEnd: data.duration
      };
      setClips((prev) => [...prev, newClip]);
      setYtInput('');
    } catch (err: any) {
      alert(`Error adding YouTube clip: ${err.message}`);
    } finally {
      setYtLoading(false);
    }
  };

  const removeClip = (id: string) => {
    const clip = clips.find(c => c.id === id);
    if (clip && clip.objectUrl) {
      URL.revokeObjectURL(clip.objectUrl);
    }
    if (clip && clip.type === 'youtube' && ytPlayerRefs.current[id]) {
      ytPlayerRefs.current[id].destroy();
      delete ytPlayerRefs.current[id];
    }
    setClips((prev) => prev.filter(c => c.id !== id));
  };

  const updateTrim = (id: string, field: 'trimStart' | 'trimEnd', value: number) => {
    setClips((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      const clamped = Math.max(0, Math.min(c.duration, value));
      if (field === 'trimStart') {
        return { ...c, trimStart: Math.min(clamped, c.trimEnd - 0.1) };
      } else {
        return { ...c, trimEnd: Math.max(clamped, c.trimStart + 0.1) };
      }
    }));
  };

  const startPreview = () => {
    setPreviewActive(true);
    setPreviewIndex(0);
  };

  const advancePreview = () => {
    if (previewIndex + 1 < clips.length) {
      setPreviewIndex((i) => i + 1);
    } else {
      stopPreview();
    }
  };

  const stopPreview = () => {
    setPreviewActive(false);
    setPreviewIndex(0);
    if (previewIntervalRef.current) {
      clearInterval(previewIntervalRef.current);
      previewIntervalRef.current = null;
    }
    if (previewVideoRef.current) {
      previewVideoRef.current.pause();
    }
    if (previewYtPlayerRef.current) {
      previewYtPlayerRef.current.destroy();
      previewYtPlayerRef.current = null;
    }
  };

  const startStitch = async () => {
    if (clips.length < 2 || !socket) return;
    setIsStitching(true);
    setLogs(['Starting stitch...']);
    setProgress(0);

    // Upload files first if needed
    const clipsToStitch = await Promise.all(
      clips.map(async (clip) => {
        if (clip.type === 'file' && !clip.uploadedPath && clip.file) {
          const formData = new FormData();
          formData.append('file', clip.file);
          const res = await fetch('/api/stitch/upload-file', {
            method: 'POST',
            body: formData
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          return { ...clip, uploadedPath: data.uploadedPath };
        }
        return clip;
      })
    );

    const payload = {
      socketId: socket.id,
      clips: clipsToStitch.map((c) => ({
        type: c.type,
        uploadedPath: c.uploadedPath,
        youtubeUrl: c.youtubeUrl,
        trimStart: c.trimStart,
        trimEnd: c.trimEnd
      }))
    };

    try {
      const res = await fetch('/api/stitch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        setLogs((prev) => [...prev, `Error: ${data.error}`]);
        setIsStitching(false);
      }
    } catch (err: any) {
      setLogs((prev) => [...prev, `Failed: ${err.message}`]);
      setIsStitching(false);
    }
  };

  const currentClip = clips[previewIndex];

  return (
    <div className="container">
      <header>
        <h1><Film /> Stitch Files</h1>
      </header>

      {previewActive && (
        <div className="preview-player-section">
          <div className="preview-controls">
            <span className="preview-clip-info">
              Clip {previewIndex + 1} of {clips.length}: {currentClip?.title}
            </span>
            <button onClick={stopPreview} className="secondary">
              Stop Preview
            </button>
          </div>

          {currentClip?.type === 'file' ? (
            <video
              ref={previewVideoRef}
              src={currentClip.objectUrl}
              autoPlay
              style={{
                width: '100%',
                borderRadius: '8px',
                backgroundColor: '#000',
                maxHeight: '500px'
              }}
              onLoadedMetadata={() => {
                if (previewVideoRef.current) {
                  previewVideoRef.current.currentTime = currentClip.trimStart;
                }
              }}
              onTimeUpdate={() => {
                if (
                  previewVideoRef.current &&
                  previewVideoRef.current.currentTime >= currentClip.trimEnd
                ) {
                  advancePreview();
                }
              }}
            />
          ) : (
            <div id="preview-yt-player" style={{ borderRadius: '8px', overflow: 'hidden' }} />
          )}
        </div>
      )}

      {/* YouTube player init for preview */}
      {previewActive && currentClip?.type === 'youtube' && youtubeReady && (
        <YouTubePreviewInit
          clip={currentClip}
          onRef={(player) => {
            previewYtPlayerRef.current = player;
          }}
          onAdvance={advancePreview}
          previewIntervalRef={previewIntervalRef}
        />
      )}

      <div className="add-clip-panel">
        <button onClick={() => fileInputRef.current?.click()}>
          📁 Upload from device
        </button>
        <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
          <input
            type="text"
            placeholder="YouTube URL"
            value={ytInput}
            onChange={(e) => setYtInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addYouTubeClip()}
            disabled={ytLoading}
          />
          <button onClick={addYouTubeClip} disabled={ytLoading || !youtubeReady}>
            {ytLoading ? 'Adding...' : '+ Add'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {clips.length > 0 && (
        <>
          <div style={{ marginTop: '20px' }}>
            {clips.map((clip, idx) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                index={idx}
                onRemove={() => removeClip(clip.id)}
                onTrimChange={(field, value) => updateTrim(clip.id, field, value)}
                onPlayerRef={(el) => {
                  if (clip.type === 'file') videoRefs.current[clip.id] = el;
                }}
                onYtPlayerInit={(player) => {
                  ytPlayerRefs.current[clip.id] = player;
                }}
                youtubeReady={youtubeReady}
              />
            ))}
          </div>

          <div className="stitch-footer">
            <div className="total-duration-label">
              Total: {formatTimestamp(totalDuration)}
            </div>
            {clips.length >= 2 && (
              <>
                <button onClick={startPreview} className="secondary">
                  ▶ Preview All
                </button>
                <button
                  onClick={startStitch}
                  disabled={isStitching}
                  style={{ minWidth: '150px' }}
                >
                  {isStitching ? 'Stitching...' : `Stitch ${clips.length} clips`}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {(isStitching || logs.length > 0) && (
        <div className="status-section">
          <div className="status-header">
            <h3><Terminal size={18} /> Process Logs</h3>
            {isStitching && <span className="badge">Active</span>}
          </div>
          <div className="progress-section" ref={logContainerRef}>
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
          {isStitching && (
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ClipCardProps {
  clip: ClipItem;
  index: number;
  onRemove: () => void;
  onTrimChange: (field: 'trimStart' | 'trimEnd', value: number) => void;
  onPlayerRef: (el: HTMLVideoElement | null) => void;
  onYtPlayerInit: (player: any) => void;
  youtubeReady: boolean;
}

function ClipCard({
  clip,
  index,
  onRemove,
  onTrimChange,
  onPlayerRef,
  onYtPlayerInit,
  youtubeReady
}: ClipCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const ytInitialized = useRef(false);

  // Initialize YouTube player for this clip
  useEffect(() => {
    if (
      clip.type === 'youtube' &&
      youtubeReady &&
      window.YT &&
      !ytInitialized.current
    ) {
      ytInitialized.current = true;
      const playerId = `yt-player-${clip.id}`;
      const container = document.getElementById(playerId);
      if (container) {
        ytPlayerRef.current = new window.YT.Player(playerId, {
          videoId: clip.videoId,
          playerVars: {
            autoplay: 0,
            modestbranding: 1,
            rel: 0,
            controls: 1,
            playsinline: 1,
            origin: window.location.origin
          }
        });
        onYtPlayerInit(ytPlayerRef.current);
      }
    }
  }, [clip.type, clip.videoId, youtubeReady, clip.id, onYtPlayerInit]);

  const getCurrentTime = (): number => {
    if (clip.type === 'file' && videoRef.current) {
      return videoRef.current.currentTime;
    }
    if (clip.type === 'youtube' && ytPlayerRef.current) {
      return ytPlayerRef.current.getCurrentTime();
    }
    return 0;
  };

  const trimmedDuration = Math.max(0, clip.trimEnd - clip.trimStart);

  return (
    <div className="clip-card">
      <div className="clip-preview-pane">
        {clip.type === 'file' ? (
          <video
            ref={(el) => {
              videoRef.current = el;
              onPlayerRef(el);
            }}
            src={clip.objectUrl}
            style={{ width: '100%', height: '100%', display: 'block' }}
            controls
          />
        ) : (
          <div id={`yt-player-${clip.id}`} style={{ width: '100%', height: '100%' }} />
        )}
      </div>

      <div className="clip-controls-pane">
        <div className="clip-header">
          <div>
            <div className="clip-title">
              {index + 1}. {clip.title}
            </div>
            <span
              className="clip-type-badge"
              style={{
                backgroundColor: clip.type === 'youtube' ? '#1e40af' : '#059669',
                color: 'white'
              }}
            >
              {clip.type === 'youtube' ? 'YouTube' : 'File'}
            </span>
          </div>
          <button onClick={onRemove} className="secondary" style={{ padding: '4px 8px' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
          Total: {formatTimestamp(clip.duration)}
        </div>

        <div className="trim-controls">
          <div className="trim-row">
            <label className="trim-label">Start:</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max={clip.duration}
              value={clip.trimStart.toFixed(2)}
              onChange={(e) => onTrimChange('trimStart', parseFloat(e.target.value))}
              style={{ flex: 1, width: '100px' }}
            />
            <button
              className="trim-set-btn"
              onClick={() => onTrimChange('trimStart', getCurrentTime())}
              title="Set to current time"
            >
              ↑
            </button>
          </div>

          <div className="trim-row">
            <label className="trim-label">End:</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max={clip.duration}
              value={clip.trimEnd.toFixed(2)}
              onChange={(e) => onTrimChange('trimEnd', parseFloat(e.target.value))}
              style={{ flex: 1, width: '100px' }}
            />
            <button
              className="trim-set-btn"
              onClick={() => onTrimChange('trimEnd', getCurrentTime())}
              title="Set to current time"
            >
              ↑
            </button>
          </div>

          <div className="clip-selected-duration">
            Selected: {formatTimestamp(trimmedDuration)}
          </div>
        </div>
      </div>
    </div>
  );
}

interface YouTubePreviewInitProps {
  clip: ClipItem;
  onRef: (player: any) => void;
  onAdvance: () => void;
  previewIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

function YouTubePreviewInit({
  clip,
  onRef,
  onAdvance,
  previewIntervalRef
}: YouTubePreviewInitProps) {
  useEffect(() => {
    if (!window.YT) return;

    const player = new window.YT.Player('preview-yt-player', {
      videoId: clip.videoId,
      playerVars: {
        autoplay: 1,
        modestbranding: 1,
        rel: 0,
        controls: 1,
        playsinline: 1,
        origin: window.location.origin
      },
      events: {
        onReady: (event: any) => {
          event.target.seekTo(clip.trimStart);
          event.target.playVideo();
        },
        onStateChange: (event: any) => {
          if (event.data === window.YT.PlayerState.PLAYING) {
            if (previewIntervalRef.current) clearInterval(previewIntervalRef.current);
            previewIntervalRef.current = setInterval(() => {
              const currentTime = event.target.getCurrentTime();
              if (currentTime >= clip.trimEnd) {
                event.target.pauseVideo();
                if (previewIntervalRef.current) clearInterval(previewIntervalRef.current);
                onAdvance();
              }
            }, 250);
          } else if (
            event.data === window.YT.PlayerState.PAUSED ||
            event.data === window.YT.PlayerState.ENDED
          ) {
            if (previewIntervalRef.current) {
              clearInterval(previewIntervalRef.current);
              previewIntervalRef.current = null;
            }
          }
        }
      }
    });

    onRef(player);

    return () => {
      if (previewIntervalRef.current) {
        clearInterval(previewIntervalRef.current);
      }
    };
  }, [clip.videoId, clip.trimStart, clip.trimEnd, onRef, onAdvance, previewIntervalRef]);

  return null;
}

export default StitchPage;
