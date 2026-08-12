const OID_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PREVIEW_BYTES = 4_096;
const MAX_STRUCTURAL_BYTES = 1_048_576;
const MAX_TREE_DEPTH = 64;
const MAX_TREE_ENTRIES = 10_000;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const asciiDecoder = new TextDecoder("ascii", { fatal: true });
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message) {
  throw new Error(message);
}

function decodedLength(base64) {
  if (
    typeof base64 !== "string" ||
    base64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(base64)
  ) {
    invalid("Object payload is not canonical base64");
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function decodeObjectBytes(object, maximumBytes = Infinity) {
  const length = decodedLength(object?.base64);
  if (length > maximumBytes) return null;
  let binary;
  try {
    binary = atob(object.base64);
  } catch {
    invalid("Object payload is not canonical base64");
  }
  if (binary.length !== length)
    invalid("Object payload length is inconsistent");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCommitTreeOid(commit) {
  const bytes = decodeObjectBytes(commit, MAX_STRUCTURAL_BYTES);
  if (bytes === null) invalid("Commit payload exceeds the display limit");
  const headerEnd = bytes.indexOf(0x0a);
  if (headerEnd === -1) invalid("Commit payload has no header line");
  let firstHeader;
  try {
    firstHeader = asciiDecoder.decode(bytes.subarray(0, headerEnd));
  } catch {
    invalid("Commit payload starts with a non-ASCII header");
  }
  const match = /^tree ([0-9a-f]{40})$/.exec(firstHeader);
  if (match === null)
    invalid("Commit payload has no canonical root tree header");
  return match[1];
}

export function parseTreeEntries(tree) {
  const bytes = decodeObjectBytes(tree, MAX_STRUCTURAL_BYTES);
  if (bytes === null) invalid("Tree payload exceeds the display limit");
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space === -1 ? -1 : bytes.indexOf(0x00, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 21 > bytes.length) {
      invalid("Tree payload contains a truncated entry");
    }
    let mode;
    let name;
    try {
      mode = asciiDecoder.decode(bytes.subarray(offset, space));
      name = utf8Decoder.decode(bytes.subarray(space + 1, nul));
    } catch {
      invalid("Tree payload contains a non-canonical mode or UTF-8 name");
    }
    if (name.includes("/") || name === "" || name === "." || name === "..") {
      invalid("Tree payload contains an invalid name");
    }
    const oid = bytesToHex(bytes.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid, type: objectTypeForMode(mode) });
    offset = nul + 21;
  }
  return entries;
}

export function objectTypeForMode(mode) {
  switch (mode) {
    case "40000":
      return "tree";
    case "100644":
    case "100664":
    case "100755":
    case "120000":
      return "blob";
    case "160000":
      return "commit";
    default:
      invalid(`Tree payload contains unsupported mode ${mode}`);
  }
}

function kindForMode(mode) {
  switch (mode) {
    case "40000":
      return "directory";
    case "100755":
      return "executable";
    case "120000":
      return "symlink";
    case "160000":
      return "gitlink";
    default:
      return "file";
  }
}

export function decodeRepositoryTree(repository) {
  if (!repository?.resolvedHeadOid) return null;
  if (!OID_PATTERN.test(repository.resolvedHeadOid)) {
    invalid("HEAD does not contain a canonical object ID");
  }
  const objects = new Map();
  for (const object of repository.objects ?? []) {
    if (!OID_PATTERN.test(object?.oid) || typeof object.type !== "string") {
      invalid("Exported object identity is invalid");
    }
    if (objects.has(object.oid)) invalid(`Duplicate object ${object.oid}`);
    objects.set(object.oid, object);
  }
  const commit = objects.get(repository.resolvedHeadOid);
  if (commit?.type !== "commit") {
    invalid("HEAD does not resolve to an exported commit object");
  }
  const rootTreeOid = parseCommitTreeOid(commit);
  const activeTrees = new Set();
  let renderedEntries = 0;
  function visitTree(treeOid, prefix = "", depth = 0) {
    if (depth > MAX_TREE_DEPTH) invalid("Tree graph exceeds the depth limit");
    if (activeTrees.has(treeOid)) invalid("Tree graph contains a cycle");
    activeTrees.add(treeOid);
    try {
      const tree = objects.get(treeOid);
      if (tree?.type !== "tree") invalid(`Missing tree object ${treeOid}`);
      const entries = [];
      for (const entry of parseTreeEntries(tree)) {
        renderedEntries += 1;
        if (renderedEntries > MAX_TREE_ENTRIES) {
          invalid("Tree graph exceeds the entry limit");
        }
        const object = objects.get(entry.oid);
        if (object?.type !== entry.type) {
          invalid(`Missing ${entry.type} object ${entry.oid}`);
        }
        const path = `${prefix}${entry.name}`;
        entries.push({ ...entry, kind: kindForMode(entry.mode), path });
        if (entry.type === "tree") {
          entries.push(...visitTree(entry.oid, `${path}/`, depth + 1));
        }
      }
      return entries;
    } finally {
      activeTrees.delete(treeOid);
    }
  }
  return {
    commitOid: commit.oid,
    rootTreeOid,
    entries: visitTree(rootTreeOid),
    objects,
  };
}

export function blobPreview(object) {
  const byteLength = decodedLength(object?.base64);
  const bytes = decodeObjectBytes(object, MAX_PREVIEW_BYTES);
  if (bytes === null) {
    return { kind: "omitted", text: `Preview omitted · ${byteLength} bytes` };
  }
  if (
    bytes.some(
      (byte) =>
        byte === 0 ||
        (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
        byte === 0x7f,
    )
  ) {
    return { kind: "binary", text: `Binary content · ${byteLength} bytes` };
  }
  try {
    const text = utf8Decoder.decode(bytes);
    return {
      kind: "text",
      text: text === "" ? "Empty file" : text,
      byteLength,
    };
  } catch {
    return { kind: "binary", text: `Binary content · ${byteLength} bytes` };
  }
}
