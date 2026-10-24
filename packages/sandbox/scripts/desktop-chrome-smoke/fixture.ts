import { createServer } from "node:http";

// Only fixture event handlers mutate the DOM. The smoke drives production physical input.
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Nap Chrome smoke</title>
<style>
body{margin:24px;background:#111827;color:#e5e7eb;font:18px sans-serif}h1{font-size:28px;margin:0 0 12px}p{margin:12px 0}
input,button{font:18px sans-serif;padding:8px}button{background:#a7f3d0}
#result{min-height:25px;color:#a7f3d0}#scroller{height:130px;width:450px;overflow:auto;border:3px solid #60a5fa}
#tall{height:900px;background:linear-gradient(#1e40af,#0369a1)}
#track{width:500px;height:84px;position:relative;background:#374151;margin-top:14px}
#handle{width:60px;height:60px;position:absolute;left:10px;top:12px;background:#fbbf24;touch-action:none}
</style>
<h1>Actual Chrome physical input</h1><p id="origin"></p>
<form><label>Name <input id="name" autocomplete="off"></label> <button>Apply</button></form>
<p id="result">Waiting for input</p>
<div id="scroller"><div id="tall">Scroll this blue panel</div></div><p id="scroll-result">Scroll: waiting</p>
<div id="track"><div id="handle"></div></div><p id="drag-result">Drag: waiting</p>
<script>
document.querySelector('#origin').textContent='Origin '+location.origin;
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();${process.env.NAP_CHROME_SMOKE_FAULT === "typing" ? "" : "document.querySelector('#result').textContent='Applied: '+document.querySelector('#name').value;"}});
const scroller=document.querySelector('#scroller');scroller.addEventListener('scroll',()=>{document.querySelector('#scroll-result').textContent='Scroll: '+scroller.scrollTop;});
const handle=document.querySelector('#handle');let start;
handle.addEventListener('pointerdown',event=>{start=event.clientX;handle.setPointerCapture(event.pointerId);});
handle.addEventListener('pointermove',event=>{if(start!==undefined){const distance=Math.max(0,Math.min(400,event.clientX-start));handle.style.left=(10+distance)+'px';document.querySelector('#drag-result').textContent='Drag: '+distance;}});
handle.addEventListener('pointerup',()=>{start=undefined;});
console.log('fixture ready',location.origin);
</script></html>`;
for (const port of [5173, 5174]) {
  createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(page);
  }).listen(port, "0.0.0.0", () => console.log(`Fixture ready on ${port}`));
}
