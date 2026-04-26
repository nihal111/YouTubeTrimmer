import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Video, Scissors, Terminal, Clock, Download, FileAudio, FileVideo } from 'lucide-react';
import './App.css';

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  formats: any[];
}

const SERVER_URL = '';

function extractYouTubeId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [format, setFormat] = useState('mp4');
  const [resolution, setResolution] = useState('best');
  const [logs, setLogs] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [youtubeStatus, setYoutubeStatus] = useState('Loading YouTube API...');

  const logContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);

  // Load YouTube iframe API
  useEffect(() => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      setYoutubeStatus('✓ YouTube API Ready');
    };

    return () => {
      setYoutubeStatus('');
    };
  }, []);

  // Capture system errors for debugging
  useEffect(() => {
    window.addEventListener('error', (event) => {
      const msg = `[CRASH] ${event.message} at ${event.filename}:${event.lineno}`;
      setDebugLogs(prev => [...prev.slice(-20), msg]);
    });

    window.addEventListener('unhandledrejection', (event) => {
      const msg = `[UNHANDLED] ${event.reason}`;
      setDebugLogs(prev => [...prev.slice(-20), msg]);
    });
  }, []);

  useEffect(() => {
    console.log('Connecting to socket at:', window.location.origin);
    const newSocket = io({
      path: '/socket.io',
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5
    });
    setSocket(newSocket);

    newSocket.on('log', (msg: string) => {
      setLogs((prev) => [...prev.slice(-100), msg]);
    });

    newSocket.on('progress', (p: number) => {
      setProgress(p);
    });

    newSocket.on('complete', (data: { url: string; fileName: string }) => {
      setIsDownloading(false);
      setProgress(100);
      setLogs((prev) => [...prev, 'DOWNLOAD COMPLETE! Opening in new tab...']);

      const fileUrl = `${SERVER_URL}${data.url}`;
      window.open(fileUrl, '_blank');
    });

    newSocket.on('error', (err: string) => {
      setIsDownloading(false);
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
    if (videoInfo && playerContainerRef.current && window.YT) {
      try {
        const videoId = extractYouTubeId(url);
        console.log('[PLAYER] Creating YT.Player for videoId:', videoId);

        // Clear container
        playerContainerRef.current.innerHTML = '';

        playerRef.current = new window.YT.Player(playerContainerRef.current, {
          videoId: videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            modestbranding: 1,
            rel: 0,
            fs: 1,
            controls: 1,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onError: (event: any) => {
              const errorCode = event.data;
              console.error('[PLAYER] Error:', errorCode);
              setDebugLogs(prev => [...prev, `[PLAYER ERROR] Error code ${errorCode}`]);
            }
          }
        });
        console.log('[PLAYER] YT.Player created successfully');
      } catch (err: any) {
        console.error('[PLAYER] Failed to create player:', err.message);
        setDebugLogs(prev => [...prev, `[PLAYER ERROR] ${err.message}`]);
      }
    }

    return () => {
      if (playerRef.current && playerRef.current.destroy) {
        try {
          playerRef.current.destroy();
        } catch (e) {
          // Player already destroyed
        }
      }
    };
  }, [videoInfo, url]);

  const fetchVideoInfo = async () => {
    if (!url) return;
    setLoading(true);
    setVideoInfo(null);
    try {
      console.log('[API] Fetching video info for:', url);
      const res = await fetch(`${SERVER_URL}/api/info?url=${encodeURIComponent(url)}`);
      console.log('[API] Response status:', res.status);
      const data = await res.json();
      console.log('[API] Response data:', data);
      if (data.error) throw new Error(data.error);
      console.log('[API] Setting video info');
      setVideoInfo(data);
      setStartTime(0);
      setEndTime(data.duration);
      console.log('[API] Video info set successfully');
    } catch (err: any) {
      const errMsg = `Error: ${err.message}`;
      console.error('[API] Fetch failed:', errMsg);
      setDebugLogs(prev => [...prev, `[API ERROR] ${errMsg}`]);
      alert(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const startDownload = () => {
    if (!socket || !videoInfo) return;
    setLogs(['Initializing download...']);
    setProgress(0);
    setIsDownloading(true);
    socket.emit('start-download', {
      url,
      start: startTime,
      end: endTime,
      format,
      resolution
    });
  };

  const secondsToHMS = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return { h, m, s };
  };

  const hmsToSeconds = (h: number, m: number, s: number) => {
    return h * 3600 + m * 60 + s;
  };

  const formatTimestamp = (secs: number): string => {
    const hms = secondsToHMS(secs);
    const sDisplay = hms.s.toFixed(2);
    return `${String(hms.h).padStart(2, '0')}:${String(hms.m).padStart(2, '0')}:${sDisplay}`;
  };

  const handleHMSChange = (type: 'start' | 'end', unit: 'h' | 'm' | 's', value: string) => {
    const current = secondsToHMS(type === 'start' ? startTime : endTime);
    let val: number;

    if (unit === 's') {
      val = Math.max(0, parseFloat(value) || 0);
    } else {
      val = Math.max(0, parseInt(value) || 0);
    }

    const newHMS = { ...current, [unit]: val };
    const newSecs = hmsToSeconds(newHMS.h, newHMS.m, newHMS.s);

    if (type === 'start') {
      setStartTime(Math.min(newSecs, endTime));
    } else {
      setEndTime(Math.min(newSecs, videoInfo?.duration || newSecs));
    }
  };

  const setTimeFromPlayer = (type: 'start' | 'end') => {
    if (!playerRef.current || !playerRef.current.getCurrentTime) {
      alert('Player not ready. Please wait a moment and try again.');
      return;
    }
    const currentTime = playerRef.current.getCurrentTime();
    if (type === 'start') {
      setStartTime(currentTime);
    } else {
      setEndTime(currentTime);
    }
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoInfo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedTime = (x / rect.width) * videoInfo.duration;

    if (Math.abs(clickedTime - startTime) < Math.abs(clickedTime - endTime)) {
      setStartTime(clickedTime);
    } else {
      setEndTime(clickedTime);
    }
  };

  const handleTimelineMouseDown = (e: React.MouseEvent, edge: 'start' | 'end' | 'range') => {
    if (!videoInfo) return;
    e.preventDefault();

    const startX = e.clientX;
    const timelineContainer = e.currentTarget.closest('.timeline-container') as HTMLElement;
    const timelineRect = timelineContainer.getBoundingClientRect();
    const initialStart = startTime;
    const initialEnd = endTime;
    const duration = initialEnd - initialStart;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = (deltaX / timelineRect.width) * videoInfo.duration;

      if (edge === 'start') {
        const newStart = Math.max(0, Math.min(initialStart + deltaTime, initialEnd - 0.1));
        setStartTime(newStart);
      } else if (edge === 'end') {
        const newEnd = Math.min(videoInfo.duration, Math.max(initialEnd + deltaTime, initialStart + 0.1));
        setEndTime(newEnd);
      } else if (edge === 'range') {
        const newStart = Math.max(0, Math.min(initialStart + deltaTime, videoInfo.duration - duration));
        setStartTime(newStart);
        setEndTime(newStart + duration);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const renderHMSInput = (type: 'start' | 'end') => {
    const hms = secondsToHMS(type === 'start' ? startTime : endTime);
    return (
      <div className="hms-input">
        <input
          type="number"
          value={hms.h}
          onChange={(e) => handleHMSChange(type, 'h', e.target.value)}
          placeholder="HH"
        />:
        <input
          type="number"
          value={hms.m}
          onChange={(e) => handleHMSChange(type, 'm', e.target.value)}
          placeholder="MM"
        />:
        <input
          type="number"
          step="0.01"
          value={hms.s.toFixed(2)}
          onChange={(e) => handleHMSChange(type, 's', e.target.value)}
          placeholder="SS.ss"
        />
      </div>
    );
  };

  return (
    <div className="container">
      <header>
        <h1><Video /> YouTubeTrimmer</h1>
        {youtubeStatus && (
          <div style={{ fontSize: '0.85rem', color: youtubeStatus.includes('✗') ? '#ff6b6b' : youtubeStatus.includes('✓') ? '#51cf66' : '#aaaaaa', marginTop: '8px' }}>
            {youtubeStatus}
          </div>
        )}
      </header>

      <div className="url-input-group">
        <input
          type="text"
          placeholder="Paste YouTube URL (e.g., https://youtube.com/watch?v=...)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading || isDownloading}
        />
        <button onClick={fetchVideoInfo} disabled={loading || !url || isDownloading}>
          {loading ? 'Loading...' : 'Load'}
        </button>
      </div>

      {videoInfo && (
        <div className="video-section">
          <div className="player-wrapper">
            <div
              ref={playerContainerRef}
              className="react-player"
              style={{ width: '100%', height: '100%' }}
            />
          </div>

          <div className="controls-section">
            <div className="time-grid">
              <div className="input-field start-position">
                <label><Clock size={14} /> Start Position</label>
                {renderHMSInput('start')}
                <button className="secondary" onClick={() => setTimeFromPlayer('start')}>
                  Set to Current
                </button>
              </div>
              <div className="input-field end-position">
                <label><Clock size={14} /> End Position</label>
                {renderHMSInput('end')}
                <button className="secondary" onClick={() => setTimeFromPlayer('end')}>
                  Set to Current
                </button>
              </div>
            </div>

            <div className="timeline-container" onClick={handleTimelineClick}>
               <div
                 className="timeline-label start"
                 style={{
                   left: `${(startTime / videoInfo.duration) * 100}%`
                 }}
                 onMouseDown={(e) => {
                   e.stopPropagation();
                   handleTimelineMouseDown(e, 'start');
                 }}
               >
                 {formatTimestamp(startTime)}
               </div>
               <div
                 className="timeline-range"
                 onMouseDown={(e) => handleTimelineMouseDown(e, 'range')}
                 style={{
                   left: `${(startTime / videoInfo.duration) * 100}%`,
                   width: `${((endTime - startTime) / videoInfo.duration) * 100}%`
                 }}
               >
                 <div
                   className="timeline-edge start-edge"
                   onMouseDown={(e) => {
                     e.stopPropagation();
                     handleTimelineMouseDown(e, 'start');
                   }}
                 />
                 <div
                   className="timeline-edge end-edge"
                   onMouseDown={(e) => {
                     e.stopPropagation();
                     handleTimelineMouseDown(e, 'end');
                   }}
                 />
               </div>
               <div
                 className="timeline-label end"
                 style={{
                   left: `${(endTime / videoInfo.duration) * 100}%`
                 }}
                 onMouseDown={(e) => {
                   e.stopPropagation();
                   handleTimelineMouseDown(e, 'end');
                 }}
               >
                 {formatTimestamp(endTime)}
               </div>
            </div>

            <div className="options-grid">
              <div className="input-field">
                <label>Output Format</label>
                <select value={format} onChange={(e) => setFormat(e.target.value)}>
                  <option value="mp4">MP4 (Video)</option>
                  <option value="mp3">MP3 (Audio)</option>
                </select>
              </div>
              <div className="input-field">
                <label>Resolution</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  disabled={format === 'mp3'}
                >
                  <option value="best">Best Quality</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                  <option value="360">360p</option>
                </select>
              </div>
            </div>

            <button
              className="download-btn"
              onClick={startDownload}
              disabled={isDownloading}
            >
              {isDownloading ? (
                'Processing Snippet...'
              ) : (
                <>
                  <Scissors size={20} />
                  {format === 'mp3' ? 'Extract MP3' : 'Trim & Download MP4'}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {(isDownloading || logs.length > 0) && (
        <div className="status-section">
          <div className="status-header">
            <h3><Terminal size={18} /> Process Logs</h3>
            {isDownloading && <span className="badge">Active</span>}
          </div>
          <div className="progress-section" ref={logContainerRef}>
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
          </div>
          {isDownloading && (
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {debugLogs.length > 0 && (
        <div className="debug-panel">
          <small>System Debug Logs:</small>
          {debugLogs.map((log, i) => (
            <div key={i} className="debug-entry">{log}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
