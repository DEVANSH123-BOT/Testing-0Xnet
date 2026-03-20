import React, { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ScrambledText from './ScrambledText'
import PillNav from './PillNav'
import { useWebRTC } from './hooks/useWebRTC'
import './LiveSession.css'

// Internal Video component to safely attach MediaStreams to <video> tags
const VideoView: React.FC<{ stream: MediaStream | null; muted?: boolean; isLocal?: boolean }> = ({ stream, muted, isLocal }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <video 
      ref={videoRef} 
      autoPlay 
      playsInline 
      muted={muted} 
      className={`video-element ${isLocal ? 'local-view' : ''}`} 
    />
  );
};

interface Participant {
  id: string
  name: string
  avatar: string
  status: 'online' | 'busy' | 'away'
  role?: 'host' | 'guest'
  isMe?: boolean
}

interface LiveSessionProps {
  sessionData: {
    members: Participant[]
    host?: string
  }
  myDeviceID: string
  onLeave: () => void
}

const LiveSession: React.FC<LiveSessionProps> = ({ sessionData, myDeviceID, onLeave }) => {
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('video')
  
  // Connect to the WebRTC hook
  const { 
    localStream, 
    remoteStreams, 
    remoteStatus,
    remoteConnectionStatus,
    isVideoOn, 
    isAudioOn, 
    toggleVideo, 
    toggleAudio 
  } = useWebRTC(sessionData.id, myDeviceID, sessionData.host);

  const controlItems = [
    { id: 'video', label: isVideoOn ? 'Video' : 'Video Off', icon: isVideoOn ? '📹' : '🚫' },
    { id: 'audio', label: isAudioOn ? 'Unmuted' : 'Muted', icon: isAudioOn ? '🎙️' : '🔇' },
    { id: 'screenshare', label: 'Screen', icon: '🖥️' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ]

  const handleControlChange = (id: string) => {
    if (id === 'video') toggleVideo();
    if (id === 'audio') toggleAudio();
  }

  return (
    <motion.div 
      className="live-session-overlay meet-theme"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="meet-container">
        {/* Top Header */}
        <header className="meet-header">
          <div className="header-left">
            <ScrambledText 
              text={sessionData.name} 
              className="meet-session-name" 
              duration={1000}
            />
            <span className="meet-session-id">0X-{sessionData.id}</span>
          </div>
          
          <div className="header-right">
             <motion.button 
               className={`meet-utility-btn ${participantsOpen ? 'active' : ''}`}
               onClick={() => setParticipantsOpen(!participantsOpen)}
               whileHover={{ scale: 1.1 }}
               whileTap={{ scale: 0.9 }}
               title="Participants"
             >
               👥 <span>{sessionData.members.length + remoteStreams.size}</span>
             </motion.button>
             <button className="meet-utility-btn" title="Chat">💬</button>
          </div>
        </header>

        {/* Video Call Grid Area */}
        <main className="meet-main">
          <div className={`video-grid count-${1 + remoteStreams.size}`}>
            
            {/* 1. LOCAL VIDEO TILE */}
            <motion.div className="video-tile" layout>
              {localStream && isVideoOn ? (
                <VideoView stream={localStream} muted={true} isLocal={true} />
              ) : (
                <div className="avatar-placeholder">Y</div>
              )}
              <div className="tile-label">You</div>
              {isAudioOn && (
                <div className="audio-indicator">
                  <div className="audio-bars">
                    {[1, 2, 3].map(b => <motion.div key={b} className="bar" animate={{ height: [2, 8, 2] }} transition={{ repeat: Infinity, duration: 0.5 }} />)}
                  </div>
                </div>
              )}
            </motion.div>

            {/* 2. REMOTE VIDEO TILES (From hook) */}
            {Array.from(remoteStreams.entries()).map(([peerId, stream]) => {
              const status = remoteStatus.get(peerId) || { video: true, audio: true };
              return (
                <motion.div key={peerId} className="video-tile" layout>
                  {status.video ? (
                    <VideoView stream={stream} />
                  ) : (
                    <div className="avatar-placeholder">{peerId[0].toUpperCase()}</div>
                  )}
                  <div className="tile-label">Remote Peer ({peerId.slice(0, 4)})</div>
                  
                  {/* Connection Status Badge */}
                  {remoteConnectionStatus.get(peerId) && !['connected', 'completed'].includes(remoteConnectionStatus.get(peerId)!) && (
                    <div className="connection-status-badge">
                      {remoteConnectionStatus.get(peerId) === 'failed' ? '❌ Failed' : '📡 Connecting...'}
                    </div>
                  )}

                  {!status.audio && (
                    <div className="audio-indicator" style={{ background: 'rgba(234, 67, 53, 0.4)', borderRadius: '50%', padding: '4px' }}>
                      🔇
                    </div>
                  )}
                </motion.div>
              );
            })}

          </div>

          {/* Floating Participants Sidebar */}
          <AnimatePresence>
            {participantsOpen && (
              <motion.aside 
                className="meet-participants-sidebar"
                initial={{ x: 400, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 400, opacity: 0 }}
              >
                <div className="sidebar-header">
                  <h3>Participants</h3>
                  <button onClick={() => setParticipantsOpen(false)}>✕</button>
                </div>
                <div className="participants-list">
                  <div className="participant-row">
                    <div className="p-avatar">Y</div>
                    <span className="p-name">You (Host)</span>
                  </div>
                  {Array.from(remoteStreams.keys()).map((id) => (
                    <div key={id} className="participant-row">
                      <div className="p-avatar">{id[0]}</div>
                      <span className="p-name">Peer {id.slice(0, 4)}</span>
                    </div>
                  ))}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </main>

        {/* Floating Control Bar */}
        <footer className="meet-footer">
           <div className="footer-left-info">{sessionData.activeSince}</div>
           
           <div className="footer-center">
              <PillNav 
                items={controlItems} 
                activeId={activeTab} 
                onChange={handleControlChange} 
                className="control-pills"
              />
              <motion.button 
                className="end-call-btn"
                whileHover={{ scale: 1.1, backgroundColor: '#ea4335' }}
                whileTap={{ scale: 0.9 }}
                onClick={onLeave}
              >
                📞
              </motion.button>
           </div>

           <div className="footer-right-info">0XNET SECURE • LOCAL</div>
        </footer>
      </div>
    </motion.div>
  )
}

export default LiveSession
