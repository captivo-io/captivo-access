package main

import "testing"

func TestReadHostInfo(t *testing.T) {
	h := readHostInfo(`"Ubuntu 24.04.1 LTS"`, "10.0.5.12 172.17.0.1 fd00::1 ")
	if h.os != "Ubuntu 24.04.1 LTS" || h.localIP != "10.0.5.12" {
		t.Fatalf("got %+v", h)
	}
}

func TestReadHostInfoRejectsJunk(t *testing.T) {
	if h := readHostInfo("", "not-an-ip"); h.localIP != "" || h.os != "" {
		t.Fatalf("junk accepted: %+v", h)
	}
}

func TestContainerIDHostnameIsNotReported(t *testing.T) {
	if !containerID.MatchString("3f9a2c1b7d0e") || containerID.MatchString("dc-gw-01") {
		t.Fatal("container id pattern wrong")
	}
}
