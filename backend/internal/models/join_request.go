package models

type JoinRequest struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	DeviceID  string `json:"deviceId"`
	Status    string `json:"status"` // PENDING, APPROVED, REJECTED
}
