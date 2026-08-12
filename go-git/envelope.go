package main

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/go-git/go-git/v5/plumbing"
)

var envelopeMagic = []byte{'G', 'A', 'O', '1'}

func encodeEnvelope(t plumbing.ObjectType, payload []byte) ([]byte, error) {
	if !validObjectType(t) {
		return nil, fmt.Errorf("unsupported object type %s", t)
	}
	buf := make([]byte, 0, len(envelopeMagic)+2+binary.MaxVarintLen64+len(payload))
	buf = append(buf, envelopeMagic...)
	buf = append(buf, byte(t))
	buf = binary.AppendUvarint(buf, uint64(len(payload)))
	buf = append(buf, payload...)
	return buf, nil
}

func decodeEnvelope(data []byte) (plumbing.ObjectType, []byte, error) {
	if len(data) < len(envelopeMagic)+2 || !bytes.Equal(data[:len(envelopeMagic)], envelopeMagic) {
		return plumbing.InvalidObject, nil, errorsf("invalid object envelope magic")
	}
	t := plumbing.ObjectType(data[len(envelopeMagic)])
	if !validObjectType(t) {
		return plumbing.InvalidObject, nil, errorsf("invalid object type %d", t)
	}
	sz, n := binary.Uvarint(data[len(envelopeMagic)+1:])
	if n <= 0 {
		return plumbing.InvalidObject, nil, errorsf("invalid object envelope length")
	}
	payload := data[len(envelopeMagic)+1+n:]
	if uint64(len(payload)) != sz {
		return plumbing.InvalidObject, nil, errorsf("object envelope length mismatch")
	}
	return t, append([]byte(nil), payload...), nil
}

func validObjectType(t plumbing.ObjectType) bool {
	return t == plumbing.CommitObject || t == plumbing.TreeObject || t == plumbing.BlobObject || t == plumbing.TagObject
}

func errorsf(format string, args ...any) error { return fmt.Errorf(format, args...) }
