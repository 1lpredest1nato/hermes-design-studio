"""Development copy is explicit, bounded to one plugin and hash-verified."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class InstallTests(unittest.TestCase):
    def installer(self):
        path = ROOT / 'scripts' / 'install_dev.py'
        self.assertTrue(path.exists(), 'development installer not implemented')
        spec = importlib.util.spec_from_file_location('studio_install', path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_copy_verifies_hashes_without_shipping_evidence(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temp:
            root = Path(temp)
            src = root / 'src'
            src.mkdir()
            for name in ['plugin.yaml', '__init__.py', 'desktop/plugin.js', 'studio_core/bridge.py', 'evidence/private.txt']:
                p = src / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(name)
            target = root / 'plugins' / 'hermes-design-studio'
            result = self.installer().install(src, target)
            self.assertTrue(result['copy_verified'])
            self.assertEqual((target / 'desktop/plugin.js').read_text(), 'desktop/plugin.js')
            self.assertFalse((target / 'evidence').exists())
            self.assertFalse(target.is_symlink())

    def test_rejects_symlink_payload(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temp:
            root = Path(temp)
            src = root / 'src'
            src.mkdir()
            (src / 'plugin.yaml').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                self.installer().install(src, root / 'plugins' / 'hermes-design-studio')

if __name__ == '__main__':
    unittest.main()
