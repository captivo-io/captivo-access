package tunnel

// Recording reports. A connector's store changes after a session has ended: it
// turns a graphical session's instruction stream into a seekable video, and it
// compresses what it keeps. The control plane's index has to follow, so the
// player knows a video is there and the console shows what the disk holds. The
// connector sends a RecReport on its control stream; the data plane relays it
// and, once the control plane has recorded it, answers with a RecReportAck.
// Until that ack arrives the connector keeps reporting, so nothing is lost to a
// restart on either side.
type RecReport struct {
	Kind  string          `json:"kind"` // "recreport"
	Items []RecReportItem `json:"items"`
}

// RecReportItem is the current state of one recording.
type RecReportItem struct {
	TenantID     string `json:"tenantId"`
	RecordingKey string `json:"recordingKey"`
	// Video: the recording now plays from its "video" stream (WebM). Set for a
	// converted RDP/VNC recording; an isolated-browser one always was video.
	Video bool `json:"video"`
	// DurationMs is the video's length, when the connector has measured it.
	DurationMs int64 `json:"durationMs,omitempty"`
	// StoredBytes is what the recording occupies on the connector's disk.
	StoredBytes int64 `json:"storedBytes"`
}

// RecReportAck names the items the control plane has recorded, echoed as sent:
// the connector marks an item reported only if it still matches its current
// state, so a later change is reported again.
type RecReportAck struct {
	Kind  string          `json:"kind"` // "recreportack"
	Items []RecReportItem `json:"items"`
}
