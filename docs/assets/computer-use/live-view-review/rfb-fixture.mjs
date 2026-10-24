// @bun
// ../../../../../../private/tmp/nap-149-browser/server.ts
var peers = new Set();
var stats = { opens: 0, closes: 0, frames: 0, forbidden: 0, encodings: [] };
function frame() {
  const w = 1024,
    h = 768;
  const b = new Uint8Array(16 + w * h * 4);
  const d = new DataView(b.buffer);
  b[3] = 1;
  d.setUint16(8, w);
  d.setUint16(10, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 16 + (y * w + x) * 4;
      const card = x > 250 && x < 774 && y > 180 && y < 590;
      const stripe = card && y > 270 && y < 310;
      b[i] = stripe ? 190 : card ? 38 : 20;
      b[i + 1] = stripe ? 100 : card ? 35 : 18;
      b[i + 2] = stripe ? 52 : card ? 32 : 16;
    }
  return b;
}
var image = frame();
Bun.serve({
  hostname: "127.0.0.1",
  port: 43179,
  fetch(req, server) {
    const url = new URL(req.url);
    const headers = { "Access-Control-Allow-Origin": "*" };
    if (url.pathname === "/stream") {
      if (server.upgrade(req, { data: { stage: 0, sent: false } })) return;
      return new Response("upgrade", { status: 400 });
    }
    if (url.pathname === "/close") {
      for (const ws of peers) ws.close();
      return new Response("closed", { headers });
    }
    return Response.json(stats, { headers });
  },
  websocket: {
    open(ws) {
      peers.add(ws);
      stats.opens++;
      ws.send(
        new TextEncoder().encode(`RFB 003.008
`),
      );
    },
    message(ws, msg) {
      const b = typeof msg === "string" ? new TextEncoder().encode(msg) : new Uint8Array(msg);
      if (ws.data.stage === 0) {
        ws.data.stage = 1;
        ws.send(new Uint8Array([1, 1]));
        return;
      }
      if (ws.data.stage === 1) {
        ws.data.stage = 2;
        ws.send(new Uint8Array([0, 0, 0, 0]));
        return;
      }
      if (ws.data.stage === 2) {
        ws.data.stage = 3;
        const name = new TextEncoder().encode("Nap local fixture");
        const out = new Uint8Array(24 + name.length);
        const d = new DataView(out.buffer);
        d.setUint16(0, 1024);
        d.setUint16(2, 768);
        out.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0], 4);
        d.setUint32(20, name.length);
        out.set(name, 24);
        ws.send(out);
        return;
      }
      let i = 0;
      while (i < b.length) {
        const t = b[i];
        let n = 0;
        if (t === 0) n = 20;
        else if (t === 2) {
          n = 4 + ((b[i + 2] << 8) | b[i + 3]) * 4;
          const d = new DataView(b.buffer, b.byteOffset + i, n);
          const list = [];
          for (let k = 4; k < n; k += 4) list.push(d.getInt32(k));
          stats.encodings.push(list);
        } else if (t === 3) {
          n = 10;
          if (!ws.data.sent) {
            ws.send(image);
            ws.data.sent = true;
            stats.frames++;
          }
        } else if (t === 4) {
          stats.forbidden++;
          n = 8;
        } else if (t === 5) {
          stats.forbidden++;
          n = 6;
        } else if (t === 6) {
          stats.forbidden++;
          n = 8 + new DataView(b.buffer, b.byteOffset + i).getUint32(4);
        } else break;
        i += n;
      }
    },
    close(ws) {
      peers.delete(ws);
      stats.closes++;
    },
  },
});
console.log("local RFB fixture :43179");
