package websocket

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer.
	maxMessageSize = 65536 // Increased to 64KB for large WebRTC SDP payloads
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// SignalMessage defines the structure for WebRTC signaling messages
type SignalMessage struct {
	Type      string          `json:"type"`       // "offer", "answer", "candidate", "join-session"
	SessionID string          `json:"session_id"`
	SenderID  string          `json:"sender_id"`
	TargetID  string          `json:"target_id"`  // Peer to receive the signaling
	Data      json.RawMessage `json:"data"`       // SDP or ICE Candidate
}

// Hub maintains the set of active clients and broadcasts messages to the
// clients.
type Hub struct {
	// Registered clients by DeviceID
	clients map[string]*Client

	// Sessions maps sessionID to a set of deviceIDs
	sessions map[string]map[string]bool

	// Register requests from the clients.
	register chan *Client

	// Unregister requests from clients.
	unregister chan *Client

	mu sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[string]*Client),
		sessions:   make(map[string]map[string]bool),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ID] = client
			h.mu.Unlock()
			log.Printf("📱 Device registered: %s", client.ID)
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ID]; ok {
				// Clean up from sessions
				if client.SessionID != "" {
					if sess, ok := h.sessions[client.SessionID]; ok {
						delete(sess, client.ID)
						if len(sess) == 0 {
							delete(h.sessions, client.SessionID)
						} else {
							// Notify others that user left
							leaveMsg, _ := json.Marshal(SignalMessage{
								Type:      "user-left",
								SenderID:  client.ID,
								SessionID: client.SessionID,
							})
							for otherID := range sess {
								if other, exists := h.clients[otherID]; exists {
									select {
									case other.send <- leaveMsg:
									default:
									}
								}
							}
						}
					}
				}
				delete(h.clients, client.ID)
				close(client.send)
				log.Printf("📱 Device unregistered: %s", client.ID)
			}
			h.mu.Unlock()
		}
	}
}

// BroadcastToSession sends a message to all members of a session except the sender
func (h *Hub) BroadcastToSession(sessionID string, senderID string, message []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if sess, ok := h.sessions[sessionID]; ok {
		for otherID := range sess {
			if otherID != senderID {
				if other, exists := h.clients[otherID]; exists {
					select {
					case other.send <- message:
					default:
					}
				}
			}
		}
	}
}

// Client is a middleman between the websocket connection and the hub.
type Client struct {
	hub *Hub

	// The websocket connection.
	conn *websocket.Conn

	// The client's DeviceID.
	ID string

	// The session this client is currently in
	SessionID string

	// Buffered channel of outbound messages.
	send chan []byte
}

// readPump pumps messages from the websocket connection to the hub.
// The application runs readPump in a per-connection goroutine. The application
// ensures that there is at most one reader on a connection by executing all
// reads from this goroutine.
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error { c.conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		var sig SignalMessage
		if err := json.Unmarshal(message, &sig); err != nil {
			log.Printf("invalid signal message: %v", err)
			continue
		}

		sig.SenderID = c.ID

		// 1. Handle Room Joining
		if sig.Type == "join-session" && sig.SessionID != "" {
			c.SessionID = sig.SessionID
			c.hub.mu.Lock()
			if c.hub.sessions[sig.SessionID] == nil {
				c.hub.sessions[sig.SessionID] = make(map[string]bool)
			}
			c.hub.sessions[sig.SessionID][c.ID] = true
			c.hub.mu.Unlock()
			log.Printf("👥 User %s joined session %s", c.ID, sig.SessionID)

			// Broadcast presence to others in the room
			msgBytes, _ := json.Marshal(sig)
			c.hub.BroadcastToSession(sig.SessionID, c.ID, msgBytes)
			continue
		}

		// 2. Direct Relay (Standard WebRTC P2P)
		if sig.TargetID != "" {
			c.hub.mu.RLock()
			if target, ok := c.hub.clients[sig.TargetID]; ok {
				// Re-marshal to ensure SenderID is correct
				msgBytes, _ := json.Marshal(sig)
				target.send <- msgBytes
			}
			c.hub.mu.RUnlock()
		} else if sig.SessionID != "" {
			// 3. Broadcast to Session (Presence, Mute status, etc)
			msgBytes, _ := json.Marshal(sig)
			c.hub.BroadcastToSession(sig.SessionID, c.ID, msgBytes)
		}
	}
}

// writePump pumps messages from the hub to the websocket connection.
// A goroutine running writePump is started for each connection. The
// application ensures that there is at most one writer on a connection by
// executing all writes from this goroutine.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// The hub closed the channel.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued chat messages to the current websocket message.
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ServeWs handles websocket requests from the peer.
func ServeWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}

	deviceID := r.URL.Query().Get("deviceId")
	if deviceID == "" {
		log.Println("deviceID is required for websocket connection")
		conn.Close()
		return
	}

	client := &Client{hub: hub, conn: conn, ID: deviceID, SessionID: "", send: make(chan []byte, 256)}
	client.hub.register <- client

	// Allow collection of memory referenced by the caller by doing all work in
	// new goroutines.
	go client.writePump()
	go client.readPump()
}
