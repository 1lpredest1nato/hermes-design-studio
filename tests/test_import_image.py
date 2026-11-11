"""Image import contract; all writes are isolated under pytest's scratch root."""
import hashlib
import importlib
from pathlib import Path

from PIL import Image
import pytest
import os
import struct
import zlib
import tracemalloc
from concurrent.futures import ThreadPoolExecutor


def test_import_image_repeated_copy_preserves_existing_inode_and_source(tmp_path):
    source = image_file(tmp_path)
    before = source.stat()
    root = tmp_path / 'data'
    first = importer(root, source)
    destination = root / first['asset']
    inode = destination.stat().st_ino
    assert importer(root, source) == first
    assert destination.stat().st_ino == inode
    assert importer(root, destination) == first
    assert destination.stat().st_ino == inode
    assert (source.stat().st_ino, source.stat().st_mtime_ns, source.stat().st_ctime_ns) == (
        before.st_ino, before.st_mtime_ns, before.st_ctime_ns)
    assert list((root / 'assets').iterdir()) == [destination]


def test_import_image_rejects_existing_corrupt_digest_target(tmp_path):
    source = image_file(tmp_path)
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    assets = tmp_path / 'data' / 'assets'
    assets.mkdir(parents=True)
    target = assets / (sha + '.png')
    target.write_bytes(b'not the digest content')
    with pytest.raises(ValueError, match='integrity'):
        importer(assets.parent, source)
    assert target.read_bytes() == b'not the digest content'
    assert list(assets.iterdir()) == [target]


def test_import_image_large_file_streamed_hash_and_bounded_memory(tmp_path):
    source = image_file(tmp_path)
    png = source.read_bytes()
    block = b'\x87' * (1024 * 1024)
    count = 21
    with source.open('wb') as handle:
        handle.write(png[:-12])
        handle.write(struct.pack('>I', len(block) * count) + b'zzZZ')
        crc = zlib.crc32(b'zzZZ')
        for _ in range(count):
            handle.write(block)
            crc = zlib.crc32(block, crc)
        handle.write(struct.pack('>I', crc))
        handle.write(png[-12:])
    with Image.open(source) as image:
        image.load()
        assert image.size == (31, 19)
    assert source.stat().st_size >= 20 * 1024 * 1024
    expected = hashlib.sha256()
    with source.open('rb') as handle:
        while data := handle.read(1024 * 1024):
            expected.update(data)
    tracemalloc.start()
    try:
        result = importer(tmp_path / 'data', source)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result['sha256'] == expected.hexdigest()
    assert result['bytes'] == source.stat().st_size
    assert peak < 8 * 1024 * 1024
    with (tmp_path / 'data' / result['asset']).open('rb') as handle:
        actual = hashlib.file_digest(handle, 'sha256').hexdigest()
    assert actual == expected.hexdigest()


@pytest.mark.parametrize('kind', ['root', 'ancestor', 'assets', 'destination'])
def test_import_image_rejects_symlink_storage(tmp_path, kind):
    source = image_file(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    root = tmp_path / 'data'
    if kind == 'root':
        root.symlink_to(outside, target_is_directory=True)
    elif kind == 'ancestor':
        (tmp_path / 'link').symlink_to(outside, target_is_directory=True)
        root = tmp_path / 'link' / 'data'
    else:
        root.mkdir()
        if kind == 'assets':
            (root / 'assets').symlink_to(outside, target_is_directory=True)
        else:
            (root / 'assets').mkdir()
            sha = hashlib.sha256(source.read_bytes()).hexdigest()
            (root / 'assets' / (sha + '.png')).symlink_to(source)
    original = source.read_bytes()
    with pytest.raises(ValueError, match='symlink'):
        importer(root, source)
    assert source.read_bytes() == original
    assert list(outside.iterdir()) == []
    assert not list(root.glob('assets/.import-*'))


def test_import_image_rejects_traversal_root(tmp_path):
    source = image_file(tmp_path)
    with pytest.raises(ValueError, match='traversal'):
        importer(tmp_path / 'data' / '..' / 'escape', source)
    assert not (tmp_path / 'escape').exists()


def test_import_image_source_symlink_and_concurrent_imports(tmp_path):
    source = image_file(tmp_path)
    link = tmp_path / 'source-link'
    link.symlink_to(source)
    root = tmp_path / 'data'
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: importer(root, link), range(16)))
    assert all(result == results[0] for result in results)
    assert (root / results[0]['asset']).read_bytes() == source.read_bytes()
    assert sorted(p.name for p in (root / 'assets').iterdir()) == [results[0]['sha256'] + '.png']


