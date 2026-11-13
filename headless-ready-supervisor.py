from pathlib import Path
import subprocess,os,time,threading,http.server,re,hashlib,json
RUN=Path(__file__).parent
ROOT=Path.cwd()
route=ROOT/'apps/web/src/app/gods-hand-proof'
basecopy=ROOT/'apps/web/src/components/preview-pane-proof-before.tsx'
assert not route.exists()
assert not basecopy.exists()
base=subprocess.check_output(['git','show','4de3797ae606cba50639cd65c2e7e14c306091b4:apps/web/src/components/preview-pane.tsx'])
# The recorded snapshot was local-only; reproduce using the reachable feature HEAD.
after=subprocess.check_output(['git','show','HEAD:apps/web/src/components/preview-pane.tsx'])
assert hashlib.sha256(after).hexdigest()=='e7077f2d9667e036f05605bac3dfa3cc7da31b3db87162c607e15f5a794ca4c2', 'Check out the preview candidate before reproducing'
assert (ROOT/'apps/web/src/components/preview-pane.tsx').read_bytes()==after
(RUN/'fixture-base-pane.tsx').write_bytes(base)
(RUN/'fixture-after-pane.tsx').write_bytes(after)
(RUN/'fixture-source-map.json').write_text(json.dumps({'base':'4de3797ae606cba50639cd65c2e7e14c306091b4','candidateSnapshot':'debc9171b195269a78a82c198dcfb743819241f9','basePaneSHA256':hashlib.sha256(base).hexdigest(),'candidatePaneSHA256':hashlib.sha256(after).hexdigest()},indent=2))
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path=='/thumbnail.svg':
   content=b'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#82b89e"/><text x="45" y="130" fill="#123" font-family="sans-serif" font-size="32">Saved app snapshot</text><rect x="45" y="180" width="490" height="110" rx="12" fill="#deede4"/><text x="65" y="245" fill="#345" font-family="sans-serif" font-size="22">Last successful turn</text></svg>'
   self.send_response(200);self.send_header('Content-type','image/svg+xml');self.send_header('Access-Control-Allow-Origin','http://localhost:4598');self.send_header('Access-Control-Allow-Credentials','true');self.end_headers();self.wfile.write(content);return
  match=re.match(r'/v(\d+)/d(\d+)(.*)',self.path)
  if not match:self.send_error(404);return
  v,delay,path=match.groups();time.sleep(int(delay)/1000)
  content=f'<body style="margin:0;font:600 28px system-ui;display:grid;place-items:center;height:100vh;background:hsl({int(v)*120%360} 70% 85%);color:#123">App version {v}<small style="font-size:16px">path {path or "/"}</small></body>'.encode()
  self.send_response(200);self.send_header('Content-type','text/html');self.end_headers();self.wfile.write(content)
 def log_message(self,*args):pass
server=None;child=None
try:
 route.mkdir();(route/'page.tsx').write_bytes((RUN/'fixture-page.tsx').read_bytes());basecopy.write_bytes(base)
 server=http.server.ThreadingHTTPServer(('127.0.0.1',4599),Handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 with (RUN/'browser-next.log').open('w') as log:
  child=subprocess.Popen(['bunx','next','dev','--port','4598'],cwd=ROOT/'apps/web',stdout=log,stderr=subprocess.STDOUT)
  print('browser fixture starting on 4598, fake server 4599',flush=True)
  subprocess.run(['node',str(RUN/'ready-driver.mjs')],check=True,timeout=60)
  subprocess.run(['/opt/homebrew/bin/ffmpeg','-hide_banner','-loglevel','error','-threads','1','-f','concat','-safe','0','-i',str(RUN/'ready-frames.ffconcat'),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-filter_threads','1','-fps_mode','vfr','-movflags','+faststart','-y',str(RUN/'ready-overlap.mp4')],check=True,timeout=30)
finally:
 if child is not None:
  child.terminate()
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 if server is not None:server.shutdown();server.server_close()
 if basecopy.exists():basecopy.unlink()
 page=route/'page.tsx'
 if page.exists():page.unlink()
 if route.exists():route.rmdir()
 print('browser fixture stopped and owned source files removed',flush=True)
