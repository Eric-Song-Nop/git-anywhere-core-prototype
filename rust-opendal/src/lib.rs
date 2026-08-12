#![deny(unsafe_code)]

use std::rc::Rc;

use futures::lock::Mutex;
use js_sys::{Error as JsError, Reflect, Uint8Array};
use opendal::services::Opfs;
use opendal::{EntryMode, Error, ErrorKind, Operator};
use wasm_bindgen::prelude::*;

const ERROR_NAME: &str = "GitObjectStoreError";
const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

/// A root-scoped immutable Git object store backed by OpenDAL's OPFS service.
///
/// Every public async method is emitted by wasm-bindgen as a JavaScript
/// Promise. The Go-WASM adapter deliberately waits for those Promises from a
/// Go goroutine rather than blocking a JavaScript-to-Go callback.
#[wasm_bindgen]
pub struct ObjectStore {
    operator: Operator,
    // Serialize mutations made through one instance. OPFS does not provide an
    // atomic create-if-absent operation, so this cannot fence another tab or
    // another ObjectStore instance. See README.md.
    mutation_lock: Rc<Mutex<()>>,
}

/// Open (and, if necessary, create) a root beneath the origin-private file
/// system. `root` is a relative slash-separated path such as
/// `git-anywhere/repository-id/objects-v1`.
#[wasm_bindgen]
pub async fn create_store(root: String) -> Result<ObjectStore, JsValue> {
    let root = validate_root(&root)?;

    // OpenDAL's rooted OPFS operator navigates its configured root with
    // create=false. Bootstrap the directory from an unrooted operator first.
    let bootstrap = new_operator(None).map_err(|error| map_error("init", None, error))?;
    bootstrap
        .create_dir(&format!("{root}/"))
        .await
        .map_err(|error| map_error("init", Some(&root), error))?;

    let operator = new_operator(Some(&root)).map_err(|error| map_error("init", None, error))?;

    Ok(ObjectStore {
        operator,
        mutation_lock: Rc::new(Mutex::new(())),
    })
}

#[wasm_bindgen]
impl ObjectStore {
    /// Store bytes at an immutable, caller-chosen content key.
    ///
    /// The operation is idempotent when the key already contains identical
    /// bytes. It rejects an existing different value with `ImmutableConflict`.
    /// The returned JavaScript number is the persisted byte length.
    pub async fn put(&self, path: String, bytes: Uint8Array) -> Result<f64, JsValue> {
        let path = validate_path(&path, "put")?;
        let bytes = bytes.to_vec();
        let size = checked_js_size(bytes.len() as u64, "put", Some(&path))?;
        let _guard = self.mutation_lock.lock().await;

        match self.read_bytes(&path, "put").await {
            Ok(existing) if existing == bytes => return Ok(size),
            Ok(_) => {
                return Err(store_error(
                    "ImmutableConflict",
                    "put",
                    Some(&path),
                    false,
                    "the immutable key already contains different bytes",
                ));
            }
            Err(error) if error_code(&error).as_deref() == Some("NotFound") => {}
            Err(error) => return Err(error),
        }

        self.operator
            .write(&path, bytes.clone())
            .await
            .map_err(|error| map_error("put", Some(&path), error))?;

        // OPFS has no conditional create. Always verify what became visible
        // before reporting success, which detects a conflicting external
        // writer in the common interleaving (but cannot make it atomic).
        let persisted = self.read_bytes(&path, "put").await?;
        if persisted != bytes {
            return Err(store_error(
                "ImmutableConflict",
                "put",
                Some(&path),
                false,
                "the immutable key changed while it was being written",
            ));
        }

        Ok(size)
    }

