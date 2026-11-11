"""Bounded loopback ASGI + real Chromium service integration, not Desktop proof."""
from pathlib import Path
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import uvicorn
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from studio_core.application import Application
DATA = ROOT / 'evidence' / 'p1-service-data'
application = Application(DATA)
spec = importlib.util.spec_from_file_location('p1_service_loopback',ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
api.get_store = lambda: application.bridge
server = FastAPI()
server.include_router(api.router)
server.mount('/code',StaticFiles(directory=ROOT),name='source')
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
config=uvicorn.Config(server,log_level='error',lifespan='off')
worker=uvicorn.Server(config)
thread=threading.Thread(target=lambda:worker.run(sockets=[sock]),daemon=True)
thread.start()
try:
    deadline=time.monotonic()+10
    while not worker.started:
        if time.monotonic()>deadline: raise TimeoutError('loopback server startup')
        time.sleep(0.02)
    result=subprocess.run(['node',str(ROOT/'tests/p1-service-headless.mjs'),f'http://127.0.0.1:{port}'],
        cwd=ROOT,capture_output=True,text=True,timeout=90)
    (ROOT/'evidence/p1-parent-service-browser.txt').write_text(result.stdout+result.stderr)
    print(result.stdout[-8000:]);print(result.stderr[-2000:])
    if result.returncode: raise SystemExit(result.returncode)
    browser=json.loads((ROOT/'evidence/p1-parent-service-browser.json').read_text())
    export=browser['export']
    import hashlib
    png=Path(export['path']);raw=png.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==export['sha256']
    with Image.open(png) as im: im.verify()
    with Image.open(png) as im:
        im.load();assert list(im.size)==[export['width'],export['height']]
    browser['pillow']={'verify':True,'load':True,'sha256':export['sha256'],'path':str(png)}
    (ROOT/'evidence/p1-parent-service-integration.json').write_text(json.dumps(browser,indent=2)+'\n')
    print('Actual HTTP service/GPU integration and exported PNG: PASS (secondary, not Desktop).')
finally:
    worker.should_exit=True
    thread.join(timeout=5)
    sock.close()
