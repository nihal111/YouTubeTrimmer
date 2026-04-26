import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Film, Terminal, X, Plus } from 'lucide-react';
import './App.css';

function StitchPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [isStitching, setIsStitching] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFirstFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFiles([e.target.files[0]]);
    }
  };

  const handleAddFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setFiles((prev) => [...prev, file]);
      e.target.value = '';
    }
  };

  const handleDropzone = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0] && files.length === 0) {
      setFiles([e.dataTransfer.files[0]]);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const startStitch = async () => {
    if (files.length < 2 || !socket) return;

    setIsStitching(true);
    setLogs(['Uploading files...']);
    setProgress(0);

    const formData = new FormData();
    files.forEach((file) => {
      formData.append('files', file);
    });
    formData.append('socketId', socket.id);

    try {
      const res = await fetch('/api/stitch/upload', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();

      if (!res.ok) {
        setLogs((prev) => [...prev, `Upload error: ${data.error}`]);
        setIsStitching(false);
      }
      // Server will handle the rest via socket events
    } catch (err: any) {
      setLogs((prev) => [...prev, `Upload failed: ${err.message}`]);
      setIsStitching(false);
    }
  };

  return (
    <div className="container">
      <header>
        <h1><Film /> Stitch Files</h1>
      </header>

      {files.length === 0 ? (
        <>
          <div
            className="stitch-dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropzone}
          >
            <Film size={48} style={{ opacity: 0.6, margin: '0 auto' }} />
            <p>Click to select first file or drag & drop</p>
            <p style={{ fontSize: '0.8rem', marginTop: '8px', color: 'var(--text-dim)' }}>
              Supports video (mp4, mov, mkv) and audio (mp3, wav, m4a)
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*"
              onChange={handleFirstFileSelect}
            />
          </div>
        </>
      ) : (
        <>
          <div className="stitch-file-list">
            {files.map((file, index) => (
              <div key={index} className="stitch-file-item">
                <span className="stitch-file-index">{index + 1}.</span>
                <span className="stitch-file-name">{file.name}</span>
                <button
                  className="stitch-file-remove"
                  onClick={() => removeFile(index)}
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            className="stitch-add-btn"
            onClick={() => addFileInputRef.current?.click()}
          >
            + Add File
          </button>

          <input
            ref={addFileInputRef}
            type="file"
            accept="video/*,audio/*"
            onChange={handleAddFile}
            style={{ display: 'none' }}
          />

          {files.length >= 2 && (
            <button
              className="download-btn"
              onClick={startStitch}
              disabled={isStitching}
              style={{ width: '100%' }}
            >
              {isStitching ? 'Stitching...' : `Stitch ${files.length} Files`}
            </button>
          )}
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

export default StitchPage;
