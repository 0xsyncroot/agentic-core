import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { S3ObjectStore, type S3Config } from "../src/index.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** Exercise the SDK's real signed HTTP/XML transport against a deterministic local S3 endpoint. */
async function endpoint(t: TestContext, handler: Handler, overrides: Partial<S3Config> = {}) {
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    Promise.resolve().then(() => handler(request, response)).catch(error => {
      errors.push(error);
      response.writeHead(500).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.deepEqual(errors, [], "the fake service must satisfy its wire assertions");
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new S3ObjectStore({ endPoint: "127.0.0.1", port: address.port, useSSL: false,
    accessKey: "test-access", secretKey: "test-secret", region: "us-east-1", bucket: "test-bucket", pathStyle: true, ...overrides });
}

async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function xml(response: ServerResponse, body: string, status = 200) {
  response.writeHead(status, { "content-type": "application/xml" }).end(body);
}

test("buffer and unknown-length uploads preserve bytes, content type and normalized user metadata", async t => {
  const payload = Buffer.from([0, 255, 4, 13, 10]);
  let puts = 0;
  const store = await endpoint(t, async (request, response) => {
    assert.equal(request.method, "PUT");
    assert.match(request.url!, /^\/test-bucket\/folder\/binary/u);
    assert.match(request.headers.authorization!, /Credential=test-access\/\d+\/us-east-1\/s3\/aws4_request/u);
    assert.equal(request.headers["content-type"], "application/octet-stream");
    assert.equal(request.headers["x-amz-meta-origin"], "test");
    assert.equal(request.headers["x-amz-meta-x-amz-meta-origin"], undefined);
    assert.deepEqual(await bytes(request), payload);
    puts++;
    response.writeHead(200, { etag: '"binary"' }).end();
  });
  const options = { contentType: "application/octet-stream", metadata: { "X-Amz-Meta-Origin": "test" } };
  await store.put("folder/binary", payload, options);
  await store.put("folder/binary", Readable.from([payload.subarray(0, 2), payload.subarray(2)]), options);
  assert.equal(puts, 2);
});

test("listing follows continuation pages, preserves metadata and sorts all keys", async t => {
  let calls = 0;
  const store = await endpoint(t, (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    assert.equal(url.searchParams.get("prefix"), "docs/");
    assert.equal(url.searchParams.get("delimiter"), null);
    calls++;
    const first = calls === 1;
    assert.equal(url.searchParams.get("continuation-token"), first ? null : "page/2");
    xml(response, `<ListBucketResult><IsTruncated>${first}</IsTruncated>${first ? "<NextContinuationToken>page/2</NextContinuationToken>" : ""}<Contents><Key>docs/${first ? "z" : "a"}</Key><Size>7</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;etag-value&quot;</ETag></Contents></ListBucketResult>`);
  });
  const found = await store.list("docs/");
  assert.equal(calls, 2);
  assert.deepEqual(found.map(item => item.key), ["docs/a", "docs/z"]);
  assert.equal(found[0]!.etag, "etag-value");
  assert.equal(found[0]!.size, 7);
  assert.equal(found[0]!.lastModified?.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("truncated listings with missing or repeated tokens fail rather than lose data or loop", async t => {
  for (const token of ["", "same-token"]) {
    let calls = 0;
    const store = await endpoint(t, (_request, response) => {
      calls++;
      xml(response, `<ListBucketResult><IsTruncated>true</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}</ListBucketResult>`);
    });
    await assert.rejects(store.list(), /invalid continuation token/u);
    assert.equal(calls, token ? 2 : 1);
  }
});

test("get enforces a streaming byte limit and closes an oversized response", async t => {
  let closed!: () => void;
  const responseClosed = new Promise<void>(resolve => { closed = resolve; });
  const store = await endpoint(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(4));
    const timer = setInterval(() => response.write(Buffer.alloc(4)), 5);
    response.once("close", () => { clearInterval(timer); closed(); });
  });
  await assert.rejects(store.get("large", 4), /exceeds 4 bytes/u);
  await responseClosed;
  await assert.rejects(store.get("large", Infinity), /non-negative safe integer/u);
});

test("get preserves binary bytes at the exact bound and rejects an oversized Content-Length", async t => {
  const data = Buffer.from([0, 255, 10]);
  const store = await endpoint(t, (_request, response) => {
    response.writeHead(200, { "content-length": data.length }).end(data);
  });
  assert.deepEqual(await store.get("data", 3), data);
  await assert.rejects(store.get("data", 2), /exceeds 2 bytes/u);
});

test("stat maps missing keys to undefined and preserves metadata without swallowing denied access", async t => {
  const store = await endpoint(t, (request, response) => {
    assert.equal(request.method, "HEAD");
    if (request.url?.includes("missing")) response.writeHead(404).end();
    else if (request.url?.includes("denied")) response.writeHead(403).end();
    else response.writeHead(200, { "content-length": "12", "content-type": "text/csv", "x-amz-meta-filename": "%E2%82%AC.csv", "x-amz-meta-tenant": "tenant-a" }).end();
  });
  assert.equal(await store.stat("missing"), undefined);
  assert.deepEqual(await store.stat("present"), { size: 12, contentType: "text/csv", metadata: { filename: "%E2%82%AC.csv", tenant: "tenant-a" } });
  await assert.rejects(store.stat("denied"), error => (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode === 403);
});

test("explicit provisioning creates only missing buckets and uses the configured region", async t => {
  for (const region of ["us-east-1", "eu-west-1"]) {
    let creates = 0;
    const store = await endpoint(t, async (request, response) => {
      if (request.method === "HEAD") response.writeHead(404).end();
      else {
        assert.equal(request.method, "PUT");
        const body = (await bytes(request)).toString();
        if (region === "us-east-1") assert.equal(body.includes("LocationConstraint"), false);
        else assert.match(body, /<LocationConstraint>eu-west-1<\/LocationConstraint>/u);
        creates++;
        response.writeHead(200).end();
      }
    }, { region });
    await store.ensureBucket();
    assert.equal(creates, 1);
  }
  const denied = await endpoint(t, (request, response) => {
    assert.equal(request.method, "HEAD", "an authorization failure must not cause a create");
    response.writeHead(403).end();
  });
  await assert.rejects(denied.ensureBucket());
});

test("virtual-hosted addressing uses the bucket hostname when configured", async t => {
  const lookup = dns.lookup;
  t.mock.method(dns, "lookup", (...args: Parameters<typeof dns.lookup>) => {
    if (args[0] === "test-bucket.localhost") args[0] = "127.0.0.1";
    return Reflect.apply(lookup, dns, args);
  });
  const store = await endpoint(t, (request, response) => {
    assert.match(request.headers.host!, /^test-bucket\.localhost:/u);
    assert.match(request.url!, /^\/key/u);
    response.writeHead(204).end();
  }, { endPoint: "localhost", pathStyle: false });
  await store.remove("key");
});

test("failed multipart uploads abort their uploaded parts", async t => {
  let aborted = false;
  const store = await endpoint(t, async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    await bytes(request);
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      xml(response, "<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>large</Key><UploadId>failed-upload</UploadId></InitiateMultipartUploadResult>");
    } else if (request.method === "DELETE") {
      assert.equal(url.searchParams.get("uploadId"), "failed-upload");
      aborted = true;
      response.writeHead(204).end();
    } else {
      xml(response, "<Error><Code>AccessDenied</Code><Message>Denied by test service</Message></Error>", 403);
    }
  });
  await assert.rejects(store.put("large", Readable.from([Buffer.alloc(6 * 1024 * 1024)])));
  assert.equal(aborted, true);
});
