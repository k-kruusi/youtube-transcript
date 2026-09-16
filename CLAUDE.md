# youtube-transcript — Source of Truth

This `packages/youtube-transcript/` directory is the **source of truth** for the
youtube-transcript cartridge. Edit code **here**, never in `cartridges/youtube-transcript/`
— `scripts/rebuild.sh youtube-transcript` overwrites the cartridge copy from this source
(dev-mode symlinks are the only exception).

`state/`, `config/`, `dist/`, `node_modules/` are runtime-only — they live in the cartridge
instance, never in this package. See `packages/CLAUDE.md` for the full convention and
`README.md` here for the spec/contract.
