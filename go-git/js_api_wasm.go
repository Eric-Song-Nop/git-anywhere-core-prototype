//go:build js && wasm

package main

import (
	"encoding/json"
	"errors"
	"syscall/js"

	"github.com/go-git/go-git/v5/plumbing"
)

var retainedJSFuncs []js.Func

func main() {
	core := js.Global().Get("Object").New()
	exportPromise(core, "init", func(args []js.Value) (any, error) {
		repoID, branch, _, err := commandArgs(args)
		if err != nil {
			return nil, err
		}
		objects, metadata, err := browserBackends()
		if err != nil {
			return nil, err
		}
		handle, err := InitRepository(repoID, objects, metadata, plumbing.NewBranchReferenceName(branch))
		if err != nil {
			return nil, err
		}
		return handle.ReadMetadataState()
	})
	exportPromise(core, "open", func(args []js.Value) (any, error) {
		repoID, _, _, err := commandArgs(args)
		if err != nil {
			return nil, err
		}
		objects, metadata, err := browserBackends()
		if err != nil {
			return nil, err
		}
		handle, err := OpenRepository(repoID, objects, metadata)
		if err != nil {
			return nil, err
		}
		return handle.ReadMetadataState()
	})
	exportPromise(core, "createCommit", func(args []js.Value) (any, error) {
		repoID, branch, idempotencyKey, err := commandArgs(args)
		if err != nil {
			return nil, err
		}
		if idempotencyKey == "" {
			return nil, errorsf("createCommit requires options.idempotencyKey")
		}
		objects, metadata, err := browserBackends()
		if err != nil {
			return nil, err
		}
		handle, err := OpenRepository(repoID, objects, metadata)
		if err != nil {
			return nil, err
		}
		expected, err := commitExpectation(args)
		if err != nil {
			return nil, err
		}
		return handle.CreateDeterministicCommit(plumbing.NewBranchReferenceName(branch), idempotencyKey, expected)
	})
	exportPromise(core, "readCommitState", func(args []js.Value) (any, error) {
		repoID, _, _, err := commandArgs(args)
		if err != nil {
			return nil, err
		}
		objects, metadata, err := browserBackends()
		if err != nil {
			return nil, err
		}
		handle, err := OpenRepository(repoID, objects, metadata)
		if err != nil {
			return nil, err
		}
		return handle.ReadState()
	})
	js.Global().Set("__gitCore", core)
	select {}
}

func commitExpectation(args []js.Value) (*CommitExpectation, error) {
	if len(args) < 2 || args[1].Type() != js.TypeObject {
		return nil, nil
	}
	options := args[1]
	generation := options.Get("expectedGeneration")
	revision := options.Get("expectedRevision")
	if generation.Type() == js.TypeUndefined && revision.Type() == js.TypeUndefined {
		return nil, nil
	}
	if generation.Type() != js.TypeString || generation.String() == "" || revision.Type() != js.TypeNumber || revision.Float() < 0 || revision.Float() != float64(uint64(revision.Float())) {
		return nil, errorsf("expectedGeneration and non-negative integer expectedRevision must be supplied together")
	}
	expected := &CommitExpectation{Generation: generation.String(), Revision: uint64(revision.Float())}
	branch := options.Get("expectedBranchOid")
	if branch.Type() != js.TypeUndefined && branch.Type() != js.TypeNull {
		if branch.Type() != js.TypeString || !plumbing.IsHash(branch.String()) {
			return nil, errorsf("expectedBranchOid must be null/omitted for absent or a Git OID")
		}
		oid := branch.String()
		expected.BranchOID = &oid
	}
	return expected, nil
}

func browserBackends() (ObjectBackend, MetadataBackend, error) {
	objects, err := globalBackend("__gitObjectStore")
	if err != nil {
		return nil, nil, err
	}
	metadata, err := globalBackend("__gitMetadataStore")
	if err != nil {
		return nil, nil, err
	}
	return jsObjectBackend{value: objects}, jsMetadataBackend{value: metadata}, nil
}

type asyncOperation func([]js.Value) (any, error)

// exportPromise returns a Promise before any Go storage work begins. The work
// runs in a goroutine, allowing awaitPromise to yield to the JS event loop.
func exportPromise(target js.Value, name string, operation asyncOperation) {
	function := js.FuncOf(func(_ js.Value, args []js.Value) any {
		constructor := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
			resolve, reject := promiseArgs[0], promiseArgs[1]
			copied := append([]js.Value(nil), args...)
			go func() {
				value, err := operation(copied)
				if err != nil {
					reject.Invoke(jsError(err))
					return
				}
				resolve.Invoke(toJS(value))
			}()
			return nil
		})
		promise := js.Global().Get("Promise").New(constructor)
		constructor.Release()
		return promise
	})
	retainedJSFuncs = append(retainedJSFuncs, function)
	target.Set(name, function)
}

func commandArgs(args []js.Value) (repoID, branch, idempotencyKey string, err error) {
	if len(args) == 0 || args[0].Type() != js.TypeString || args[0].String() == "" {
		return "", "", "", errorsf("repoId is required")
	}
	repoID = args[0].String()
	if !repoIDPattern.MatchString(repoID) {
		return "", "", "", errorsf("repoId must match %s", repoIDPattern.String())
	}
	branch = "main"
	if len(args) > 1 && args[1].Type() == js.TypeObject {
		if value := args[1].Get("branch"); value.Type() == js.TypeString && value.String() != "" {
			branch = value.String()
		}
		if value := args[1].Get("idempotencyKey"); value.Type() == js.TypeString {
			idempotencyKey = value.String()
		}
	}
	branchRef := plumbing.NewBranchReferenceName(branch)
	if err := branchRef.Validate(); err != nil {
		return "", "", "", errorsf("invalid branch %q: %v", branch, err)
	}
	return repoID, branch, idempotencyKey, nil
}

func toJS(value any) js.Value {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return js.Global().Get("JSON").Call("parse", string(encoded))
}

func jsError(err error) js.Value {
	value := js.Global().Get("Error").New(err.Error())
	value.Set("name", "GitCoreError")
	value.Set("code", "GIT_CORE_ERROR")
	if errors.Is(err, ErrConflict) {
		value.Set("code", "CONFLICT")
	}
	return value
}
