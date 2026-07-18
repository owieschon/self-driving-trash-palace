# Run TrashPal locally

This guide starts the credential-free application topology without printing or exporting its generated secrets.

Prerequisite: [start here](start-here.md).

## Prerequisites

- Node.js 22 through 26
- pnpm 11.7.0
- Docker Engine with Compose support

Install the pinned workspace:

```bash
pnpm install --frozen-lockfile
```

## Prepare and start

Generate ignored local configuration, build the application image, and start every service:

```bash
pnpm local:up
```

Inspect health without opening the private environment file:

```bash
pnpm local:status
```

When every service is healthy, open [TrashPal](http://127.0.0.1:3300). Set
`TRASH_PALACE_WEB_PORT` before `pnpm local:prepare` if you need a different loopback port.

If a service is not ready, follow the service logs and press Ctrl+C after collecting the relevant interval:

```bash
pnpm local:logs
```

The scripts own Compose selection, generated local-only secrets, and loopback bindings. Use them instead of copying values from `compose.yaml` into a second setup procedure.

## Stop safely

```bash
pnpm local:down
```

Stopping preserves the named database and evidence volumes. Do not describe a later run as a clean seed unless the repository's reset command has removed only those project-owned volumes.

Reset only this project's containers and named data volumes before a clean study:

```bash
pnpm local:prepare
pnpm local:reset
pnpm local:up
```

To test process recovery without resetting durable state, recreate only the gateway and worker:

```bash
pnpm local:restart
```

## Next step

[Learn the identities behind a safe resumable change](../concepts/missions-plans-and-operations.md).
