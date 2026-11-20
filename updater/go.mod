module github.com/kurtserdar/captivo-access/updater

go 1.23.4

require github.com/kurtserdar/captivo-access/tunnel v0.0.0

require github.com/hashicorp/yamux v0.1.2 // indirect

replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
