# ADR 0005: Use AWS SDK v3 inside the S3 adapter

Status: Accepted

## Context

Object storage supports knowledge documents and durable attachments. The storage boundary needs portable S3 semantics, bounded reads and streaming uploads. Its SDK dependency must receive compatible security updates without forcing unrelated transitive packages across major versions

## Decision

Use `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` behind the existing `S3ObjectStore` API. Keep endpoint, region, static credentials and addressing mode explicit. The kernel and consuming products do not depend on SDK types

Buffer uploads use `PutObject`; unknown-length streams use bounded multipart uploads with automatic abort on failure. Reads enforce their byte budget while consuming the stream and close the body on every exit. Listing follows continuation tokens and returns deterministic key order. Bucket creation remains an explicit operator action; ordinary writes do not provision buckets

Keep the SDK's checksum defaults. Exercise content type, normalized metadata, pagination, access errors, multipart failure cleanup and response cleanup through HTTP/XML tests and a separate live S3 profile

## Consequences

The adapter remains compatible with S3 services while replacing the previous SDK dependency chain. A compatible service test does not establish support for every AWS deployment policy or every third-party S3 feature

The [AWS migration guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html) describes streamed response consumption and the multipart upload helper
