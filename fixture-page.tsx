"use client";
import { useState } from "react";
import { PreviewPane as Before } from "../../components/preview-pane-proof-before.tsx";
import { PreviewPane as After } from "../../components/preview-pane.tsx";
import type { ProjectPhase } from "../../projects/project-phase.ts";

export default function Proof() {
  const [phase, setPhase] = useState<ProjectPhase>({ kind: "starting" });
  const [reloads, setReloads] = useState(0);
  const [route, setRoute] = useState("/");
  const ready = (seq: number) => setPhase({kind:"running",url:`http://localhost:4599/v${seq}/d2500`,seq});
  return <main style={{padding:20,height:"100vh",boxSizing:"border-box",display:"flex",flexDirection:"column",gap:12,background:"#141417",color:"#ddd",fontFamily:"system-ui"}}>
    <h1 style={{fontSize:20,margin:0}}>Preview startup and replacement · local fake server</h1>
    <p style={{margin:0,fontSize:13}}>Each iframe response waits 2.5 seconds. Both panes below are actual repository components.</p>
    <nav aria-label="Fixture controls" style={{display:"flex",gap:12}}>
      <button type="button" onClick={()=>setPhase({kind:"starting"})}>Starting</button>
      <button type="button" onClick={()=>ready(1)}>Ready version 1</button>
      <button type="button" onClick={()=>ready(2)}>Ready version 2</button>
      <button type="button" onClick={()=>setReloads(x=>x+1)}>Reload</button>
      <button type="button" onClick={()=>setRoute(x=>x==="/"?"/pricing":"/")}>Change route</button>
    </nav>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,flex:1,minHeight:0}}>
      <div style={{display:"flex",flexDirection:"column",gap:8,minHeight:0}}><h2 style={{fontSize:14,margin:0}}>Before · base 4de3797a</h2><div style={{flex:1,minHeight:0,border:"1px solid #444",borderRadius:8,overflow:"hidden"}}><Before paneId="before" phase={phase} reloads={reloads} route={route}/></div></div>
      <div style={{display:"flex",flexDirection:"column",gap:8,minHeight:0}}><h2 style={{fontSize:14,margin:0}}>After · snapshot debc9171</h2><div style={{flex:1,minHeight:0,border:"1px solid #444",borderRadius:8,overflow:"hidden"}}><After paneId="after" projectId="fixture-a" phase={phase} reloads={reloads} route={route} thumbnail={{projectId:"fixture-a",src:"http://localhost:4599/thumbnail.svg"}}/></div></div>
    </div>
  </main>;
}
