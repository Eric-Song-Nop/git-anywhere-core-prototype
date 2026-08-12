package main

import (
	"encoding/base64"
	"fmt"
	"sort"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/storage/memory"
)

const (
	deterministicFile    = "proof.txt"
	deterministicContent = "git-anywhere core proof\n"
	deterministicMessage = "deterministic browser storage proof\n"
)

var deterministicTime = time.Date(2026, time.August, 12, 0, 0, 0, 0, time.UTC)

type RepositoryHandle struct {
	Repository *git.Repository
	Store      *Store
}

func InitRepository(repoID string, objects ObjectBackend, metadata MetadataBackend, branch plumbing.ReferenceName) (*RepositoryHandle, error) {
	if branch == "" {
		branch = plumbing.NewBranchReferenceName("main")
	}
	if err := branch.Validate(); err != nil {
		return nil, err
	}
	existing, err := metadata.Snapshot(repoID)
	if err != nil {
		return nil, fmt.Errorf("preflight metadata snapshot: %w", err)
	}
	if existing.Exists {
		return nil, fmt.Errorf("repository %q already exists: %w", repoID, ErrConflict)
	}
	// Exercise go-git's bare initialization logic in an ephemeral staging
	// storer, then publish the derived initial state atomically as generation 1.
	staging := memory.NewStorage()
	if _, err := git.InitWithOptions(staging, nil, git.InitOptions{DefaultBranch: branch}); err != nil {
		return nil, fmt.Errorf("go-git init staging state: %w", err)
	}
	configuration, err := staging.Config()
	if err != nil {
		return nil, err
	}
	configBytes, err := configuration.Marshal()
	if err != nil {
		return nil, err
	}
	refs, head, err := collectRefs(staging)
	if err != nil {
		return nil, err
	}
	initial := MetadataSnapshot{Exists: true, Refs: refs, Head: head, Config: configBytes, Shallow: []string{}}
	if _, err := metadata.Initialize(repoID, initial); err != nil {
		return nil, fmt.Errorf("initialize metadata: %w", err)
	}
	return OpenRepository(repoID, objects, metadata)
}

func OpenRepository(repoID string, objects ObjectBackend, metadata MetadataBackend) (*RepositoryHandle, error) {
	store, err := OpenStore(repoID, objects, metadata)
	if err != nil {
		return nil, err
	}
	repository, err := git.Open(store, nil)
	if err != nil {
		return nil, fmt.Errorf("go-git open: %w", err)
	}
	return &RepositoryHandle{Repository: repository, Store: store}, nil
}

func collectRefs(source storer.ReferenceStorer) (map[string]string, *HeadValue, error) {
	iter, err := source.IterReferences()
	if err != nil {
		return nil, nil, err
	}
	refs := make(map[string]string)
	var head *HeadValue
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		if ref.Name() == plumbing.HEAD {
			value, err := headValue(ref)
			if err != nil {
				return err
			}
			head = &value
			return nil
		}
		if ref.Type() != plumbing.HashReference {
			return fmt.Errorf("symbolic non-HEAD reference: %w", ErrUnsupported)
		}
		refs[ref.Name().String()] = ref.Hash().String()
		return nil
	})
	return refs, head, err
}

type CommitProof struct {
	BlobOID    string `json:"blobOid"`
	TreeOID    string `json:"treeOid"`
	CommitOID  string `json:"commitOid"`
	Revision   uint64 `json:"revision"`
	Generation string `json:"generation"`
}

type CommitExpectation struct {
	Generation string
	Revision   uint64
	BranchOID  *string // nil means branch must be absent.
}

