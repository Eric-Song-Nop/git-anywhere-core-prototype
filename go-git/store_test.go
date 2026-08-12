package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"testing"

	"github.com/go-git/go-git/v5/plumbing"
)

type memoryObjects struct {
	mu     sync.Mutex
	values map[string][]byte
}

func newMemoryObjects() *memoryObjects    { return &memoryObjects{values: make(map[string][]byte)} }
func objectKey(repoID, oid string) string { return repoID + "/" + oid }

func (m *memoryObjects) Put(repoID, oid string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := objectKey(repoID, oid)
	if prior, ok := m.values[key]; ok && !bytes.Equal(prior, value) {
		return ErrConflict
	}
	m.values[key] = append([]byte(nil), value...)
	return nil
}

func (m *memoryObjects) Get(repoID, oid string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	value, ok := m.values[objectKey(repoID, oid)]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), value...), nil
}

func (m *memoryObjects) Exists(repoID, oid string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.values[objectKey(repoID, oid)]
	return ok, nil
}

func (m *memoryObjects) Size(repoID, oid string) (int64, error) {
	value, err := m.Get(repoID, oid)
	return int64(len(value)), err
}

type memoryMetadata struct {
	mu         sync.Mutex
	objects    *memoryObjects
	snapshots  map[string]MetadataSnapshot
	replays    map[string]CommitResult
	digests    map[string]string
	generation uint64
}

func newMemoryMetadata(objects *memoryObjects) *memoryMetadata {
	return &memoryMetadata{objects: objects, snapshots: make(map[string]MetadataSnapshot), replays: make(map[string]CommitResult), digests: make(map[string]string)}
}

func (m *memoryMetadata) Snapshot(repoID string) (MetadataSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	snapshot, ok := m.snapshots[repoID]
	if !ok {
		return MetadataSnapshot{Exists: false}, nil
	}
	return cloneSnapshot(snapshot), nil
}

func (m *memoryMetadata) Initialize(repoID string, initial MetadataSnapshot) (MetadataSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.snapshots[repoID]; exists {
		return MetadataSnapshot{}, ErrConflict
	}
	m.generation++
	initial.Exists = true
	initial.Generation = fmt.Sprintf("generation-%d", m.generation)
	initial.Revision = 0
	initial = cloneSnapshot(initial)
	m.snapshots[repoID] = initial
	return cloneSnapshot(initial), nil
}

func (m *memoryMetadata) Commit(repoID string, mutation MetadataMutation) (CommitResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	replayKey := repoID + "/" + mutation.IdempotencyKey
	if prior, ok := m.replays[replayKey]; ok {
		if m.digests[replayKey] != mutation.Digest {
			return CommitResult{}, ErrConflict
		}
		prior.Replay = true
		return prior, nil
	}
	snapshot, ok := m.snapshots[repoID]
	if !ok || snapshot.Generation != mutation.ExpectedGeneration || snapshot.Revision != mutation.ExpectedRevision {
		return CommitResult{}, ErrConflict
	}
	for name, expected := range mutation.ExpectedRefs {
		actual, exists := snapshot.Refs[name]
		if expected == nil {
			if exists {
				return CommitResult{}, ErrConflict
			}
		} else if !exists || actual != *expected {
			return CommitResult{}, ErrConflict
		}
	}
	for _, oid := range mutation.RequiredObjects {
		if _, ok := m.objects.values[objectKey(repoID, oid)]; !ok {
			return CommitResult{}, fmt.Errorf("required object %s: %w", oid, ErrNotFound)
		}
	}
	for name, update := range mutation.RefUpdates {
		if update == nil {
			delete(snapshot.Refs, name)
		} else {
			snapshot.Refs[name] = *update
		}
	}
	if mutation.Head != nil {
		value := *mutation.Head
		snapshot.Head = &value
	}
	if mutation.Config != nil {
		snapshot.Config = append([]byte(nil), (*mutation.Config)...)
	}
	if mutation.Shallow != nil {
		snapshot.Shallow = append([]string(nil), (*mutation.Shallow)...)
	}
	snapshot.Revision++
	m.snapshots[repoID] = cloneSnapshot(snapshot)
	result := CommitResult{Snapshot: cloneSnapshot(snapshot)}
	m.replays[replayKey] = result
	m.digests[replayKey] = mutation.Digest
	return result, nil
}

