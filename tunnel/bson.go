package tunnel

import (
	"encoding/binary"
	"errors"
	"math"
)

// A small BSON reader and writer for the MongoDB proxy: enough to read a
// command's name and a few fields out of a message, and to write the handful
// of documents the proxy and the connector send themselves. Values are never
// decoded further than that; nothing here builds a document tree.

var ErrBSON = errors.New("malformed BSON")

// BSON element types the code below names.
const (
	BSONDouble   = 0x01
	BSONString   = 0x02
	BSONDocument = 0x03
	BSONArray    = 0x04
	BSONBinary   = 0x05
	BSONBool     = 0x08
	BSONInt32    = 0x10
	BSONInt64    = 0x12
)

// BSONEach calls fn for each element of a document with its type, key and raw
// value bytes; fn returns false to stop. doc must be exactly one document.
func BSONEach(doc []byte, fn func(typ byte, key string, val []byte) bool) error {
	if len(doc) < 5 || int(binary.LittleEndian.Uint32(doc)) != len(doc) || doc[len(doc)-1] != 0 {
		return ErrBSON
	}
	b := doc[4 : len(doc)-1]
	for len(b) > 0 {
		typ := b[0]
		end := 1
		for end < len(b) && b[end] != 0 {
			end++
		}
		if end >= len(b) {
			return ErrBSON
		}
		key := string(b[1:end])
		b = b[end+1:]
		n, err := bsonValueSize(typ, b)
		if err != nil || n > len(b) {
			return ErrBSON
		}
		if !fn(typ, key, b[:n]) {
			return nil
		}
		b = b[n:]
	}
	return nil
}

func bsonValueSize(typ byte, b []byte) (int, error) {
	i32 := func() (int, error) {
		if len(b) < 4 {
			return 0, ErrBSON
		}
		return int(int32(binary.LittleEndian.Uint32(b))), nil
	}
	cstr := func(from int) (int, error) {
		for i := from; i < len(b); i++ {
			if b[i] == 0 {
				return i + 1, nil
			}
		}
		return 0, ErrBSON
	}
	switch typ {
	case 0x01, 0x09, 0x11, 0x12:
		return 8, nil
	case 0x02, 0x0d, 0x0e:
		n, err := i32()
		if err != nil || n < 1 {
			return 0, ErrBSON
		}
		return 4 + n, nil
	case 0x03, 0x04, 0x0f:
		n, err := i32()
		if err != nil || n < 5 {
			return 0, ErrBSON
		}
		return n, nil
	case 0x05:
		n, err := i32()
		if err != nil || n < 0 {
			return 0, ErrBSON
		}
		return 5 + n, nil
	case 0x06, 0x0a, 0x7f, 0xff:
		return 0, nil
	case 0x07:
		return 12, nil
	case 0x08:
		return 1, nil
	case 0x0b:
		i, err := cstr(0)
		if err != nil {
			return 0, err
		}
		return cstr(i)
	case 0x0c:
		n, err := i32()
		if err != nil || n < 1 {
			return 0, ErrBSON
		}
		return 4 + n + 12, nil
	case 0x10:
		return 4, nil
	case 0x13:
		return 16, nil
	}
	return 0, ErrBSON
}

// BSONString reads a string element's value.
func BSONStringValue(val []byte) (string, bool) {
	if len(val) < 5 {
		return "", false
	}
	n := int(int32(binary.LittleEndian.Uint32(val)))
	if n < 1 || 4+n > len(val) {
		return "", false
	}
	return string(val[4 : 4+n-1]), true
}

// BSONInt reads an int32, int64 or double element's value as an integer.
func BSONInt(typ byte, val []byte) (int64, bool) {
	switch {
	case typ == BSONInt32 && len(val) >= 4:
		return int64(int32(binary.LittleEndian.Uint32(val))), true
	case typ == BSONInt64 && len(val) >= 8:
		return int64(binary.LittleEndian.Uint64(val)), true
	case typ == BSONDouble && len(val) >= 8:
		return int64(math.Float64frombits(binary.LittleEndian.Uint64(val))), true
	}
	return 0, false
}

// BSONFirst returns the first element's key, type and value.
func BSONFirst(doc []byte) (key string, typ byte, val []byte, ok bool) {
	_ = BSONEach(doc, func(t byte, k string, v []byte) bool {
		key, typ, val, ok = k, t, v, true
		return false
	})
	return
}

// BSONGet returns the element named key.
func BSONGet(doc []byte, key string) (typ byte, val []byte, ok bool) {
	_ = BSONEach(doc, func(t byte, k string, v []byte) bool {
		if k == key {
			typ, val, ok = t, v, true
			return false
		}
		return true
	})
	return
}

// BSONCount counts the elements of an array or document value.
func BSONCount(val []byte) int {
	n := 0
	_ = BSONEach(val, func(byte, string, []byte) bool { n++; return true })
	return n
}

// BSONBinaryValue returns a binary element's bytes.
func BSONBinaryValue(val []byte) ([]byte, bool) {
	if len(val) < 5 {
		return nil, false
	}
	n := int(int32(binary.LittleEndian.Uint32(val)))
	if n < 0 || 5+n > len(val) {
		return nil, false
	}
	return val[5 : 5+n], true
}

// BSONElem is one element ready to be put in a document.
type BSONElem []byte

func bsonKey(typ byte, key string) []byte {
	return append(append([]byte{typ}, key...), 0)
}

func BSONStr(key, v string) BSONElem {
	b := bsonKey(BSONString, key)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(v)+1))
	return append(append(b, v...), 0)
}

func BSONInt32Elem(key string, v int32) BSONElem {
	return binary.LittleEndian.AppendUint32(bsonKey(BSONInt32, key), uint32(v))
}

func BSONInt64Elem(key string, v int64) BSONElem {
	return binary.LittleEndian.AppendUint64(bsonKey(BSONInt64, key), uint64(v))
}

func BSONDoubleElem(key string, v float64) BSONElem {
	return binary.LittleEndian.AppendUint64(bsonKey(BSONDouble, key), math.Float64bits(v))
}

func BSONBoolElem(key string, v bool) BSONElem {
	b := bsonKey(BSONBool, key)
	if v {
		return append(b, 1)
	}
	return append(b, 0)
}

func BSONBin(key string, v []byte) BSONElem {
	b := binary.LittleEndian.AppendUint32(bsonKey(BSONBinary, key), uint32(len(v)))
	return append(append(b, 0), v...)
}

func BSONDateTime(key string, ms int64) BSONElem {
	return binary.LittleEndian.AppendUint64(bsonKey(0x09, key), uint64(ms))
}

// BSONDoc is a document of the given elements.
func BSONDoc(elems ...BSONElem) []byte {
	n := 5
	for _, e := range elems {
		n += len(e)
	}
	b := binary.LittleEndian.AppendUint32(make([]byte, 0, n), uint32(n))
	for _, e := range elems {
		b = append(b, e...)
	}
	return append(b, 0)
}

// BSONSub is an embedded document element.
func BSONSub(key string, elems ...BSONElem) BSONElem {
	return append(bsonKey(BSONDocument, key), BSONDoc(elems...)...)
}

// BSONStrings is an array-of-strings element.
func BSONStrings(key string, vals ...string) BSONElem {
	elems := make([]BSONElem, len(vals))
	for i, v := range vals {
		elems[i] = BSONStr(itoa(i), v)
	}
	return append(bsonKey(BSONArray, key), BSONDoc(elems...)...)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	n := len(b)
	for ; i > 0; i /= 10 {
		n--
		b[n] = byte('0' + i%10)
	}
	return string(b[n:])
}