func (h *RepositoryHandle) CreateDeterministicCommit(branch plumbing.ReferenceName, idempotencyKey string, expected *CommitExpectation) (CommitProof, error) {
	if branch == "" {
		branch = plumbing.NewBranchReferenceName("main")
	}
	blob := &plumbing.MemoryObject{}
	blob.SetType(plumbing.BlobObject)
	blob.SetSize(int64(len(deterministicContent)))
	if _, err := blob.Write([]byte(deterministicContent)); err != nil {
		return CommitProof{}, err
	}
	blobHash, err := h.Store.SetEncodedObject(blob)
	if err != nil {
		return CommitProof{}, err
	}

	tree := &object.Tree{Entries: []object.TreeEntry{{Name: deterministicFile, Mode: filemode.Regular, Hash: blobHash}}}
	treeObject := h.Store.NewEncodedObject()
	if err := tree.Encode(treeObject); err != nil {
		return CommitProof{}, err
	}
	treeHash, err := h.Store.SetEncodedObject(treeObject)
	if err != nil {
		return CommitProof{}, err
	}

	signature := object.Signature{Name: "Git Anywhere", Email: "proof@example.invalid", When: deterministicTime}
	commit := &object.Commit{Author: signature, Committer: signature, Message: deterministicMessage, TreeHash: treeHash}
	commitObject := h.Store.NewEncodedObject()
	if err := commit.Encode(commitObject); err != nil {
		return CommitProof{}, err
	}
	commitHash, err := h.Store.SetEncodedObject(commitObject)
	if err != nil {
		return CommitProof{}, err
	}

	nextBranch := plumbing.NewHashReference(branch, commitHash)
	nextHEAD := plumbing.NewSymbolicReference(plumbing.HEAD, branch)
	h.Store.mu.Lock()
	currentBranch, branchExists := h.Store.snapshot.Refs[branch.String()]
	expectations := map[string]*string{branch.String(): nil}
	expectedGeneration := h.Store.snapshot.Generation
	expectedRevision := h.Store.snapshot.Revision
	if branchExists {
		value := currentBranch
		expectations[branch.String()] = &value
	}
	if expected != nil {
		expectedGeneration = expected.Generation
		expectedRevision = expected.Revision
		expectations[branch.String()] = expected.BranchOID
	}
	branchOID := nextBranch.Hash().String()
	head, _ := headValue(nextHEAD)
	mutation := MetadataMutation{
		IdempotencyKey:     idempotencyKey,
		ExpectedGeneration: expectedGeneration,
		ExpectedRevision:   expectedRevision,
		ExpectedRefs:       expectations,
		RefUpdates:         map[string]*string{branch.String(): &branchOID},
		Head:               &head,
		RequiredObjects:    []string{blobHash.String(), treeHash.String(), commitHash.String()},
	}
	setMutationDigest(&mutation)
	result, err := h.Store.metadata.Commit(h.Store.repoID, mutation)
	if err == nil {
		h.Store.snapshot = cloneSnapshot(result.Snapshot)
	}
	h.Store.mu.Unlock()
	if err != nil {
		return CommitProof{}, fmt.Errorf("atomic publish branch and HEAD: %w", err)
	}
	return CommitProof{
		BlobOID: blobHash.String(), TreeOID: treeHash.String(), CommitOID: commitHash.String(),
		Revision: result.Snapshot.Revision, Generation: result.Snapshot.Generation,
	}, nil
}

type ExportObject struct {
	Type   string `json:"type"`
	OID    string `json:"oid"`
	Base64 string `json:"base64"`
}

type RepositoryState struct {
	Generation   string            `json:"generation"`
	Revision     uint64            `json:"revision"`
	Head         *HeadValue        `json:"head"`
	ResolvedHEAD string            `json:"resolvedHeadOid,omitempty"`
	Refs         map[string]string `json:"refs"`
	Objects      []ExportObject    `json:"objects"`
}

func (h *RepositoryHandle) ReadMetadataState() (RepositoryState, error) {
	h.Store.mu.Lock()
	snapshot := cloneSnapshot(h.Store.snapshot)
	h.Store.mu.Unlock()
	state := RepositoryState{Generation: snapshot.Generation, Revision: snapshot.Revision, Head: snapshot.Head, Refs: snapshot.Refs, Objects: []ExportObject{}}
	if head, err := h.Repository.Head(); err == nil {
		state.ResolvedHEAD = head.Hash().String()
	} else if err != plumbing.ErrReferenceNotFound {
		return RepositoryState{}, err
	}
	return state, nil
}

// ReadState exports every object reachable from HEAD as raw Git payload bytes,
// suitable for a canonical `git hash-object -w -t TYPE --stdin` oracle.
func (h *RepositoryHandle) ReadState() (RepositoryState, error) {
	h.Store.mu.Lock()
	snapshot := cloneSnapshot(h.Store.snapshot)
	h.Store.mu.Unlock()
	head, err := h.Repository.Head()
	if err != nil {
		return RepositoryState{}, err
	}
	state := RepositoryState{Generation: snapshot.Generation, Revision: snapshot.Revision, Head: snapshot.Head, ResolvedHEAD: head.Hash().String(), Refs: snapshot.Refs}
	seen := make(map[plumbing.Hash]struct{})
	var visit func(plumbing.ObjectType, plumbing.Hash) error
	visit = func(t plumbing.ObjectType, hash plumbing.Hash) error {
		if _, ok := seen[hash]; ok {
			return nil
		}
		encoded, err := h.Store.EncodedObject(t, hash)
		if err != nil {
			return err
		}
		payload, err := rawObject(encoded)
		if err != nil {
			return err
		}
		seen[hash] = struct{}{}
		state.Objects = append(state.Objects, ExportObject{Type: t.String(), OID: hash.String(), Base64: base64.StdEncoding.EncodeToString(payload)})
		switch t {
		case plumbing.CommitObject:
			commit, err := object.DecodeCommit(h.Store, encoded)
			if err != nil {
				return err
			}
			if err := visit(plumbing.TreeObject, commit.TreeHash); err != nil {
				return err
			}
			for _, parent := range commit.ParentHashes {
				if err := visit(plumbing.CommitObject, parent); err != nil {
					return err
				}
			}
		case plumbing.TreeObject:
			tree, err := object.DecodeTree(h.Store, encoded)
			if err != nil {
				return err
			}
			for _, entry := range tree.Entries {
				childType := plumbing.BlobObject
				if entry.Mode == filemode.Dir {
					childType = plumbing.TreeObject
				}
				if entry.Mode == filemode.Submodule {
					childType = plumbing.CommitObject
				}
				if err := visit(childType, entry.Hash); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(plumbing.CommitObject, head.Hash()); err != nil {
		return RepositoryState{}, err
	}
	sort.Slice(state.Objects, func(i, j int) bool { return state.Objects[i].OID < state.Objects[j].OID })
	return state, nil
}
