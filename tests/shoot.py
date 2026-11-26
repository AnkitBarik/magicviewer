#!/usr/bin/env python3
"""Drive headless Chrome over the DevTools protocol: open a page, run optional
JavaScript, wait until a JS condition holds, print console output and save a
screenshot.

    python tests/shoot.py URL OUT.png [--wait 'JS expr'] [--eval 'JS'] [--size 1400x900]
                          [--file PATH]

--file picks a local file in the page's file input (#fileInput), as a user would,
which also works for file:// pages, e.g.
    python tests/shoot.py file://$PWD/index.html out.png --file /data/G_1.run \
        --wait "document.documentElement.dataset.state === 'ready'"

Requires google-chrome and the websocket-client package.
"""
import argparse
import base64
import json
import os
import subprocess
import tempfile
import time
import urllib.request

import websocket

ap = argparse.ArgumentParser()
ap.add_argument('url')
ap.add_argument('out')
ap.add_argument('--wait', default="document.title.startsWith('READY')")
ap.add_argument('--eval', action='append', default=[])
ap.add_argument('--size', default='1400x900')
ap.add_argument('--timeout', type=float, default=180)
ap.add_argument('--chrome', default='google-chrome')
ap.add_argument('--dark', action='store_true')
ap.add_argument('--file', help='local file to pick in #fileInput')
a = ap.parse_args()
w, h = map(int, a.size.split('x'))

prof = tempfile.mkdtemp(prefix='shoot-')
port = 9333
proc = subprocess.Popen([a.chrome, '--headless=new', '--no-sandbox', '--use-angle=swiftshader',
                         '--enable-unsafe-swiftshader', f'--user-data-dir={prof}',
                         f'--remote-debugging-port={port}', f'--window-size={w},{h}', 'about:blank'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
            tab = next(t for t in tabs if t['type'] == 'page')
            break
        except Exception:
            time.sleep(0.1)
    ws = websocket.create_connection(tab['webSocketDebuggerUrl'], timeout=a.timeout)
    nid = [0]
    logs = []

    def send(method, **params):
        nid[0] += 1
        ws.send(json.dumps({'id': nid[0], 'method': method, 'params': params}))
        while True:
            m = json.loads(ws.recv())
            if m.get('method') == 'Runtime.consoleAPICalled':
                logs.append(' '.join(str(x.get('value', x.get('description', ''))) for x in m['params']['args']))
            elif m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                logs.append('EXCEPTION ' + d.get('exception', {}).get('description', d.get('text', '')))
            if m.get('id') == nid[0]:
                return m.get('result', {})

    send('Runtime.enable')
    send('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=w < 700)
    send('Page.enable')
    # headless pages are not focused, so focus/blur events would not fire otherwise
    send('Emulation.setFocusEmulationEnabled', enabled=True)
    if a.dark:
        send('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': 'dark'}])
    send('Page.navigate', url=a.url)
    t0 = time.time()
    if a.file:
        # wait until the app has started (main.js sets the memory meter), then pick the file
        while time.time() - t0 < a.timeout:
            r = send('Runtime.evaluate', returnByValue=True,
                     expression="!!document.getElementById('memText')?.textContent")
            if r.get('result', {}).get('value'):
                break
            time.sleep(0.25)
        doc = send('DOM.getDocument')
        node = send('DOM.querySelector', nodeId=doc['root']['nodeId'], selector='#fileInput')
        send('DOM.setFileInputFiles', nodeId=node['nodeId'], files=[os.path.abspath(a.file)])
    for js in a.eval:
        time.sleep(0.5)
        send('Runtime.evaluate', expression=js, awaitPromise=True)
    ok = False
    while time.time() - t0 < a.timeout:
        r = send('Runtime.evaluate', expression=f'!!({a.wait})', returnByValue=True)
        if r.get('result', {}).get('value'):
            ok = True
            break
        time.sleep(0.25)
    time.sleep(0.5)
    shot = send('Page.captureScreenshot', format='png')
    with open(a.out, 'wb') as f:
        f.write(base64.b64decode(shot['data']))
    status = send('Runtime.evaluate', expression="document.getElementById('statusText')?.textContent", returnByValue=True)
    print(f"{'ok' if ok else 'TIMEOUT'} after {time.time() - t0:.1f}s; status: {status.get('result', {}).get('value')}")
    for l in logs:
        print('console:', l)
finally:
    proc.kill()
