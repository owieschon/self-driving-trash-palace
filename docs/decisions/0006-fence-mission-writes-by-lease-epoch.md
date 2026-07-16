# ADR 0006: Fence mission writes by lease epoch

This decision prevents an expired worker from mutating a mission after another worker takes ownership.

Status: Accepted

## Context

A heartbeat can detect lease loss while its work continues. An abort signal shortens that work, but it cannot stop an ignored promise or a process that resumes after a pause. Checking a lease before a write also leaves a race between the check and the commit.

Deleting a released lease row creates a second risk: an old token can become indistinguishable from a later lease if an owner or token value repeats.

## Decision

Retain one lease row per organization and mission. Every successful acquisition increments a durable epoch. Renewal and release compare the organization, mission, owner, epoch, token hash, release state, and database expiry time.

Mission-runner mutations use a dedicated fenced unit of work. The transaction validates and locks the current lease row before changing domain state or creating an effect intent. A takeover waits for an already-authorized transaction to finish; a stale worker cannot begin another one.

The heartbeat aborts cooperative work on the first renewal failure. Device calls stay outside the fenced transaction. The transaction instead creates a stable effect intent and transactional outbox record, which the system relay may deliver after the lease changes.

## Consequences

- Lease loss affects liveness immediately and safety at the database boundary.
- A stale release cannot clear a replacement worker's lease.
- A committed effect intent remains valid after takeover; a stale worker cannot create a new one.
- PostgreSQL concurrency tests must prove takeover ordering, expiry, stale release, ignored aborts, and crash recovery.
