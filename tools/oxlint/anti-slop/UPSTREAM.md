# Anti-slop provenance

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), revision `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Includes the generic entry point, its rules/shared helpers, and the ESLint Stylistic adapter. Effect-specific rules and upstream test suites are not included because this application does not use Effect. Production files are copied without local modifications. Both upstream licenses are retained.

All 18 generic rules and `oxc/no-accumulating-spread` are enabled in `oxlint.config.ts`. Vendored source is excluded from application linting as upstream recommends; application code, system tests and local tooling are not excluded.

To update, retrieve an explicit upstream revision, compare it with this snapshot, preserve local policy changes if any, and run `mise run lint`, `mise run test`, and `mise run build`.