@pytest.mark.parametrize('lossless,alpha,extended', [
    (False, False, False), (True, False, False),
    (False, True, False), (True, True, True), (False, False, True)])
def test_import_image_real_webp(tmp_path, lossless, alpha, extended):
    source = tmp_path / 'source.webp'
    image = Image.new('RGBA' if alpha else 'RGB', (31, 19),
                      (20, 50, 80, 100) if alpha else (20, 50, 80))
    options = {'icc_profile': b'test-profile'} if extended else {}
    image.save(source, format='WEBP', lossless=lossless, **options)
    data = source.read_bytes()
    result = importer(tmp_path / 'data', source)
    assert (result['w'], result['h']) == (31, 19)
    assert (tmp_path / 'data' / result['asset']).read_bytes() == data
    assert result['sha256'] == hashlib.sha256(data).hexdigest()


def test_import_image_webp_exif_and_animation_rejected_clearly(tmp_path):
    source = tmp_path / 'source.webp'
    exif = Image.Exif()
    exif[274] = 6
    image = Image.new('RGB', (31, 19), 'red')
    image.save(source, format='WEBP', exif=exif)
    with pytest.raises(ValueError, match='unsupported.*WebP.*EXIF'):
        importer(tmp_path / 'data', source)
    image.save(source, format='WEBP', save_all=True,
               append_images=[Image.new('RGB', (31, 19), 'blue')], duration=100)
    with pytest.raises(ValueError, match='unsupported.*WebP.*animation'):
        importer(tmp_path / 'data', source)
    assert not (tmp_path / 'data').exists()


@pytest.mark.parametrize('orientation', range(1, 9))
def test_import_image_jpeg_orientation_survives_unrelated_app1(tmp_path, orientation):
    exif = Image.Exif()
    exif[274] = orientation
    source = image_file(tmp_path, 'JPEG', exif=exif)
    data = source.read_bytes()
    # Insert unrelated XMP APP1 after the existing EXIF APP1, before SOF.
    position = data.index(b'\xff\xe1')
    next_position = position + 2 + int.from_bytes(data[position + 2:position + 4], 'big')
    xmp = b'http://ns.adobe.com/xap/1.0/\0test'
    source.write_bytes(data[:next_position] + b'\xff\xe1' + struct.pack('>H', len(xmp) + 2) + xmp + data[next_position:])
    result = importer(tmp_path / 'data', source)
    assert (result['w'], result['h']) == ((19, 31) if orientation >= 5 else (31, 19))


@pytest.mark.parametrize('progressive', [False, True])
@pytest.mark.parametrize('orientation', [1, 3, 6, 8])
def test_import_image_real_jpeg_with_exif(tmp_path, progressive, orientation):
    exif = Image.Exif()
    exif[274] = orientation
    source = image_file(tmp_path, 'JPEG', progressive=progressive, exif=exif)
    original = source.read_bytes()
    result = importer(tmp_path / 'data', source)
    expected = (19, 31) if orientation in (6, 8) else (31, 19)
    assert (result['w'], result['h']) == expected
    assert (tmp_path / 'data' / result['asset']).read_bytes() == original
    assert result['sha256'] == hashlib.sha256(original).hexdigest()


def test_import_image_rejects_invalid_or_missing_paths_without_storage(tmp_path):
    root = tmp_path / 'data'
    for value in ('', None, 17, False):
        with pytest.raises(ValueError, match='path'):
            importer(root, value)
    with pytest.raises(FileNotFoundError):
        importer(root, tmp_path / 'missing.png')
    with pytest.raises((ValueError, OSError)):
        importer(root, tmp_path)
    fifo = tmp_path / 'pipe'
    os.mkfifo(fifo)
    for value in (fifo, '/dev/null', '/dev/zero'):
        with pytest.raises(ValueError, match='regular file'):
            importer(root, value)
    assert not root.exists()


@pytest.mark.parametrize('data', [b'', b'GIF89a' + b'\0' * 100,
                                  b'not an image', b'BM' + b'\0' * 100])
def test_import_image_unsupported_format(tmp_path, data):
    source = tmp_path / 'source.png'
    source.write_bytes(data)
    with pytest.raises(ValueError, match='unsupported image format'):
        importer(tmp_path / 'data', source)
    assert not (tmp_path / 'data').exists()


