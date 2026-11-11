"""Stdlib-only gateway image import, without project or Hermes dependencies.

Header inspection is metadata validation, NOT a full image decode. The browser
must still decode the copied asset before it can render. Stored bytes are exact;
the .png suffix is a storage convention, not a conversion or MIME assertion.
"""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import stat
import struct
import uuid
import zlib


_CHUNK = 1024 * 1024


def _dimensions(handle):
    header = handle.read(33)
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        if len(header) != 33 or header[8:16] != b'\0\0\0\rIHDR':
            raise ValueError('malformed PNG IHDR header')
        if zlib.crc32(header[12:29]) != int.from_bytes(header[29:33], 'big'):
            raise ValueError('malformed PNG IHDR checksum')
        w, h, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', header[16:29])
        depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
        if not (0 < w <= 0x7fffffff and 0 < h <= 0x7fffffff):
            raise ValueError('malformed PNG dimensions')
        if depth not in depths.get(color, ()) or compression or filtering or interlace not in (0, 1):
            raise ValueError('malformed PNG IHDR fields')
        return w, h
    if header.startswith(b'\xff\xd8'):
        handle.seek(2)
        return _jpeg_dimensions(handle)
    if header.startswith(b'RIFF') and header[8:12] == b'WEBP':
        return _webp_dimensions(handle, header)
    raise ValueError('unsupported image format; expected PNG, JPEG, or static WebP')


def _webp_dimensions(handle, header):
    """Inspect RIFF framing and VP8/VP8L/VP8X metadata, never decode pixels."""
    end = int.from_bytes(header[4:8], 'little') + 8
    if end != os.fstat(handle.fileno()).st_size or end < 20:
        raise ValueError('malformed WebP RIFF length')
    position = 12
    canvas = dimensions = None
    while position < end:
        if position + 8 > end:
            raise ValueError('malformed WebP chunk header')
        handle.seek(position)
        chunk = handle.read(8)
        kind = chunk[:4]
        length = int.from_bytes(chunk[4:], 'little')
        following = position + 8 + length + (length & 1)
        if following > end:
            raise ValueError('malformed WebP truncated chunk')
        data = handle.read(min(length, 10))
        if kind == b'VP8X':
            if position != 12 or canvas is not None or length != 10 or data[0] & 0xc1 or data[1:4] != b'\0\0\0':
                raise ValueError('malformed WebP VP8X header')
            if data[0] & 0x02:
                raise ValueError('unsupported WebP animation')
            if data[0] & 0x08:
                raise ValueError('unsupported WebP EXIF orientation metadata')
            canvas = (1 + int.from_bytes(data[4:7], 'little'),
                      1 + int.from_bytes(data[7:10], 'little'))
            if canvas[0] * canvas[1] > 0xffffffff:
                raise ValueError('malformed WebP canvas dimensions')
        elif kind in (b'VP8 ', b'VP8L'):
            if dimensions is not None:
                raise ValueError('malformed WebP duplicate image chunk')
            if kind == b'VP8 ':
                if length < 10 or data[0] & 1 or data[3:6] != b'\x9d\x01\x2a':
                    raise ValueError('malformed WebP VP8 frame header')
                dimensions = (int.from_bytes(data[6:8], 'little') & 0x3fff,
                              int.from_bytes(data[8:10], 'little') & 0x3fff)
                if not all(dimensions):
                    raise ValueError('malformed WebP VP8 dimensions')
            else:
                if length < 5 or data[0] != 0x2f or data[4] & 0xe0:
                    raise ValueError('malformed WebP VP8L frame header')
                packed = int.from_bytes(data[1:5], 'little')
                dimensions = (1 + (packed & 0x3fff), 1 + ((packed >> 14) & 0x3fff))
        elif kind in (b'ANIM', b'ANMF'):
            raise ValueError('unsupported WebP animation')
        elif kind == b'EXIF':
            raise ValueError('unsupported WebP EXIF orientation metadata')
        position = following
    if dimensions is None or (canvas is not None and canvas != dimensions):
        raise ValueError('malformed WebP missing image or inconsistent canvas')
    return dimensions


def _exif_orientation(data):
    """Read only TIFF IFD0 orientation; do not interpret embedded thumbnails."""
    if not data.startswith(b'Exif\0\0'):
        return 1
    tiff = data[6:]
    if len(tiff) < 8 or tiff[:2] not in (b'II', b'MM'):
        raise ValueError('malformed JPEG EXIF header')
    order = 'little' if tiff[:2] == b'II' else 'big'

    def number(offset, length):
        if offset < 0 or offset + length > len(tiff):
            raise ValueError('malformed JPEG EXIF offset')
        return int.from_bytes(tiff[offset:offset + length], order)

    if number(2, 2) != 42:
        raise ValueError('malformed JPEG EXIF TIFF header')
    offset = number(4, 4)
    count = number(offset, 2)
    if offset + 2 + count * 12 + 4 > len(tiff):
        raise ValueError('malformed JPEG EXIF directory')
    for entry in range(offset + 2, offset + 2 + count * 12, 12):
        if number(entry, 2) == 274:
            if number(entry + 2, 2) != 3 or number(entry + 4, 4) != 1:
                raise ValueError('malformed JPEG EXIF orientation')
            orientation = number(entry + 8, 2)
            if orientation not in range(1, 9):
                raise ValueError('malformed JPEG EXIF orientation')
            return orientation
    return 1


