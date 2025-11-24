# ScreenRecorder.tsx - Complete Integration Guide

## Overview
This document provides a comprehensive explanation of the ScreenRecorder.tsx component, designed to help developers replicate a similar screen recording service integration in another application.

## Architecture Summary
The component implements a **real-time screen recording system** that:
- Captures screen video + system audio + microphone audio
- Mixes multiple audio sources using Web Audio API
- Chunks recordings into 5-second segments
- Uploads chunks via WebSocket in real-time
- Enforces full-screen recording for security/compliance

---

## 1. Dependencies & Imports

```tsx
'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
```

**Key Points:**
- `'use client'` directive: Required for Next.js 13+ App Router (client-side component)
- React hooks used:
  - `useState`: UI state management
  - `useRef`: Persistent references (WebSocket, MediaRecorder, refs that don't trigger re-renders)
  - `useCallback`: Memoized functions to prevent unnecessary re-renders

---

## 2. State Management

### TypeScript Interface
```tsx
interface RecorderState {
  isRecording: boolean;
  mediaRecorder: MediaRecorder | null;
  combinedStream: MediaStream | null;
  websocket: WebSocket | null;
  recordingAssetId: number | null;
}
```

### State Variables

#### Component State (useState)
```tsx
const [websocketId, setWebsocketId] = useState('');
const [websocketToken, setWebsocketToken] = useState('');
const [interviewSessionId, setInterviewSessionId] = useState('');
const [isGenerating, setIsGenerating] = useState(false);
const [format, setFormat] = useState<'mp4' | 'webm'>('webm');
const [state, setState] = useState<RecorderState>({...});
```

**Purpose:**
- `websocketId` & `websocketToken`: Authentication credentials for WebSocket connection
- `interviewSessionId`: Unique identifier for the recording session
- `isGenerating`: Loading state for session generation
- `format`: Video format selection (mp4/webm)
- `state`: Main recorder state object

#### Refs (useRef)
```tsx
const wsRef = useRef<WebSocket | null>(null);
const assetIdRef = useRef<number | null>(null);
const partNumberRef = useRef(0);
const uploadCompleteReceived = useRef(false);
const isRecordingRef = useRef(false);
const chunkIntervalMs = 5000; // 5 seconds
```

**Why useRef instead of useState?**
- Refs don't trigger re-renders when updated
- Needed for values accessed in callbacks/event handlers
- `wsRef`: WebSocket instance reference
- `assetIdRef`: Server-assigned recording asset ID
- `partNumberRef`: Tracks chunk sequence numbers
- `isRecordingRef`: Recording state flag for MediaRecorder restart logic

---

## 3. WebSocket Connection Management

### connectWebSocket Function
```tsx
const connectWebSocket = useCallback(() => {
  const wsUrl = `${process.env.NEXT_PUBLIC_WEBSOCKET_DOMAIN}/ws/recording/${websocketId}`;
  const ws = new WebSocket(wsUrl);
  
  // Event handlers...
  wsRef.current = ws;
  return ws;
}, [websocketId, websocketToken]);
```

**Flow:**
1. Construct WebSocket URL with `websocketId`
2. Create WebSocket connection
3. Set up event handlers (onopen, onmessage, onerror, onclose)
4. Store reference in `wsRef`

### WebSocket Event Handlers

#### onopen - Connection Established
```tsx
ws.onopen = () => {
  const authMessage = {
    event: 'authenticate',
    data: { token: websocketToken }
  };
  ws.send(JSON.stringify(authMessage));
};
```
**Purpose:** Immediately authenticate after connection

#### onmessage - Server Messages
```tsx
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  // Handle different event types:
  // - authenticated
  // - session_recording_initialized
  // - chunk_queued
  // - chunk_ack / chunk_nack
  // - upload_complete
  // - session_status_response
};
```

**Critical Events:**
- `session_recording_initialized`: Receives `recording_asset_id` (stored in `assetIdRef`)
- `chunk_ack`: Confirms chunk upload success
- `chunk_nack`: Indicates chunk upload failure
- `upload_complete`: Final confirmation

---

## 4. Chunk Upload System

### uploadChunk Function
```tsx
const uploadChunk = useCallback((chunk: Blob, partNum: number) => {
  const reader = new FileReader();
  reader.onload = () => {
    const arrayBuffer = reader.result as ArrayBuffer;
    const bytes = new Uint8Array(arrayBuffer);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    
    // Send via WebSocket
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
    wsRef.current?.send(JSON.stringify(chunkMessage));
  };
  reader.readAsArrayBuffer(chunk);
}, [chunkIntervalMs]);
```

**Process:**
1. Receive Blob chunk from MediaRecorder
2. Read as ArrayBuffer using FileReader
3. Convert to Uint8Array
4. Encode to base64 string (for JSON transmission)
5. Send via WebSocket with metadata

**Why base64?**
- WebSocket text frames require string data
- Binary WebSocket frames could be used as alternative (more efficient)

---

## 5. MediaRecorder Management

### createRecorder Function
```tsx
const createRecorder = useCallback((stream: MediaStream) => {
  const mimeType = format === 'mp4' ? 'video/mp4' : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  let chunkData: Blob | null = null;
  
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunkData = event.data;
    }
  };
  
  recorder.onstop = () => {
    if (chunkData && assetIdRef.current) {
      partNumberRef.current += 1;
      uploadChunk(chunkData, partNumberRef.current);
    }
    
    // Auto-restart for continuous chunking
    if (isRecordingRef.current && stream.active) {
      recorder.start();
      setTimeout(() => recorder.stop(), chunkIntervalMs);
    }
  };
  
  return recorder;
}, [uploadChunk, format, chunkIntervalMs]);
```

**Chunking Strategy:**
1. Start MediaRecorder
2. Stop after 5 seconds (triggers `onstop`)
3. Upload chunk in `onstop` handler
4. Restart recorder if still recording
5. Repeat until recording ends

**Why this approach?**
- Enables real-time streaming
- Prevents memory overflow from long recordings
- Allows progressive upload during recording

---

## 6. Audio Mixing with Web Audio API

### startCombinedRecording Function

#### Step 1: Get Screen Stream
```tsx
const screenStream = await navigator.mediaDevices.getDisplayMedia({
  video: { mediaSource: "screen" },
  audio: true // System audio
});
```

**Captures:**
- Screen video
- System audio (browser tabs, applications)

#### Step 2: Validate Full Screen
```tsx
let displaySurface = screenStream.getVideoTracks()[0].getSettings().displaySurface;
if (displaySurface !== "monitor") {
  alert("Selection of entire screen mandatory!");
  screenStream.getTracks().forEach(track => track.stop());
  return;
}
```

**Purpose:** Enforce full-screen recording (security/compliance requirement)

#### Step 3: Get Microphone Stream
```tsx
const micStream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: false
});
```

#### Step 4: Mix Audio Sources
```tsx
const audioContext = new AudioContext();
const destination = audioContext.createMediaStreamDestination();

// Connect screen audio
if (screenAudioTracks.length > 0) {
  const screenAudioStream = new MediaStream([screenAudioTracks[0]]);
  const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
  screenSource.connect(destination);
}

// Connect microphone audio
if (micAudioTracks.length > 0) {
  const micAudioStream = new MediaStream([micAudioTracks[0]]);
  const micSource = audioContext.createMediaStreamSource(micAudioStream);
  micSource.connect(destination);
}
```

**Web Audio API Flow:**
```
Screen Audio → MediaStreamSource → Destination
Microphone  → MediaStreamSource → Destination
                                      ↓
                              Mixed Audio Track
```

#### Step 5: Create Combined Stream
```tsx
const combinedStream = new MediaStream();

// Add video from screen
screenStream.getVideoTracks().forEach(track => {
  combinedStream.addTrack(track);
});

// Add mixed audio
destination.stream.getAudioTracks().forEach(track => {
  combinedStream.addTrack(track);
});
```

**Result:** Single MediaStream with:
- 1 video track (screen)
- 1 audio track (mixed system + microphone)

#### Step 6: Handle Screen Sharing End
```tsx
const track = screenStream.getVideoTracks()[0];
track.onended = function () {
  audioContext.close();
  setState(prev => ({ ...prev, isRecording: false }));
};
```

**Purpose:** Clean up when user stops screen sharing

#### Step 7: Start Recording
```tsx
const recorderInstance = createRecorder(combinedStream);
recorderInstance.start();
setTimeout(() => recorderInstance.stop(), chunkIntervalMs);
```

---

## 7. Recording Lifecycle

### startRecording Function
```tsx
const startRecording = async () => {
  // 1. Connect WebSocket
  const ws = connectWebSocket();
  
  // 2. Wait for connection (1s)
  setTimeout(() => {
    // 3. Initialize session
    const initMessage = {
      event: 'initialize_session_recording',
      data: {
        interview_session_id: parseInt(interviewSessionId),
        file_extension: format,
        file_type: `video/${format}`
      }
    };
    wsRef.current.send(JSON.stringify(initMessage));
    
    // 4. Start recording (1s delay)
    setTimeout(async () => {
      isRecordingRef.current = true;
      await startCombinedRecording();
      setState(prev => ({ ...prev, isRecording: true }));
    }, 1000);
  }, 1000);
};
```

**Timing:**
- 0s: Connect WebSocket
- 1s: Send initialization message
- 2s: Start screen capture & recording

**Why delays?**
- Ensure WebSocket is fully connected
- Allow server to process initialization

### stopRecording Function
```tsx
const stopRecording = async () => {
  // 1. Confirm with user
  const userConfirmed = confirm("Do you want to end the recording?");
  if (!userConfirmed) return;
  
  // 2. Stop recording flag
  isRecordingRef.current = false;
  
  // 3. Stop MediaRecorder
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    state.mediaRecorder.stop();
  }
  
  // 4. Stop all tracks
  if (state.combinedStream) {
    state.combinedStream.getTracks().forEach(track => track.stop());
  }
  
  // 5. Wait 5s for final chunk upload
  setTimeout(() => {
    completeUpload();
  }, 5000);
};
```

**Critical:** 5-second delay ensures last chunk uploads before completion

### completeUpload Function
```tsx
const completeUpload = useCallback(() => {
  const completeMessage = {
    event: 'upload_completed',
    data: { asset_id: assetIdRef.current }
  };
  wsRef.current.send(JSON.stringify(completeMessage));
}, []);
```

**Purpose:** Signal server that all chunks uploaded

---

## 8. Session Generation

### generateSession Function
```tsx
const generateSession = async () => {
  setIsGenerating(true);
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_API_DOMAIN}/api/stream/websocket/generate`,
    { method: 'POST' }
  );
  const result = await response.json();
  
  if (result.status_code === 200) {
    const { session_id, websocket_details } = result.data;
    setInterviewSessionId(session_id.toString());
    setWebsocketId(websocket_details.websocket_id);
    setWebsocketToken(websocket_details.websocket_token);
  }
  setIsGenerating(false);
};
```

**Purpose:** Generate new recording session credentials from backend

---

## 9. Error Handling

### handleScreenSharingError Function
```tsx
const handleScreenSharingError = (err: any) => {
  switch (err.name) {
    case "NotAllowedError":
      // User denied permission
    case "NotFoundError":
      // No screen selected
    case "AbortError":
      // User cancelled
    case "OverconstrainedError":
    case "TypeError":
      // Browser constraints issue
    default:
      // Check for HTTPS or browser support issues
  }
};
```

**Common Errors:**
- `NotAllowedError`: Permission denied
- `NotFoundError`: No screen selected
- `AbortError`: User cancelled dialog
- HTTPS requirement for screen sharing

---

## 10. UI Component

### Key UI Elements

#### Input Fields
```tsx
<input value={websocketId} onChange={(e) => setWebsocketId(e.target.value)} />
<input value={websocketToken} onChange={(e) => setWebsocketToken(e.target.value)} />
<input value={interviewSessionId} onChange={(e) => setInterviewSessionId(e.target.value)} />
```

#### Format Selection
```tsx
<select value={format} onChange={(e) => setFormat(e.target.value as 'mp4' | 'webm')}>
  <option value="webm">WebM</option>
  <option value="mp4">MP4</option>
