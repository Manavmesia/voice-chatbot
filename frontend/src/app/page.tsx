'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { FormattedMessage } from './components/FormattedMessage';

const API_BASE = '';  // Same-origin via Next.js proxy — see next.config.ts
// WebSocket connects directly from the browser; configurable via NEXT_PUBLIC_WS_BASE.
const WS_BASE = process.env.NEXT_PUBLIC_WS_BASE ?? 'ws://localhost:8000';

interface PDFFile {
  filename: string;
  size_bytes: number;
  chunks_count: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isInterrupted?: boolean;
}

export default function Home() {
  const [sessionId, setSessionId] = useState<string>('');
  const [pdfs, setPdfs] = useState<PDFFile[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [partialTranscript, setPartialTranscript] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [assistantStatus, setAssistantStatus] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isReindexing, setIsReindexing] = useState<boolean>(false);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');
  
  // Manual text query state
  const [textInput, setTextInput] = useState<string>('');
  
  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const generationIdRef = useRef<number>(0);
  const assistantStatusRef = useRef<string>('idle');
  
  // Keep assistantStatusRef updated to avoid callback recreation
  useEffect(() => {
    assistantStatusRef.current = assistantStatus;
  }, [assistantStatus]);
  
  // Playback Hook
  const audioPlayer = useAudioPlayer();
  
  // Generate session ID on client mount
  useEffect(() => {
    setSessionId(`session_${Math.random().toString(36).substring(2, 11)}`);
    fetchPDFs();
  }, []);
  
  // Auto-scroll chat transcripts
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, partialTranscript]);
  
  // Fetch PDFs from the backend
  const fetchPDFs = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/pdfs/list`);
      if (res.ok) {
        const data = await res.json();
        setPdfs(data);
      }
    } catch (err) {
      console.error('Error fetching PDFs:', err);
    }
  };
  
  // Core upload logic
  const uploadFiles = async (files: FileList) => {
    if (files.length === 0) return;
    
    // Filter to only PDF files
    const pdfFiles = Array.from(files).filter(file => file.type === "application/pdf" || file.name.endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      alert("Please upload PDF documents only.");
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    for (let i = 0; i < pdfFiles.length; i++) {
      formData.append('files', pdfFiles[i]);
    }
    
    try {
      const res = await fetch(`${API_BASE}/api/pdfs/upload`, {
        method: 'POST',
        body: formData,
      });
      
      if (res.ok) {
        await fetchPDFs();
      } else {
        const errData = await res.json();
        alert(`Upload failed: ${errData.detail || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Error uploading files:', err);
      alert('Network error occurred during PDF upload.');
    } finally {
      setIsUploading(false);
    }
  };

  // Handle PDF upload via select
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await uploadFiles(e.target.files);
    e.target.value = ''; // Reset input
  };

  // Drag and Drop Handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await uploadFiles(e.dataTransfer.files);
    }
  };
  
  // Handle PDF deletion
  const handleDeletePDF = async (filename: string) => {
    if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
    
    try {
      const res = await fetch(`${API_BASE}/api/pdfs/delete/${filename}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchPDFs();
      }
    } catch (err) {
      console.error('Error deleting PDF:', err);
    }
  };
  
  // Handle PDF reindexing
  const handleReindex = async () => {
    setIsReindexing(true);
    try {
      const res = await fetch(`${API_BASE}/api/pdfs/reindex`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchPDFs();
        alert('All PDFs have been successfully re-indexed!');
      }
    } catch (err) {
      console.error('Error reindexing:', err);
    } finally {
      setIsReindexing(false);
    }
  };
  
  // Stop Speech Recognition
  const stopSpeechRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null; // Clear auto-restart
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
  }, []);

  // Cleanup Session State
  const cleanupSessionState = useCallback(() => {
    setConnectionStatus('disconnected');
    setAssistantStatus('idle');
    setPartialTranscript('');
    stopSpeechRecognition();
    audioPlayer.stopPlayback();
  }, [stopSpeechRecognition, audioPlayer]);

  // Disconnect Session
  const disconnectSession = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    cleanupSessionState();
  }, [cleanupSessionState]);

  // Browser Speech Recognition controllers
  const startSpeechRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Web Speech Recognition API is not supported in this browser. Please use Chrome, Edge, or Safari.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onstart = () => {
      setIsRecording(true);
      setAssistantStatus('listening');
    };

    rec.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      // --- BARGE-IN INTERRUPTION HANDLING ---
      // Stop local audio and notify the server. Do NOT increment generationIdRef
      // here — the increment happens exactly once when the new text-query is sent,
      // preventing a double-increment that would make the backend's response ID
      // mismatch the frontend's active ID.
      if ((interim.trim() || final.trim()) && (audioPlayer.isPlaying || assistantStatusRef.current === 'speaking')) {
        console.log('[Barge-in] Interrupting active TTS.');
        audioPlayer.stopPlayback();
        setAssistantStatus('listening');

        // Notify backend to cancel its active generation.
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
        }

        // Mark the current assistant message as interrupted in the transcript.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, isInterrupted: true }];
          }
          return prev;
        });
      }

      if (interim.trim()) {
        setPartialTranscript(interim);
        setAssistantStatus('listening');
      }

      if (final.trim()) {
        setPartialTranscript('');
        // Add user statement locally
        setMessages((prev) => [
          ...prev,
          { id: `user_${Date.now()}`, role: 'user', content: final },
        ]);

        // Increment generation ID on new query
        generationIdRef.current += 1;

        // Send query to WebSocket with generationId
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'text-query',
            text: final,
            generationId: generationIdRef.current
          }));
          setAssistantStatus('thinking');
        }
      }
    };

    rec.onerror = (err: any) => {
      if (err.error === 'no-speech') return; // Ignore silent pauses
      
      console.error("Speech recognition error:", err.error, err);
      setIsRecording(false);
      
      // Stop session and alert user if microphone is blocked or not available
      const fatalErrors = ['not-allowed', 'audio-capture', 'service-not-allowed'];
      if (fatalErrors.includes(err.error)) {
        console.warn(`Speech recognition stopped due to fatal error: ${err.error}`);
        rec.onend = null; // Prevent loop
        disconnectSession();
        
        if (err.error === 'not-allowed') {
          alert("Microphone access was denied or is blocked. Please ensure microphone permissions are granted and that you are accessing the app over localhost or a secure HTTPS connection.");
        } else if (err.error === 'audio-capture') {
          alert("No microphone found. Please connect a microphone and try again.");
        } else {
          alert(`Speech recognition error: ${err.error}. Continuous listening disabled.`);
        }
      }
    };

    rec.onend = () => {
      // Auto-restart if we are still connected to keep session alive
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          rec.start();
          return; // Skip setting isRecording to false to prevent UI flicker during silent restarts
        } catch (e) {
          // If already running, we keep isRecording = true, otherwise let it fall through
          if (e instanceof Error && e.name === 'InvalidStateError') {
            return;
          }
        }
      }
      setIsRecording(false);
    };

    recognitionRef.current = rec;
    rec.start();
  }, [audioPlayer, disconnectSession]);

  // Toggle the voice assistant session connection
  const toggleVoiceSession = async () => {
    if (connectionStatus === 'connected') {
      disconnectSession();
    } else {
      await connectSession();
    }
  };
  
  const connectSession = async () => {
    if (!sessionId) return;
    
    setConnectionStatus('connecting');
    setMessages([]);
    setPartialTranscript('');
    generationIdRef.current = 0;
    
    try {
      const wsUrl = `${WS_BASE}/ws/chat/${sessionId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      ws.onopen = () => {
        setConnectionStatus('connected');
        setAssistantStatus('idle');
        // Start client voice transcription immediately
        startSpeechRecognition();
      };
      
      ws.onclose = () => {
        cleanupSessionState();
      };
      
      ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        cleanupSessionState();
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // If message has a generationId and it's not the active one, discard it
        if (data.generationId !== undefined && data.generationId !== generationIdRef.current) {
          console.log(`Discarding stale WebSocket message of type ${data.type} (generation ID: ${data.generationId}, current: ${generationIdRef.current})`);
          return;
        }
        
        switch (data.type) {
          case 'connection-status':
            console.log('Session connection verified:', data.status);
            break;
            
          case 'language-detected':
            // Show detected language in the UI
            setDetectedLanguage(data.language_name || '');
            break;
            
          case 'llm-chunk':
            // AI is generating text
            setAssistantStatus('speaking');
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + data.text },
                ];
              } else {
                return [
                  ...prev,
                  { id: `ai_${Date.now()}`, role: 'assistant', content: data.text },
                ];
              }
            });
            break;
            
          case 'audio-chunk':
            // AI synthesized audio segment, decode and play
            setAssistantStatus('speaking');
            audioPlayer.playChunk(data.audio);
            break;
            
          case 'response-complete':
            // Generation finished
            break;
            
          case 'memory-cleared':
            setMessages([]);
            setDetectedLanguage('');
            break;
            
          case 'error':
            alert(`Server Error: ${data.message}`);
            break;
            
          default:
            console.log('Unhandled WebSocket message:', data);
        }
      };
      
    } catch (err) {
      console.error('Failed to establish WebSocket connection:', err);
      cleanupSessionState();
    }
  };
  
  // Handle text question manual submission
  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || connectionStatus !== 'connected') return;

    // Stop active audio locally if the AI is currently speaking.
    if (audioPlayer.isPlaying || assistantStatusRef.current === 'speaking') {
      audioPlayer.stopPlayback();
      setAssistantStatus('idle');
      // Notify backend — the new text-query below will cancel + replace anyway,
      // but sending interrupt first ensures immediate stop on the server side.
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
      }
    }

    // Add user message to transcript.
    setMessages((prev) => [
      ...prev,
      { id: `user_${Date.now()}`, role: 'user', content: textInput },
    ]);

    // Increment generation ID exactly once for this new query.
    generationIdRef.current += 1;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'text-query',
        text: textInput,
        generationId: generationIdRef.current,
      }));
      setAssistantStatus('thinking');
      console.log(`[TextSubmit] Sent query gen=${generationIdRef.current}`);
    }

    setTextInput('');
  };
  
  // Clear chat logs and history
  const handleClearHistory = () => {
    if (connectionStatus === 'connected' && wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'clear-memory' }));
    } else {
      setMessages([]);
    }
  };
  
  // Dynamic Canvas Waveform Visualizer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const handleResize = () => {
      if (canvas && canvas.parentElement) {
        canvas.width = canvas.parentElement.clientWidth || 400;
        canvas.height = 140;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    
    let phase = 0;
    
    const drawWavyCircle = (
      context: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      radius: number,
      noiseAmplitude: number,
      noiseFrequency: number,
      noisePhase: number,
      color: string,
      audioData: Uint8Array | null,
      isFilled = true
    ) => {
      context.beginPath();
      const numPoints = 80;
      for (let i = 0; i <= numPoints; i++) {
        const angle = (i / numPoints) * Math.PI * 2;
        
        let freqFactor = 0;
        if (audioData && audioData.length > 0) {
          const bin = Math.floor((Math.abs(Math.sin(angle * 3)) * audioData.length) / 2) % audioData.length;
          freqFactor = audioData[bin] / 255;
        }
        
        const noise = Math.sin(angle * noiseFrequency + noisePhase) * noiseAmplitude * (0.2 + 0.8 * freqFactor);
        const currentR = Math.max(5, radius + noise);
        const x = cx + Math.cos(angle) * currentR;
        const y = cy + Math.sin(angle) * currentR;
        
        if (i === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.closePath();
      if (isFilled) {
        context.fillStyle = color;
        context.fill();
      } else {
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.stroke();
      }
    };
    
    const render = () => {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      
      // State A: AI is Speaking -> draw reactive fluid orb
      if (assistantStatus === 'speaking') {
        const audioData = audioPlayer.getAnalyserData();
        let volume = 0;
        if (audioData && audioData.length > 0) {
          let sum = 0;
          for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i];
          }
          volume = sum / audioData.length;
        }
        
        const baseRadius = 35;
        const volumeBoost = (volume / 255) * 20;
        const pulse = 1 + Math.sin(phase * 1.5) * 0.04;
        const r = (baseRadius + volumeBoost) * pulse;
        
        ctx.shadowBlur = 0;
        
        // Layer 1: Outer faint wavy ring
        drawWavyCircle(ctx, centerX, centerY, r * 1.35, 12, 5, phase * 0.8, 'rgba(255, 255, 255, 0.08)', audioData, false);
        
        // Layer 2: Middle overlapping semi-transparent fluid shapes
        drawWavyCircle(ctx, centerX, centerY, r * 1.2, 8, 4, -phase * 1.2, 'rgba(115, 115, 115, 0.12)', audioData, true);
        drawWavyCircle(ctx, centerX, centerY, r * 1.05, 6, 6, phase * 1.4, 'rgba(255, 255, 255, 0.08)', audioData, true);
        
        // Layer 3: Solid Core glowing Orb
        const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, r * 0.85);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.7, '#d4d4d4');
        grad.addColorStop(1, '#737373');
        
        ctx.shadowBlur = 25;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.45)';
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
      // State B: Listening -> Draw active white pulsing orb + expanding rings
      else if (assistantStatus === 'listening' || isRecording) {
        const r = 35 + Math.sin(phase * 2.5) * 2;
        
        ctx.shadowBlur = 0;
        const numRings = 2;
        for (let i = 0; i < numRings; i++) {
          const ringProgress = ((phase * 0.08 + i * 0.5) % 1.0);
          const ringRadius = r + ringProgress * 45;
          const ringOpacity = (1 - ringProgress) * 0.35;
          ctx.strokeStyle = `rgba(255, 255, 255, ${ringOpacity})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
        
        const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(1, '#a3a3a3');
        
        ctx.shadowBlur = 15;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // State C: Thinking -> Loading/processing rotating circle loader
      else if (assistantStatus === 'thinking') {
        const r = 33 + Math.sin(phase * 1.5) * 1.2;
        
        const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, r);
        grad.addColorStop(0, '#e5e5e5');
        grad.addColorStop(1, '#737373');
        
        ctx.shadowBlur = 12;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r + 10, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r + 10, phase * 0.8, phase * 0.8 + Math.PI * 0.6);
        ctx.stroke();
      }
      // State D: Connected but Idle -> calm, slow breathing gray orb + subtle background wave
      else if (connectionStatus === 'connected') {
        const r = 32 + Math.sin(phase * 0.6) * 1.5;
        
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(115, 115, 115, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < width; x += 5) {
          const y = centerY + Math.sin(x * 0.01 + phase * 0.4) * 4;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        
        const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, r);
        grad.addColorStop(0, '#a3a3a3');
        grad.addColorStop(1, '#404040');
        
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.08)';
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // State E: Disconnected -> static faint dashed line + dark orb
      else {
        const r = 30;
        ctx.shadowBlur = 0;
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(centerX - r - 10, centerY);
        ctx.moveTo(centerX + r + 10, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        ctx.setLineDash([]);
        
        ctx.fillStyle = '#171717';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      
      phase += 0.04;
      animationRef.current = requestAnimationFrame(render);
    };
    
    render();
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [assistantStatus, connectionStatus, audioPlayer, isRecording]);
  
  // Sync status if player finishes speaking
  useEffect(() => {
    if (connectionStatus === 'connected' && !audioPlayer.isPlaying && assistantStatus === 'speaking') {
      setAssistantStatus('idle');
    }
  }, [audioPlayer.isPlaying, assistantStatus, connectionStatus]);

  return (
    <main className="max-w-7xl mx-auto p-4 md:p-8 flex flex-col gap-6 min-h-screen">
      
      {/* Header Bar */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-white/5">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-white via-neutral-200 to-neutral-400 bg-clip-text text-transparent">
            Antigravity Speech AI
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-Time Speech-to-Speech Assistant grounded strictly in your PDF Knowledge Base.
          </p>
        </div>
        
        {/* Connection Status indicator */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-900 border border-white/5 text-xs font-semibold">
            <span className={`w-2 h-2 rounded-full ${
              connectionStatus === 'connected' ? 'bg-emerald-500 shadow-emerald-500/55 shadow-[0_0_10px_1px]' :
              connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' : 'bg-neutral-600'
            }`} />
            {connectionStatus === 'connected' && 'Session Active'}
            {connectionStatus === 'connecting' && 'Connecting...'}
            {connectionStatus === 'disconnected' && 'Disconnected'}
          </div>
          
          <button
            onClick={toggleVoiceSession}
            className={`cursor-pointer px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 shadow-md ${
              connectionStatus === 'connected'
                ? 'bg-neutral-900 border border-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-800 shadow-neutral-950/20'
                : 'bg-white text-black hover:bg-neutral-200 shadow-white/5'
            }`}
          >
            {connectionStatus === 'connected' ? 'End Conversation' : 'Start Conversation'}
          </button>
        </div>
      </header>

      {/* Main Grid: Sidebar (PDF Panel) + Chat Area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start flex-grow">
        
        {/* Sidebar: PDF Management (Grid 4/12) */}
        <section className="lg:col-span-4 flex flex-col gap-6 h-full lg:max-h-[75vh]">
          
          {/* PDF Upload panel */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col gap-4">
            <h2 className="text-lg font-bold text-slate-100 flex items-center justify-between">
              <span>PDF Documents</span>
              {pdfs.length > 0 && (
                <button
                  onClick={handleReindex}
                  disabled={isReindexing}
                  className="cursor-pointer text-xs font-semibold text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
                >
                  {isReindexing ? 'Indexing...' : 'Re-index All'}
                </button>
              )}
            </h2>
            
            {/* Drag & Drop area */}
            <label 
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              className={`border border-dashed rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-all duration-200 text-center ${
                dragActive 
                  ? 'border-white bg-neutral-900 scale-[1.02]' 
                  : 'border-neutral-800 hover:border-neutral-500 hover:bg-neutral-900/40'
              }`}
            >
              <input
                type="file"
                multiple
                accept=".pdf"
                onChange={handleFileUpload}
                disabled={isUploading}
                className="hidden"
              />
              <svg className={`w-10 h-10 mb-2 transition-transform duration-200 ${dragActive ? 'text-white scale-110' : 'text-neutral-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <span className={`text-sm font-medium transition-colors duration-200 ${dragActive ? 'text-neutral-200' : 'text-slate-300'}`}>
                {isUploading ? 'Uploading & Indexing...' : dragActive ? 'Drop your PDFs here!' : 'Drag & Drop or click to upload'}
              </span>
              <span className="text-xs text-neutral-500 mt-1">Only .pdf supported</span>
            </label>
            
            {/* List of active PDFs */}
            <div className="flex flex-col gap-2 overflow-y-auto max-h-[30vh]">
              {pdfs.length === 0 ? (
                <div className="text-center py-6 text-slate-500 text-sm">
                  No documents uploaded. Index a PDF to start grounding the AI.
                </div>
              ) : (
                pdfs.map((pdf) => (
                  <div
                    key={pdf.filename}
                    className="flex items-center justify-between p-2.5 rounded-lg bg-neutral-950 border border-white/5 text-sm"
                  >
                    <div className="flex flex-col gap-0.5 truncate pr-2">
                      <span className="font-medium text-slate-200 truncate">{pdf.filename}</span>
                      <span className="text-xs text-slate-500">
                        {(pdf.size_bytes / 1024 / 1024).toFixed(2)} MB • {pdf.chunks_count} chunks
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeletePDF(pdf.filename)}
                      className="cursor-pointer p-1.5 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-all duration-100"
                      title="Delete document"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Chat Interface Area (Grid 8/12) */}
        <section className="lg:col-span-8 flex flex-col gap-6 h-full lg:max-h-[75vh]">
          
          {/* Voice Display & visualizer */}
          <div className="glass-panel rounded-2xl p-6 flex flex-col items-center justify-center gap-4 relative overflow-hidden">
            
            {/* Visualizer canvas */}
            <canvas ref={canvasRef} className="w-full h-[140px] block" />
            
            {/* Dynamic Status bubble */}
            <div className="flex items-center gap-3">
              <span className={`w-3 h-3 rounded-full ${
                assistantStatus === 'speaking' ? 'bg-white voice-speaking' :
                assistantStatus === 'thinking' ? 'bg-neutral-400 voice-thinking' :
                assistantStatus === 'listening' ? 'bg-neutral-300 voice-listening' :
                connectionStatus === 'connected' ? 'bg-neutral-500 voice-idle' : 'bg-neutral-800'
              }`} />
              <span className="text-sm font-bold tracking-wide uppercase text-slate-400">
                {connectionStatus === 'connected' ? (
                  assistantStatus === 'speaking' ? 'AI is speaking...' :
                  assistantStatus === 'thinking' ? 'Thinking...' :
                  assistantStatus === 'listening' ? 'Listening...' : 'Listening continuously'
                ) : 'Assistant offline'}
              </span>
            </div>
          </div>
          
          {/* Conversation history transcripts */}
          <div className="glass-panel rounded-2xl p-5 flex flex-col flex-grow min-h-[30vh] overflow-y-auto max-h-[40vh]">
            <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-4">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-400">Conversation transcript</h3>
                {detectedLanguage && detectedLanguage !== 'English' && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700 text-[10px] font-semibold text-neutral-300">
                    <svg className="w-3 h-3 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                    </svg>
                    {detectedLanguage}
                  </span>
                )}
              </div>
              <button
                onClick={handleClearHistory}
                className="cursor-pointer text-xs text-slate-400 hover:text-neutral-200"
              >
                Clear History
              </button>
            </div>
            
            <div className="flex flex-col gap-4 flex-grow">
              {messages.length === 0 && !partialTranscript && (
                <div className="flex-grow flex items-center justify-center text-slate-500 text-sm py-12">
                  No conversation logs yet. Click 'Start Conversation' and speak into your mic.
                </div>
              )}
              
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col gap-1 ${
                    msg.role === 'user'
                      ? 'self-end items-end max-w-[80%]'
                      : 'self-start items-start w-full'
                  }`}
                >
                  {/* Speaker Label */}
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    {msg.role === 'user' ? 'You' : 'AI Assistant'}
                  </span>

                  {/* Bubble content */}
                  {msg.role === 'user' ? (
                    <div className="px-4 py-2.5 rounded-2xl rounded-tr-none bg-neutral-200 text-black text-sm leading-relaxed">
                      {msg.content}
                      {msg.isInterrupted && (
                        <span className="text-xs text-rose-600 block mt-1 italic font-medium">
                          (Interrupted)
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-full px-4 py-3 rounded-2xl rounded-tl-none bg-neutral-900 border border-neutral-800">
                      <FormattedMessage content={msg.content} />
                      {msg.isInterrupted && (
                        <span className="text-xs text-rose-500 block mt-2 italic font-medium">
                          (Interrupted)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              
              {/* Real-time partial transcript bubble */}
              {partialTranscript && (
                <div className="flex flex-col gap-1 max-w-[85%] self-end items-end animate-pulse">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">You (speaking)</span>
                  <div className="p-3 rounded-2xl text-sm bg-neutral-800/40 text-neutral-300 border border-neutral-800 rounded-tr-none">
                    {partialTranscript}...
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>
          </div>
          
          {/* Manual text input option */}
          <form onSubmit={handleTextSubmit} className="flex gap-2">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder={connectionStatus === 'connected' ? "Type a question manually..." : "Start conversation to type..."}
              disabled={connectionStatus !== 'connected'}
              className="flex-grow bg-neutral-950 border border-white/5 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-neutral-400 transition-colors disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={connectionStatus !== 'connected' || !textInput.trim()}
              className="cursor-pointer bg-white text-black hover:bg-neutral-200 disabled:opacity-50 rounded-xl px-5 py-3 text-sm font-semibold transition-colors"
            >
              Send
            </button>
          </form>
          
        </section>
        
      </div>
    </main>
  );
}
