'use client';

import { useState, useRef, useCallback } from 'react';

interface RecorderState {
  isRecording: boolean;
  recorders: {
    screen?: MediaRecorder;
    mic_audio?: MediaRecorder;
  };
  websocket: WebSocket | null;
  recordingAssetId: number | null;
}

interface PendingBinary {
  partNumber: number;
  streamType: string;
  data: ArrayBuffer;
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
  const screenPartNumberRef = useRef(0);
  const micPartNumberRef = useRef(0);
  const pendingBinaryRef = useRef<PendingBinary | null>(null);
  const isRecordingRef = useRef(false);
  const chunkIntervalMs = 15000; // 15 seconds per chunk

  const processUploadQueue = useCallback(async () => {
    if (isUploading.current || uploadQueue.current.length === 0) {
      return;
    }

    isUploading.current = true;
    const { blob, streamType, partNumber } = uploadQueue.current.shift()!;

    if (!wsRef.current || !assetIdRef.current) {
      console.log('⚠️ Cannot upload chunk - missing websocket or asset ID');
      isUploading.current = false;
      return;
    }

    if (wsRef.current.readyState !== WebSocket.OPEN) {
      console.log(`⚠️ WebSocket not open, skipping ${streamType} chunk ${partNumber}`);
      isUploading.current = false;
      return;
    }

    console.log(`📦 Uploading ${streamType} chunk ${partNumber}, size: ${blob.size} bytes`);
    
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const checksum = await calculateChecksum(arrayBuffer);

      pendingBinaryRef.current = {
        partNumber,
        streamType,
        data: arrayBuffer
      };

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
      console.log(`📤 Sending metadata for ${streamType} part ${partNumber}`);
      wsRef.current.send(JSON.stringify(metadataMessage));
    } catch (error) {
      console.error(`❌ Error processing ${streamType} chunk ${partNumber}:`, error);
      pendingBinaryRef.current = null;
      isUploading.current = false;
    }
  }, [chunkIntervalMs]);

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
      // Handle binary messages differently from JSON messages
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        console.log('📥 Received binary data:', event.data);
        return; // Binary data should not reach here in our protocol
      }
      
      const message = JSON.parse(event.data);
      console.log('📥 Received message:', JSON.stringify(message, null, 2));
      
      if (message.event === 'authenticated') {
        console.log('✅ Authentication successful');
      } else if (message.event === 'session_recording_initialized') {
        const { recording_asset_id, status, last_parts_by_stream } = message.data || {};
        console.log('🎬 Recording initialized, asset ID:', recording_asset_id);
        
        assetIdRef.current = recording_asset_id;
        
        if (status === 'resuming' && last_parts_by_stream) {
          screenPartNumberRef.current = last_parts_by_stream.screen || 0;
          micPartNumberRef.current = last_parts_by_stream.mic_audio || 0;
          console.log(`📥 Resuming: screen from part ${screenPartNumberRef.current}, mic from part ${micPartNumberRef.current}`);
        }
        
        setState(prev => ({ ...prev, recordingAssetId: recording_asset_id }));
      } else if (message.event === 'session_status_response') {
        const { last_parts_by_stream, stream_parts, stream_sizes } = message.data || {};
        console.log('📊 Stream status:', {
          screenParts: stream_parts?.screen?.length || 0,
          micParts: stream_parts?.mic_audio?.length || 0,
          screenSize: stream_sizes?.screen || 0,
          micSize: stream_sizes?.mic_audio || 0
        });
      } else if (message.event === 'ready_for_binary') {
        console.log('📤 Ready for binary:', message.data);
        sendBinaryData(message.data);
      } else if (message.event === 'chunk_ack') {
        console.log(`✅ ${message.data?.stream_type} part ${message.data?.part_number} acknowledged`);
        
        // Process next item in upload queue
        isUploading.current = false;
        processUploadQueue();
      } else if (message.event === 'chunk_nack') {
        console.log(`❌ ${message.data?.stream_type} part ${message.data?.part_number} rejected:`, message.data?.error);
        
        // Clear pending binary data on error and process next in queue
        if (pendingBinaryRef.current && 
            pendingBinaryRef.current.partNumber === message.data?.part_number &&
            pendingBinaryRef.current.streamType === message.data?.stream_type) {
          console.log('🗑️ Clearing failed pending binary data');
          pendingBinaryRef.current = null;
        }
        
        // Process next item in upload queue
        isUploading.current = false;
        processUploadQueue();
      } else if (message.event === 'upload_complete') {
        console.log('🎉 Upload completed:', message.data);
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
  }, [websocketId, websocketToken, processUploadQueue]);

  const calculateChecksum = async (arrayBuffer: ArrayBuffer): Promise<string> => {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const sendBinaryData = (readyData: { part_number: number; stream_type: string } | undefined) => {
    if (!readyData) {
      console.log('⚠️ No ready data provided');
      return;
    }
    
    console.log(`🔍 Looking for pending binary: part ${readyData.part_number}, stream ${readyData.stream_type}`);
    
    if (pendingBinaryRef.current &&
        pendingBinaryRef.current.partNumber === readyData.part_number &&
        pendingBinaryRef.current.streamType === readyData.stream_type) {
      console.log(`📤 Sending binary data for ${readyData.stream_type} part ${readyData.part_number}`);
      
      // Check if WebSocket is still open before sending
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Validate that we have binary data
        if (pendingBinaryRef.current.data instanceof ArrayBuffer) {
          console.log(`📤 Sending ${pendingBinaryRef.current.data.byteLength} bytes of binary data`);
          wsRef.current.send(pendingBinaryRef.current.data);
          console.log(`✅ Binary data sent successfully`);
        } else {
          console.error('❌ Invalid binary data type:', typeof pendingBinaryRef.current.data);
        }
        pendingBinaryRef.current = null;
      } else {
        console.log('⚠️ WebSocket not ready, skipping binary data send');
        pendingBinaryRef.current = null;
      }
    } else {
      console.log(`⚠️ No matching pending binary data found. Current pending:`, 
        pendingBinaryRef.current ? 
        `part ${pendingBinaryRef.current.partNumber}, stream ${pendingBinaryRef.current.streamType}` : 
        'none');
    }
  };

  const uploadQueue = useRef<Array<{blob: Blob, streamType: string, partNumber: number}>>([]);
  const isUploading = useRef(false);

  const uploadChunk = useCallback(async (blob: Blob, streamType: string, partNumber: number) => {
    uploadQueue.current.push({ blob, streamType, partNumber });
    processUploadQueue();
  }, [processUploadQueue]);

  const uploadScreenChunk = useCallback(async (blob: Blob) => {
    screenPartNumberRef.current += 1;
    await uploadChunk(blob, 'screen', screenPartNumberRef.current);
  }, [uploadChunk]);

  const uploadMicChunk = useCallback(async (blob: Blob) => {
    micPartNumberRef.current += 1;
    await uploadChunk(blob, 'mic_audio', micPartNumberRef.current);
  }, [uploadChunk]);

  const handleScreenSharingError = (err: any) => {
    if (!err) {
      alert("An unknown error occurred while trying to share your screen. Please refresh the page and try again.");
      return;
    }

    switch (err.name) {
      case "NotAllowedError":
        alert("Screen sharing was blocked. Please allow screen sharing permission in your browser and try again.");
        break;
      case "NotFoundError":
        alert("No screen or window was selected. Please choose a screen or application window to share.");
        break;
      case "AbortError":
        alert("Screen sharing was cancelled. Please click on a screen or window and confirm to proceed.");
        break;
      case "OverconstrainedError":
      case "TypeError":
        alert("Screen sharing failed due to unsupported constraints. Try restarting your browser or selecting a different screen.");
        break;
      default:
        if (err.message?.includes("HTTPS")) {
          alert("Screen sharing only works on secure (HTTPS) connections. Please switch to a secure site.");
        } else if (err.message?.includes("getDisplayMedia")) {
          alert("Your browser may not support screen sharing. Please update your browser or try a different one (like Chrome or Firefox).");
        } else {
          alert("An unexpected error occurred: " + err.message);
        }
        break;
    }
    console.error("Screen sharing error:", err);
  };

  const setupRecorder = useCallback((streamType: string, stream: MediaStream, mimeType: string) => {
    // Ensure proper WebM support
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn(`${mimeType} not supported, falling back to default`);
      mimeType = streamType === 'screen' ? 'video/webm' : 'audio/webm';
    }
    
    let currentRecorder: MediaRecorder | null = null;
    let isRecording = true;
    
    const createNewRecorder = () => {
      if (!isRecording) return;
      
      const recorder = new MediaRecorder(stream, { 
        mimeType,
        videoBitsPerSecond: streamType === 'screen' ? 2500000 : undefined,
        audioBitsPerSecond: 128000
      });
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && isRecording) {
          console.log(`📹 ${streamType} chunk received: ${event.data.size} bytes`);
          
          if (streamType === 'screen') {
            uploadScreenChunk(event.data);
          } else if (streamType === 'mic_audio') {
            uploadMicChunk(event.data);
          }
        }
      };
      
      recorder.onstop = () => {
        if (isRecording) {
          // Start new recorder for next chunk to ensure proper EBML headers
          setTimeout(createNewRecorder, 100);
        }
      };
      
      recorder.start();
      currentRecorder = recorder;
      
      // Stop after interval to create complete WebM chunk
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, chunkIntervalMs);
    };
    
    // Start first recorder
    createNewRecorder();
    
    // Return a mock recorder with stop method
    const mockRecorder = {
      state: 'recording',
      stream,
      stop: () => {
        isRecording = false;
        if (currentRecorder && currentRecorder.state === 'recording') {
          currentRecorder.stop();
        }
      }
    } as MediaRecorder;
    
    console.log(`✅ ${streamType} recorder started with ${mimeType}`);
    return mockRecorder;
  }, [uploadScreenChunk, uploadMicChunk, chunkIntervalMs]);

  const startMultiStreamRecording = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Your browser may not support screen sharing. Please update your browser or try a different one (like Chrome or Firefox).");
        return;
      }

      // Get screen with both video and audio
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        // @ts-ignore
        video: { mediaSource: "screen" },
        audio: true
      });

      let displaySurface = screenStream.getVideoTracks()[0].getSettings().displaySurface;
      if (displaySurface !== "monitor") {
        alert("Selection of entire screen mandatory!");
        screenStream.getTracks().forEach(track => track.stop());
        return;
      }

      // Get microphone audio
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      const recorders = {
        screen: setupRecorder('screen', screenStream, 'video/webm;codecs=vp9,opus'),
        mic_audio: setupRecorder('mic_audio', micStream, 'audio/webm;codecs=opus')
      };

      screenStream.getVideoTracks()[0].onended = () => {
        console.log('Screen sharing ended');
        setState(prev => ({ ...prev, isRecording: false }));
      };

      setState(prev => ({ ...prev, recorders }));
      console.log('✅ Multi-stream recording started (2 streams: screen+audio, mic)');
    } catch (err: any) {
      console.error("Multi-stream recording error:", err);
      handleScreenSharingError(err);
    }
  };

  const startRecording = async () => {
    try {
      console.log('🎬 Starting combined recording process...');
      const ws = connectWebSocket();
      
      // Initialize session recording
      setTimeout(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const initMessage = {
            event: 'initialize_session_recording',
            data: {
              interview_session_id: parseInt(interviewSessionId),
              file_extension: format,
              file_type: `video/${format}`
            }
          };
          console.log('📤 Initializing session:', initMessage);
          wsRef.current.send(JSON.stringify(initMessage));
          
          // Start recording after initialization
          setTimeout(async () => {
            alert('Please ensure screen sharing is active for smooth communication. Remember to share your entire screen!');
            isRecordingRef.current = true;
            await startMultiStreamRecording();
            setState(prev => ({ ...prev, isRecording: true }));
            console.log('✅ Multi-stream recording started successfully');
          }, 1000);
        }
      }, 1000);
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

  const stopRecording = async () => {
    const userConfirmed = confirm("Do you want to end the recording?");
    if (!userConfirmed) return;

    console.log('⏹️ Stopping multi-stream recording...');
    
    // Stop recorders first to prevent new chunks
    Object.values(state.recorders).forEach(recorder => {
      if (recorder && recorder.state !== 'inactive') {
        // Clear interval if it exists
        if ((recorder as any).intervalId) {
          clearInterval((recorder as any).intervalId);
        }
        recorder.stop();
        recorder.stream.getTracks().forEach(track => track.stop());
      }
    });

    // Update UI state immediately
    setState(prev => ({ ...prev, isRecording: false, recorders: {} }));
    
    // Wait longer for final chunks to be processed before completing upload
    console.log('⏳ Waiting 5s for final chunks to process...');
    setTimeout(() => {
      isRecordingRef.current = false; // Set this after final chunks are processed
      
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        completeUpload();
      } else {
        console.log('❌ Cannot complete upload - WebSocket closed');
      }
    }, 5000);

    console.log('✅ Recording stopped successfully');
  };

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
            <div>Screen (Video+Audio): {state.recorders.screen ? '🔴 Active' : '⚫ Inactive'}</div>
            <div>Mic Audio: {state.recorders.mic_audio ? '🔴 Active' : '⚫ Inactive'}</div>
            <div>Screen Parts: {screenPartNumberRef.current}</div>
            <div>Mic Parts: {micPartNumberRef.current}</div>
            <div>Chunk Interval: {chunkIntervalMs / 1000}s</div>
          </div>
        </div>

        <div className="bg-blue-50 p-4 rounded-md">
          <h3 className="font-medium mb-2">Features</h3>
          <ul className="text-sm space-y-1">
            <li>✅ 2 streams (screen+audio, mic)</li>
            <li>✅ Binary data transfer (no base64)</li>
            <li>✅ SHA-256 checksums</li>
            <li>✅ 15-second chunks</li>
            <li>✅ Backend audio mixing</li>
            <li>✅ Reduced memory usage</li>
            <li>✅ Full screen enforcement</li>
          </ul>
        </div>

        <div className="flex gap-2">
          <button
            onClick={startRecording}
            disabled={state.isRecording || !websocketId || !websocketToken || !interviewSessionId}
            className="flex-1 bg-red-500 text-white p-2 rounded-md disabled:bg-gray-300 font-medium"
          >
            {state.isRecording ? '🔴 Recording...' : '▶️ Start Multi-Stream Recording'}
          </button>
          
          <button
            onClick={stopRecording}
            disabled={!state.isRecording}
            className="flex-1 bg-gray-500 text-white p-2 rounded-md disabled:bg-gray-300 font-medium"
          >
            ⏹️ Stop Recording
          </button>
        </div>

        {state.isRecording && (
          <div className="bg-yellow-50 border border-yellow-200 p-3 rounded-md">
            <p className="text-sm text-yellow-800">
              <strong>Recording in progress...</strong><br/>
              2 streams (screen+audio, mic) are being recorded in 15-second binary chunks.
              Do not close this tab or stop screen sharing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}