//go:build js && wasm

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"syscall/js"

	"github.com/go-git/go-git/v5/plumbing"
)

type jsObjectBackend struct{ value js.Value }

func globalBackend(name string) (js.Value, error) {
	value := js.Global().Get(name)
	if value.Type() == js.TypeUndefined || value.Type() == js.TypeNull {
		return js.Value{}, fmt.Errorf("globalThis.%s is not installed", name)
	}
	return value, nil
}

func (b jsObjectBackend) Put(repoID, oid string, value []byte) error {
	array := js.Global().Get("Uint8Array").New(len(value))
	js.CopyBytesToJS(array, value)
	_, err := awaitPromise(b.value.Call("put", objectPath(repoID, oid), array))
	return err
}

func (b jsObjectBackend) Get(repoID, oid string) ([]byte, error) {
	value, err := awaitPromise(b.value.Call("get", objectPath(repoID, oid)))
	if err != nil {
		return nil, mapJSError(err)
	}
	bytes := make([]byte, value.Get("byteLength").Int())
	js.CopyBytesToGo(bytes, value)
	return bytes, nil
}

func (b jsObjectBackend) Exists(repoID, oid string) (bool, error) {
	value, err := awaitPromise(b.value.Call("exists", objectPath(repoID, oid)))
	if err != nil {
		return false, mapJSError(err)
	}
	return value.Bool(), nil
}

func (b jsObjectBackend) Size(repoID, oid string) (int64, error) {
	value, err := awaitPromise(b.value.Call("size", objectPath(repoID, oid)))
	if err != nil {
		return 0, mapJSError(err)
	}
	return int64(value.Float()), nil
}

// Rust facade accepts a single root-relative path; repository isolation is a
// validated path prefix rather than separate JS parameters.
var repoIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func objectPath(repoID, oid string) string {
	if !repoIDPattern.MatchString(repoID) || !plumbing.IsHash(oid) {
		panic("invalid repository ID or object ID after command validation")
	}
	return "repos/" + repoID + "/objects/" + oid
}

type jsMetadataBackend struct{ value js.Value }

func (b jsMetadataBackend) Snapshot(repoID string) (MetadataSnapshot, error) {
	value, err := awaitPromise(b.value.Call("snapshot", repoID))
	if err != nil {
		if jsErrorCode(err) == "REPOSITORY_NOT_FOUND" {
			return MetadataSnapshot{Exists: false}, nil
		}
		return MetadataSnapshot{}, mapJSError(err)
	}
	return snapshotFromJS(value)
}

func (b jsMetadataBackend) Initialize(repoID string, initial MetadataSnapshot) (MetadataSnapshot, error) {
	value, err := awaitPromise(b.value.Call("initialize", repoID, snapshotToJS(initial)))
	if err != nil {
		return MetadataSnapshot{}, mapJSError(err)
	}
	return snapshotFromJS(value)
}

func (b jsMetadataBackend) Commit(repoID string, mutation MetadataMutation) (CommitResult, error) {
	value, err := awaitPromise(b.value.Call("commit", repoID, mutationToJS(mutation)))
	if err != nil {
		return CommitResult{}, mapJSError(err)
	}
	snapshot, err := snapshotFromJS(value.Get("state"))
	return CommitResult{Snapshot: snapshot}, err
}

func snapshotToJS(snapshot MetadataSnapshot) js.Value {
	config := map[string]any{}
	if len(snapshot.Config) == 0 {
		config = map[string]any{}
	} else {
		config = map[string]any{"goGitConfigBase64": base64.StdEncoding.EncodeToString(snapshot.Config)}
	}
	wire := map[string]any{
		"refs": snapshot.Refs, "head": snapshot.Head, "config": config, "shallow": snapshot.Shallow,
	}
	return js.Global().Get("JSON").Call("parse", mustJSON(wire))
}

