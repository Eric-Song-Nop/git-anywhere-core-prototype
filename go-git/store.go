package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/format/index"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/storage"
)

// Store is a bare go-git Storer split across immutable object storage and a
// transactional metadata authority. It intentionally does not expose pack,
// alternate, module, or whole-object iteration support in this prototype.
type Store struct {
	repoID   string
	objects  ObjectBackend
	metadata MetadataBackend

	mu       sync.Mutex
	snapshot MetadataSnapshot
}

// automaticMutationKeys prevents the ordinary Storer methods from reusing a
// persisted idempotency receipt after a Worker/runtime restart. The random
// namespace changes for every Go-WASM process; the counter only orders calls
// inside that process. Exported retryable operations still require a
// caller-owned stable key instead.
type automaticMutationKeys struct {
	once     sync.Once
	nonce    string
	nonceErr error
	sequence atomic.Uint64
	random   io.Reader
}

func (s *automaticMutationKeys) Next(kind string) (string, error) {
	s.once.Do(func() {
		if s.nonce != "" {
			return
		}
		reader := s.random
		if reader == nil {
			reader = rand.Reader
		}
		var nonce [16]byte
		if _, err := io.ReadFull(reader, nonce[:]); err != nil {
			s.nonceErr = fmt.Errorf("generate automatic mutation namespace: %w", err)
			return
		}
		s.nonce = hex.EncodeToString(nonce[:])
	})
	if s.nonceErr != nil {
		return "", s.nonceErr
	}
	return fmt.Sprintf("go-git:%s:%s:%d", kind, s.nonce, s.sequence.Add(1)), nil
}

var autoMutationKeys automaticMutationKeys

var _ storage.Storer = (*Store)(nil)

func OpenStore(repoID string, objects ObjectBackend, metadata MetadataBackend) (*Store, error) {
	if repoID == "" || objects == nil || metadata == nil {
		return nil, errors.New("repoID, object backend, and metadata backend are required")
	}
	snapshot, err := metadata.Snapshot(repoID)
	if err != nil {
		return nil, fmt.Errorf("snapshot metadata: %w", err)
	}
	if !snapshot.Exists {
		return nil, ErrRepositoryMissing
	}
	if err := validateSnapshot(snapshot); err != nil {
		return nil, err
	}
	return &Store{repoID: repoID, objects: objects, metadata: metadata, snapshot: cloneSnapshot(snapshot)}, nil
}

func validateSnapshot(snapshot MetadataSnapshot) error {
	if snapshot.Generation == "" {
		return errors.New("metadata snapshot has empty generation")
	}
	for name, value := range snapshot.Refs {
		refName := plumbing.ReferenceName(name)
		if err := refName.Validate(); err != nil {
			return fmt.Errorf("invalid persisted ref name %q: %w", name, err)
		}
		if refName == plumbing.HEAD || !plumbing.IsHash(value) {
			return fmt.Errorf("invalid persisted direct ref %q", name)
		}
	}
	if snapshot.Head != nil {
		if _, err := snapshot.Head.Reference(); err != nil {
			return err
		}
	}
	for _, hash := range snapshot.Shallow {
		if !plumbing.IsHash(hash) {
			return fmt.Errorf("invalid shallow hash %q", hash)
		}
	}
	return nil
}

func cloneSnapshot(in MetadataSnapshot) MetadataSnapshot {
	out := in
	out.Refs = make(map[string]string, len(in.Refs))
	for name, value := range in.Refs {
		out.Refs[name] = value
	}
	out.Config = append([]byte(nil), in.Config...)
	out.Shallow = append([]string(nil), in.Shallow...)
	return out
}

func (s *Store) NewEncodedObject() plumbing.EncodedObject { return &plumbing.MemoryObject{} }