func TestDeterministicCommitPersistsAcrossOpen(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	proof, err := handle.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:first-commit", nil)
	if err != nil {
		t.Fatal(err)
	}
	if proof.CommitOID != "894cc886e0bf70ba8f6f35e0f3750778e070ca50" {
		t.Fatalf("unexpected deterministic commit OID %s", proof.CommitOID)
	}
	if proof.Revision != 1 || proof.Generation != "generation-1" {
		t.Fatalf("unexpected publication fence: %+v", proof)
	}

	reopened, err := OpenRepository("repo", objects, metadata)
	if err != nil {
		t.Fatal(err)
	}
	state, err := reopened.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	if state.ResolvedHEAD != proof.CommitOID || len(state.Objects) != 3 {
		t.Fatalf("unexpected reopened state: %+v", state)
	}
	if reopened.Store.snapshot.Head == nil || *reopened.Store.snapshot.Head != (HeadValue{Kind: "symbolic", Target: "refs/heads/main"}) {
		t.Fatalf("unexpected HEAD: %+v", reopened.Store.snapshot.Head)
	}
}

func TestStaleMetadataSnapshotCannotPublish(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	first, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	stale, err := OpenRepository("repo", objects, metadata)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := first.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:first-commit", nil)
	if err != nil {
		t.Fatal(err)
	}
	err = stale.Store.SetReference(plumbing.NewHashReference(plumbing.NewBranchReferenceName("other"), plumbing.NewHash(proof.CommitOID)))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want metadata conflict, got %v", err)
	}
}

func TestNilOldReferenceIsUnconditionalAndTargetMustExist(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	writeBlob := func(content string) plumbing.Hash {
		t.Helper()
		object := &plumbing.MemoryObject{}
		object.SetType(plumbing.BlobObject)
		object.SetSize(int64(len(content)))
		if _, err := object.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		hash, err := handle.Store.SetEncodedObject(object)
		if err != nil {
			t.Fatal(err)
		}
		return hash
	}
	main := plumbing.NewBranchReferenceName("main")
	first := writeBlob("first")
	second := writeBlob("second")
	if err := handle.Store.SetReference(plumbing.NewHashReference(main, first)); err != nil {
		t.Fatal(err)
	}
	if err := handle.Store.CheckAndSetReference(plumbing.NewHashReference(main, second), nil); err != nil {
		t.Fatalf("nil old reference must perform an unconditional update: %v", err)
	}
	actual, err := handle.Store.Reference(main)
	if err != nil {
		t.Fatal(err)
	}
	if actual.Hash() != second {
		t.Fatalf("unconditional update stored %s, want %s", actual.Hash(), second)
	}

	missing := plumbing.NewHash("3333333333333333333333333333333333333333")
	revision := handle.Store.snapshot.Revision
	err = handle.Store.SetReference(plumbing.NewHashReference(plumbing.NewBranchReferenceName("missing"), missing))
	if !errors.Is(err, plumbing.ErrObjectNotFound) {
		t.Fatalf("missing ref target must be refused, got %v", err)
	}
	if handle.Store.snapshot.Revision != revision {
		t.Fatalf("missing target advanced metadata revision to %d", handle.Store.snapshot.Revision)
	}
}

func TestCreateCommitRetryReplaysOriginalReceipt(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	expectation := &CommitExpectation{Generation: handle.Store.snapshot.Generation, Revision: handle.Store.snapshot.Revision, BranchOID: nil}
	first, err := handle.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:retryable-commit", expectation)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRepository("repo", objects, metadata)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := reopened.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:retryable-commit", expectation)
	if err != nil {
		t.Fatal(err)
	}
	if replayed != first {
		t.Fatalf("replayed receipt changed: first=%+v replay=%+v", first, replayed)
	}
	state, err := metadata.Snapshot("repo")
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != 1 {
		t.Fatalf("retry performed another metadata commit, revision=%d", state.Revision)
	}
}

