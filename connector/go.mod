module github.com/kurtserdar/captivo-access/connector

go 1.23.4

require (
	github.com/coder/websocket v1.8.15
	github.com/hashicorp/yamux v0.1.2
	github.com/kurtserdar/captivo-access/tunnel v0.0.0-00010101000000-000000000000
)

require github.com/klauspost/compress v1.17.11

replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
