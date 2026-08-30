import type { ArtifactType, WorkspaceTemplate } from "./StudyTypes.ts";

interface ToolsDrawerProps {
  template: WorkspaceTemplate;
  onClose: () => void;
  onAddTool: (type: ArtifactType) => void;
}

const ALL_TOOLS: { type: ArtifactType; label: string; icon: string; templates: WorkspaceTemplate[] }[] = [
  { type: "notes", label: "Notes", icon: "▤", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "scratchpad", label: "Scratchpad", icon: "✎", templates: ["PROBLEM_SOLVING", "WRITING", "RESEARCH", "STANDARD", "PROJECT"] },
  { type: "calculator", label: "Calculator", icon: "123", templates: ["PROBLEM_SOLVING", "STANDARD"] },
  { type: "desmos", label: "Desmos Graph", icon: "f(x)", templates: ["PROBLEM_SOLVING", "STANDARD"] },
  { type: "dictionary", label: "Dictionary", icon: "Aa", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD"] },
  { type: "whiteboard", label: "Whiteboard", icon: "◻", templates: ["PROBLEM_SOLVING", "WRITING", "PROJECT", "STANDARD", "RESEARCH"] },
  { type: "sticky", label: "Sticky Note", icon: "❏", templates: ["WRITING", "READING", "RESEARCH", "REVISION", "PROJECT", "STANDARD", "PROBLEM_SOLVING"] },
];

export function ToolsDrawer({ template, onClose, onAddTool }: ToolsDrawerProps) {
  const recommended = ALL_TOOLS.filter(t => t.templates.includes(template));
  const others = ALL_TOOLS.filter(t => !t.templates.includes(template));

  return (
    <div className="sm-drawer">
      <div className="sm-drawer-header">
        <span>TOOLS</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <div className="sm-tools-grid">
          {recommended.map(tool => (
            <button
              key={tool.type}
              className="sm-tool-btn"
              onClick={() => { onAddTool(tool.type); onClose(); }}
            >
              <span className="sm-tool-icon">{tool.icon}</span>
              <span className="sm-tool-label">{tool.label}</span>
            </button>
          ))}
          {others.length > 0 && (
            <>
              <div className="sm-tools-divider">Other tools</div>
              {others.map(tool => (
                <button
                  key={tool.type}
                  className="sm-tool-btn sm-tool-btn-other"
                  onClick={() => { onAddTool(tool.type); onClose(); }}
                >
                  <span className="sm-tool-icon">{tool.icon}</span>
                  <span className="sm-tool-label">{tool.label}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