func TestAutomaticMutationKeysDoNotCollideAcrossProcessRestart(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	initial := MetadataSnapshot{Exists: true, Refs: map[string]string{}, Head: &HeadValue{Kind: "symbolic", Target: "refs/heads/main"}}
	firstSnapshot, err := metadata.Initialize("repo", initial)
	if err != nil {
		t.Fatal(err)
	}

	firstProcess := automaticMutationKeys{nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	secondProcess := automaticMutationKeys{nonce: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	firstKey, err := firstProcess.Next("refs")
	if err != nil {
		t.Fatal(err)
	}
	secondKey, err := secondProcess.Next("refs")
	if err != nil {
		t.Fatal(err)
	}
	if firstKey == secondKey {
		t.Fatalf("independent process namespaces reused %q", firstKey)
	}

	firstOID := plumbing.NewHash("1111111111111111111111111111111111111111").String()
	firstMutation := MetadataMutation{
		IdempotencyKey: firstKey, ExpectedGeneration: firstSnapshot.Generation,
		ExpectedRevision: 0, RefUpdates: map[string]*string{"refs/heads/first": &firstOID},
	}
	setMutationDigest(&firstMutation)
	firstResult, err := metadata.Commit("repo", firstMutation)
	if err != nil {
		t.Fatal(err)
	}

	secondOID := plumbing.NewHash("2222222222222222222222222222222222222222").String()
	secondMutation := MetadataMutation{
		IdempotencyKey: secondKey, ExpectedGeneration: firstSnapshot.Generation,
		ExpectedRevision: firstResult.Snapshot.Revision,
		RefUpdates:       map[string]*string{"refs/heads/second": &secondOID},
	}
	setMutationDigest(&secondMutation)
	secondResult, err := metadata.Commit("repo", secondMutation)
	if err != nil {
		t.Fatalf("new process auto key collided with persisted receipt: %v", err)
	}
	if secondResult.Snapshot.Revision != 2 {
		t.Fatalf("second process mutation was not published: %+v", secondResult.Snapshot)
	}
}

func TestInitDoesNotReplaceExistingRepository(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	if _, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main")); err != nil {
		t.Fatal(err)
	}
	if _, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("other")); !errors.Is(err, ErrConflict) {
		t.Fatalf("want existing repository conflict, got %v", err)
	}
	snapshot, err := metadata.Snapshot("repo")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Head == nil || snapshot.Head.Target != "refs/heads/main" {
		t.Fatalf("second init replaced existing HEAD: %+v", snapshot.Head)
	}
}

func TestObjectEnvelopeCorruptionIsDetected(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	proof, err := handle.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:first-commit", nil)
	if err != nil {
		t.Fatal(err)
	}
	objects.mu.Lock()
	value := objects.values[objectKey("repo", proof.CommitOID)]
	value[len(value)-1] ^= 1
	objects.mu.Unlock()
	_, err = handle.Store.EncodedObject(plumbing.CommitObject, plumbing.NewHash(proof.CommitOID))
	if err == nil {
		t.Fatal("corrupted content-addressed object unexpectedly passed")
	}
}

func TestObjectIterationAndModulesAreExplicitlyDeferred(t *testing.T) {
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Store.IterEncodedObjects(plumbing.AnyObject); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("want unsupported iteration, got %v", err)
	}
	if _, err := handle.Store.Module("module"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("want unsupported module, got %v", err)
	}
}

func TestCanonicalGitAcceptsExport(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("canonical Git is not installed")
	}
	objects := newMemoryObjects()
	metadata := newMemoryMetadata(objects)
	handle, err := InitRepository("repo", objects, metadata, plumbing.NewBranchReferenceName("main"))
	if err != nil {
		t.Fatal(err)
	}
	proof, err := handle.CreateDeterministicCommit(plumbing.NewBranchReferenceName("main"), "test:canonical-oracle", nil)
	if err != nil {
		t.Fatal(err)
	}
	state, err := handle.ReadState()
	if err != nil {
		t.Fatal(err)
	}
	gitDir := t.TempDir()
	runGit := func(input []byte, args ...string) string {
		t.Helper()
		command := exec.Command(gitPath, append([]string{"--git-dir=" + gitDir}, args...)...)
		command.Stdin = bytes.NewReader(input)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, output)
		}
		return string(bytes.TrimSpace(output))
	}
	if output, err := exec.Command(gitPath, "init", "--bare", gitDir).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, output)
	}
	for _, exported := range state.Objects {
		payload, err := base64.StdEncoding.DecodeString(exported.Base64)
		if err != nil {
			t.Fatal(err)
		}
		if oid := runGit(payload, "hash-object", "-w", "-t", exported.Type, "--stdin"); oid != exported.OID {
			t.Fatalf("canonical Git OID mismatch for %s: got %s", exported.OID, oid)
		}
	}
	runGit(nil, "update-ref", "refs/heads/main", proof.CommitOID)
	runGit(nil, "symbolic-ref", "HEAD", "refs/heads/main")
	runGit(nil, "fsck", "--full", "--strict")
}
