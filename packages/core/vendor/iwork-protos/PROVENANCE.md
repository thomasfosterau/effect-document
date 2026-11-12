# Provenance of the iWork protobuf snapshot

The `.proto` files and registries here are the input of `scripts/generate-iwork-schema.ts`, which writes `src/iwork/schema.generated.ts` (the type ids, field numbers and enum values the iWork readers use). They are vendored unmodified and are not published (the package's `files` are `dist`, the README, the changelog and the licence).

The definitions are reverse-engineered by the projects below from Apple's iWork app binaries; Apple publishes no schema. They can differ between iWork versions.

## keynote-parser 14.5 (`keynote-parser-14.5/`)

- Repository: https://github.com/psobot/keynote-parser
- Commit: `56a4d3b0d38c999f4273d084acd45415665e2030` (2026-08-08)
- Licence: MIT, declared in the repository's `pyproject.toml` (`license = { text = "MIT License" }`). The repository has no LICENSE file.
- Files, from `protos/versions/14.5/` upstream: `TSPMessages.proto`, `TSPArchiveMessages.proto`, `KNArchives.proto`, `TSWPArchives.proto`, and `registry.json` (the type id to message name map for that iWork version).

## numbers-parser (`numbers-parser/`)

- Repository: https://github.com/masaccio/numbers-parser
- Commit: `5cf174d432276bb1651070c9866e8e093a034d19` (2026-11-11)
- Licence: MIT, `LICENSE.rst` (Copyright 2021 Jon Connell).
- Files: `src/protos/TNArchives.proto` and `src/numbers_parser/generated/mapping.py` (its `TSPRegistryMapping` literal is the type id map; the generator reads its `"<id>": "<Name>",` lines).

## Refreshing

1. Copy the same files from the new upstream commit over these (for a newer iWork version, a new `keynote-parser-<version>/` directory, with `KEYNOTE_REGISTRY` in the generator updated).
2. Update the repository, commit and date above.
3. Run `vpx packages/core/scripts/generate-iwork-schema.ts` from the repository root, and commit the snapshot and `src/iwork/schema.generated.ts` together.

`test/iwork/schema-generated.test.ts` fails while the committed module and the snapshot disagree. The generator fails, naming the file and position, on any `.proto` construct outside the subset it parses.