</select>
```

#### Action Buttons
```tsx
<button onClick={generateSession} disabled={isGenerating || state.isRecording}>
  Generate New Session
</button>

<button onClick={startRecording} disabled={state.isRecording || !websocketId || !websocketToken || !interviewSessionId}>
  Start Combined Recording
</button>

<button onClick={stopRecording} disabled={!state.isRecording}>
  Stop Recording
</button>
```

#### Status Display
```tsx
<div>WebSocket: {state.websocket ? '🟢 Connected' : '🔴 Disconnected'}</div>
<div>Combined Recording: {state.mediaRecorder ? '🔴 Active' : '⚫ Inactive'}</div>
<div>Chunk Interval: {chunkIntervalMs / 1000}s</div>
```

---

## 11. Integration Checklist

### Backend Requirements
- [ ] WebSocket server endpoint: `/ws/recording/{websocket_id}`
- [ ] REST API endpoint: `/api/stream/websocket/generate`
- [ ] WebSocket message handlers:
  - `authenticate`
  - `initialize_session_recording`
  - `upload_chunk`
  - `upload_completed`
- [ ] Chunk storage system (S3, database, etc.)
- [ ] Multipart upload assembly logic

### Frontend Requirements
- [ ] HTTPS connection (required for screen sharing)
- [ ] Browser permissions: screen sharing, microphone
- [ ] Environment variables:
  - `NEXT_PUBLIC_WEBSOCKET_DOMAIN`
  - `NEXT_PUBLIC_API_DOMAIN`

### Browser Compatibility
- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Limited (check MediaRecorder codec support)

---

## 12. Key Technical Decisions

### Why WebSocket over HTTP?
- Real-time chunk streaming
- Bidirectional communication (ack/nack)
- Lower latency than polling

### Why 5-Second Chunks?
- Balance between:
  - Upload frequency (network overhead)
  - Memory usage (chunk size)
  - Recovery granularity (if upload fails)

### Why Web Audio API for Mixing?
- Native browser support
- Real-time audio mixing
- No external libraries needed
- Precise control over audio sources

### Why useRef for Critical State?
- Avoid stale closures in event handlers
- Prevent unnecessary re-renders
- Maintain consistent references across async operations

---

## 13. Common Pitfalls & Solutions

### Problem: Chunks Upload Out of Order
**Solution:** Use `part_number` sequencing, server reassembles in order

### Problem: Last Chunk Not Uploaded
**Solution:** 5-second delay in `stopRecording` before `completeUpload`

### Problem: Audio Not Mixed
**Solution:** Ensure both audio sources connected to `destination` before creating combined stream

### Problem: Screen Sharing Stops Unexpectedly
**Solution:** Handle `track.onended` event, clean up resources

### Problem: WebSocket Disconnects
**Solution:** Implement reconnection logic (not shown in this code)

---

## 14. Replication Steps

### Step 1: Set Up State Management
```tsx
// Copy state structure
const [state, setState] = useState<RecorderState>({...});
const wsRef = useRef<WebSocket | null>(null);
const assetIdRef = useRef<number | null>(null);
// ... other refs
```

### Step 2: Implement WebSocket Connection
```tsx
const connectWebSocket = useCallback(() => {
  // Create WebSocket
  // Set up event handlers
  // Handle authentication
}, [dependencies]);
```

### Step 3: Implement Audio Mixing
```tsx
const startCombinedRecording = async () => {
  // Get screen stream
  // Get microphone stream
  // Create AudioContext
  // Mix audio sources
  // Create combined stream
};
```

### Step 4: Implement MediaRecorder Chunking
```tsx
const createRecorder = useCallback((stream) => {
  // Create MediaRecorder
  // Handle ondataavailable
  // Handle onstop with auto-restart
}, [dependencies]);
```

### Step 5: Implement Upload Logic
```tsx
const uploadChunk = useCallback((chunk, partNum) => {
  // Convert Blob to base64
  // Send via WebSocket
}, [dependencies]);
```

### Step 6: Wire Up UI
```tsx
return (
  <div>
    {/* Input fields */}
    {/* Control buttons */}
    {/* Status display */}
  </div>
);
```

---

## 15. Testing Recommendations

### Unit Tests
- WebSocket message handling
- Chunk encoding/decoding
- State transitions

### Integration Tests
- Full recording flow
- Error scenarios
- Network interruptions

### Manual Tests
- Different screen sizes
- Multiple audio sources
- Browser compatibility
- Long recordings (memory leaks)

---

## 16. Performance Considerations

### Memory Management
- Chunks released after upload
- Streams stopped properly
- AudioContext closed on cleanup

### Network Optimization
- Consider binary WebSocket frames instead of base64
- Implement compression (gzip)
- Add retry logic for failed chunks

### CPU Usage
- MediaRecorder handles encoding (hardware accelerated)
- Web Audio API is efficient
- Avoid unnecessary re-renders with useCallback/useRef

---

## 17. Security Considerations

### Authentication
- WebSocket token-based auth
- Session ID validation
- Secure credential storage

### Data Privacy
- HTTPS required
- Full-screen enforcement
- User consent dialogs

### Input Validation
- Validate chunk data on server
- Verify part numbers sequential
- Check asset_id ownership

---

## 18. Future Enhancements

### Potential Improvements
- [ ] Reconnection logic for WebSocket
- [ ] Pause/resume recording
- [ ] Quality settings (resolution, bitrate)
- [ ] Preview window
- [ ] Recording timer display
- [ ] Chunk upload retry mechanism
- [ ] Progress indicator
- [ ] Local backup (IndexedDB)
- [ ] Multiple video quality options
- [ ] Screen annotation tools

---

## 19. Environment Variables

```env
NEXT_PUBLIC_WEBSOCKET_DOMAIN=wss://your-websocket-domain.com
NEXT_PUBLIC_API_DOMAIN=https://your-api-domain.com
```

---

## 20. Summary

This component implements a production-ready screen recording system with:
- ✅ Multi-source audio mixing
- ✅ Real-time chunk streaming
- ✅ WebSocket-based upload
- ✅ Full-screen enforcement
- ✅ Comprehensive error handling
- ✅ Clean resource management

**Core Technologies:**
- MediaRecorder API (video recording)
- getDisplayMedia API (screen capture)
- getUserMedia API (microphone)
- Web Audio API (audio mixing)
- WebSocket API (real-time communication)
- FileReader API (blob processing)

**Key Patterns:**
- useRef for persistent state
- useCallback for memoization
- Event-driven architecture
- Chunked streaming
- Base64 encoding for transport

---

## Contact & Support

For questions about this implementation, refer to:
- MDN Web Docs: MediaRecorder, Web Audio API
- WebSocket Protocol Documentation
- Next.js Documentation

---

**Document Version:** 1.0  
**Last Updated:** 2024  
**Component File:** `app/components/ScreenRecorder.tsx`
