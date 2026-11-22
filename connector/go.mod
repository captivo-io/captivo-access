module github.com/kurtserdar/captivo-access/connector

go 1.25.0

require (
	github.com/coder/websocket v1.8.15
	github.com/hashicorp/yamux v0.1.2
	github.com/kurtserdar/captivo-access/tunnel v0.0.0-00010101000000-000000000000
)

require (
	github.com/go-ldap/ldap/v3 v3.4.14
	github.com/klauspost/compress v1.17.11
	golang.org/x/crypto v0.54.0
)

require (
	github.com/Azure/go-ntlmssp v0.1.1 // indirect
	github.com/go-asn1-ber/asn1-ber v1.5.8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
)

replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
