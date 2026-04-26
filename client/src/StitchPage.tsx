import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Film, Terminal, X } from 'lucide-react';
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

const parseTimestamp = (str: string): number | null => {
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Try HH:MM:SS or HH:MM:SS.MS format
  const match = trimmed.match(/^(\d{1,2}):(\d{1,2})(?::(\d+(?:\.\d+)?))?$/);
  if (match) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const s = match[3] ? parseFloat(match[3]) : 0;
    if (h >= 0 && m >= 0 && m < 60 && s >= 0) {
      return h * 3600 + m * 60 + s;
    }
  }

  // Try raw seconds (with or without decimal)
  const seconds = parseFloat(trimmed);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  return null;
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

// Module-level cache for File objects (survives component mount/unmount within the same session)
const fileClipCache = new Map<string, File>();

const CLIPS_STORAGE_KEY = 'stitcher_clips';

const persistClips = (clips: ClipItem[]) => {
  const serialized = clips.map((c) => ({
    id: c.id,
    type: c.type,
    youtubeUrl: c.youtubeUrl,
    videoId: c.videoId,
    title: c.title,
    duration: c.duration,
    trimStart: c.trimStart,
    trimEnd: c.trimEnd,
    uploadedPath: c.uploadedPath
  }));
  localStorage.setItem(CLIPS_STORAGE_KEY, JSON.stringify(serialized));
};

