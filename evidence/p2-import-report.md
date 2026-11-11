# P2 image import verification

## Delivered seam

`studio_core.import_image.import_image(root, path)` returns exactly
`{asset: 'assets/<sha256>.png', w, h, sha256, bytes}`. Runtime imports are
stdlib only. No Hermes imports, project mutation, image conversion, or source
writes. The `.png` suffix deliberately does not assert the encoded MIME type.

Copy/hash uses 1 MiB reads without a file-size ceiling. The staged bytes are
re-inspected so returned dimensions describe the copied header even if an
external writer changes the source after preliminary inspection. This is not a
snapshot/locking guarantee against external source writers.

Publication uses fsynced same-directory staging and atomic no-clobber hard links.
Concurrent identical imports converge; existing assets retain their inode and
are checked for digest/size integrity. Ordinary errors remove staging files.
Destination traversal/symlinks are rejected; all destination directory traversal
and file operations use pinned directory descriptors and no-follow flags.
Normal source symlinks are allowed; directories, devices and FIFOs are rejected.
Requires the existing POSIX/Linux filesystem facilities; an unsupported hard-link
operation surfaces as an OSError rather than a non-atomic fallback.

## Format limits (metadata inspection, NOT a full decoder)

- PNG: signature, first IHDR framing/CRC, legal bit-depth/color combinations,
  compression/filter/interlace fields, positive dimensions up to PNG's
  2^31-1 per-axis limit. Returns IHDR dimensions; does not parse PNG eXIf,
  animation chunks, IDAT payloads, or later chunk CRCs.
- JPEG: marker/segment framing through the first SOS, mandatory SOF dimensions,
  segment bounds, component counts; baseline and progressive real fixtures.
  Reads EXIF IFD0 orientation with little- and big-endian TIFF, including APP1
  occurring after SOF. Orientations 5–8 swap logical width/height; bytes are not
  rotated. Unrelated XMP APP1 cannot reset the orientation.
- Static WebP: RIFF/chunk bounds, VP8, VP8L, and VP8X canvas/frame dimensions.
  VP8X canvas must match the static image dimensions. WebP animation and EXIF
  metadata are explicitly unsupported and rejected, avoiding orientation lies.
- Valid metadata does not establish pixel decodability. A header-only PNG is
  intentionally accepted by this helper and explicitly tested as not decodable
  by Pillow. Browser decoding remains mandatory before rendering.

## Sequential RED -> GREEN evidence

- 01: missing module -> exact PNG copy and return contract.
- 02: unsupported JPEG -> baseline/progressive JPEG and EXIF orientation.
- 03 / 03b: repeated imports replaced inode; corrupt digest target overwritten
  -> atomic no-clobber publication, integrity checks and idempotency.
- 04: unsupported WebP -> static VP8 / VP8L / VP8X, clear EXIF/animation rejection.
- 05: unrelated APP1 reset EXIF orientation -> retained orientation.
- 09: stale preliminary dimensions when source changes -> staged-byte metadata.
- 06 / 08: additional regression/edge coverage without production changes.

All fixtures and storage roots are under pytest's configured scratch directory,
not real user projects. Tests use the already available Pillow only for fixtures
and independent decode checks; no dependency installation occurred.

## Exact latest runs

`PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py --python-only -k import_image`

Result (`p2-import-09-green.txt`): **77 passed, 272 deselected in 4.25s**.
Coverage includes a Pillow-decodable PNG larger than 20 MiB; bounded Python
allocation (<8 MiB peak during import), independent streamed hash comparison,
normal source symlinks, malicious root/ancestor/assets/destination symlinks,
symlink swap at destination open, traversal roots, concurrent imports,
unsupported/malformed formats, invalid/missing paths, source timestamps/inode,
atomic publication visibility and injected fsync/link failure cleanup.

`PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py --python-only`

Latest result (`p2-import-10-full-python.txt`): **346 passed, 3 failed, 8 warnings
in 62.68s**. The three failures are concurrent adapter-worker tests, outside this
worker's owned files:
- test_bad_outer_argument_types_fail_before_application_io[recipe-args3]
- test_bad_outer_argument_types_fail_before_application_io[recipe-args4]
- test_bad_outer_argument_types_fail_before_application_io[create_tool-args5]

All fail because invalid outer arguments opened application storage. No import
helper failure. Warnings are existing multiprocessing/fork deprecation warnings.
Earlier full-suite attempt is retained as p2-import-07-full-python.txt (then the
adapter worker had three not-yet-implemented export tests).

`git diff --check -- studio_core/import_image.py tests/test_import_image.py`
returned no diagnostics. No commits, installs, restarts, configuration changes,
or adapter/core/UI edits outside the assigned image helper were made.
