# ADR 0002: Database-first, tenant-scoped memory

Status: accepted

Memory must preserve provenance, permissions and deletion semantics independently of a retrieval index

Canonical memory records live in the authoritative store with tenant scope, ownership and lifecycle metadata. Reads and changes require the corresponding permissions. Search indexes are derived representations and must not broaden access. Context compaction is separate from long-term memory

This makes storage and audit semantics explicit and allows retrieval implementations to change. Deployments still need to validate retention, deletion across derived stores, encryption and retrieval quality for their own workload