def png_header(w=31, h=19, depth=8, color=2, compression=0, filtering=0, interlace=0):
    payload = b'IHDR' + struct.pack('>IIBBBBB', w, h, depth, color, compression, filtering, interlace)
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + payload + struct.pack('>I', zlib.crc32(payload))


@pytest.mark.parametrize('data', [
    b'\x89PNG\r\n\x1a\n', png_header(w=0), png_header(h=0),
    png_header(w=0x80000000), png_header(h=0xffffffff),
    png_header(depth=3), png_header(color=5), png_header(compression=1),
    png_header(filtering=1), png_header(interlace=2),
    png_header()[:-1] + bytes([png_header()[-1] ^ 1]),
    png_header()[:8] + b'\0\0\0\x0c' + png_header()[12:],
    b'\xff\xd8', b'\xff\xd8\xff\xd9', b'\xff\xd8\xff\xe0\0\1',
    b'\xff\xd8\xff\xe0\xff\xffabc', b'\xff\xd8not-markers',
    b'\xff\xd8\xff\xda\0\x08\x01\x01\0\0\x3f\0',
    b'RIFF\xff\xff\xff\xffWEBPVP8 ',
    b'RIFF\x0c\0\0\0WEBPVP8 \0\0\0\0',
])
def test_import_image_malformed_headers_leave_no_storage(tmp_path, data):
    source = tmp_path / 'broken'
    source.write_bytes(data)
    with pytest.raises(ValueError, match='malformed'):
        importer(tmp_path / 'data', source)
    assert source.read_bytes() == data
    assert not (tmp_path / 'data').exists()


def test_import_image_explicit_metadata_only_not_full_decode(tmp_path):
    # A valid IHDR alone cannot decode, but is sufficient for this helper's
    # deliberately narrow metadata check. The UI must still decode the asset.
    source = tmp_path / 'header-only.png'
    source.write_bytes(png_header(w=0x7fffffff, h=1))
    result = importer(tmp_path / 'data', source)
    assert (result['w'], result['h']) == (0x7fffffff, 1)
    with pytest.raises(OSError):
        Image.open(source).load()


@pytest.mark.parametrize('stage', ['fsync', 'link'])
def test_import_image_io_failure_cleans_temporary_files(tmp_path, monkeypatch, stage):
    source = image_file(tmp_path)
    original = source.read_bytes()
    module = importlib.import_module('studio_core.import_image')

    def fail(*args, **kwargs):
        raise OSError('injected IO failure')

    monkeypatch.setattr(module.os, stage, fail)
    with pytest.raises(OSError, match='injected IO failure'):
        importer(tmp_path / 'data', source)
    assert source.read_bytes() == original
    assert list((tmp_path / 'data' / 'assets').iterdir()) == []


def test_import_image_atomic_publish_has_complete_bytes(tmp_path, monkeypatch):
    source = image_file(tmp_path)
    original = source.read_bytes()
    module = importlib.import_module('studio_core.import_image')
    real_link = module.os.link
    calls = []

    def checked_link(temporary, destination, **kwargs):
        directory = kwargs['src_dir_fd']
        fd = os.open(temporary, os.O_RDONLY, dir_fd=directory)
        with os.fdopen(fd, 'rb') as handle:
            assert handle.read() == original
        with pytest.raises(FileNotFoundError):
            os.stat(destination, dir_fd=directory)
        calls.append(destination)
        return real_link(temporary, destination, **kwargs)

    monkeypatch.setattr(module.os, 'link', checked_link)
    result = importer(tmp_path / 'data', source)
    assert calls == [result['sha256'] + '.png']
    assert len(list((tmp_path / 'data' / 'assets').iterdir())) == 1


@pytest.mark.parametrize('part', ['root', 'assets'])
def test_import_image_rejects_storage_files(tmp_path, part):
    source = image_file(tmp_path)
    root = tmp_path / 'data'
    target = root if part == 'root' else root / 'assets'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'not a directory')
    with pytest.raises(NotADirectoryError):
        importer(root, source)
    assert target.read_bytes() == b'not a directory'


@pytest.mark.parametrize('byteorder', ['little', 'big'])
@pytest.mark.parametrize('after_sof', [False, True])
def test_import_image_exif_endian_and_position(tmp_path, byteorder, after_sof):
    source = image_file(tmp_path, 'JPEG')
    endian = '<' if byteorder == 'little' else '>'
    tiff = (b'II' if byteorder == 'little' else b'MM') + struct.pack(endian + 'HI', 42, 8)
    tiff += struct.pack(endian + 'HHHIH', 1, 274, 3, 1, 6) + b'\0\0' + b'\0\0\0\0'
    exif = b'Exif\0\0' + tiff
    segment = b'\xff\xe1' + struct.pack('>H', len(exif) + 2) + exif
    data = source.read_bytes()
    position = data.index(b'\xff\xda') if after_sof else 2
    source.write_bytes(data[:position] + segment + data[position:])
    result = importer(tmp_path / 'data', source)
    assert (result['w'], result['h']) == (19, 31)