def _jpeg_dimensions(handle):
    dimensions = None
    orientation = 1
    sof = set(range(0xc0, 0xd0)) - {0xc4, 0xc8, 0xcc}
    while True:
        if handle.read(1) != b'\xff':
            raise ValueError('malformed JPEG marker header')
        marker = handle.read(1)
        while marker == b'\xff':
            marker = handle.read(1)
        if not marker or marker[0] in (0, 0xd8, 0xd9) or 0xd0 <= marker[0] <= 0xd7:
            raise ValueError('malformed JPEG marker before scan')
        kind = marker[0]
        if kind == 1:  # TEM is the only standalone marker before a scan.
            continue
        raw_length = handle.read(2)
        if len(raw_length) != 2:
            raise ValueError('malformed JPEG segment length')
        length = int.from_bytes(raw_length, 'big')
        if length < 2:
            raise ValueError('malformed JPEG segment length')
        data = handle.read(length - 2)
        if len(data) != length - 2:
            raise ValueError('malformed JPEG truncated segment')
        if kind == 0xe1 and data.startswith(b'Exif\0\0'):
            orientation = _exif_orientation(data)
        elif kind in sof:
            if dimensions is not None or len(data) < 6:
                raise ValueError('malformed JPEG SOF header')
            precision, h, w, components = struct.unpack('>BHHB', data[:6])
            if not w or not h or precision not in (8, 12, 16) or not components or len(data) != 6 + 3 * components:
                raise ValueError('malformed JPEG SOF dimensions or fields')
            dimensions = (w, h)
        elif kind == 0xda:
            if dimensions is None or not data or not data[0] or len(data) != 4 + 2 * data[0]:
                raise ValueError('malformed JPEG scan header or missing SOF')
            return dimensions[::-1] if orientation in (5, 6, 7, 8) else dimensions


@contextmanager
def _asset_directory(root):
    """Walk from / with no-follow directory descriptors, pinning every lookup."""
    if not isinstance(root, (str, os.PathLike)) or not os.fspath(root):
        raise ValueError('data root must be a nonempty filesystem path')
    root = Path(root).absolute()
    if '..' in root.parts:
        raise ValueError('traversal in data root is forbidden')
    directory = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in (*root.parts[1:], 'assets'):
            try:
                os.mkdir(part, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            if stat.S_ISLNK(os.stat(part, dir_fd=directory, follow_symlinks=False).st_mode):
                raise ValueError('symlink data root or asset storage is forbidden')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory
    finally:
        os.close(directory)


def _verify_existing(directory, name, sha, size):
    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise ValueError('symlink asset destination is forbidden')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, 'rb') as existing:
        info = os.fstat(existing.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('asset destination must be a regular file')
        if info.st_size != size or hashlib.file_digest(existing, 'sha256').hexdigest() != sha:
            raise ValueError('existing content-addressed asset failed integrity check')


def import_image(root, path):
    """Copy a regular gateway file to immutable content-addressed asset storage.

    No source writes, project mutation, conversion, file-size ceiling, or external
    dependencies. JPEG dimensions account for EXIF IFD0 orientation (5–8 swap
    axes); pixels and metadata remain unchanged. Invalid metadata raises
    ValueError; filesystem failures retain their OSError subclasses. Normal
    source symlinks are allowed. Destinations are pinned, no-follow directories.
    """
    if not isinstance(path, (str, os.PathLike)) or not os.fspath(path):
        raise ValueError('image path must be a nonempty filesystem path')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb', buffering=0) as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('image source must be a regular file')
        w, h = _dimensions(source)
        source.seek(0)
        with _asset_directory(root) as directory:
            temporary = '.import-' + uuid.uuid4().hex
            target_fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                0o600, dir_fd=directory)
            try:
                digest = hashlib.sha256()
                size = 0
                with os.fdopen(target_fd, 'w+b') as target:
                    while chunk := source.read(_CHUNK):
                        target.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                    target.flush()
                    # A source may be edited externally during IO. Metadata must
                    # describe the staged bytes, not a stale preliminary header.
                    target.seek(0)
                    w, h = _dimensions(target)
                    os.fsync(target.fileno())
                sha = digest.hexdigest()
                destination = sha + '.png'
                try:
                    # Atomic no-clobber publish: concurrent identical imports
                    # converge without replacing any existing source/asset inode.
                    os.link(temporary, destination, src_dir_fd=directory,
                            dst_dir_fd=directory, follow_symlinks=False)
                except FileExistsError:
                    _verify_existing(directory, destination, sha, size)
            finally:
                os.unlink(temporary, dir_fd=directory)
            os.fsync(directory)
    return dict(asset=f'assets/{sha}.png', w=w, h=h, sha256=sha, bytes=size)