func (s *Store) SetEncodedObject(object plumbing.EncodedObject) (plumbing.Hash, error) {
	if !validObjectType(object.Type()) || object.Size() < 0 {
		return plumbing.ZeroHash, fmt.Errorf("invalid encoded object type/size")
	}
	reader, err := object.Reader()
	if err != nil {
		return plumbing.ZeroHash, err
	}
	payload, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil {
		return plumbing.ZeroHash, readErr
	}
	if closeErr != nil {
		return plumbing.ZeroHash, closeErr
	}
	if int64(len(payload)) != object.Size() {
		return plumbing.ZeroHash, fmt.Errorf("object size mismatch: declared %d, read %d", object.Size(), len(payload))
	}
	hash := plumbing.ComputeHash(object.Type(), payload)
	if reported := object.Hash(); reported != hash {
		return plumbing.ZeroHash, fmt.Errorf("object hash mismatch: reported %s, computed %s", reported, hash)
	}
	envelope, err := encodeEnvelope(object.Type(), payload)
	if err != nil {
		return plumbing.ZeroHash, err
	}
	if err := s.objects.Put(s.repoID, hash.String(), envelope); err != nil {
		return plumbing.ZeroHash, fmt.Errorf("put object %s: %w", hash, err)
	}
	return hash, nil
}

func (s *Store) EncodedObject(want plumbing.ObjectType, hash plumbing.Hash) (plumbing.EncodedObject, error) {
	envelope, err := s.objects.Get(s.repoID, hash.String())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, plumbing.ErrObjectNotFound
		}
		return nil, fmt.Errorf("get object %s: %w", hash, err)
	}
	t, payload, err := decodeEnvelope(envelope)
	if err != nil {
		return nil, fmt.Errorf("decode object %s: %w", hash, err)
	}
	if want != plumbing.AnyObject && want != t {
		return nil, plumbing.ErrObjectNotFound
	}
	if actual := plumbing.ComputeHash(t, payload); actual != hash {
		return nil, fmt.Errorf("object %s failed content-address verification (got %s)", hash, actual)
	}
	object := &plumbing.MemoryObject{}
	object.SetType(t)
	object.SetSize(int64(len(payload)))
	if _, err := object.Write(payload); err != nil {
		return nil, err
	}
	return object, nil
}

func (s *Store) HasEncodedObject(hash plumbing.Hash) error {
	ok, err := s.objects.Exists(s.repoID, hash.String())
	if err != nil {
		return err
	}
	if !ok {
		return plumbing.ErrObjectNotFound
	}
	return nil
}

func (s *Store) EncodedObjectSize(hash plumbing.Hash) (int64, error) {
	object, err := s.EncodedObject(plumbing.AnyObject, hash)
	if err != nil {
		return 0, err
	}
	return object.Size(), nil
}

func (s *Store) IterEncodedObjects(plumbing.ObjectType) (storer.EncodedObjectIter, error) {
	return nil, fmt.Errorf("iterate objects: %w (object facade deliberately has no list operation)", ErrUnsupported)
}

func (s *Store) AddAlternate(string) error { return fmt.Errorf("alternates: %w", ErrUnsupported) }

func (s *Store) Reference(name plumbing.ReferenceName) (*plumbing.Reference, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == plumbing.HEAD {
		if s.snapshot.Head == nil {
			return nil, plumbing.ErrReferenceNotFound
		}
		return s.snapshot.Head.Reference()
	}
	value, ok := s.snapshot.Refs[name.String()]
	if !ok {
		return nil, plumbing.ErrReferenceNotFound
	}
	return plumbing.NewHashReference(name, plumbing.NewHash(value)), nil
}

func (s *Store) SetReference(ref *plumbing.Reference) error {
	if ref.Name() == plumbing.HEAD {
		head, err := headValue(ref)
		if err != nil {
			return err
		}
		return s.mutateRefs(nil, nil, &head, nil)
	}
	if ref.Type() != plumbing.HashReference {
		return fmt.Errorf("symbolic non-HEAD reference: %w", ErrUnsupported)
	}
	oid := ref.Hash().String()
	return s.mutateRefs(map[string]*string{ref.Name().String(): &oid}, nil, nil, nil)
}

