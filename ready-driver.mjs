import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const { chromium }=await import(pathToFileURL(path.join(process.cwd(),'node_modules/.bun/playwright-core@1.57.0/node_modules/playwright-core/index.mjs')).href);
const out=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 for(let i=0;i<15;i++){try{await page.goto('http://localhost:4598/gods-hand-proof',{waitUntil:'domcontentloaded',timeout:3000});break;}catch(e){if(i===14)throw e;await page.waitForTimeout(300);}}
 await page.getByRole('button',{name:'Ready version 1',exact:true}).click();
 await page.waitForFunction(()=>{const fs=Array.from(document.querySelectorAll('iframe'));return fs.length===2&&fs.every(f=>getComputedStyle(f).opacity==='1'&&f.getAttribute('aria-hidden')!=='true');},{timeout:10000});
 for(const f of page.frames().filter(f=>f.url().includes('/v1/d2500'))){if(!(await f.locator('body').textContent()).includes('App version 1'))throw new Error('Initial app1 not loaded');}
 const cdp=await page.context().newCDPSession(page);
 const frames=[];
 cdp.on('Page.screencastFrame',async e=>{const file=`ready-frame-${String(frames.length).padStart(4,'0')}.jpg`;fs.writeFileSync(path.join(out,file),Buffer.from(e.data,'base64'));frames.push({file,timestamp:e.metadata.timestamp});await cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});});
 await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1280,maxHeight:800,everyNthFrame:6});
 const before=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ready-before-loaded.png'),Buffer.from(before.data,'base64'));
 await page.evaluate(()=>{window.__readyProof={started:performance.now(),samples:[]};const sample=label=>{window.__readyProof.samples.push({label,ms:performance.now()-window.__readyProof.started,frames:Array.from(document.querySelectorAll('iframe')).map(f=>({src:f.src,opacity:getComputedStyle(f).opacity,inert:f.inert,ariaHidden:f.getAttribute('aria-hidden')})),statuses:Array.from(document.querySelectorAll('[role="status"]')).map(e=>e.textContent)});};sample('initial');setTimeout(()=>{Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Ready version 2').click();window.__readyProof.ready2At=performance.now()-window.__readyProof.started;setTimeout(()=>sample('pending500'),500);},1000);setTimeout(()=>sample('sample6000'),6000);});
 await page.waitForTimeout(1500);
 const pending=await page.evaluate(()=>({ms:performance.now()-window.__readyProof.started,ready2At:window.__readyProof.ready2At,frames:Array.from(document.querySelectorAll('iframe')).map(f=>({src:f.src,opacity:getComputedStyle(f).opacity,inert:f.inert,ariaHidden:f.getAttribute('aria-hidden')})),statuses:Array.from(document.querySelectorAll('[role="status"]')).map(e=>e.textContent)}));
 if(pending.frames.length!==3||!pending.statuses.includes('Updating the preview…'))throw new Error('No pending ready overlap: '+JSON.stringify(pending));
 const old=pending.frames.find(f=>f.src.includes('/v1/'));if(!old?.inert||old.ariaHidden!=='true')throw new Error('Old frame reachable');
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ready-overlap-comparison.png'),Buffer.from(shot.data,'base64'));
 await page.waitForTimeout(6500);
 const proof=await page.evaluate(()=>window.__readyProof);proof.pendingCapture=pending;
 const final=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ready-final-capture.png'),Buffer.from(final.data,'base64'));
 await cdp.send('Page.stopScreencast');
 if(frames.length<2)throw new Error('No screencast frames');
 const first=frames[0].timestamp;const last=frames.at(-1).timestamp;if(last-first>20)throw new Error('Recording exceeds20s');
 fs.writeFileSync(path.join(out,'ready-dom-proof.json'),JSON.stringify({...proof,recording:{frames:frames.length,first,last,duration:last-first},browser:'Headless Chrome via Playwright/CDP after two shared-browser capture failures'},null,2));
 const concat=['ffconcat version 1.0'];for(let i=0;i<frames.length;i++){concat.push(`file '${frames[i].file}'`);if(i+1<frames.length)concat.push(`duration ${Math.max(.001,frames[i+1].timestamp-frames[i].timestamp)}`);}concat.push(`file '${frames.at(-1).file}'`);fs.writeFileSync(path.join(out,'ready-frames.ffconcat'),concat.join('\n')+'\n');
 console.log(JSON.stringify({pending,frameCount:frames.length,recordedSeconds:last-first}));
} finally {await browser.close();}
