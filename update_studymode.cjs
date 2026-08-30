const fs = require('fs');

const path = 'client/StudyMode.tsx';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

const newReturn = `  return (
    <div className="study-mode-v2" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {/* Top Bar (Layer 3) */}
      <div style={{ height: '40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={() => exitSession()} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
          <span style={{ fontWeight: 500, fontSize: '14px' }}>{task.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ fontSize: '14px', fontFamily: 'monospace' }}>{formatTime(timeRemaining)}</div>
          <button onClick={() => exitSession()} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      {/* Main Workspace (Layer 1) */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {envState?.layout === 'writing' ? (
           <WritingWorkspace activeResource={materials.find(m => m.id === envState.activeResource) || null} />
        ) : envState?.layout === 'research' ? (
           <ResearchWorkspace 
             browserUrl={browserUrl} 
             notes={notes} 
             onBrowserUrlChange={setBrowserUrl} 
             onNotesChange={setNotes} 
             panes={envState.panes || {}} 
             setPanes={(p) => setEnvState({...envState, panes: p})} 
           />
        ) : envState?.layout === 'math' ? (
           <ProblemSolvingWorkspace 
             activeResource={materials.find(m => m.id === envState.activeResource) || null} 
             formulaSheet={materials.find(m => m.type === 'pdf') || null}
             panes={envState.panes || {}} 
           />
        ) : (
           <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
             <p>General Workspace</p>
           </div>
        )}
      </div>

      {/* Bottom Bar Tools (Layer 3) */}
      <div style={{ height: '50px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '24px', borderTop: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
        <button className="btn btn-ghost" onClick={() => setMaterialsOpen(!materialsOpen)}>Materials</button>
        <button className="btn btn-ghost" onClick={() => setNotesOpen(!notesOpen)}>Notes</button>
        <button className="btn btn-ghost" onClick={() => setShowSearch(!showSearch)}>Search</button>
        <button className="btn btn-ghost" onClick={() => setShowCommandPalette(true)}>Tools</button>
        <button className="btn btn-ghost" onClick={() => setShowAudioPanel(!showAudioPanel)}>Audio</button>
        <button className="btn btn-ghost" onClick={() => setAiOpen(!aiOpen)}>AI</button>
      </div>
      
      {/* Slide-in Panels (Layer 2) */}
      {materialsOpen && (
         <div style={{ position: 'absolute', top: '40px', bottom: '50px', right: 0, width: '300px', backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border)', zIndex: 10 }}>
           <MaterialsDrawer materials={materials} onClose={() => setMaterialsOpen(false)} task={task} />
         </div>
      )}
      {notesOpen && (
         <div style={{ position: 'absolute', top: '40px', bottom: '50px', right: materialsOpen ? '300px' : 0, width: '300px', backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border)', zIndex: 10 }}>
           <NotesPanel notes={notes} onChange={setNotes} onClose={() => setNotesOpen(false)} />
         </div>
      )}
      {aiOpen && (
         <div style={{ position: 'absolute', bottom: '60px', right: '16px', width: '350px', height: '500px', backgroundColor: 'var(--bg-card)', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
           <AIAssistantPanel task={task} onClose={() => setAiOpen(false)} chat={aiChat} onSendMessage={sendAiMessage} input={aiInput} onInputChange={setAiInput} loading={aiLoading} onOptionClick={handleAiOption} />
         </div>
      )}
      {showSearch && (
         <div style={{ position: 'absolute', bottom: '50px', left: 0, right: 0, backgroundColor: 'var(--bg-card)', borderTop: '1px solid var(--border)', padding: '16px', zIndex: 15, display: 'flex', justifyContent: 'center' }}>
           <input type="text" autoFocus placeholder="Search the web or enter a URL" style={{ width: '600px', padding: '12px 16px', borderRadius: '24px', border: '1px solid var(--border)', outline: 'none', fontSize: '16px' }} onKeyPress={(e) => {
             if (e.key === 'Enter') {
               setBrowserUrl(e.currentTarget.value);
               setEnvState({...envState, layout: 'research'});
               setShowSearch(false);
             }
           }} />
           <button style={{ marginLeft: '16px', background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }} onClick={() => setShowSearch(false)}>✕</button>
         </div>
      )}
    </div>
  );
`;

const newLines = lines.slice(0, 676).concat(newReturn.split('\n')).concat(lines.slice(1362));
newLines.splice(4, 0, 'import { WritingWorkspace, ResearchWorkspace, ProblemSolvingWorkspace } from "./workspaces";');

fs.writeFileSync(path, newLines.join('\n'));