func (s *Store) CheckAndSetReference(next, old *plumbing.Reference) error {
	if next.Name() == plumbing.HEAD {
		return fmt.Errorf("HEAD CheckAndSetReference: %w (revision CAS is used by atomic publication)", ErrUnsupported)
	}
	if next.Type() != plumbing.HashReference || (old != nil && old.Type() != plumbing.HashReference) {
		return fmt.Errorf("symbolic non-HEAD reference: %w", ErrUnsupported)
	}
	expected := map[string]*string{}
	if old != nil {
		if next.Name() != old.Name() {
			return errors.New("new and old references have different names")
		}
		oid := old.Hash().String()
		expected[next.Name().String()] = &oid
	}
	oid := next.Hash().String()
	err := s.mutateRefs(map[string]*string{next.Name().String(): &oid}, expected, nil, nil)
	if errors.Is(err, ErrConflict) {
		return storage.ErrReferenceHasChanged
	}
	return err
}

func (s *Store) RemoveReference(name plumbing.ReferenceName) error {
	if name == plumbing.HEAD {
		return fmt.Errorf("removing HEAD: %w", ErrUnsupported)
	}
	return s.mutateRefs(map[string]*string{name.String(): nil}, nil, nil, nil)
}

func (s *Store) IterReferences() (storer.ReferenceIter, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.snapshot.Refs))
	for name := range s.snapshot.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	refs := make([]*plumbing.Reference, 0, len(names)+1)
	if s.snapshot.Head != nil {
		head, err := s.snapshot.Head.Reference()
		if err != nil {
			return nil, err
		}
		refs = append(refs, head)
	}
	for _, name := range names {
		refs = append(refs, plumbing.NewHashReference(plumbing.ReferenceName(name), plumbing.NewHash(s.snapshot.Refs[name])))
	}
	return storer.NewReferenceSliceIter(refs), nil
}

func (s *Store) CountLooseRefs() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := len(s.snapshot.Refs)
	if s.snapshot.Head != nil {
		count++
	}
	return count, nil
}

func (s *Store) PackRefs() error { return nil }

// PublishReferences is the prototype's explicit atomic multi-ref primitive.
// go-git's ReferenceStorer interface only exposes one-ref CheckAndSetReference.
func (s *Store) PublishReferences(updates []*plumbing.Reference, expected []*plumbing.Reference, required []plumbing.Hash) error {
	refUpdates := make(map[string]*string, len(updates))
	var head *HeadValue
	for _, ref := range updates {
		if ref.Name() == plumbing.HEAD {
			value, err := headValue(ref)
			if err != nil {
				return err
			}
			head = &value
			continue
		}
		if ref.Type() != plumbing.HashReference {
			return fmt.Errorf("symbolic non-HEAD reference: %w", ErrUnsupported)
		}
		oid := ref.Hash().String()
		refUpdates[ref.Name().String()] = &oid
	}
	expectations := make(map[string]*string, len(expected))
	for _, ref := range expected {
		if ref.Name() == plumbing.HEAD {
			continue // generation+revision CAS fences the separate HEAD value.
		}
		oid := ref.Hash().String()
		expectations[ref.Name().String()] = &oid
	}
	requiredObjects := make([]string, 0, len(required))
	for _, hash := range required {
		requiredObjects = append(requiredObjects, hash.String())
	}
	return s.mutateRefs(refUpdates, expectations, head, requiredObjects)
}