    /// Read an immutable object as a fresh Uint8Array.
    pub async fn get(&self, path: String) -> Result<Uint8Array, JsValue> {
        let path = validate_path(&path, "get")?;
        let bytes = self.read_bytes(&path, "get").await?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    /// Return whether a file exists at `path`.
    pub async fn exists(&self, path: String) -> Result<bool, JsValue> {
        let path = validate_path(&path, "exists")?;
        match self.operator.stat(&path).await {
            Ok(metadata) if metadata.mode() == EntryMode::FILE => Ok(true),
            Ok(_) => Err(store_error(
                "NotAFile",
                "exists",
                Some(&path),
                false,
                "the key resolves to a directory rather than an object blob",
            )),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(map_error("exists", Some(&path), error)),
        }
    }

    /// Return a file's byte length as an exact JavaScript number.
    pub async fn size(&self, path: String) -> Result<f64, JsValue> {
        let path = validate_path(&path, "size")?;
        let metadata = self
            .operator
            .stat(&path)
            .await
            .map_err(|error| map_error("size", Some(&path), error))?;
        if metadata.mode() != EntryMode::FILE {
            return Err(store_error(
                "NotAFile",
                "size",
                Some(&path),
                false,
                "the key resolves to a directory rather than an object blob",
            ));
        }
        checked_js_size(metadata.content_length(), "size", Some(&path))
    }

    /// Remove one key. This exists only for tests and unreachable-object
    /// cleanup; published Git objects must not be deleted concurrently.
    /// Returns false when the key was already absent.
    pub async fn remove(&self, path: String) -> Result<bool, JsValue> {
        let path = validate_path(&path, "remove")?;
        let _guard = self.mutation_lock.lock().await;
        if !self.exists(path.clone()).await? {
            return Ok(false);
        }
        self.operator
            .delete(&path)
            .await
            .map_err(|error| map_error("remove", Some(&path), error))?;
        Ok(true)
    }

    /// Recursively clear this store's root. Test-only.
    pub async fn clear(&self) -> Result<(), JsValue> {
        let _guard = self.mutation_lock.lock().await;
        let entries = self
            .operator
            .list_with("")
            .recursive(true)
            .await
            .map_err(|error| map_error("clear", None, error))?;
        // OpenDAL 0.58.1's OPFS recursive root deletion can ask OPFS to
        // remove the configured root itself and fail with InvalidModification.
        // Delete only listed files; empty directories are harmless test
        // residue and are reused by later puts.
        for entry in entries {
            if entry.metadata().mode() == EntryMode::FILE {
                self.operator
                    .delete(entry.path())
                    .await
                    .map_err(|error| map_error("clear", Some(entry.path()), error))?;
            }
        }
        Ok(())
    }
}

impl ObjectStore {
    async fn read_bytes(&self, path: &str, operation: &str) -> Result<Vec<u8>, JsValue> {
        let buffer = self
            .operator
            .read(path)
            .await
            .map_err(|error| map_error(operation, Some(path), error))?;
        Ok(buffer.to_bytes().to_vec())
    }
}

fn new_operator(root: Option<&str>) -> Result<Operator, Error> {
    let builder = match root {
        Some(root) => Opfs::default().root(&format!("/{root}/")),
        None => Opfs::default(),
    };
    Operator::new(builder)
}

fn validate_root(root: &str) -> Result<String, JsValue> {
    if root.is_empty() || root.starts_with('/') || root.ends_with('/') {
        return Err(store_error(
            "InvalidPath",
            "init",
            Some(root),
            false,
            "root must be a non-empty relative path",
        ));
    }
    validate_segments(root, "init")?;
    Ok(root.to_owned())
}

fn validate_path(path: &str, operation: &str) -> Result<String, JsValue> {
    if path.is_empty() || path.starts_with('/') || path.ends_with('/') {
        return Err(store_error(
            "InvalidPath",
            operation,
            Some(path),
            false,
            "object keys must be non-empty relative file paths",
        ));
    }
    validate_segments(path, operation)?;
    Ok(path.to_owned())
}

fn validate_segments(path: &str, operation: &str) -> Result<(), JsValue> {
    if path.contains('\\') || path.contains('\0') {
        return Err(store_error(
            "InvalidPath",
            operation,
            Some(path),
            false,
            "backslashes and NUL bytes are not allowed",
        ));
    }
    if path.split('/').any(|segment| {
        segment.is_empty() || segment == "." || segment == ".." || segment.len() > 255
    }) {
        return Err(store_error(
            "InvalidPath",
            operation,
            Some(path),
            false,
            "path segments must be non-empty, at most 255 bytes, and not '.' or '..'",
        ));
    }
    Ok(())
}

fn checked_js_size(size: u64, operation: &str, path: Option<&str>) -> Result<f64, JsValue> {
    if size > MAX_SAFE_INTEGER {
        return Err(store_error(
            "SizeOverflow",
            operation,
            path,
            false,
            "the byte length cannot be represented exactly as a JavaScript number",
        ));
    }
    Ok(size as f64)
}

fn map_error(operation: &str, path: Option<&str>, error: Error) -> JsValue {
    let (code, retryable) = match error.kind() {
        ErrorKind::NotFound => ("NotFound", false),
        ErrorKind::PermissionDenied => ("PermissionDenied", false),
        ErrorKind::Unsupported => ("Unsupported", false),
        ErrorKind::RateLimited => ("RateLimited", true),
        ErrorKind::IsADirectory => ("NotAFile", false),
        ErrorKind::NotADirectory => ("InvalidPath", false),
        _ if error.is_temporary() => ("Temporary", true),
        _ if error.message().to_ascii_lowercase().contains("quota") => ("QuotaExceeded", false),
        _ => ("Backend", false),
    };
    store_error(code, operation, path, retryable, error.to_string())
}

fn store_error(
    code: &str,
    operation: &str,
    path: Option<&str>,
    retryable: bool,
    message: impl AsRef<str>,
) -> JsValue {
    let error = JsError::new(message.as_ref());
    error.set_name(ERROR_NAME);
    let value: JsValue = error.into();
    set_property(&value, "code", &JsValue::from_str(code));
    set_property(&value, "operation", &JsValue::from_str(operation));
    set_property(&value, "retryable", &JsValue::from_bool(retryable));
    if let Some(path) = path {
        set_property(&value, "path", &JsValue::from_str(path));
    }
    value
}

fn set_property(target: &JsValue, key: &str, value: &JsValue) {
    // Reflect::set can only fail for an exotic/frozen JS Error object. Errors
    // created here are extensible, so ignoring that impossible branch keeps
    // the error-construction path non-panicking.
    let _ = Reflect::set(target, &JsValue::from_str(key), value);
}

fn error_code(value: &JsValue) -> Option<String> {
    Reflect::get(value, &JsValue::from_str("code"))
        .ok()
        .and_then(|value| value.as_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_relative_object_paths() {
        assert_eq!(
            validate_path("objects/ab/cdef", "get").unwrap(),
            "objects/ab/cdef"
        );
        for bad in [
            "",
            "/absolute",
            "trailing/",
            "a//b",
            "a/./b",
            "a/../b",
            "a\\b",
        ] {
            assert!(validate_path(bad, "get").is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn rejects_unscoped_roots() {
        assert!(validate_root("").is_err());
        assert!(validate_root("/").is_err());
        assert!(validate_root("/repo/objects").is_err());
        assert!(validate_root("repo/objects/").is_err());
        assert_eq!(validate_root("repo/objects").unwrap(), "repo/objects");
    }
}
