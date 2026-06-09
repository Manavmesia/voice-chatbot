import { useRef, useCallback, useState } from 'react';

/**
 * Manages gapless, sequential MP3 playback via the Web Audio API.
 * AudioContext is created without a fixed sampleRate so the browser resamples
 * Edge TTS output (24 kHz) to its native rate automatically.
 */
export function useAudioPlayer() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextStartTimeRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const initContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass();
      audioContextRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      console.log(`[AudioPlayer] Context created. Sample rate: ${ctx.sampleRate} Hz`);
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().then(() => console.log('[AudioPlayer] Context resumed.'));
    }
  }, []);

  const playChunk = useCallback(async (base64Data: string) => {
    initContext();
    const ctx = audioContextRef.current!;
    const analyser = analyserRef.current!;

    try {
      const binary = window.atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      } catch (err) {
        console.error(`[AudioPlayer] decodeAudioData failed (${bytes.length} bytes):`, err);
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);

      const now = ctx.currentTime;
      const startTime = Math.max(now, nextStartTimeRef.current);
      source.start(startTime);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      activeSourcesRef.current.push(source);
      setIsPlaying(true);
      console.log(`[AudioPlayer] Chunk scheduled: start=${startTime.toFixed(3)}s dur=${audioBuffer.duration.toFixed(3)}s`);

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
        if (activeSourcesRef.current.length === 0) {
          setIsPlaying(false);
          console.log('[AudioPlayer] Playback complete.');
        }
      };
    } catch (err) {
      console.error('[AudioPlayer] Unexpected error in playChunk:', err);
    }
  }, [initContext]);

  const stopPlayback = useCallback(() => {
    const count = activeSourcesRef.current.length;
    activeSourcesRef.current.forEach(source => {
      try { source.onended = null; source.stop(); } catch { /* already stopped */ }
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    setIsPlaying(false);
    if (count > 0) console.log(`[AudioPlayer] Stopped ${count} source(s).`);
  }, []);

  const getAnalyserData = useCallback((): Uint8Array | null => {
    if (!analyserRef.current) return null;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    return data;
  }, []);

  return { isPlaying, playChunk, stopPlayback, getAnalyserData };
}
