module github.com/kurtserdar/captivo-access/connector

go 1.25.0

require (
	github.com/coder/websocket v1.8.15
	github.com/hashicorp/yamux v0.1.2
	github.com/kurtserdar/captivo-access/tunnel v0.0.0-00010101000000-000000000000
)

require (
	github.com/go-ldap/ldap/v3 v3.4.14
	github.com/jfjallid/go-smb v0.12.0
	github.com/jfjallid/golog v0.4.0
	github.com/klauspost/compress v1.17.11
	golang.org/x/crypto v0.54.0
)

require (
	github.com/Azure/go-ntlmssp v0.1.1 // indirect
	github.com/go-asn1-ber/asn1-ber v1.5.8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jfjallid/gofork v1.7.6 // indirect
	github.com/jfjallid/gokrb5/v9 v9.1.0 // indirect
	github.com/jfjallid/mstypes v0.0.2 // indirect
	github.com/jfjallid/ndr v0.2.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	software.sslmate.com/src/go-pkcs12 v0.7.0 // indirect
)

replace github.com/kurtserdar/captivo-access/tunnel => ../tunnel
