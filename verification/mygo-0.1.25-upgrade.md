# MyGo 0.1.25 enhancement migration

Upstream tag: `v0.1.25`, commit `298c88a03407844ac1c4eb76e3590edfe4577121`.

The complete 0.1.24 enhancement patch applies cleanly to this tag. Regenerated
`patches/mygo-0.1.25-enhancements.patch` includes all added taskbar files and tests.
Build input, packaged manifest and installer payload validation now target 0.1.25.
Official and enhanced older builds remain eligible for upgrade; unknown hashes
remain unsupported.

Official Windows x64 executable SHA256:
`20d680e6a6dc12a3c84b62841e02d3c021b855f5c28c6d135f59893bcc61ea0d`.

Verified against the official release archive SHA256:
`21e8ce842db1f1d20b008080a77f5963e028555d10f358a486fddc93cabbe92d`.

Validation on Windows x64:
- Plugin tests: 149 passed.
- Enhanced upstream: `go test ./internal/...` passed.
- Taskbar tests: `go test ./internal/app -run '^TestTaskbar' -count=5` passed.
- Installer and packager tests passed.
- Enhanced player and Windows/Mac helpers compiled; both plugin packages built.
- Installer read-only check against installed official 0.1.25: `not-installed`.

Not verified: enhanced-player installation/restart and visual interaction on
Windows; Mac runtime and installation. macOS package is cross-compiled and does
not include the Windows enhancement.
