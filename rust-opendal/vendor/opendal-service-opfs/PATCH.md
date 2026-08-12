# OpenDAL OPFS 0.58.1 Worker patch

This directory vendors only the Apache OpenDAL `opendal-service-opfs` crate
from release `0.58.1`.

- Upstream commit: `6f544a131be78e553d28e79f3cfe5ac948f2963e`
- crates.io archive SHA-256:
  `0e0460c83438db0a4841e70cc5f41bd6a2ac32bf7415969ce4a7168cddbea3a2`
- Upstream path: `core/services/opfs`

The source patch is intentionally one functional change in `src/core.rs`:
`get_root_directory_handle` first uses `Window.navigator.storage` and otherwise
casts the real JavaScript global to `WorkerGlobalScope` and uses
`WorkerNavigator.storage`. The two Worker web-sys features are added to this
crate manifest. No runtime globals or prototypes are modified.
The exact auditable source delta is `worker-global-scope.patch`.

To audit the code against a downloaded upstream crate:

```sh
./scripts/check-vendor.sh /path/to/opendal-service-opfs-0.58.1
```
