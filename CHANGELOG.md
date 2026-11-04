# Changelog

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