const loadClips = (setClips: React.Dispatch<React.SetStateAction<ClipItem[]>>) => {
  try {
    const stored = localStorage.getItem(CLIPS_STORAGE_KEY);
    if (!stored) return;

    const clips = JSON.parse(stored) as ClipItem[];
    const restoredClips = clips.map((c) => {
      if (c.type === 'file') {
        const file = fileClipCache.get(c.id);
        const objectUrl = file ? URL.createObjectURL(file) : undefined;
        return { ...c, file, objectUrl };
      }
      return c;
    });

    setClips(restoredClips);
  } catch (err) {
    console.error('Failed to load clips from storage:', err);
  }
};

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
  const projectInputRef = useRef<HTMLInputElement>(null);

  const totalDuration = clips.reduce((sum, c) => sum + Math.max(0, c.trimEnd - c.trimStart), 0);

  useEffect(() => {
    loadClips(setClips);
  }, []);

  useEffect(() => {
    if (document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      if (window.YT && window.YT.Player) setYoutubeReady(true);
      return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => setYoutubeReady(true);
  }, []);

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

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const addFileClip = (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    const id = `${Date.now()}_${Math.random()}`;
    fileClipCache.set(id, file);

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
      setClips((prev) => {
        const updated = [...prev, newClip];
        persistClips(updated);
        return updated;
      });
    };
  };

  const reuploadFileClip = (id: string, file: File) => {
    const objectUrl = URL.createObjectURL(file);
    fileClipCache.set(id, file);
    setClips((prev) => {
      const updated = prev.map((c) =>
        c.id === id ? { ...c, file, objectUrl, uploadedPath: undefined } : c
      );
      persistClips(updated);
      return updated;
    });
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
      setClips((prev) => {
        const updated = [...prev, newClip];
        persistClips(updated);
        return updated;
      });
      setYtInput('');
    } catch (err: any) {
      alert(`Error adding YouTube clip: ${err.message}`);
    } finally {
      setYtLoading(false);
    }
  };

  const removeClip = (id: string) => {
    const clip = clips.find((c) => c.id === id);
    if (clip?.objectUrl) URL.revokeObjectURL(clip.objectUrl);
    if (clip?.type === 'youtube' && ytPlayerRefs.current[id]) {
      ytPlayerRefs.current[id].destroy();
      delete ytPlayerRefs.current[id];
    }
    fileClipCache.delete(id);
    setClips((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      persistClips(updated);
      return updated;
    });
  };

  const moveClip = (id: string, direction: 'up' | 'down') => {
    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1) return prev;
      const newIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      persistClips(next);
      return next;
    });
  };

  const updateTrim = (id: string, field: 'trimStart' | 'trimEnd', value: number) => {
    setClips((prev) => {
      const updated = prev.map((c) => {
        if (c.id !== id) return c;
        const clamped = Math.max(0, Math.min(c.duration, value));
        if (field === 'trimStart') {
          return { ...c, trimStart: Math.min(clamped, c.trimEnd - 0.1) };
        } else {
          return { ...c, trimEnd: Math.max(clamped, c.trimStart + 0.1) };
        }
      });
      persistClips(updated);
      return updated;
    });
  };

  const startPreview = () => {
    // Clear stitch state so the log section disappears and UI is clean
    setLogs([]);
    setProgress(0);
    setIsStitching(false);
    setPreviewActive(true);
    setPreviewIndex(0);
  };

  const advancePreview = () => {
    const current = clipsRef.current;
    setPreviewIndex((i) => {
      if (i + 1 < current.length) return i + 1;
      stopPreview();
      return i;
    });
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

  const saveProject = () => {
    if (clips.length === 0) {
      alert('No clips to save');
      return;
    }

    const projectData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      clips: clips.map((c) => ({
        id: c.id,
        type: c.type,
        youtubeUrl: c.youtubeUrl,
        videoId: c.videoId,
        title: c.title,
        duration: c.duration,
        trimStart: c.trimStart,
        trimEnd: c.trimEnd,
        uploadedPath: c.uploadedPath
      }))
    };

    const json = JSON.stringify(projectData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stitch-project-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const loadProject = async (file: File) => {
    try {
      const text = await file.text();
      const projectData = JSON.parse(text);

      if (!projectData.clips || !Array.isArray(projectData.clips)) {
        alert('Invalid project file format');
        return;
      }

      const restoredClips: ClipItem[] = [];

      for (const clip of projectData.clips) {
        if (clip.type === 'youtube') {
          restoredClips.push({
            id: clip.id,
            type: 'youtube',
            youtubeUrl: clip.youtubeUrl,
            videoId: clip.videoId,
            title: clip.title,
            duration: clip.duration,
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd
          });
        } else if (clip.type === 'file' && clip.uploadedPath) {
          restoredClips.push({
            id: clip.id,
            type: 'file',
            uploadedPath: clip.uploadedPath,
            title: clip.title,
            duration: clip.duration,
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd
          });
        }
      }

      if (restoredClips.length === 0) {
        alert('No valid clips found in project file');
        return;
      }

      setClips(restoredClips);
      persistClips(restoredClips);
      alert(`Loaded ${restoredClips.length} clips`);
    } catch (err: any) {
      alert(`Failed to load project: ${err.message}`);
    }
  };

  const handleProjectFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadProject(file);
      e.target.value = '';
    }
  };

  const startStitch = async () => {
    if (clips.length < 2 || !socket) return;
    setIsStitching(true);
    setLogs(['Starting stitch...']);
    setProgress(0);

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

  // Check if any file clip is missing its objectUrl (file lost after page reload)
  const hasOrphanedClips = clips.some((c) => c.type === 'file' && !c.objectUrl);

  return (
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1><Film /> Stitch Files</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={saveProject} className="secondary" title="Download project as JSON">
            💾 Save Project
          </button>
          <button onClick={() => projectInputRef.current?.click()} className="secondary" title="Load project from JSON">
            📂 Load Project
          </button>
          <input
            ref={projectInputRef}
            type="file"
            accept=".json"
            onChange={handleProjectFileSelect}
            style={{ display: 'none' }}
          />
        </div>
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
              key={currentClip.id}
              ref={previewVideoRef}
              src={currentClip.objectUrl}
              style={{ width: '100%', borderRadius: '8px', backgroundColor: '#000', maxHeight: '500px', display: 'block' }}
              onLoadedMetadata={() => {
                if (previewVideoRef.current) {
                  previewVideoRef.current.currentTime = currentClip.trimStart;
                  previewVideoRef.current.play();
                }
              }}
              onTimeUpdate={() => {
                if (previewVideoRef.current && previewVideoRef.current.currentTime >= currentClip.trimEnd) {
                  advancePreview();
                }
              }}
            />
          ) : (
            <div id="preview-yt-player" style={{ borderRadius: '8px', overflow: 'hidden' }} />
          )}
        </div>
      )}

      {previewActive && currentClip?.type === 'youtube' && youtubeReady && (
        <YouTubePreviewInit
          clip={currentClip}
          onRef={(player) => { previewYtPlayerRef.current = player; }}
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

      {hasOrphanedClips && (
        <div className="orphan-warning">
          ⚠ Some file clips lost their reference after page reload. Use the re-upload button on each affected clip.
        </div>
      )}

      {clips.length > 0 && (
        <>
          <div style={{ marginTop: '8px' }}>
            {clips.map((clip, idx) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                index={idx}
                total={clips.length}
                onRemove={() => removeClip(clip.id)}
                onTrimChange={(field, value) => updateTrim(clip.id, field, value)}
                onPlayerRef={(el) => { videoRefs.current[clip.id] = el; }}
                onYtPlayerInit={(player) => { ytPlayerRefs.current[clip.id] = player; }}
                onMoveUp={() => moveClip(clip.id, 'up')}
                onMoveDown={() => moveClip(clip.id, 'down')}
                onReupload={(file) => reuploadFileClip(clip.id, file)}
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
                <button onClick={startPreview} className="secondary" disabled={hasOrphanedClips}>
                  ▶ Preview All
                </button>
                <button
                  onClick={startStitch}
                  disabled={isStitching || hasOrphanedClips}
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
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TimestampInputProps {
  value: number;
  onChange: (seconds: number) => void;
  maxDuration: number;
  label: string;
  minValue?: number;
}

function TimestampInput({ value, onChange, maxDuration, label, minValue = 0 }: TimestampInputProps) {
  const [displayValue, setDisplayValue] = useState(formatTimestamp(value));
  const [isFocused, setIsFocused] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayValue(e.target.value);
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseTimestamp(displayValue);

    if (parsed === null) {
      setDisplayValue(formatTimestamp(value));
    } else {
      const clamped = Math.max(minValue, Math.min(maxDuration, parsed));
      onChange(clamped);
      setDisplayValue(formatTimestamp(clamped));
    }
  };

  useEffect(() => {
    if (!isFocused) {
      setDisplayValue(formatTimestamp(value));
    }
  }, [value, isFocused]);

  return (
    <div className="trim-row">
      <label className="trim-label">{label}</label>
      <input
        type="text"
        value={displayValue}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        placeholder="HH:MM:SS"
        title="HH:MM:SS or HH:MM:SS.MS (e.g., 01:30:45 or 1:30)"
        style={{ flex: 1, width: '100px' }}
      />
    </div>
  );
}

interface ClipCardProps {
  clip: ClipItem;
  index: number;
  total: number;
  onRemove: () => void;
  onTrimChange: (field: 'trimStart' | 'trimEnd', value: number) => void;
  onPlayerRef: (el: HTMLVideoElement | null) => void;
  onYtPlayerInit: (player: any) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onReupload: (file: File) => void;
  youtubeReady: boolean;
}

function ClipCard({
  clip,
  index,
  total,
  onRemove,
  onTrimChange,
  onPlayerRef,
  onYtPlayerInit,
  onMoveUp,
  onMoveDown,
  onReupload,
  youtubeReady
}: ClipCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const ytInitialized = useRef(false);
  const reuploadInputRef = useRef<HTMLInputElement | null>(null);

  const canMoveUp = index > 0;
  const canMoveDown = index < total - 1;
  const isMissingFile = clip.type === 'file' && !clip.objectUrl;

  useEffect(() => {
    if (clip.type === 'youtube' && youtubeReady && window.YT && !ytInitialized.current) {
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
    if (clip.type === 'file' && videoRef.current) return videoRef.current.currentTime;
    if (clip.type === 'youtube' && ytPlayerRef.current) return ytPlayerRef.current.getCurrentTime();
    return 0;
  };

  const trimmedDuration = Math.max(0, clip.trimEnd - clip.trimStart);

  return (
    <div className="clip-card">
      <div className="clip-reorder-col">
        <button className="reorder-btn" onClick={onMoveUp} disabled={!canMoveUp} title="Move up">▲</button>
        <button className="reorder-btn" onClick={onMoveDown} disabled={!canMoveDown} title="Move down">▼</button>
      </div>

      <div className="clip-preview-pane">
        {isMissingFile ? (
          <div className="clip-missing-file">
            <span>File unavailable</span>
            <input
              ref={reuploadInputRef}
              type="file"
              accept="video/*,audio/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { onReupload(f); e.target.value = ''; }
              }}
            />
            <button className="trim-set-btn" onClick={() => reuploadInputRef.current?.click()}>
              Re-upload
            </button>
          </div>
        ) : clip.type === 'file' ? (
          <video
            ref={(el) => { videoRef.current = el; onPlayerRef(el); }}
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
          <div className="clip-header-info">
            <div className="clip-title">{index + 1}. {clip.title}</div>
            <span
              className="clip-type-badge"
              style={{ backgroundColor: clip.type === 'youtube' ? '#1e40af' : '#059669', color: 'white' }}
            >
              {clip.type === 'youtube' ? 'YouTube' : 'File'}
            </span>
          </div>
          <button onClick={onRemove} className="secondary" style={{ padding: '4px 8px', flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
          Total: {formatTimestamp(clip.duration)}
        </div>

        <div className="trim-controls">
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <TimestampInput
              value={clip.trimStart}
              onChange={(v) => onTrimChange('trimStart', v)}
              maxDuration={clip.duration}
              minValue={0}
              label="Start:"
            />
            <button className="trim-set-btn" onClick={() => onTrimChange('trimStart', getCurrentTime())} title="Set to current time">
              ↑
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <TimestampInput
              value={clip.trimEnd}
              onChange={(v) => onTrimChange('trimEnd', v)}
              maxDuration={clip.duration}
              minValue={0}
              label="End:"
            />
            <button className="trim-set-btn" onClick={() => onTrimChange('trimEnd', getCurrentTime())} title="Set to current time">
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

function YouTubePreviewInit({ clip, onRef, onAdvance, previewIntervalRef }: YouTubePreviewInitProps) {
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;

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
                onAdvanceRef.current();
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
      if (previewIntervalRef.current) clearInterval(previewIntervalRef.current);
      try { player.destroy(); } catch {}
    };
  }, [clip.videoId, clip.trimStart, clip.trimEnd]);

  return null;
}

export default StitchPage;
