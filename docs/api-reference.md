# Banter API Reference

> Auto-generated from OpenAPI route definitions. Do not edit manually.

## Contents

- [Health](#health)
- [Services](#services)
- [Events](#events)
- [Hosts](#hosts)
- [Capabilities](#capabilities)
- [Shards](#shards)
- [Config](#config)
- [Shard](#shard)
- [Schemas](#schemas)

## Health

### `GET` /api/health

Liveness probe

**Responses:**
- **200** — Service is alive
  → [HealthResponse](#healthresponse)

---

## Services

### `POST` /api/services/{id}/check

On-demand health check (bypasses consecutive failure threshold)

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service with updated health state
  → [ServiceWithHealth](#servicewithhealth)
- **404** — Service not found
  → [Error](#error)

---

### `GET` /api/services/{id}

Get a single service by ID

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service with health state
  → [ServiceWithHealth](#servicewithhealth)
- **404** — Service not found
  → [Error](#error)

---

### `PATCH` /api/services/{id}

Update service fields (endpoint, healthPath, etc.)

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Updated service with health state
  → [ServiceWithHealth](#servicewithhealth)
- **400** — Invalid patch
  → [Error](#error)
- **404** — Service not found
  → [Error](#error)

---

### `GET` /api/services/{id}/info

Proxy to a service's /info endpoint

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service-specific info (shape varies by capability)
- **404** — Service not found
  → [Error](#error)
- **502** — Failed to reach service
  → [Error](#error)

---

### `GET` /api/services

List all services with health state

**Parameters:**
- `capability` (query) — Filter by capability ID

**Responses:**
- **200** — All services enriched with health state
  Array of → [ServiceWithHealth](#servicewithhealth)

---

### `POST` /api/services/{id}/restart

Restart a service

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service restarted
  → [Success](#success)
- **400** — Service does not support restart
  → [Error](#error)
- **404** — Service not found
  → [Error](#error)
- **500** — Restart failed
  → [Error](#error)

---

### `POST` /api/services/{id}/start

Start a service

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service started
  → [Success](#success)
- **400** — Service disabled or does not support start
  → [Error](#error)
- **404** — Service not found
  → [Error](#error)
- **500** — Start failed
  → [Error](#error)

---

### `POST` /api/services/{id}/stop

Stop a service

**Parameters:**
- `id` (path) *(required)* — Service ID

**Responses:**
- **200** — Service stopped
  → [Success](#success)
- **400** — Service does not support stop
  → [Error](#error)
- **403** — Cannot stop a protected service
  → [Error](#error)
- **404** — Service not found
  → [Error](#error)
- **500** — Stop failed
  → [Error](#error)

---

### `PATCH` /api/services/{id}/enabled

Enable or disable a service

**Parameters:**
- `id` (path) *(required)* — Service ID

**Request body:**
- `enabled`: boolean

**Responses:**
- **200** — Updated service
- **403** — Cannot disable a protected service
  → [Error](#error)
- **404** — Service not found
  → [Error](#error)
- **500** — Enable/disable action failed
  → [Error](#error)

---

## Events

### `GET` /api/events

List recent events

**Parameters:**
- `limit` (query) — Max events to return
- `subjectId` (query) — Filter by subject ID

**Responses:**
- **200** — Events sorted newest-first
  Array of → [Event](#event)

---

## Hosts

### `GET` /api/hosts

List all hosts

**Responses:**
- **200** — All registered hosts
  Array of → [Host](#host)

---

## Capabilities

### `GET` /api/capabilities

List all capabilities

**Responses:**
- **200** — All registered capabilities
  Array of → [Capability](#capability)

---

## Shards

### `GET` /api/shards

List shard connection statuses

**Responses:**
- **200** — All shards with online/offline status
  Array of → [ShardStatus](#shardstatus)

---

### `POST` /api/shards/{hostId}/poll

Trigger an immediate shard poll

**Parameters:**
- `hostId` (path) *(required)* — Host ID of the shard

**Responses:**
- **200** — Poll result
  - `hostId`: string
  - `online`: boolean
  - `lastPoll`: number
- **404** — Shard not found
  → [Error](#error)
- **500** — No poller available
  → [Error](#error)

---

## Config

### `GET` /api/gateway

OpenClaw gateway URL and token

**Responses:**
- **200** — Gateway connection info
  → [GatewayConfig](#gatewayconfig)
- **503** — Gateway not configured
  → [Error](#error)

---

### `GET` /api/voice

Voice configuration (TTS providers, models, voices, options)

**Responses:**
- **200** — Voice configuration object
- **503** — Voice not configured
  → [Error](#error)

---

### `PATCH` /api/gateway/defaultAgent

Set the default OpenClaw agent

**Request body:**
- `agentId`: string

**Responses:**
- **200** — Default agent updated
  - `defaultAgent`: string
- **400** — Missing agentId or invalid JSON body
  → [Error](#error)
- **500** — Config path not set
  → [Error](#error)

---

### `PATCH` /api/gateway/lastSession

Record the last-used session name for an agent

**Request body:**
- `agentId`: string
- `sessionName`: string

**Responses:**
- **200** — Last session recorded
  - `lastSessionByAgent`: object
- **400** — Missing agentId/sessionName or invalid JSON body
  → [Error](#error)
- **500** — Config path not set
  → [Error](#error)

---

### `PATCH` /api/voice/selection

Update the active TTS/STT selection

**Request body:**
→ [VoiceSelectionPatch](#voiceselectionpatch)

**Responses:**
- **200** — Updated voice configuration object
- **400** — Invalid JSON body, or the patch failed validation
  → [Error](#error)
- **500** — Config path not set
  → [Error](#error)
- **503** — Voice not configured
  → [Error](#error)

---

### `POST` /api/config/reload

Reload config.json from disk without restarting the process

**Responses:**
- **200** — Config reloaded
  - `ok`: boolean
  - `version`: number
- **500** — Config path not set, or reload failed
  → [Error](#error)

---

### `POST` /api/debug/mic-sample

Save a raw mic sample for debugging (only registered when DEBUG is set)

**Responses:**
- **200** — Sample saved
  - `filename`: string
  - `dir`: string
- **400** — Empty body
  → [Error](#error)
- **403** — Mic sample saving disabled in config
  → [Error](#error)

---

## Shard

### `GET` /status

Shard memory and per-service health/ping status

**Responses:**
- **200** — Shard status with memory info and per-service health
  → [ShardStatusResponse](#shardstatusresponse)

---

### `POST` /ping/{service}

Record a ping for idle eviction tracking

**Parameters:**
- `service` (path) *(required)* — Service ID

**Responses:**
- **200** — Ping recorded
  - `ok`: boolean
- **404** — Service not found
  → [Error](#error)

---

## Schemas

### ServiceWithHealth

Extends: [Service](#service)

**Additional fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `health` | `healthy` \| `degraded` \| `timed_out` \| `down` \| `disabled` \| `unknown` | yes |  |
| `lastEvent` | → Event \| null | yes |  |

### ServiceRunner


### Event

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes |  |
| `timestamp` | string | yes |  |
| `type` | `service.up` \| `service.down` \| `service.degraded` \| `service.timed_out` \| `service.disabled` \| `service.enabled` \| `service.restarted` \| `service.started` \| `service.stopped` \| `service.installed` \| `service.uninstalled` \| `service.unloaded` \| `memory.pressure` \| `tailscale.serve_failed` \| `tailscale.serve_remove_failed` | yes |  |
| `subjectType` | string | yes |  |
| `subjectId` | string | yes |  |
| `data` | object | yes |  |
| `actor` | `system` \| `user` | yes |  |

### Service

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes |  |
| `name` | string | no |  |
| `capabilityId` | string | yes |  |
| `hostId` | string | yes |  |
| `permissions` | object | yes |  |
| `network` | object | no |  |
| `runner` | → ServiceRunner | no |  |
| `ops` | object | no |  |
| `lifecycle` | object | no |  |
| `state` | object | no |  |

### Error

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error` | string | yes |  |

### Capability

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes |  |
| `name` | string | yes |  |

### GatewayConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes |  |
| `token` | string | yes |  |

### HealthResponse

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | yes |  |
| `uptime` | number | yes |  |

### Host

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `hostname` | string | yes |  |
| `role` | `control` \| `worker` | yes |  |

### ShardStatus

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostId` | string | yes |  |
| `endpoint` | string | yes |  |
| `online` | boolean | yes |  |
| `lastPoll` | number | yes |  |

### VoiceSelectionPatch

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `serviceId` | string | no |  |
| `model` | string | no |  |
| `voice` | string | no |  |
| `speed` | number | no |  |
| `chunkStrategy` | string \| null | no |  |
| `minChunkWords` | number \| null | no |  |
| `maxChunkWords` | number \| null | no |  |
| `settingsScope` | `global` \| `per-model` | no |  |
| `sttServiceId` | string | no |  |

### Success

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | boolean | yes |  |

### ShardStatusResponse

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `freeMem` | number | yes |  |
| `services` | object | yes |  |

