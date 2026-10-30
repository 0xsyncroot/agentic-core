"""Reads one object from S3-compatible storage (MinIO, Ceph RGW, AWS) — a signed GET, stdlib only.

Configuration is read from `<P>_ENDPOINT`, `<P>_BUCKET`, `<P>_ACCESS_KEY`, `<P>_SECRET_KEY` and the
optional `<P>_REGION` (default us-east-1), `<P>_PATH_STYLE`, `<P>_USE_SSL`, where `<P>` is
`DOCUMENT_S3_ENV_PREFIX` (default `S3`: the shared `S3_*` settings the backends read for the same
bucket, so a deployment carries the credentials once). The retired prefixes `AGENTIC_KNOWLEDGE_S3`,
`AGENTIC_S3` and `DOCUMENT_S3` still configure the shared set, with one warning per name; any other
prefix names a bucket of its own. Documents live under `DOCUMENT_S3_PREFIX` + documentId.

Same endpoint rules as the TypeScript adapter (`packages/adapter-s3`): an endpoint without a scheme
means https unless it is loopback; path-style addressing unless the host is amazonaws.com.
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from settings import read_setting

EMPTY_PAYLOAD_SHA256 = hashlib.sha256(b"").hexdigest()
SHARED_S3_PREFIX = "S3"
RETIRED_S3_PREFIXES = ("AGENTIC_KNOWLEDGE_S3", "AGENTIC_S3", "DOCUMENT_S3")
FETCH_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class S3Location:
    base_url: str  # scheme://host[:port]
    host: str      # host[:port] exactly as sent in the Host header
    bucket: str
    path_style: bool
    region: str
    access_key: str
    secret_key: str
    key_prefix: str


@dataclass(frozen=True)
class S3Object:
    content: bytes
    content_type: str
    metadata: dict[str, str]


class S3NotFound(Exception):
    pass


class S3TooLarge(RuntimeError):
    """The object is larger than the caller is willing to load."""


def configured_location() -> S3Location | None:
    """The configured bucket, or None when no S3 variables are set at all (partial config raises)."""
    requested = read_setting("DOCUMENT_S3_ENV_PREFIX") or SHARED_S3_PREFIX
    shared = requested == SHARED_S3_PREFIX or requested in RETIRED_S3_PREFIXES
    prefix = SHARED_S3_PREFIX if shared else requested
    retired = tuple(dict.fromkeys(p for p in (requested, *RETIRED_S3_PREFIXES) if p != SHARED_S3_PREFIX)) if shared else ()

    def read(name: str) -> str:
        return read_setting(f"{prefix}_{name}", tuple(f"{old}_{name}" for old in retired)) or ""

    endpoint, bucket, access_key, secret_key = read("ENDPOINT"), read("BUCKET"), read("ACCESS_KEY"), read("SECRET_KEY")
    if not (endpoint or bucket or access_key or secret_key):
        return None
    missing = [name for name, value in (("ENDPOINT", endpoint), ("BUCKET", bucket), ("ACCESS_KEY", access_key), ("SECRET_KEY", secret_key)) if not value]
    if missing:
        raise RuntimeError("object storage is partly configured; missing " + ", ".join(f"{prefix}_{name}" for name in missing))
    has_scheme = endpoint.startswith(("http://", "https://"))
    parsed = urllib.parse.urlsplit(endpoint if has_scheme else f"https://{endpoint}")
    hostname = parsed.hostname or ""
    loopback = hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0")
    use_ssl_setting = read("USE_SSL")
    use_ssl = use_ssl_setting == "true" if use_ssl_setting else (parsed.scheme == "https" if has_scheme else not loopback)
    path_style_setting = read("PATH_STYLE")
    path_style = path_style_setting == "true" if path_style_setting else not hostname.endswith("amazonaws.com")
    host = parsed.netloc if path_style else f"{bucket}.{parsed.netloc}"
    key_prefix = os.environ.get("DOCUMENT_S3_PREFIX", "").strip().lstrip("/")
    if key_prefix and not key_prefix.endswith("/"):
        key_prefix += "/"
    return S3Location(
        base_url=f"{'https' if use_ssl else 'http'}://{host}", host=host, bucket=bucket, path_style=path_style,
        region=read("REGION") or "us-east-1", access_key=access_key, secret_key=secret_key, key_prefix=key_prefix,
    )


def _uri_encode(value: str, keep_slash: bool = False) -> str:
    return urllib.parse.quote(value, safe="-_.~" + ("/" if keep_slash else ""))


def _sign(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def get_object(location: S3Location, key: str, max_bytes: int) -> S3Object:
    """Signed GET (AWS Signature V4). Raises S3NotFound for a missing object, S3TooLarge for one over max_bytes, RuntimeError otherwise."""
    path = "/" + (_uri_encode(location.bucket) + "/" if location.path_style else "") + _uri_encode(key, keep_slash=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    canonical_headers = f"host:{location.host}\nx-amz-content-sha256:{EMPTY_PAYLOAD_SHA256}\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = f"GET\n{path}\n\n{canonical_headers}\n{signed_headers}\n{EMPTY_PAYLOAD_SHA256}"
    scope = f"{date}/{location.region}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
    signing_key = _sign(_sign(_sign(_sign(("AWS4" + location.secret_key).encode("utf-8"), date), location.region), "s3"), "aws4_request")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    request = urllib.request.Request(location.base_url + path, method="GET", headers={
        "Host": location.host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
        "Authorization": f"AWS4-HMAC-SHA256 Credential={location.access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
    })
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:  # noqa: S310 - configured storage endpoint
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise S3TooLarge(f"object exceeds the {max_bytes} byte limit")
            metadata = {name.lower()[len("x-amz-meta-"):]: value for name, value in response.headers.items() if name.lower().startswith("x-amz-meta-")}
            return S3Object(content=body, content_type=response.headers.get("Content-Type", ""), metadata=metadata)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise S3NotFound(key) from error
        raise RuntimeError(f"object storage returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"object storage is unreachable: {error.reason}") from error
