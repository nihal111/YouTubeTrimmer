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

const formatTimestamp = (secs: number, maxSecs?: number): string => {
  const { h, m, s } = secondsToHMS(secs);
  const showHours = h > 0 || (maxSecs !== undefined && maxSecs >= 3600);
  
  const mPart = String(m).padStart(2, '0');
  const sPart = s.toFixed(2).padStart(5, '0');
  
  if (showHours) {
    return `${String(h).padStart(2, '0')}:${mPart}:${sPart}`;
  }
  return `${mPart}:${sPart}`;
};

const parseTimestamp = (str: string): number | null => {
  const trimmed = str.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  if (parts.length === 3) {
    // HH:MM:SS
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const s = parseFloat(parts[2]);
    if (!isNaN(h) && !isNaN(m) && !isNaN(s) && h >= 0 && m >= 0 && m < 60 && s >= 0 && s < 60) {
      return h * 3600 + m * 60 + s;
    }
  } else if (parts.length === 2) {
    // MM:SS
    const m = parseInt(parts[0], 10);
    const s = parseFloat(parts[1]);
    if (!isNaN(m) && !isNaN(s) && m >= 0 && s >= 0 && s < 60) {
      return m * 60 + s;
    }
  } else if (parts.length === 1) {
    // SS
    const s = parseFloat(parts[0]);
    if (!isNaN(s) && s >= 0) return s;
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

const fileClipCache = new Map<string, File>();
const CLIPS_STORAGE_KEY = 'stitcher_clips';
const ACTIVE_JOB_KEY = 'stitcher_active_job';

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

const loadClipsFromStorage = (setClips: React.Dispatch<React.SetStateAction<ClipItem[]>>) => {
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
  const [progress, setProgress] = useState({ percent: 0, etc: '' });
  const [isStitching, setIsStitching] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [stitchResult, setStitchResult] = useState<{ url: string; fileName: string } | null>(null);
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
    loadClipsFromStorage(setClips);
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
      reconnectionAttempts: 10
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      const savedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
      if (savedJobId) {
        newSocket.emit('stitch:attach', savedJobId);
      }
    });

    newSocket.on('stitch:attached', (data) => {
      setActiveJobId(data.jobId);
      setIsStitching(!data.result && !data.error);
      if (data.progress) setProgress(data.progress);
      if (data.logs) setLogs(data.logs);
      if (data.result) setStitchResult(data.result);
    });

    newSocket.on('stitch:log', (data: any) => {
      const msg = typeof data === 'string' ? data : (data.msg || JSON.stringify(data));
      setLogs((prev) => [...prev.slice(-100), msg]);
    });

    newSocket.on('stitch:progress', (data: any) => {
      setProgress({ percent: data.percent, etc: data.etc });
    });

    newSocket.on('stitch:complete', (data: any) => {
      setIsStitching(false);
      setProgress({ percent: 100, etc: 'Done!' });
      setStitchResult(data);
      localStorage.removeItem(ACTIVE_JOB_KEY);
      setLogs((prev) => [...prev, 'STITCH COMPLETE!']);
    });

    newSocket.on('stitch:error', (data: any) => {
      setIsStitching(false);
      setLogs((prev) => [...prev, `ERROR: ${data.error}`]);
      localStorage.removeItem(ACTIVE_JOB_KEY);
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

  const resetProject = () => {
    if (clips.length === 0) return;
    if (window.confirm('Are you sure you want to reset the entire project? All clips will be removed.')) {
      clips.forEach((c) => {
        if (c.objectUrl) URL.revokeObjectURL(c.objectUrl);
        if (c.type === 'youtube' && ytPlayerRefs.current[c.id]) {
          ytPlayerRefs.current[c.id].destroy();
          delete ytPlayerRefs.current[c.id];
        }
      });
      fileClipCache.clear();
      setClips([]);
      localStorage.removeItem(CLIPS_STORAGE_KEY);
      stopPreview();
    }
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
    setLogs([]);
    setProgress({ percent: 0, etc: '' });
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
    setStitchResult(null);
    setLogs(['Starting stitch...']);
    setProgress({ percent: 0, etc: 'Starting...' });

    try {
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

      const res = await fetch('/api/stitch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socketId: socket.id,
          clips: clipsToStitch.map((c) => ({
            type: c.type,
            uploadedPath: c.uploadedPath,
            youtubeUrl: c.youtubeUrl,
            trimStart: c.trimStart,
            trimEnd: c.trimEnd
          }))
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setLogs((prev) => [...prev, `Error: ${data.error}`]);
        setIsStitching(false);
      } else {
        setActiveJobId(data.jobId);
        localStorage.setItem(ACTIVE_JOB_KEY, data.jobId);
      }
    } catch (err: any) {
      setLogs((prev) => [...prev, `Failed: ${err.message}`]);
      setIsStitching(false);
    }
  };

  const currentClip = clips[previewIndex];
  const [globalElapsed, setGlobalElapsed] = useState(0);

  useEffect(() => {
    if (!previewActive) {
      setGlobalElapsed(0);
      return;
    }

    const interval = setInterval(() => {
      let elapsed = 0;
      for (let i = 0; i < previewIndex; i++) {
        elapsed += (clips[i].trimEnd - clips[i].trimStart);
      }
      if (currentClip) {
        if (currentClip.type === 'file' && previewVideoRef.current) {
          elapsed += Math.max(0, previewVideoRef.current.currentTime - currentClip.trimStart);
        } else if (currentClip.type === 'youtube' && previewYtPlayerRef.current && previewYtPlayerRef.current.getCurrentTime) {
          elapsed += Math.max(0, previewYtPlayerRef.current.getCurrentTime() - currentClip.trimStart);
        }
      }
      setGlobalElapsed(elapsed);
    }, 250);

    return () => clearInterval(interval);
  }, [previewActive, previewIndex, clips, currentClip]);

  const hasOrphanedClips = clips.some((c) => c.type === 'file' && !c.objectUrl);

  return (
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1><Film /> YouTubeTailor <span style={{ fontSize: '0.6em', opacity: 0.7, fontWeight: 400, marginLeft: '8px', verticalAlign: 'middle' }}>Stitcher</span></h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={resetProject} className="secondary" title="Reset everything and start over" style={{ color: '#ff6b6b' }}>
            🗑 Reset
          </button>
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
              Total: {formatTimestamp(totalDuration, totalDuration)}
            </div>
            {clips.length >= 2 && (
              <>
                <button 
                  onClick={previewActive ? stopPreview : startPreview} 
                  className="secondary" 
                  disabled={hasOrphanedClips}
                >
                  {previewActive ? '⏹ Clear Preview' : '▶ Preview All'}
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

          {previewActive && (
            <div className="preview-player-section" style={{ marginTop: '20px' }}>
              <div className="preview-controls-enhanced">
                <div className="preview-top-row">
                  <span className="preview-clip-count">
                    Clip <span className="highlight-text">{previewIndex + 1}</span> of <span className="highlight-text">{clips.length}</span>
                  </span>
                  <span className="preview-clip-title-truncated" title={currentClip?.title}>
                    {currentClip?.title}
                  </span>
                  <button onClick={stopPreview} className="secondary mini-btn">
                    Stop
                  </button>
                </div>
                
                <div className="preview-details-row">
                  <div className="preview-portion-info">
                    Selected: <span className="highlight-text">{formatTimestamp(currentClip?.trimStart || 0, currentClip?.duration)}</span> - <span className="highlight-text">{formatTimestamp(currentClip?.trimEnd || 0, currentClip?.duration)}</span>
                    <span className="preview-duration-badge">({formatTimestamp((currentClip?.trimEnd || 0) - (currentClip?.trimStart || 0), currentClip?.duration)})</span>
                  </div>
                  <div className="preview-global-progress">
                    <span className="highlight-text">{formatTimestamp(globalElapsed, totalDuration)}</span> / {formatTimestamp(totalDuration, totalDuration)}
                  </div>
                </div>
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
        </>
      )}

      {(isStitching || logs.length > 0 || stitchResult) && (
        <div className="status-section">
          <div className="status-header">
            <h3><Terminal size={18} /> Process Status</h3>
            {isStitching && <span className="badge">Active</span>}
          </div>
          
          {(isStitching || progress.percent > 0) && (
            <div className="progress-details-panel" style={{ marginBottom: '16px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px' }}>
              <div className="progress-metrics" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.9rem' }}>
                <div className="progress-percent-label">
                  Progress: <span className="highlight-text">{progress.percent}%</span>
                </div>
                {isStitching && progress.etc && (
                  <div className="progress-etc-label">
                    Est. remaining: <span className="highlight-text">{progress.etc}</span>
                  </div>
                )}
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
          )}

          {stitchResult && (
            <div className="result-panel" style={{ marginBottom: '16px', padding: '16px', background: 'rgba(81, 207, 102, 0.1)', border: '1px solid rgba(81, 207, 102, 0.3)', borderRadius: '8px', textAlign: 'center' }}>
              <div className="result-message" style={{ color: '#51cf66', fontWeight: '600', marginBottom: '12px' }}>✓ Stitching finished successfully!</div>
              <button 
                onClick={() => window.open(stitchResult.url, '_blank')} 
                className="primary"
                style={{ width: '100%' }}
              >
                📥 Download Output Video
              </button>
            </div>
          )}

          <div className="progress-section" ref={logContainerRef}>
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
        </div>
      )}

      <footer style={{ marginTop: '40px', padding: '20px 0', textAlign: 'center', borderTop: '1px solid var(--border)', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
        <p>© {new Date().getFullYear()} <strong>YouTubeTailor</strong> — Handcrafted for perfect cuts.</p>
      </footer>
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
  const [displayValue, setDisplayValue] = useState(formatTimestamp(value, maxDuration));
  const [isFocused, setIsFocused] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayValue(e.target.value);
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseTimestamp(displayValue);

    if (parsed === null) {
      setDisplayValue(formatTimestamp(value, maxDuration));
    } else {
      const clamped = Math.max(minValue, Math.min(maxDuration, parsed));
      onChange(clamped);
      setDisplayValue(formatTimestamp(clamped, maxDuration));
    }
  };

  useEffect(() => {
    if (!isFocused) {
      setDisplayValue(formatTimestamp(value, maxDuration));
    }
  }, [value, isFocused, maxDuration]);

  return (
    <div className="trim-row">
      <label className="trim-label">{label}</label>
      <input
        type="text"
        value={displayValue}
        onChange={handleChange}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        placeholder={maxDuration >= 3600 ? "HH:MM:SS" : "MM:SS"}
        title="HH:MM:SS, MM:SS or SS.MS"
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

        <div className="clip-duration-row">
          <div className="clip-total-duration">
            Total: {formatTimestamp(clip.duration, clip.duration)}
          </div>
          <div className="clip-selected-duration">
            Selected: <span className="highlight-text">{formatTimestamp(trimmedDuration, clip.duration)}</span>
          </div>
        </div>

        <div className="trim-controls-horizontal">
          <div className="trim-input-group">
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

          <div className="trim-input-group">
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
