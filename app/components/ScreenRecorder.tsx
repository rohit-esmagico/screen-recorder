'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface RecorderState {
  isRecording: boolean;
  mediaRecorder: MediaRecorder | null;
  websocket: WebSocket | null;
  recordingAssetId: number | null;
  partNumber: number;
}

export default function ScreenRecorder() {
  const [websocketId, setWebsocketId] = useState('');
  const [websocketToken, setWebsocketToken] = useState('');
  const [interviewSessionId, setInterviewSessionId] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [format, setFormat] = useState<'mp4' | 'webm'>('webm');
  const [quality, setQuality] = useState<'1080p' | '720p' | '480p' | 'auto'>('auto');
  const [state, setState] = useState<RecorderState>({
    isRecording: false,
    mediaRecorder: null,
    websocket: null,
    recordingAssetId: null,
    partNumber: 0
  });

  const chunkBuffer = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const assetIdRef = useRef<number | null>(null);
  const partNumberRef = useRef(0);
  const recordingStartTime = useRef<number>(0);
  const chunkStartTime = useRef<number>(0);
  const uploadIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const uploadCompleteReceived = useRef(false);
  const chunkSize = 5 * 1024 * 1024; // 5MB for MinIO multipart uploads

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
      console.log('📤 Sending authenticate:', authMessage);
      ws.send(JSON.stringify(authMessage));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      console.log('📥 Received message:', JSON.stringify(message, null, 2));
      
      // Handle different message types
      if (message.event === 'authenticated') {
        console.log('✅ Authentication successful - initializing session');
        // Initialize session immediately after authentication
        const initMessage = {
          event: 'initialize_session_recording',
          data: {
            interview_session_id: parseInt(interviewSessionId),
            file_extension: format,
            file_type: `video/${format}`
          }
        };
        console.log('📤 Initializing session:', initMessage);
        ws.send(JSON.stringify(initMessage));
      } else if (message.event === 'session_recording_initialized') {
        console.log('🎬 Recording initialized, asset ID:', message.data.recording_asset_id);
        assetIdRef.current = message.data.recording_asset_id;
        setState(prev => ({
          ...prev,
          recordingAssetId: message.data.recording_asset_id
        }));
      } else if (message.event === 'chunk_queued') {
        console.log('📋 Chunk queued:', message.data.part_number, 'Task ID:', message.data.task_id);
      } else if (message.type === 'chunk_ack') {
        console.log('✅ Chunk acknowledged:', message.part_number, 'ETag:', message.etag);
      } else if (message.type === 'chunk_nack' || message.event === 'chunk_nack') {
        console.log('❌ Chunk rejected:', message.part_number || message.data?.part_number, 'Error:', message.error || message.data?.error);
      } else if (message.event === 'upload_complete') {
        console.log('🎉 Upload completed:', message.data);
        uploadCompleteReceived.current = true;
        // Close WebSocket after receiving completion
        setTimeout(() => {
          console.log('🔌 Closing WebSocket after upload completion...');
          wsRef.current?.close();
          setState(prev => ({ ...prev, websocket: null }));
        }, 2000);
      } else if (message.event === 'session_status_response') {
        console.log('📊 Session status:', message.data);
      } else {
        console.log('❓ Unknown message type:', message);
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
    };

    ws.onclose = (event) => {
      console.log('🔌 WebSocket closed:', event.code, event.reason);
    };

    wsRef.current = ws;
    setState(prev => ({ ...prev, websocket: ws }));
    return ws;
  }, [websocketId, websocketToken, interviewSessionId, format]);

  const getSessionStatus = useCallback(() => {
    if (!wsRef.current) {
      console.log('⚠️ No websocket connection for status check');
      return;
    }
    const statusMessage = {
      event: 'get_session_status',
      data: {
        interview_session_id: parseInt(interviewSessionId)
      }
    };
    console.log('📤 Getting session status:', statusMessage);
    wsRef.current.send(JSON.stringify(statusMessage));
  }, [interviewSessionId]);

  const uploadChunk = useCallback(async (chunk: Blob, partNum: number, startTime: number, duration: number) => {
    if (!wsRef.current || !assetIdRef.current) {
      console.log('⚠️ Cannot upload chunk - missing websocket or asset ID');
      return;
    }

    console.log(`📦 Uploading chunk ${partNum}, size: ${chunk.size} bytes, duration: ${duration}s`);
    
    // Use FileReader for efficient base64 encoding
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Remove data URL prefix (e.g., "data:video/webm;base64,")
      const base64 = dataUrl.split(',')[1];

      const chunkMessage = {
        event: 'upload_chunk',
        data: {
          asset_id: assetIdRef.current,
          part_number: partNum,
          chunk_data: base64,
          checksum: 'no-validation',
          start_timestamp: Math.floor(startTime / 1000),
          duration_seconds: Math.round(duration)
        }
      };
      console.log(`📤 Sending chunk ${partNum}:`, { ...chunkMessage.data, chunk_data: `[${base64.length} chars]` });
      wsRef.current?.send(JSON.stringify(chunkMessage));
    };
    reader.readAsDataURL(chunk);
  }, []);

  const completeUpload = useCallback(() => {
    if (!wsRef.current || !assetIdRef.current) {
      console.log('⚠️ Cannot complete upload - missing websocket or asset ID');
      return;
    }
    const completeMessage = {
      event: 'upload_completed',
      data: {
        asset_id: assetIdRef.current
      }
    };
    console.log('🏁 Completing upload:', completeMessage);
    wsRef.current.send(JSON.stringify(completeMessage));
  }, []);

  const processChunks = useCallback(() => {
    const totalSize = chunkBuffer.current.reduce((size, chunk) => size + chunk.size, 0);
    console.log(`📊 Buffer status: ${chunkBuffer.current.length} chunks, ${totalSize} bytes total`);
    
    if (totalSize >= chunkSize && assetIdRef.current) {
      console.log('🚀 Processing chunks - threshold reached');
      const combinedChunk = new Blob(chunkBuffer.current, { type: `video/${format}` });
      partNumberRef.current += 1;
      const partNum = partNumberRef.current;
      
      const now = Date.now();
      const duration = (now - chunkStartTime.current) / 1000; // Duration in seconds
      
      console.log(`📤 Creating upload part ${partNum} with ${chunkBuffer.current.length} chunks`);
      uploadChunk(combinedChunk, partNum, chunkStartTime.current, duration);
      
      chunkBuffer.current = [];
      chunkStartTime.current = now; // Reset for next chunk
      setState(prev => ({ ...prev, partNumber: partNum }));
    } else if (totalSize >= chunkSize && !assetIdRef.current) {
      console.log('⚠️ Chunks ready but no asset ID yet - waiting for session initialization');
    }
  }, [chunkSize, format, uploadChunk]);

  const startRecording = async () => {
    try {
      console.log('🎬 Starting recording process...');
      const ws = connectWebSocket();
      
      console.log('🖥️ Requesting display media...');
      
      // Get quality constraints based on screen dimensions
      const getVideoConstraints = () => {
        const screenWidth = window.screen.width;
        const screenHeight = window.screen.height;
        
        switch (quality) {
          case '1080p':
            return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
          case '720p':
            return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
          case '480p':
            return { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
          default:
            // Auto - use screen's native resolution but cap at reasonable limits
            return { 
              width: { ideal: Math.min(screenWidth, 1920) }, 
              height: { ideal: Math.min(screenHeight, 1080) }, 
              frameRate: { ideal: 30 } 
            };
        }
      };
      
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: getVideoConstraints(),
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        }
      });
      console.log('✅ Display media obtained');

      const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
      console.log('🎥 Creating MediaRecorder with type:', mimeType);
      // Highest quality bitrates
      const getBitrate = () => {
        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        const actualWidth = settings.width || 1920;
        const actualHeight = settings.height || 1080;
        const pixels = actualWidth * actualHeight;
        
        switch (quality) {
          case '1080p': return 20000000; // 20 Mbps
          case '720p': return 12000000;  // 12 Mbps
          case '480p': return 8000000;   // 8 Mbps
          default: 
            // Auto - highest quality based on resolution
            if (pixels > 1920 * 1080) return 25000000; // 25 Mbps for higher res
            if (pixels > 1280 * 720) return 20000000;  // 20 Mbps for 1080p
            if (pixels > 854 * 480) return 12000000;   // 12 Mbps for 720p
            return 8000000; // 8 Mbps for lower res
        }
      };
      
      const options = {
        mimeType,
        videoBitsPerSecond: getBitrate(),
        audioBitsPerSecond: 128000
      };
      const recorder = new MediaRecorder(stream, options);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          console.log(`📹 Data available: ${event.data.size} bytes`);
          chunkBuffer.current.push(event.data);
          
          const totalSize = chunkBuffer.current.reduce((sum, chunk) => sum + chunk.size, 0);
          console.log(`📊 Buffer total: ${totalSize} bytes`);
          
          if (totalSize >= chunkSize && assetIdRef.current) {
            const blob = new Blob(chunkBuffer.current, { type: `video/${format}` });
            partNumberRef.current += 1;
            const partNum = partNumberRef.current;
            const now = Date.now();
            const duration = (now - chunkStartTime.current) / 1000;
            console.log(`📤 Uploading chunk ${partNum}, total size: ${blob.size} bytes`);
            uploadChunk(blob, partNum, chunkStartTime.current, duration);
            chunkStartTime.current = now;
            chunkBuffer.current = [];
          }
        }
      };

      recorder.onstop = () => {
        console.log('⏹️ Recording stopped');
        if (uploadIntervalRef.current) {
          clearInterval(uploadIntervalRef.current);
          uploadIntervalRef.current = null;
        }
        stream.getTracks().forEach(track => track.stop());
        if (chunkBuffer.current.length > 0 && assetIdRef.current) {
          const finalChunk = new Blob(chunkBuffer.current, { type: `video/${format}` });
          if (finalChunk.size >= chunkSize) {
            console.log('📦 Uploading final chunk');
            partNumberRef.current += 1;
            const finalPartNumber = partNumberRef.current;
            const now = Date.now();
            const duration = (now - chunkStartTime.current) / 1000;
            uploadChunk(finalChunk, finalPartNumber, chunkStartTime.current, duration);
            setState(prev => ({ ...prev, partNumber: finalPartNumber }));
          } else {
            console.log(`🗑️ Discarding final chunk (${finalChunk.size} bytes < 5MB minimum)`);
          }
          chunkBuffer.current = [];
        } else if (chunkBuffer.current.length > 0) {
          console.log('⚠️ Final chunks available but no asset ID');
        }
      };

      console.log('▶️ Starting recorder...');
      recordingStartTime.current = Date.now();
      chunkStartTime.current = Date.now();
      recorder.start();
      
      // Request data every 3 seconds for faster uploads with high bitrate
      uploadIntervalRef.current = setInterval(() => {
        if (recorder.state === 'recording') {
          recorder.requestData();
        }
      }, 3000);
      setState(prev => ({
        ...prev,
        isRecording: true,
        mediaRecorder: recorder,
        partNumber: 0
      }));
      console.log('✅ Recording started successfully');
    } catch (error) {
      console.error('❌ Error starting recording:', error);
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
        console.log('✅ New session generated:', result.data);
      }
    } catch (error) {
      console.error('❌ Failed to generate session:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const stopRecording = () => {
    console.log('⏹️ Stopping recording...');
    if (state.mediaRecorder) {
      state.mediaRecorder.stop();
      setState(prev => ({
        ...prev,
        isRecording: false,
        mediaRecorder: null
      }));
      
      uploadCompleteReceived.current = false;
      console.log('⏳ Waiting 5s before completing upload...');
      setTimeout(() => {
        if (state.recordingAssetId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          completeUpload();
          // WebSocket will be closed automatically when upload_complete is received
        } else {
          console.log('❌ Cannot complete upload - WebSocket closed or no asset ID');
        }
      }, 5000);
    }
  };

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h1 className="text-2xl font-bold mb-6 text-center">Screen Recorder</h1>
      
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

        <div>
          <label className="block text-sm font-medium mb-2">Quality</label>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as '1080p' | '720p' | '480p' | 'auto')}
            className="w-full p-2 border rounded-md"
          >
            <option value="auto">Auto (Native Resolution)</option>
            <option value="1080p">1080p (1920x1080)</option>
            <option value="720p">720p (1280x720)</option>
            <option value="480p">480p (854x480)</option>
          </select>
        </div>

        <button
          onClick={generateSession}
          disabled={isGenerating || state.isRecording}
          className="w-full bg-blue-500 text-white p-2 rounded-md disabled:bg-gray-300"
        >
          {isGenerating ? 'Generating...' : 'Generate New Session'}
        </button>

        <div className="flex gap-2">
          <button
            onClick={startRecording}
            disabled={state.isRecording || !websocketId || !websocketToken || !interviewSessionId}
            className="flex-1 bg-red-500 text-white p-2 rounded-md disabled:bg-gray-300"
          >
            {state.isRecording ? 'Recording...' : 'Start Recording'}
          </button>
          
          <button
            onClick={stopRecording}
            disabled={!state.isRecording}
            className="flex-1 bg-gray-500 text-white p-2 rounded-md disabled:bg-gray-300"
          >
            Stop Recording
          </button>
        </div>
      </div>
    </div>
  );
}