func snapshotFromJS(value js.Value) (MetadataSnapshot, error) {
	if value.Type() == js.TypeUndefined || value.Type() == js.TypeNull {
		return MetadataSnapshot{}, ErrRepositoryMissing
	}
	snapshot := MetadataSnapshot{Exists: true, Generation: value.Get("generation").String(), Revision: uint64(value.Get("revision").Float()), Refs: map[string]string{}}
	jsonText := js.Global().Get("JSON").Call("stringify", value).String()
	var wire struct {
		Refs    map[string]string `json:"refs"`
		Head    *HeadValue        `json:"head"`
		Config  map[string]any    `json:"config"`
		Shallow []string          `json:"shallow"`
	}
	if err := json.Unmarshal([]byte(jsonText), &wire); err != nil {
		return MetadataSnapshot{}, err
	}
	snapshot.Refs, snapshot.Head, snapshot.Shallow = wire.Refs, wire.Head, wire.Shallow
	if encoded, ok := wire.Config["goGitConfigBase64"].(string); ok {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return MetadataSnapshot{}, err
		}
		snapshot.Config = decoded
	}
	return snapshot, nil
}

func mutationToJS(m MetadataMutation) js.Value {
	expectedRefs := m.ExpectedRefs
	if expectedRefs == nil {
		expectedRefs = map[string]*string{}
	}
	requiredObjects := m.RequiredObjects
	if requiredObjects == nil {
		requiredObjects = []string{}
	}
	wire := map[string]any{
		"idempotencyKey": m.IdempotencyKey, "digest": m.Digest,
		"expectedGeneration": m.ExpectedGeneration, "expectedRevision": m.ExpectedRevision,
		"expectedRefs": expectedRefs, "requiredObjects": requiredObjects,
	}
	updates := map[string]any{}
	if m.RefUpdates != nil {
		updates["refs"] = m.RefUpdates
	}
	if m.Head != nil {
		updates["head"] = m.Head
	}
	if m.Config != nil {
		updates["config"] = map[string]any{"goGitConfigBase64": base64.StdEncoding.EncodeToString(*m.Config)}
	}
	if m.Shallow != nil {
		updates["shallow"] = *m.Shallow
	}
	wire["updates"] = updates
	return js.Global().Get("JSON").Call("parse", mustJSON(wire))
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

type promiseResult struct {
	value js.Value
	err   error
}

// awaitPromise is safe only from a Go goroutine entered after the exported JS
// callback has returned. Awaiting inside a blocking syscall/js callback would
// deadlock the JS event loop.
func awaitPromise(promise js.Value) (js.Value, error) {
	result := make(chan promiseResult, 1)
	resolve := js.FuncOf(func(_ js.Value, args []js.Value) any {
		result <- promiseResult{value: args[0]}
		return nil
	})
	reject := js.FuncOf(func(_ js.Value, args []js.Value) any {
		result <- promiseResult{err: jsValueError{value: args[0]}}
		return nil
	})
	promise.Call("then", resolve).Call("catch", reject)
	out := <-result
	resolve.Release()
	reject.Release()
	return out.value, out.err
}

type jsValueError struct{ value js.Value }

func (e jsValueError) Error() string {
	message := e.value.Get("message")
	if message.Type() == js.TypeString {
		return message.String()
	}
	return e.value.String()
}

func jsErrorCode(err error) string {
	var jsErr jsValueError
	if errors.As(err, &jsErr) {
		code := jsErr.value.Get("code")
		if code.Type() == js.TypeString {
			return code.String()
		}
	}
	return ""
}

func mapJSError(err error) error {
	switch jsErrorCode(err) {
	case "NotFound", "NOT_FOUND":
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case "ImmutableConflict", "REPOSITORY_EXISTS", "GENERATION_CONFLICT", "REVISION_CONFLICT", "REF_CONFLICT", "IDEMPOTENCY_KEY_REUSED":
		return fmt.Errorf("%w: %v", ErrConflict, err)
	default:
		return err
	}
}
