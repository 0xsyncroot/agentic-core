"""Transport-independent document input. Readers know bytes, not S3 or HTTP."""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class FetchedDocument:
    document_id: str
    name: str
    media_type: str
    content: bytes


class DocumentSource(Protocol):
    def read(self, document_id: str) -> FetchedDocument: ...
