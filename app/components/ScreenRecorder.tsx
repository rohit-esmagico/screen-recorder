'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface RecorderState {
  isRecording: boolean;
  mediaRecorder: MediaRecorder | null;
  combinedStream: MediaStream | null;
  websocket: WebSocket | null;
  recordingAssetId: number | null;
}

export default function ScreenRecorder() {
  const [websocketId, setWebsocketId] = useState('');
  const [websocketToken, setWebsocketToken] = useState('');
  const [interviewSessionId, setInterviewSessionId] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [format, setFormat] = useState<'mp4' | 'webm'>('webm');
  const [state, setState] = useState<RecorderState>({
    isRecording: false,
    mediaRecorder: null,
    combinedStream: null,
    websocket: null,
    recordingAssetId: null
  });

  const wsRef = useRef<WebSocket | null>(null);
  const assetIdRef = useRef<number | null>(null);
  const partNumberRef = useRef(0);
  const uploadCompleteReceived = useRef(false);
  const isRecordingRef = useRef(false);
  const chunkIntervalMs = 5000; // 5 seconds per chunk

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
      
      if (message.event === 'authenticated') {
        console.log('✅ Authentication successful');
      } else if (message.event === 'session_recording_initialized') {
        console.log('🎬 Recording initialized, asset ID:', message.data.recording_asset_id);
        assetIdRef.current = message.data.recording_asset_id;
        partNumberRef.current = message.data.last_part_number || 0;
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
      } else if (message.event === 'session_status_response') {
        console.log('📊 Session status:', message.data);
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
  }, [websocketId, websocketToken]);

  const uploadChunk = useCallback((chunk: Blob, partNum: number) => {
    if (!wsRef.current || !assetIdRef.current) {
      console.log('⚠️ Cannot upload chunk - missing websocket or asset ID');
      return;
    }

    console.log(`📦 Uploading chunk ${partNum}, size: ${chunk.size} bytes`);
    
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      const chunkMessage = {
        event: 'upload_chunk',
        data: {
          asset_id: assetIdRef.current,
          part_number: partNum,
          chunk_data: base64,
          checksum: 'no-validation',
          start_timestamp: Math.floor(Date.now() / 1000),
          duration_seconds: Math.round(chunkIntervalMs / 1000)
        }
      };
      console.log(`📤 Sending chunk ${partNum}:`, { ...chunkMessage.data, chunk_data: `[${base64.length} chars]` });
      wsRef.current?.send(JSON.stringify(chunkMessage));
    };
    reader.readAsArrayBuffer(chunk);
  }, [chunkIntervalMs]);

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

  const createRecorder = useCallback((stream: MediaStream) => {
    const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    let chunkData: Blob | null = null;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        console.log(`📹 Combined chunk received: ${event.data.size} bytes`);
        chunkData = event.data;
      }
    };

    recorder.onstop = () => {
      if (chunkData && assetIdRef.current) {
        partNumberRef.current += 1;
        const partNum = partNumberRef.current;
        console.log(`📤 Uploading chunk ${partNum}`);
        uploadChunk(chunkData, partNum);
      }

      // Restart recorder if still recording
      if (isRecordingRef.current && stream.active) {
        console.log(`🔄 Restarting recorder...`);
        recorder.start();
        setTimeout(() => recorder.stop(), chunkIntervalMs);
      }
    };

    return recorder;
  }, [uploadChunk, format, chunkIntervalMs]);

  const startCombinedRecording = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Your browser may not support screen sharing. Please update your browser or try a different one (like Chrome or Firefox).");
        return;
      }

      // Get screen share with system audio
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        // @ts-ignore
        video: { mediaSource: "screen" },
        audio: true // This captures system audio
      });

      let displaySurface = screenStream.getVideoTracks()[0].getSettings().displaySurface;
      if (displaySurface !== "monitor") {
        alert("Selection of entire screen mandatory!");
        const tracks = screenStream.getTracks();
        tracks.forEach((track) => track.stop());
        return;
      }

      // Get microphone audio
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      // Create Web Audio API context to mix audio
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();

      // Create combined stream with screen video
      const combinedStream = new MediaStream();
      
      // Add screen video track
      screenStream.getVideoTracks().forEach(track => {
        combinedStream.addTrack(track);
      });

      // Mix audio using Web Audio API
      const screenAudioTracks = screenStream.getAudioTracks();
      const micAudioTracks = micStream.getAudioTracks();

      if (screenAudioTracks.length > 0) {
        const screenAudioStream = new MediaStream([screenAudioTracks[0]]);
        const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
        screenSource.connect(destination);
        console.log('✅ Screen audio connected');
      }

      if (micAudioTracks.length > 0) {
        const micAudioStream = new MediaStream([micAudioTracks[0]]);
        const micSource = audioContext.createMediaStreamSource(micAudioStream);
        micSource.connect(destination);
        console.log('✅ Microphone audio connected');
      }

      // Add mixed audio track to combined stream
      destination.stream.getAudioTracks().forEach(track => {
        combinedStream.addTrack(track);
      });

      const track = screenStream.getVideoTracks()[0];
      track.onended = function () {
        console.log('Screen sharing ended');
        audioContext.close();
        setState(prev => ({ ...prev, isRecording: false }));
      };

      const recorderInstance = createRecorder(combinedStream);
      recorderInstance.start();
      setTimeout(() => recorderInstance.stop(), chunkIntervalMs);

      setState(prev => ({
        ...prev,
        mediaRecorder: recorderInstance,
        combinedStream: combinedStream
      }));

      console.log('✅ Combined recording started (Screen + Mixed Audio)');
      console.log(`📊 Audio tracks in combined stream: ${combinedStream.getAudioTracks().length}`);
      console.log(`📊 Video tracks in combined stream: ${combinedStream.getVideoTracks().length}`);
    } catch (err: any) {
      console.error("Combined recording error:", err);
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
            await startCombinedRecording();
            setState(prev => ({ ...prev, isRecording: true }));
            console.log('✅ Combined recording started successfully');
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

    console.log('⏹️ Stopping combined recording...');
    isRecordingRef.current = false;
    setState(prev => ({ ...prev, isRecording: false }));

    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.stop();
    }

    if (state.combinedStream) {
      state.combinedStream.getTracks().forEach(track => track.stop());
    }

    setState(prev => ({
      ...prev,
      mediaRecorder: null,
      combinedStream: null
    }));

    uploadCompleteReceived.current = false;

    console.log('⏳ Waiting 5s before completing upload...');
    setTimeout(() => {
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
      <h1 className="text-2xl font-bold mb-6 text-center">Combined Screen Recorder</h1>
      
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
            <div>Combined Recording: {state.mediaRecorder ? '🔴 Active' : '⚫ Inactive'}</div>
            <div>Chunk Interval: {chunkIntervalMs / 1000}s</div>
          </div>
        </div>

        <div className="bg-blue-50 p-4 rounded-md">
          <h3 className="font-medium mb-2">Features</h3>
          <ul className="text-sm space-y-1">
            <li>✅ Screen video capture</li>
            <li>✅ Screen audio capture</li>
            <li>✅ Microphone audio capture</li>
            <li>✅ Web Audio API mixing</li>
            <li>✅ Single combined stream</li>
            <li>✅ 5-second chunk uploads via WebSocket</li>
            <li>✅ Full screen enforcement</li>
          </ul>
        </div>

        <div className="flex gap-2">
          <button
            onClick={startRecording}
            disabled={state.isRecording || !websocketId || !websocketToken || !interviewSessionId}
            className="flex-1 bg-red-500 text-white p-2 rounded-md disabled:bg-gray-300 font-medium"
          >
            {state.isRecording ? '🔴 Recording...' : '▶️ Start Combined Recording'}
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
              Screen + screen audio + microphone are being recorded in 5-second chunks via WebSocket.
              Do not close this tab or stop screen sharing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}