package main

import "github.com/klauspost/compress/zstd"

// One encoder and one decoder for every chunk: both are safe for concurrent
// EncodeAll/DecodeAll. The default level compresses a guac stream about as well
// as the slowest gzip, at a fraction of the CPU.
var (
	zstdEncoder, _ = zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	// A chunk inflates to at most what the data plane flushes in one write
	// (256 KiB) plus the finalize path's own chunks; the cap only stops a
	// corrupt frame from asking for unbounded memory.
	zstdDecoder, _ = zstd.NewReader(nil, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(64<<20))
)