@pytest.mark.parametrize('exif', [
    b'Exif\0\0', b'Exif\0\0XX' + b'\0' * 20,
    b'Exif\0\0MM\0\x2a\xff\xff\xff\xff',
    b'Exif\0\0II\x2a\0\x08\0\0\0\xff\xff',
])
def test_import_image_rejects_malformed_exif(tmp_path, exif):
    source = image_file(tmp_path, 'JPEG')
    segment = b'\xff\xe1' + struct.pack('>H', len(exif) + 2) + exif
    data = source.read_bytes()
    source.write_bytes(data[:2] + segment + data[2:])
    with pytest.raises(ValueError, match='malformed JPEG EXIF'):
        importer(tmp_path / 'data', source)
    assert not (tmp_path / 'data').exists()


@pytest.mark.parametrize('root', ['', None, 7])
def test_import_image_rejects_invalid_root_without_writes(tmp_path, root):
    source = image_file(tmp_path)
    before = sorted(tmp_path.iterdir())
    with pytest.raises(ValueError, match='data root'):
        importer(root, source)
    assert sorted(tmp_path.iterdir()) == before


def test_import_image_destination_symlink_race_cannot_redirect(tmp_path, monkeypatch):
    source = image_file(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    root = tmp_path / 'data'
    (root / 'assets').mkdir(parents=True)
    module = importlib.import_module('studio_core.import_image')
    real_open = module.os.open
    switched = []

    def switch_before_open(path, flags, *args, **kwargs):
        if path == 'assets' and kwargs.get('dir_fd') is not None and not switched:
            switched.append(True)
            (root / 'assets').rmdir()
            (root / 'assets').symlink_to(outside, target_is_directory=True)
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(module.os, 'open', switch_before_open)
    with pytest.raises(OSError):
        importer(root, source)
    assert switched == [True]
    assert list(outside.iterdir()) == []


def test_import_image_metadata_describes_copied_bytes_if_source_changes(tmp_path, monkeypatch):
    source = image_file(tmp_path)
    replacement = tmp_path / 'replacement.png'
    Image.new('RGB', (17, 23), 'green').save(replacement)
    new_bytes = replacement.read_bytes()
    module = importlib.import_module('studio_core.import_image')
    original_dimensions = module._dimensions
    changed = []

    def mutate_after_metadata(handle):
        result = original_dimensions(handle)
        if not changed:
            changed.append(True)
            source.write_bytes(new_bytes)  # Simulated external writer, not helper.
        return result

    monkeypatch.setattr(module, '_dimensions', mutate_after_metadata)
    result = importer(tmp_path / 'data', source)
    assert (result['w'], result['h']) == (17, 23)
    assert result['sha256'] == hashlib.sha256(new_bytes).hexdigest()
    assert (tmp_path / 'data' / result['asset']).read_bytes() == new_bytes


def test_import_image_module_has_no_nonstdlib_imports():
    import ast
    module = importlib.import_module('studio_core.import_image')
    assert module.__file__ is not None
    tree = ast.parse(Path(module.__file__).read_text())
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            imports.add(node.module.split('.')[0])
    import sys
    assert imports <= sys.stdlib_module_names


def importer(root, path):
    return importlib.import_module('studio_core.import_image').import_image(root, path)


def image_file(tmp_path, fmt='PNG', size=(31, 19), **kwargs):
    source = tmp_path / ('source.' + fmt.lower())
    Image.new('RGB', size, (80, 120, 200)).save(source, format=fmt, **kwargs)
    return source


def test_import_image_png_exact_copy_without_project_mutations(tmp_path):
    source = image_file(tmp_path)
    original = source.read_bytes()
    root = tmp_path / 'data'
    result = importer(root, str(source))
    sha = hashlib.sha256(original).hexdigest()
    assert result == dict(asset=f'assets/{sha}.png', w=31, h=19,
                          sha256=sha, bytes=len(original))
    assert (root / result['asset']).read_bytes() == original
    assert source.read_bytes() == original
    assert sorted(str(p.relative_to(root)) for p in root.rglob('*')) == [
        'assets', f'assets/{sha}.png']
