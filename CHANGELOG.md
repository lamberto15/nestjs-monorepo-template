# Changelog

## [0.4.2](https://github.com/lamberto15/nestjs-monorepo-template/compare/v0.4.1...v0.4.2) (2026-11-10)


### Bug Fixes

* **deps:** raise transitive dependencies with open advisories ([#1101](https://github.com/lamberto15/nestjs-monorepo-template/issues/1101)) ([8d0fdfa](https://github.com/lamberto15/nestjs-monorepo-template/commit/8d0fdfa3a3b4c5772f001538f4b7baad6cbe1792))

## [0.4.1](https://github.com/lamberto15/nestjs-monorepo-template/compare/v0.4.0...v0.4.1) (2026-11-09)


### Bug Fixes

* **deploy:** unblock production deploys (manual staging gate, migrate health check) ([#1098](https://github.com/lamberto15/nestjs-monorepo-template/issues/1098)) ([1dfe813](https://github.com/lamberto15/nestjs-monorepo-template/commit/1dfe813c4aac3a5bb637de5b37111657e114c216)), closes [#1097](https://github.com/lamberto15/nestjs-monorepo-template/issues/1097)

## [0.4.0](https://github.com/lamberto15/nestjs-monorepo-template/compare/v0.3.0...v0.4.0) (2026-11-09)


### Features

* **deploy:** render the heavy worker and the pgbouncer, pitr and clamav overlays under Swarm ([#1094](https://github.com/lamberto15/nestjs-monorepo-template/issues/1094)) ([cadb603](https://github.com/lamberto15/nestjs-monorepo-template/commit/cadb603126d42d0f07267b3f4172d6279ef5ccda))


### Bug Fixes

* **api:** type-check the tests in CI and fix their 66 type errors ([#1091](https://github.com/lamberto15/nestjs-monorepo-template/issues/1091)) ([f6830e3](https://github.com/lamberto15/nestjs-monorepo-template/commit/f6830e3ef41526ac7584e66fac14d762deff3d27))
* **backup:** the shellcheck findings in the backup scripts, and shellcheck in CI ([#1090](https://github.com/lamberto15/nestjs-monorepo-template/issues/1090)) ([4e16a68](https://github.com/lamberto15/nestjs-monorepo-template/commit/4e16a68db35f34dee611283e87aba23fdeca0e3a))
* **ci:** pin pnpm 12.18.0 everywhere and check devEngines agrees with the Dockerfiles ([#1079](https://github.com/lamberto15/nestjs-monorepo-template/issues/1079)) ([5430e5b](https://github.com/lamberto15/nestjs-monorepo-template/commit/5430e5b8c4cfecf62948c561042e7acec851e344))
* **deploy:** Caddy health check reads its answer, migration lint names squawk's failure, monitoring note ([#1093](https://github.com/lamberto15/nestjs-monorepo-template/issues/1093)) ([db1a21e](https://github.com/lamberto15/nestjs-monorepo-template/commit/db1a21ea37209511c43c84a330b14a4bd1b6afaf))
* **deps:** clear the high advisories in @lhci/cli's chain and refresh seroval ([#1076](https://github.com/lamberto15/nestjs-monorepo-template/issues/1076)) ([b5a3141](https://github.com/lamberto15/nestjs-monorepo-template/commit/b5a3141c6abc97ac6c833692d9689166a6c30a55))

## [0.3.0](https://github.com/lamberto15/nestjs-monorepo-template/compare/v0.2.2...v0.3.0) (2026-11-09)


### Features

* **data-transfer:** replace exceljs with turbosheet ([#1048](https://github.com/lamberto15/nestjs-monorepo-template/issues/1048)) ([1c2af66](https://github.com/lamberto15/nestjs-monorepo-template/commit/1c2af66345a22f4f86ec0a4d21a3014c638fe6ec))


### Bug Fixes

* **deps:** bump fast-uri to 3.1.9 and serialize-javascript to 7.1.4 ([#1066](https://github.com/lamberto15/nestjs-monorepo-template/issues/1066), [#1067](https://github.com/lamberto15/nestjs-monorepo-template/issues/1067)) ([1c2af66](https://github.com/lamberto15/nestjs-monorepo-template/commit/1c2af66345a22f4f86ec0a4d21a3014c638fe6ec))
* **documents:** run the official Gotenberg 9.2.0 image, pinned by digest, instead of rebuilding our own ([#1050](https://github.com/lamberto15/nestjs-monorepo-template/issues/1050)) ([1c2af66](https://github.com/lamberto15/nestjs-monorepo-template/commit/1c2af66345a22f4f86ec0a4d21a3014c638fe6ec))
* **images:** patch zlib in the app image and build rclone v1.76.0 ([#1064](https://github.com/lamberto15/nestjs-monorepo-template/issues/1064)) ([e9ef081](https://github.com/lamberto15/nestjs-monorepo-template/commit/e9ef081506f787392109b0e5465f0c07028e41da))

## [0.2.2](https://github.com/lamby-dev/nestjs-monorepo-template/compare/v0.2.1...v0.2.2) (2026-11-04)


### Bug Fixes

* **api:** store timestamps to the millisecond so date-sorted pages seek their index ([#1046](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1046)) ([030ab35](https://github.com/lamby-dev/nestjs-monorepo-template/commit/030ab3575a50011b9bb82503a7bb7d074c615fdd))

## [0.2.1](https://github.com/lamby-dev/nestjs-monorepo-template/compare/v0.2.0...v0.2.1) (2026-11-04)


### Performance Improvements

* **notes:** index the tenant's notes in id order for exports ([#1043](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1043)) ([da49acf](https://github.com/lamby-dev/nestjs-monorepo-template/commit/da49acf21c50900027845f39a39898afca140424))

## [0.2.0](https://github.com/lamby-dev/nestjs-monorepo-template/compare/v0.1.2...v0.2.0) (2026-11-04)


### Features

* **deploy:** production needs a green staging deploy of the release ([#1042](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1042)) ([2ddba7b](https://github.com/lamby-dev/nestjs-monorepo-template/commit/2ddba7b1082cc7789835094d8bc4c0c49479f129))


### Bug Fixes

* **deploy:** let PostgreSQL use the host's spare memory ([#1038](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1038)) ([2d3a237](https://github.com/lamby-dev/nestjs-monorepo-template/commit/2d3a237c65114c10fc50402b8628d9c55502e1bd))
* typed client job, swarm deploy retry, docs say pnpm run setup ([#1040](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1040)) ([39f3705](https://github.com/lamby-dev/nestjs-monorepo-template/commit/39f3705813e05696ba6f0a1cd02ab37922a328fb))

## [0.1.2](https://github.com/lamby-dev/nestjs-monorepo-template/compare/v0.1.1...v0.1.2) (2026-11-03)


### Bug Fixes

* **deploy:** leave room for the new api's reservation during a deploy ([#1035](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1035)) ([e260ca0](https://github.com/lamby-dev/nestjs-monorepo-template/commit/e260ca0a78657bf0e1d23dd3a5e8c62fd1456daa))

## [0.1.1](https://github.com/lamby-dev/nestjs-monorepo-template/compare/v0.1.0...v0.1.1) (2026-11-03)


### Bug Fixes

* **ci:** read large GitHub API answers in the release tooling ([#1031](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1031)) ([b161133](https://github.com/lamby-dev/nestjs-monorepo-template/commit/b161133ab32fe9c972008e03f59bdcf260466c39))

## 0.1.0 (2026-11-02)


### Features

* **deploy:** reach production through a Cloudflare Tunnel ([#1028](https://github.com/lamby-dev/nestjs-monorepo-template/issues/1028)) ([7119561](https://github.com/lamby-dev/nestjs-monorepo-template/commit/711956157bb31eb21e7b4ae0f97bbfe4788da262))

## Changelog

Release Please writes the entries below from the Conventional Commit titles
merged to `main` ([docs/releases.md](docs/releases.md)). Each
[GitHub release](https://github.com/lamby-dev/nestjs-monorepo-template/releases)
repeats its entry and adds the migrations, the image digests and the
configuration changes.

The typed client (`packages/api-client`) is versioned separately and keeps its own
[CHANGELOG](packages/api-client/CHANGELOG.md), written from the changesets in
[.changeset](.changeset/README.md).
