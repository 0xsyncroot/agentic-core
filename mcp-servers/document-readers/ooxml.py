"""Bound OOXML expansion and XML trees before parsing untrusted Office uploads."""
from xml.etree import ElementTree as ET

from errors import ToolInputError

MAX_PART_BYTES = 16 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_PARTS = 10_000
MAX_XML_ELEMENTS = 500_000


def validate_archive(archive):
    parts = archive.infolist()
    if len(parts) > MAX_PARTS or sum(part.file_size for part in parts) > MAX_EXPANDED_BYTES:
        raise ToolInputError('Office package exceeds the expanded size or part count limit', code='document_too_large')
    if any(part.file_size > MAX_PART_BYTES or part.flag_bits & 1 for part in parts):
        raise ToolInputError('Office package has an oversized or encrypted part', code='document_too_large')


class _BoundedTree(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.elements = 0

    def start(self, tag, attributes):
        self.elements += 1
        if self.elements > MAX_XML_ELEMENTS:
            raise ToolInputError('Office XML exceeds the element limit', code='document_too_large')
        return super().start(tag, attributes)

    def doctype(self, name, pubid, system):
        raise ToolInputError('Document type declarations are not allowed in Office XML')


def read_xml(archive, name):
    # Validate the actual expansion too; ZIP metadata is supplied by the uploader.
    with archive.open(name) as part:
        content = part.read(MAX_PART_BYTES + 1)
    if len(content) > MAX_PART_BYTES:
        raise ToolInputError('Office XML exceeds the part size limit', code='document_too_large')
    return ET.fromstring(content, parser=ET.XMLParser(target=_BoundedTree()))
