"""Ephemeral local files received over internal HTTP. This service has no S3 adapter."""
import json
from pathlib import Path
import re
import time

from errors import ToolInputError
from file_source import FetchedDocument

MAX_FILE_BYTES = 25 * 1024 * 1024


class FileStore:
    def __init__(self, directory: str):
        self.directory = Path(directory)

    def read(self, document_id: str) -> FetchedDocument:
        if not isinstance(document_id, str) or not re.fullmatch(r'[0-9a-f]{32}', document_id):
            raise ToolInputError('Invalid file handle')
        try:
            metadata = json.loads((self.directory / f'{document_id}.json').read_text())
            if metadata['expiresAt'] <= time.time() * 1000:
                raise ToolInputError('File handle expired; send the original file again')
            with open(self.directory / document_id, 'rb') as handle:
                content = handle.read(MAX_FILE_BYTES + 1)
            if len(content) > MAX_FILE_BYTES:
                raise ToolInputError('File exceeds 25 MiB')
            return FetchedDocument(document_id, metadata['name'], metadata['mediaType'], content)
        except (OSError, ValueError, KeyError) as error:
            raise ToolInputError('File handle is unknown or expired; send the original file again') from error
