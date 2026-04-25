import { useState, useEffect, useRef } from 'react';
import ReactPlayer from 'react-player';
import { io, Socket } from 'socket.io-client';
import { Video, Scissors, Terminal } from 'lucide-react';
import './App.css';

const Player = ReactPlayer as any;

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  formats: any[];
}

const SERVER_URL = `http://${window.location.hostname}:3001`;

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  
  const logEndRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);

  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    newSocket.on('log', (msg: string) => {
      setLogs((prev) => [...prev, msg]);
    });

    newSocket.on('progress', (p: number) => {
      setProgress(p);
    });

    newSocket.on('complete', (data: { url: string; fileName: string }) => {
      setIsDownloading(false);
      setProgress(100);
      setLogs((prev) => [...prev, 'DOWNLOAD COMPLETE! Triggering file download...']);
      
      // Auto download
      const link = document.createElement('a');
      link.href = `${SERVER_URL}${data.url}`;
      link.setAttribute('download', data.fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    newSocket.on('error', (err: string) => {
      setIsDownloading(false);
      setLogs((prev) => [...prev, `ERROR: ${err}`]);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const fetchVideoInfo = async () => {
    if (!url) return;
    setLoading(true);
    setVideoInfo(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/info?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setVideoInfo(data);
      setStartTime(0);
      setEndTime(data.duration);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
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
      end: endTime
    });
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
  };

  return (
    <div className="container">
      <header>
        <h1><Video /> YouTube Trimmer</h1>
      </header>

      <div className="url-input-group">
        <input 
          type="text" 
          placeholder="Paste YouTube URL here..." 
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
            <Player
              ref={playerRef}
              url={url}
              width="100%"
              height="100%"
              className="react-player"
              controls
            />
          </div>

          <div className="controls-section">
            <div className="time-inputs">
              <div className="input-field">
                <label>Start Time (seconds)</label>
                <input 
                  type="number" 
                  value={startTime}
                  onChange={(e) => setStartTime(Number(e.target.value))}
                  min={0}
                  max={endTime}
                />
                <small>{formatTime(startTime)}</small>
              </div>
              <div className="input-field">
                <label>End Time (seconds)</label>
                <input 
                  type="number" 
                  value={endTime}
                  onChange={(e) => setEndTime(Number(e.target.value))}
                  min={startTime}
                  max={videoInfo.duration}
                />
                <small>{formatTime(endTime)}</small>
              </div>
            </div>

            <div className="timeline-container">
               <div 
                 className="timeline-range" 
                 style={{ 
                   left: `${(startTime / videoInfo.duration) * 100}%`,
                   width: `${((endTime - startTime) / videoInfo.duration) * 100}%`
                 }} 
               />
            </div>

            <button 
              className="download-btn" 
              onClick={startDownload} 
              disabled={isDownloading}
            >
              {isDownloading ? (
                'Processing...'
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                  <Scissors size={18} /> Trim & Download
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {(isDownloading || logs.length > 0) && (
        <div className="status-section">
          <h3><Terminal size={18} style={{ verticalAlign: 'middle', marginRight: '8px' }}/> Logs</h3>
          <div className="progress-section">
            {logs.map((log, i) => (
              <div key={i} className="log-entry">{log}</div>
            ))}
            <div ref={logEndRef} />
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
    </div>
  );
}

export default App;
