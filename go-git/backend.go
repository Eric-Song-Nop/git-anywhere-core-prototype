package main

import (
	"errors"
	"fmt"

	"github.com/go-git/go-git/v5/plumbing"
)

var (
	ErrNotFound          = errors.New("not found")
	ErrConflict          = errors.New("metadata conflict")
	ErrUnsupported       = errors.New("operation is outside prototype coverage")
	ErrRepositoryMissing = errors.New("repository metadata is missing")
)

// ObjectBackend is the narrow immutable-object boundary implemented by the
// OpenDAL WASM facade. Values are complete, versioned object envelopes.
type ObjectBackend interface {
	Put(repoID, oid string, value []byte) error
	Get(repoID, oid string) ([]byte, error)
	Exists(repoID, oid string) (bool, error)
	Size(repoID, oid string) (int64, error)
}

// HeadValue mirrors the metadata contract's separate HEAD field. Direct refs
// are deliberately hashes only; symbolic non-HEAD refs are deferred.
type HeadValue struct {
	Kind   string `json:"kind"`
	Target string `json:"target,omitempty"`
	OID    string `json:"oid,omitempty"`
}

func headValue(ref *plumbing.Reference) (HeadValue, error) {
	if ref.Name() != plumbing.HEAD {
		return HeadValue{}, errors.New("headValue requires HEAD")
	}
	if ref.Type() == plumbing.SymbolicReference {
		return HeadValue{Kind: "symbolic", Target: ref.Target().String()}, nil
	}
	return HeadValue{Kind: "detached", OID: ref.Hash().String()}, nil
}

func (v HeadValue) Reference() (*plumbing.Reference, error) {
	switch v.Kind {
	case "symbolic":
		target := plumbing.ReferenceName(v.Target)
		if err := target.Validate(); err != nil {
			return nil, fmt.Errorf("invalid symbolic HEAD target: %w", err)
		}
		return plumbing.NewSymbolicReference(plumbing.HEAD, target), nil
	case "detached":
		if !plumbing.IsHash(v.OID) {
			return nil, errors.New("invalid detached HEAD OID")
		}
		return plumbing.NewHashReference(plumbing.HEAD, plumbing.NewHash(v.OID)), nil
	default:
		return nil, fmt.Errorf("invalid HEAD kind %q", v.Kind)
	}
}

type MetadataSnapshot struct {
	Exists     bool
	Generation string
	Revision   uint64
	Refs       map[string]string
	Head       *HeadValue
	Config     []byte
	Shallow    []string
}

type MetadataMutation struct {
	IdempotencyKey     string
	Digest             string
	ExpectedGeneration string
	ExpectedRevision   uint64
	ExpectedRefs       map[string]*string // nil value means absent.
	RefUpdates         map[string]*string // nil value deletes.
	Head               *HeadValue
	RequiredObjects    []string
	Config             *[]byte
	Shallow            *[]string
}

type CommitResult struct {
	Snapshot MetadataSnapshot
	Replay   bool
}

// MetadataBackend is a generation- and revision-fenced transactional metadata
// authority. Initialize creates a fresh generation. Commit atomically checks
// all expectations and applies every update.
type MetadataBackend interface {
	Snapshot(repoID string) (MetadataSnapshot, error)
	Initialize(repoID string, initial MetadataSnapshot) (MetadataSnapshot, error)
	Commit(repoID string, mutation MetadataMutation) (CommitResult, error)
}