func (s *Store) mutateRefs(updates, expected map[string]*string, head *HeadValue, required []string) error {
	idempotencyKey, err := autoMutationKeys.Next("refs")
	if err != nil {
		return err
	}
	requiredSet := make(map[string]struct{}, len(required)+len(updates)+1)
	for _, oid := range required {
		requiredSet[oid] = struct{}{}
	}
	for _, oid := range updates {
		if oid != nil {
			requiredSet[*oid] = struct{}{}
		}
	}
	if head != nil && head.Kind == "detached" {
		requiredSet[head.OID] = struct{}{}
	}
	required = required[:0]
	for oid := range requiredSet {
		hash := plumbing.NewHash(oid)
		if _, err := s.EncodedObject(plumbing.AnyObject, hash); err != nil {
			return fmt.Errorf("verify ref target %s: %w", oid, err)
		}
		required = append(required, oid)
	}
	sort.Strings(required)
	s.mu.Lock()
	defer s.mu.Unlock()
	mutation := MetadataMutation{
		IdempotencyKey:     idempotencyKey,
		ExpectedGeneration: s.snapshot.Generation,
		ExpectedRevision:   s.snapshot.Revision,
		ExpectedRefs:       expected,
		RefUpdates:         updates,
		Head:               head,
		RequiredObjects:    required,
	}
	setMutationDigest(&mutation)
	result, err := s.metadata.Commit(s.repoID, mutation)
	if err != nil {
		return err
	}
	if err := validateSnapshot(result.Snapshot); err != nil {
		return fmt.Errorf("invalid commit result: %w", err)
	}
	s.snapshot = cloneSnapshot(result.Snapshot)
	return nil
}

func setMutationDigest(mutation *MetadataMutation) {
	copy := *mutation
	copy.IdempotencyKey = ""
	copy.Digest = ""
	encoded, _ := json.Marshal(copy)
	digest := sha256.Sum256(encoded)
	mutation.Digest = hex.EncodeToString(digest[:])
}

func (s *Store) Config() (*config.Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	configuration := config.NewConfig()
	if len(s.snapshot.Config) == 0 {
		return configuration, nil
	}
	if err := configuration.Unmarshal(s.snapshot.Config); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return configuration, nil
}

func (s *Store) SetConfig(configuration *config.Config) error {
	if err := configuration.Validate(); err != nil {
		return err
	}
	encoded, err := configuration.Marshal()
	if err != nil {
		return err
	}
	idempotencyKey, err := autoMutationKeys.Next("config")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	mutation := MetadataMutation{IdempotencyKey: idempotencyKey, ExpectedGeneration: s.snapshot.Generation, ExpectedRevision: s.snapshot.Revision, Config: &encoded}
	setMutationDigest(&mutation)
	result, err := s.metadata.Commit(s.repoID, mutation)
	if err != nil {
		return err
	}
	s.snapshot = cloneSnapshot(result.Snapshot)
	return nil
}

func (s *Store) Shallow() ([]plumbing.Hash, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hashes := make([]plumbing.Hash, len(s.snapshot.Shallow))
	for i, value := range s.snapshot.Shallow {
		hashes[i] = plumbing.NewHash(value)
	}
	return hashes, nil
}

func (s *Store) SetShallow(hashes []plumbing.Hash) error {
	values := make([]string, len(hashes))
	for i, hash := range hashes {
		values[i] = hash.String()
	}
	idempotencyKey, err := autoMutationKeys.Next("shallow")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	mutation := MetadataMutation{IdempotencyKey: idempotencyKey, ExpectedGeneration: s.snapshot.Generation, ExpectedRevision: s.snapshot.Revision, Shallow: &values}
	setMutationDigest(&mutation)
	result, err := s.metadata.Commit(s.repoID, mutation)
	if err != nil {
		return err
	}
	s.snapshot = cloneSnapshot(result.Snapshot)
	return nil
}

func (s *Store) Index() (*index.Index, error) {
	return nil, fmt.Errorf("bare repository index: %w", ErrUnsupported)
}

func (s *Store) SetIndex(*index.Index) error {
	return fmt.Errorf("bare repository index: %w", ErrUnsupported)
}

func (s *Store) Module(string) (storage.Storer, error) {
	return nil, fmt.Errorf("submodules: %w", ErrUnsupported)
}

func rawObject(object plumbing.EncodedObject) ([]byte, error) {
	reader, err := object.Reader()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	var buffer bytes.Buffer
	_, err = io.Copy(&buffer, reader)
	return buffer.Bytes(), err
}
