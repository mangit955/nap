/** The browser and the provider use this same App.tsx, including the deliberately broken save. */
export function computerLocalAppSource(version: "buggy" | "fixed"): string {
  const save =
    version === "fixed" ? "setNotes((saved) => [...saved, note]);" : "setNotes((saved) => saved);";
  return `import { useState } from "react";

export default function App() {
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  function saveNote() {
    const note = draft.trim();
    if (!note) return;
    ${save}
    setDraft("");
  }

  return (
    <main data-testid="notes-app">
      <style>{\`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f8f5ef; color: #223c35; font-family: ui-sans-serif, system-ui, sans-serif; }
        [data-testid="notes-app"] { position: relative; min-height: 650px; padding: 72px max(24px, calc((100vw - 640px) / 2)) 32px; }
        .demo-label { position: fixed; top: 20px; right: 24px; border: 1px solid #b8c8bd; border-radius: 20px; padding: 7px 13px; background: #edf3eb; color: #315d49; font-size: 12px; font-weight: 600; }
        .eyebrow { margin: 0 0 8px; color: #597467; font-size: 12px; font-weight: 700; letter-spacing: 2px; }
        h1 { margin: 0; font-size: 46px; line-height: 1.15; letter-spacing: -2px; font-weight: 600; }
        .intro { margin: 12px 0 0; color: #617067; font-size: 16px; }
        .note-form { position: absolute; top: 184px; left: max(24px, calc((100vw - 576px) / 2)); width: min(576px, calc(100vw - 48px)); }
        label { display: block; height: 28px; font-size: 13px; font-weight: 600; }
        .input-row { display: grid; grid-template-columns: 1fr 112px; gap: 16px; height: 128px; }
        input { width: 100%; min-width: 0; border: 1px solid #a7b4a6; border-radius: 16px; background: #fffefa; padding: 20px; font: inherit; font-size: 18px; color: #223c35; box-shadow: 0 4px 20px #223c3507; }
        input::placeholder { color: #748177; }
        button { border: 0; border-radius: 16px; background: #315d49; color: #fff; font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
        button:hover { background: #244b39; }
        input:focus-visible, button:focus-visible { outline: 3px solid #a6bb7b; outline-offset: 4px; }
        .saved { margin-top: 216px; border-top: 1px solid #d9ddd1; padding-top: 24px; }
        .saved-header { display: flex; justify-content: space-between; align-items: center; }
        h2 { margin: 0; font-size: 18px; font-weight: 600; }
        .count { border-radius: 20px; background: #e6ecdf; padding: 4px 10px; font-size: 12px; }
        ul { list-style: none; margin: 16px 0 0; padding: 0; }
        li { margin-bottom: 10px; padding: 17px 20px; border: 1px solid #d4ddcc; border-radius: 12px; background: #fffefa; overflow-wrap: anywhere; }
        .empty { margin: 24px 0; padding: 26px; border: 1px dashed #bbc8b5; border-radius: 12px; text-align: center; color: #617067; font-size: 14px; }
        footer { margin-top: 24px; color: #617067; font-size: 12px; }
      \`}</style>
      <div className="demo-label">Scripted local demo</div>
      <header>
        <p className="eyebrow">A LITTLE SPACE FOR YOUR THOUGHTS</p>
        <h1>Good to note.</h1>
        <p className="intro">Catch a thought. Keep it here for a moment.</p>
      </header>
      <form className="note-form" onSubmit={(event) => { event.preventDefault(); saveNote(); }}>
        <label htmlFor="note-input">Your note</label>
        <div className="input-row">
          <input id="note-input" data-testid="note-input" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Something to remember..." autoComplete="off" />
          <button data-testid="save-note" type="submit">Save</button>
        </div>
      </form>
      <section className="saved" aria-labelledby="saved-title">
        <div className="saved-header"><h2 id="saved-title">Saved notes</h2><span className="count">{notes.length} saved</span></div>
        <ul data-testid="saved-notes" aria-label="Saved notes">
          {notes.map((note, index) => <li data-testid="saved-note" key={index}>{note}</li>)}
        </ul>
        {notes.length === 0 && <p className="empty">Your next good idea belongs here.</p>}
      </section>
      <footer>Notes stay here until you refresh this page.</footer>
    </main>
  );
}
`;
}
