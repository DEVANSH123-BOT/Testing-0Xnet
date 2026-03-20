import { useEffect, useRef, useState, useCallback } from 'react';

// This matches the Go backend SignalMessage struct
interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate' | 'join-session' | 'user-left' | 'audio-status' | 'video-status';
  session_id: string;
  sender_id: string;
  target_id?: string;
  data?: any;
}

export const useWebRTC = (sessionID: string, myDeviceID: string, host?: string) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [remoteStatus, setRemoteStatus] = useState<Map<string, { video: boolean, audio: boolean }>>(new Map());
  const [remoteConnectionStatus, setRemoteConnectionStatus] = useState<Map<string, RTCIceConnectionState>>(new Map());
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isAudioOn, setIsAudioOn] = useState(true);
  
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const socketRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // 1. Initialize Media (Camera/Mic) with Resilience
  const initMedia = useCallback(async () => {
    // Return existing stream if already initialized
    if (localStreamRef.current) return localStreamRef.current;
    
    // First attempt: Video + Audio
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      localStreamRef.current = stream;
      setIsVideoOn(true);
      return stream;
    } catch (err) {
      console.warn("Full media access failed, trying audio-only...", err);
      // Second attempt: Audio-only
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        setLocalStream(stream);
        localStreamRef.current = stream;
        setIsVideoOn(false); // No video track available
        return stream;
      } catch (audioErr) {
        console.error("Critical: Failed to get even audio media:", audioErr);
        return null;
      }
    }
  }, []);

  // 2. Create a Peer Connection for a specific device
  const createPeerConnection = useCallback((targetID: string, stream: MediaStream) => {
    if (peerConnections.current.has(targetID)) return peerConnections.current.get(targetID)!;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ] 
    });

    // Add local tracks to the connection
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    // Monitor Connection Health
    pc.oniceconnectionstatechange = () => {
      console.log(`📡 Peer ${targetID.slice(0, 4)} state: ${pc.iceConnectionState}`);
      setRemoteConnectionStatus(prev => {
        const next = new Map(prev);
        next.set(targetID, pc.iceConnectionState);
        return next;
      });
    };

    // Receive incoming tracks from the peer
    pc.ontrack = (event) => {
      setRemoteStreams(prev => {
        const next = new Map(prev);
        if (event.streams[0]) {
          next.set(targetID, event.streams[0]);
        }
        return next;
      });
    };

    // Relay local ICE candidates to the Go backend
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'candidate',
          session_id: sessionID,
          target_id: targetID,
          data: event.candidate
        }));
      }
    };

    peerConnections.current.set(targetID, pc);
    return pc;
  }, [sessionID]);

  // Handle incoming signaling messages
  const handleSignalMessage = useCallback(async (msg: SignalMessage) => {
    const { type, sender_id, data } = msg;

    // Skip messages from ourselves
    if (sender_id === myDeviceID) return;

    // A. Another person joined or we received an offer
    if (type === 'join-session' || type === 'offer') {
      const stream = localStreamRef.current || await initMedia();
      if (!stream) return;

      const pc = createPeerConnection(sender_id, stream);

      if (type === 'join-session') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.send(JSON.stringify({ 
          type: 'offer', 
          session_id: sessionID, 
          target_id: sender_id, 
          data: offer 
        }));
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current?.send(JSON.stringify({ 
          type: 'answer', 
          session_id: sessionID, 
          target_id: sender_id, 
          data: answer 
        }));

        // Flush pending candidates
        if (pendingCandidates.current.has(sender_id)) {
          pendingCandidates.current.get(sender_id)?.forEach(candidate => {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn("Queued candidate error:", e));
          });
          pendingCandidates.current.delete(sender_id);
        }
      }
    }

    // B. Handshake Complete
    if (type === 'answer') {
      const pc = peerConnections.current.get(sender_id);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        
        // Flush pending candidates
        if (pendingCandidates.current.has(sender_id)) {
          pendingCandidates.current.get(sender_id)?.forEach(candidate => {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn("Queued answer candidate error:", e));
          });
          pendingCandidates.current.delete(sender_id);
        }
      }
    }

    // C. Network path found
    if (type === 'candidate') {
      const pc = peerConnections.current.get(sender_id);
      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(data)).catch(e => {
          console.warn("Candidate failure (maybe peer closed?):", e);
        });
      } else {
        // Queue if description is not yet set
        if (!pendingCandidates.current.has(sender_id)) {
          pendingCandidates.current.set(sender_id, []);
        }
        pendingCandidates.current.get(sender_id)?.push(data);
      }
    }

    // D. Someone left
    if (type === 'user-left') {
      const pc = peerConnections.current.get(sender_id);
      pc?.close();
      peerConnections.current.delete(sender_id);
      pendingCandidates.current.delete(sender_id);
      setRemoteStreams(prev => {
        const next = new Map(prev);
        next.delete(sender_id);
        return next;
      });
      setRemoteStatus(prev => {
        const next = new Map(prev);
        next.delete(sender_id);
        return next;
      });
      setRemoteConnectionStatus(prev => {
        const next = new Map(prev);
        next.delete(sender_id);
        return next;
      });
    }

    // E. Status Updates
    if (type === 'video-status') {
      setRemoteStatus(prev => {
        const next = new Map(prev);
        const current = next.get(sender_id) || { video: true, audio: true };
        next.set(sender_id, { ...current, video: data.enabled });
        return next;
      });
    }

    if (type === 'audio-status') {
      setRemoteStatus(prev => {
        const next = new Map(prev);
        const current = next.get(sender_id) || { video: true, audio: true };
        next.set(sender_id, { ...current, audio: data.enabled });
        return next;
      });
    }
  }, [myDeviceID, sessionID, initMedia, createPeerConnection]);

  // 3. Connect to Go Signaling Server
  useEffect(() => {
    if (!sessionID || !myDeviceID) return;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const signalingHost = host || (window.location.hostname + ':8080');
    const wsUrl = `${wsProtocol}//${signalingHost}/ws?deviceId=${myDeviceID}`;
    
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = async () => {
      console.log("Connected to Signaling Server:", signalingHost);
      const stream = await initMedia();
      if (stream) {
        // Small delay to ensure hub registration is processed
        setTimeout(() => {
          ws.send(JSON.stringify({ 
            type: 'join-session', 
            session_id: sessionID 
          }));
        }, 300);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg: SignalMessage = JSON.parse(event.data);
        handleSignalMessage(msg);
      } catch (err) {
        console.error("Signal parsing error:", err);
      }
    };

    ws.onerror = (e) => console.error("Signaling Socket Error:", e);
    ws.onclose = () => console.warn("Signaling Socket Closed");

    return () => {
      ws.close();
      peerConnections.current.forEach(pc => pc.close());
      peerConnections.current.clear();
      pendingCandidates.current.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    };
  }, [sessionID, myDeviceID, host, handleSignalMessage, initMedia]);

  // UI Control Helpers
  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
        setIsVideoOn(track.enabled);
        
        // Notify others
        socketRef.current?.send(JSON.stringify({
          type: 'video-status',
          session_id: sessionID,
          data: { enabled: track.enabled }
        }));
      });
    }
  }, [sessionID]);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
        setIsAudioOn(track.enabled);

        // Notify others
        socketRef.current?.send(JSON.stringify({
          type: 'audio-status',
          session_id: sessionID,
          data: { enabled: track.enabled }
        }));
      });
    }
  }, [sessionID]);

  return { 
    localStream, 
    remoteStreams, 
    remoteStatus, 
    remoteConnectionStatus,
    isVideoOn, 
    isAudioOn, 
    toggleVideo, 
    toggleAudio 
  };
};


