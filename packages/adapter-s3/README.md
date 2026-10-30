# S3 object storage

`S3ObjectStore` handles bytes for S3-compatible storage. Callers own authorization, accepted content types and key-prefix policy

Composition reads `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` through `s3Config`. Optional settings select region, TLS and path-style addressing. Partial configuration fails closed. A custom prefix can describe a separate store

`normalizeKeyPrefix` adds a trailing slash to nonempty prefixes. Folder names belong in the key prefix, not the bucket name. Writes do not implicitly create buckets; bucket creation is an explicit operator action

Reads enforce byte limits while streaming. The adapter returns original bytes and does not interpret document contents. Knowledge loading and attachment access belong to their consuming services
