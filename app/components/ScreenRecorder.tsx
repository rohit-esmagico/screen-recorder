'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface RecorderController {
  state: string;
  stream: MediaStream;
  stop: () => void;
}

interface RecorderState {
  isRecording: boolean;
  recorders: {
    screen?: RecorderController;
    mic_audio?: RecorderController;
  };
  websocket: WebSocket | null;
  recordingAssetId: number | null;
}

interface PendingBinary {
  partNumber: number;
  streamType: string;
  data: ArrayBuffer;
}

// Helper to manage queue items
interface QueueItem {
  blob: Blob;
  streamType: string;
  partNumber: number;
}

export default function ScreenRecorder() {
  const [websocketId, setWebsocketId] = useState('');
  const [websocketToken, setWebsocketToken] = useState('');
  const [interviewSessionId, setInterviewSessionId] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [format, setFormat] = useState<'mp4' | 'webm'>('webm');
  
  const [state, setState] = useState<RecorderState>({
    isRecording: false,
    recorders: {},
    websocket: null,
    recordingAssetId: null
  });

  const wsRef = useRef<WebSocket | null>(null);
  const assetIdRef = useRef<number | null>(null);
  const partNumberRef = useRef(0);
  
  // Queue System Refs
  const uploadQueue = useRef<QueueItem[]>([]);
  const isUploading = useRef(false);
  const pendingBinaryRef = useRef<PendingBinary | null>(null);
  
  const isRecordingRef = useRef(false);
  const chunkIntervalMs = 15000; 

  const calculateChecksum = async (arrayBuffer: ArrayBuffer): Promise<string> => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // 3. Send binary data when backend requests it
  const sendBinaryData = useCallback((readyData: { part_number: number; stream_type: string } | undefined) => {
    if (!readyData) return;
    
    if (pendingBinaryRef.current &&
        pendingBinaryRef.current.partNumber === readyData.part_number &&
        pendingBinaryRef.current.streamType === readyData.stream_type) {
      
      console.log(`📤 Sending binary for ${readyData.stream_type} #${readyData.part_number}`);
      wsRef.current?.send(pendingBinaryRef.current.data);
      
      // Clear binary data from memory immediately after sending
      pendingBinaryRef.current = null;
    }
  }, []);

  // 2. Process Queue: Sequential execution
  const processUploadQueue = useCallback(async () => {
    // If already uploading or queue empty, stop.
    if (isUploading.current || uploadQueue.current.length === 0) {
      return;
    }

    // Lock the process
    isUploading.current = true;
    const item = uploadQueue.current.shift()!;
    const { blob, streamType, partNumber } = item;

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !assetIdRef.current) {
      console.log(`⚠️ Cannot upload ${streamType} #${partNumber} - connection issues`);
      // If connection fails, unlock to allow potential retries or stop
      isUploading.current = false;
      return;
    }

    console.log(`📦 Processing ${streamType} #${partNumber} (${blob.size} bytes)`);

    try {
      // Prepare Data (Heavy lifting)
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const checksum = await calculateChecksum(arrayBuffer);

      // Store binary for step 3
      pendingBinaryRef.current = {
        partNumber,
        streamType,
        data: arrayBuffer
      };

      // Send Metadata (Step 1 of Protocol)
      const metadataMessage = {
        event: 'upload_chunk_metadata',
        data: {
          asset_id: assetIdRef.current,
          part_number: partNumber,
          stream_type: streamType,
          checksum,
          start_timestamp: Date.now() / 1000,
          duration_seconds: chunkIntervalMs / 1000,
          data_size: uint8Array.byteLength
        }
      };
      
      wsRef.current.send(JSON.stringify(metadataMessage));
      // NOTE: isUploading remains TRUE here. 
      // It is only set to FALSE when we receive 'chunk_ack' or 'chunk_nack' from backend.

    } catch (error) {
      console.error(`❌ Error processing ${streamType} #${partNumber}:`, error);
      pendingBinaryRef.current = null;
      isUploading.current = false;
      processUploadQueue(); // Try next item
    }
  }, [chunkIntervalMs]);

  // 1. Enqueue chunks coming from recorders
  const uploadChunk = useCallback((blob: Blob, streamType: string) => {
    if (!assetIdRef.current) return;

    // Increment global part number on video chunks only to keep sync
    if (streamType === 'screen') {
      partNumberRef.current += 1;
    }
    
    // Just push to queue and trigger processor
    uploadQueue.current.push({ 
      blob, 
      streamType, 
      partNumber: partNumberRef.current 
    });
    
    processUploadQueue();
  }, [processUploadQueue]);

  const connectWebSocket = useCallback(() => {
    const wsUrl = `${process.env.NEXT_PUBLIC_WEBSOCKET_DOMAIN}/ws/recording/${websocketId}`;
    console.log('🔌 Connecting to WebSocket:', wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✅ WebSocket connected');
      const authMessage = {
        event: 'authenticate',
        data: { token: websocketToken }
      };
      ws.send(JSON.stringify(authMessage));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) return;

      try {
        const message = JSON.parse(event.data);
        
        if (message.event === 'authenticated') {
          console.log('✅ Authentication successful');
        } 
        else if (message.event === 'session_recording_initialized') {
          const data = message.data || {};
          console.log('🎬 Recording initialized, Asset:', data.recording_asset_id);
          assetIdRef.current = data.recording_asset_id;
          partNumberRef.current = data.last_part_number || 0;
          setState(prev => ({ ...prev, recordingAssetId: data.recording_asset_id }));
        } 
        else if (message.event === 'ready_for_binary') {
          // Backend is ready for binary of the CURRENT uploading chunk
          sendBinaryData(message.data);
        } 
        else if (message.event === 'chunk_ack') {
          console.log(`✅ ACK: ${message.data?.stream_type} #${message.data?.part_number}`);
          // Unlock queue and process next
          isUploading.current = false;
          processUploadQueue();
        } 
        else if (message.event === 'chunk_nack') {
          console.error(`❌ NACK: ${message.data?.stream_type} #${message.data?.part_number}`, message.data?.error);
          // Clear pending data if matched
          if (pendingBinaryRef.current && 
              pendingBinaryRef.current.partNumber === message.data?.part_number &&
              pendingBinaryRef.current.streamType === message.data?.stream_type) {
            pendingBinaryRef.current = null;
          }
          // Unlock queue and process next
          isUploading.current = false;
          processUploadQueue();
        } 
        else if (message.event === 'upload_complete') {
          console.log('🎉 Upload completed:', message.data);
        }
      } catch (e) {
        console.error("Error handling WS message:", e);
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      isUploading.current = false; // Reset lock on error
    };

    ws.onclose = (event) => {
      console.log('🔌 WebSocket closed:', event.code);
      isUploading.current = false; // Reset lock on close
    };

    wsRef.current = ws;
    setState(prev => ({ ...prev, websocket: ws }));
    return ws;
  }, [websocketId, websocketToken, processUploadQueue, sendBinaryData]);

  const setupRecorder = useCallback((streamType: string, stream: MediaStream, mimeType: string): RecorderController => {
    if (!MediaRecorder.isTypeSupported(mimeType)) {
        console.warn(`${mimeType} not supported, falling back`);
        mimeType = streamType === 'screen' ? 'video/webm' : 'audio/webm';
    }

    let currentRecorder: MediaRecorder | null = null;
    let isActive = true; 
    let intervalId: NodeJS.Timeout | null = null;

    const createNewRecorder = () => {
        if (!isRecordingRef.current || !isActive) return;

        try {
            const recorder = new MediaRecorder(stream, { mimeType });
            
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    uploadChunk(event.data, streamType);
                }
            };

            recorder.onstop = () => {
                if (isRecordingRef.current && isActive) {
                    createNewRecorder();
                }
            };

            recorder.start();
            currentRecorder = recorder;

            intervalId = setTimeout(() => {
                if (recorder.state === 'recording') {
                    recorder.stop();
                }
            }, chunkIntervalMs);

        } catch (e) {
            console.error(`Error creating ${streamType} recorder:`, e);
            isActive = false;
        }
    };

    createNewRecorder();

    return {
        state: 'recording',
        stream,
        stop: () => {
            isActive = false; 
            if (intervalId) clearTimeout(intervalId);
            if (currentRecorder && currentRecorder.state === 'recording') {
                currentRecorder.stop();
            }
        }
    };
  }, [uploadChunk, chunkIntervalMs]);

  const handleScreenSharingError = (err: any) => {
    console.error("Screen sharing error:", err);
    alert("Screen sharing error: " + (err.message || err.name));
  };

  const startMultiStreamRecording = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Browser not supported.");
        return;
      }

      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        // @ts-ignore
        video: { mediaSource: "screen" },
        audio: true
      });

      // @ts-ignore
      const displaySurface = screenStream.getVideoTracks()[0].getSettings().displaySurface;
      if (displaySurface && displaySurface !== "monitor") {
        alert("Selection of entire screen mandatory for audio capture!");
        screenStream.getTracks().forEach(t => t.stop());
        return;
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      screenStream.getVideoTracks()[0].onended = () => {
        console.log('Screen sharing ended by user');
        stopRecording();
      };

      const recorders: any = {
        screen: setupRecorder('screen', screenStream, 'video/webm;codecs=vp9,opus'),
        mic_audio: setupRecorder('mic_audio', micStream, 'audio/webm;codecs=opus')
      };

      setState(prev => ({ ...prev, recorders }));
      console.log('✅ Multi-stream recording started');
    } catch (err: any) {
      handleScreenSharingError(err);
    }
  };

  const startRecording = async () => {
    try {
      console.log('🎬 Starting recording...');
      const ws = connectWebSocket();
      
      setTimeout(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            event: 'initialize_session_recording',
            data: {
              interview_session_id: parseInt(interviewSessionId),
              file_extension: format,
              file_type: `video/${format}`
            }
          }));
          
          setTimeout(async () => {
            alert('Please ensure screen sharing is active! Share entire screen.');
            isRecordingRef.current = true;
            await startMultiStreamRecording();
            setState(prev => ({ ...prev, isRecording: true }));
          }, 1000);
        }
      }, 1000);
    } catch (error) {
      console.error('❌ Error starting:', error);
    }
  };

  const generateSession = async () => {
    setIsGenerating(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_DOMAIN}/api/stream/websocket/generate`, {
        method: 'POST'
      });
      const result = await response.json();
      if (result.status_code === 200) {
        const { session_id, websocket_details } = result.data;
        setInterviewSessionId(session_id.toString());
        setWebsocketId(websocket_details.websocket_id);
        setWebsocketToken(websocket_details.websocket_token);
      }
    } catch (error) {
      console.error('❌ Failed to generate:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const completeUpload = useCallback(() => {
    if (!wsRef.current || !assetIdRef.current) return;
    
    console.log('🏁 Completing upload...');
    wsRef.current.send(JSON.stringify({
      event: 'upload_completed',
      data: { asset_id: assetIdRef.current }
    }));
  }, []);

  const stopRecording = async () => {
    if (!isRecordingRef.current) return;

    const userConfirmed = confirm("End recording?");
    if (!userConfirmed) return;

    console.log('⏹️ Stopping...');
    isRecordingRef.current = false;

    Object.values(state.recorders).forEach((recorder) => {
      if (recorder) {
        recorder.stop();
        recorder.stream.getTracks().forEach(track => track.stop());
      }
    });

    setState(prev => ({ ...prev, isRecording: false, recorders: {} }));
    
    console.log('⏳ Waiting 5s for final chunks...');
    setTimeout(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        completeUpload();
      }
    }, 5000);
  };

  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h1 className="text-2xl font-bold mb-6 text-center">Multi-Stream Screen Recorder</h1>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">WebSocket ID</label>
          <input
            type="text"
            value={websocketId}
            onChange={(e) => setWebsocketId(e.target.value)}
            className="w-full p-2 border rounded-md"
            placeholder="Enter WebSocket ID"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">WebSocket Token</label>
          <input
            type="text"
            value={websocketToken}
            onChange={(e) => setWebsocketToken(e.target.value)}
            className="w-full p-2 border rounded-md"
            placeholder="Enter WebSocket Token"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Interview Session ID</label>
          <input
            type="number"
            value={interviewSessionId}
            onChange={(e) => setInterviewSessionId(e.target.value)}
            className="w-full p-2 border rounded-md"
            placeholder="Enter Interview Session ID"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Format</label>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as 'mp4' | 'webm')}
            className="w-full p-2 border rounded-md"
          >
            <option value="webm">WebM</option>
            <option value="mp4">MP4</option>
          </select>
        </div>

        <button
          onClick={generateSession}
          disabled={isGenerating || state.isRecording}
          className="w-full bg-blue-500 text-white p-2 rounded-md disabled:bg-gray-300"
        >
          {isGenerating ? 'Generating...' : 'Generate New Session'}
        </button>

        <div className="bg-gray-50 p-4 rounded-md">
          <h3 className="font-medium mb-2">Recording Status</h3>
          <div className="space-y-1 text-sm">
            <div>WebSocket: {state.websocket ? '🟢 Connected' : '🔴 Disconnected'}</div>
            <div>Screen: {state.recorders.screen ? '🔴 Active' : '⚫ Inactive'}</div>
            <div>Mic: {state.recorders.mic_audio ? '🔴 Active' : '⚫ Inactive'}</div>
            <div>Chunk Interval: {chunkIntervalMs / 1000}s</div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={startRecording}
            disabled={state.isRecording || !websocketId || !websocketToken || !interviewSessionId}
            className="flex-1 bg-red-500 text-white p-2 rounded-md disabled:bg-gray-300 font-medium"
          >
            {state.isRecording ? '🔴 Recording...' : '▶️ Start'}
          </button>
          
          <button
            onClick={stopRecording}
            disabled={!state.isRecording}
            className="flex-1 bg-gray-500 text-white p-2 rounded-md disabled:bg-gray-300 font-medium"
          >
            ⏹️ Stop
          </button>
        </div>
      </div>
    </div>
  );
}