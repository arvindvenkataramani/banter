# Live config: synced to a schema, deployed by merge

Each node keeps its live configuration at the top of its deployment folder, `~/services/banter/` by default, beside the deployed code. A deploy ships the repo's example configuration into it by a three-way merge, the running system writes dashboard settings into it, and every load brings each file into line with the schema the running code declares. Nothing a running process writes is tracked by the repo.

A machine runs one node, a control plane or a shard, never both, so there is one live folder per machine.

## Files

The live files sit at the top of the deployment folder (`$BANTER_PROD`, and `$BANTER_SHARD_PROD` for a shard). A deploy replaces only the code folders it names (`control/`, `dashboard/`, `shared/`, and on the control plane `ops/` and `scripts/`), so it never touches these.

| Node | File | Holds |
|---|---|---|
| Control plane | `config.json` | configuration, including every dashboard setting |
| | `registry.json` | the node's services |
| | `shipped/config.json`, `shipped/registry.json` | what the last deploy shipped: the merge base |
| | `state/state.json` | last agent used, last session per agent |
| Shard | `registry.json` | the shard's services and roster |
| | `shipped/registry.json` | the merge base |

The repo tracks `control/control-plane/data/config.example.json`, `control/control-plane/data/registry.example.json` and `control/control-shard/data/registry.example.json`. These are what deploys ship, and what `scripts/install.sh` seeds a first install from. Only developers write them. Event logs stay where they are.

`scripts/deploy.conf` is the one configuration file outside the folder. It names the folder, so the deployed scripts cannot find it without help; it stays in the checkout's `scripts/` and a deploy copies it into `$BANTER_PROD/scripts/`.

**Configuration and registry** hold everything a deploy ships and everything set through the dashboard: service definitions, placement, tuning, voice and model selections, chunking, turn-taking and speech-detection settings, a service's enabled flag, and the fields the service editor changes. A field may be changed in the repo, on the node, or both; the deploy merge decides between them.

**`state/`** holds what the system records as it is used, which a deploy never touches and the merge never sees. It is kept apart because it changes on ordinary navigation, and mixing it into the configuration would turn every deploy into a merge of noise. The last agent used is named `lastAgent`, and is set by `PATCH /api/gateway/lastAgent`.

## Schemas

Each file (configuration, registry, state) has a schema declared with Zod, in `control/shared/src/live-config/schemas.ts`. A schema states each field's type and, where one exists, its default. The registry's semantic checks (references between hosts, capabilities and services; what each runner type requires; the port rules) stay as code that runs after the schema has shaped the document; the schema owns shape, the checks own meaning.

A configuration that does not satisfy its schema is refused with a message naming the field. A configuration that fails to load stops the control plane at startup, as a bad registry does.

Each schema carries an integer version, raised whenever its shape changes.

## Sync

Every load (startup, reload, and the deploy's own pass) brings a file into line with the schema the loading code declares, then validates it.

- A field the schema has and the file lacks is added with its default.
- A value the file has is kept.
- A field the file has and the schema does not know is kept, and a warning names it. Unknown fields are kept so that a deploy from a newer checkout, followed by one from an older one, does not strip a field the newer code added. The warning is what surfaces a typo or a leftover.
- **Repair rules** handle what the shape cannot express: a rename, a value whose meaning changed, a field moving between files. Each rule fires only when the file does not already have the target shape, so running sync twice changes nothing, and each has a test built on a fixture of the old shape. The rules are: `defaultAgent` and `lastSessionByAgent` move from the configuration into the state file, the former renamed `lastAgent`; a literal `--port N` in a process runner's `main` becomes `{port}`; the path after `--registry` in a process runner's `main` becomes `{registry}`.
- When the file's version is higher than the schema's, the file was written by newer code. The load uses it as it stands, never writes a synced copy back, and warns; single-field saves still go through, since they reshape nothing. When the file's version is lower, sync writes the result with the schema's version.
- What sync cannot resolve (a value of the wrong type with no repair rule) stops the load with a message naming the field and the file.

A file sync changed is written back to disk atomically.

The repo's own example files are synced by `bun run config:sync` in `control/`, which the pre-commit hook runs on any commit that touches `control/`, never by a running process. A schema change lands in the same commit as the examples it reshapes.

## Writing settings

A settings save (a dashboard change, a service edit, an enable or disable) reads the file from disk, changes the one field it names, and writes the file back atomically. It never writes out the process's in-memory copy, so a hand edit or a field the writing code does not know survives the save.

## Placeholders in commands

A process runner's `main` may use `{port}`, filled from `network.port`, and `{registry}`, filled with the path of the registry the node loaded. The second lets the fluid speech servers find the live registry without its path written into the registry itself.

## Deploy

A deploy merges three versions of each shipped file: the previous ship from `shipped/`, the node's live file, and the repo's example being shipped now.

1. The live files are synced with the new code's schemas, so a shape change does not appear as a conflict.
2. Each file is merged field by field. Changed only in the repo, the repo's value is taken; changed only on the node, the node's value stays; changed on both to different values, the deploy stops before restarting anything and names the conflicting fields.
3. The merged files are written to the live folder, and the shipped files to `shipped/`.

The merge is structural: objects merge by key, the registry's `services`, `hosts` and `capabilities` lists by id, and any other array is a single value. A file present in the repo but absent from `shipped/` merges with a base built from the repo's example, limited to the fields the live file has, which keeps every live value and adds only what the repo adds. An untouched placeholder in an example therefore never conflicts with the value a user has written over it.

The deploy runs `control/scripts/deploy-config.ts`, which `control-deploy.sh` and `shard-deploy.sh` call before they stop anything. It never stashes live files and never asks whether to keep or overwrite them.

## First deploy on a node

With no live file, a first deploy seeds it from the old paths if present: `$BANTER_PROD/control/control-plane/data/config.json` and `registry.json` on a control plane, `~/services/shard/registry.json` on a shard. Otherwise it seeds it from the example. `shipped/` starts empty, so the merge keeps every value the node has, and the runtime state moves out of the configuration into `state/state.json` by the repair rule on first load.

A fresh install gets its live files from `scripts/install.sh`, which writes them at the top of the deployment folder from the examples (filling in the gateway URL and token) before the first deploy; the deploy then merges the examples into them.

## Dev

`scripts/control-dev.sh` runs against the deployed folder's live files, so new code is tried on real settings, and syncs them like any other load. Nothing restricts what dev writes, since nothing could: it runs as the same user on the same files.

Dev's sync reshaping a file is the migration its code will bring anyway, arriving before the deploy. Until then the deployed code reads a file from newer code: it keeps the fields it does not know, saves single fields into it, and where a repair rule has moved a field it falls back to that field's default. A value dev writes that the deployed code cannot load stops it at startup with a message naming the field, never silently. Load warnings name what is left over from abandoned work; restore the file by hand.
