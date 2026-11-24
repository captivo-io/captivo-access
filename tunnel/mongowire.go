package tunnel

import (
	"encoding/binary"
	"errors"
	"io"
)

// MongoDB wire protocol framing shared by the data plane's MongoDB proxy and
// the connector's sign-in: the message header, OP_MSG with one body section,
// and the legacy OP_QUERY / OP_REPLY pair drivers still open a connection with.

const (
	MongoOpReply      = 1
	MongoOpQuery      = 2004
	MongoOpCompressed = 2012
	MongoOpMsg        = 2013

	MongoMsgChecksum    = 1 << 0
	MongoMsgMoreToCome  = 1 << 1
	MongoMsgExhaustable = 1 << 16

	// MongoMaxMessage is the server's own limit (maxMessageSizeBytes).
	MongoMaxMessage = 48_000_000
)

var ErrMongoMsg = errors.New("malformed MongoDB message")

type MongoHeader struct {
	Len        int32
	RequestID  int32
	ResponseTo int32
	OpCode     int32
}

// ReadMongoHeader reads the 16 bytes that start every message.
func ReadMongoHeader(r io.Reader) (MongoHeader, error) {
	var b [16]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return MongoHeader{}, err
	}
	h := ParseMongoHeader(b[:])
	if h.Len < 16 || h.Len > MongoMaxMessage {
		return h, ErrMongoMsg
	}
	return h, nil
}

func ParseMongoHeader(b []byte) MongoHeader {
	return MongoHeader{
		Len:        int32(binary.LittleEndian.Uint32(b[0:])),
		RequestID:  int32(binary.LittleEndian.Uint32(b[4:])),
		ResponseTo: int32(binary.LittleEndian.Uint32(b[8:])),
		OpCode:     int32(binary.LittleEndian.Uint32(b[12:])),
	}
}

func (h MongoHeader) Bytes() []byte {
	b := make([]byte, 0, 16)
	b = binary.LittleEndian.AppendUint32(b, uint32(h.Len))
	b = binary.LittleEndian.AppendUint32(b, uint32(h.RequestID))
	b = binary.LittleEndian.AppendUint32(b, uint32(h.ResponseTo))
	return binary.LittleEndian.AppendUint32(b, uint32(h.OpCode))
}

// MongoMsg is an OP_MSG with the command document as its only section.
func MongoMsg(requestID, responseTo int32, flags uint32, doc []byte) []byte {
	h := MongoHeader{Len: int32(16 + 4 + 1 + len(doc)), RequestID: requestID, ResponseTo: responseTo, OpCode: MongoOpMsg}
	b := h.Bytes()
	b = binary.LittleEndian.AppendUint32(b, flags)
	b = append(b, 0)
	return append(b, doc...)
}

// MongoMsgBody returns the body document (the first kind-0 section) of an
// OP_MSG's bytes after its header, and its flags.
func MongoMsgBody(payload []byte) (doc []byte, flags uint32, err error) {
	if len(payload) < 5 {
		return nil, 0, ErrMongoMsg
	}
	flags = binary.LittleEndian.Uint32(payload)
	b := payload[4:]
	end := len(b)
	if flags&MongoMsgChecksum != 0 && end >= 4 {
		end -= 4
	}
	b = b[:end]
	for len(b) > 0 {
		kind := b[0]
		b = b[1:]
		switch kind {
		case 0:
			if len(b) < 4 {
				return nil, flags, ErrMongoMsg
			}
			n := int(binary.LittleEndian.Uint32(b))
			if n < 5 || n > len(b) {
				return nil, flags, ErrMongoMsg
			}
			return b[:n], flags, nil
		case 1:
			if len(b) < 4 {
				return nil, flags, ErrMongoMsg
			}
			n := int(binary.LittleEndian.Uint32(b))
			if n < 4 || n > len(b) {
				return nil, flags, ErrMongoMsg
			}
			b = b[n:]
		default:
			return nil, flags, ErrMongoMsg
		}
	}
	return nil, flags, ErrMongoMsg
}

// MongoReply is an OP_REPLY carrying one document (the answer to an OP_QUERY).
// failure sets the QueryFailure flag, which makes the document an error.
func MongoReply(requestID, responseTo int32, doc []byte, failure bool) []byte {
	h := MongoHeader{Len: int32(16 + 4 + 8 + 4 + 4 + len(doc)), RequestID: requestID, ResponseTo: responseTo, OpCode: MongoOpReply}
	b := h.Bytes()
	flags := uint32(8) // AwaitCapable
	if failure {
		flags = 2 // QueryFailure
	}
	b = binary.LittleEndian.AppendUint32(b, flags)
	b = binary.LittleEndian.AppendUint64(b, 0) // cursorID
	b = binary.LittleEndian.AppendUint32(b, 0) // startingFrom
	b = binary.LittleEndian.AppendUint32(b, 1) // numberReturned
	return append(b, doc...)
}

// MongoQueryDoc returns the collection name and query document of an
// OP_QUERY's bytes after its header.
func MongoQueryDoc(payload []byte) (coll string, doc []byte, err error) {
	if len(payload) < 4 {
		return "", nil, ErrMongoMsg
	}
	b := payload[4:]
	i := 0
	for i < len(b) && b[i] != 0 {
		i++
	}
	if i >= len(b) || len(b) < i+1+8+5 {
		return "", nil, ErrMongoMsg
	}
	coll = string(b[:i])
	b = b[i+1+8:] // numberToSkip, numberToReturn
	n := int(binary.LittleEndian.Uint32(b))
	if n < 5 || n > len(b) {
		return "", nil, ErrMongoMsg
	}
	return coll, b[:n], nil
}
