# Otto board — state schema and tutor action payloads

The board is **state**, not a picture and not a transcript. Every element is a typed object with a stable id; the tutor changes the board only through validated actions that return a structured result; nothing is regenerated per message.

The concrete schema and the reducer live in [`shared/boardState.ts`](../shared/boardState.ts) (pure, no dependencies, same rules on server, client and tests). The acceptance tests are in `tests/run.mjs` ("board state" block).

## 1. Board state

```ts
BoardState {
  problemId: string
  revision: number                 // +1 per successful state-changing action (undo counts)
  objects: Record<id, BoardObject>
  order: id[]                      // display order of ACTIVE objects (the layout engine's input)
  focusId: id | null               // the object under discussion; temporary emphasis is a `highlight` object, never content
  history: RevisionRecord[]        // per revision: action, author, time, objects BEFORE (what undo restores)
}

BoardObject<T> {
  id, type: T, data: ObjectData[T]
  author: "problem" | "student" | "tutor" | "system"
  revision: number                 // per-object, +1 on every change
  createdAt, updatedAt
  section?: id                     // a "section" object this belongs to
  visible: boolean                 // false = hidden from the student until revealed
  dependsOn: id[]                  // computed-from links; a change marks dependents stale
  verification: "unverified" | "verified" | "invalid" | "stale"
  status: "active" | "archived" | "removed"   // removed/archived stay in state so undo works
}
```

### Object types (`ObjectData[T]`)

| type | data |
|---|---|
| `problem` | `{ statement, givens: {name, value, unit?}[], task?, sourceUrl? }` |
| `text` | `{ text }` |
| `equation` | `{ latex, expr? }` |
| `calculation_step` | `{ formula, substituted?, expr?, result?, unit?, explanation? }` — one linked step; `expr` is what the engine evaluates |
| `diagram` | `{ caption, svg?, parts? }` — svg is sanitised (no script/handlers/foreignObject) |
| `vector` | `{ label, origin?, directionDeg, magnitude?, unit?, frame?, componentOf? }` — a component is its own vector with `componentOf` = the full one |
| `shape` | `{ kind, vertices?, angles?: {at, deg, given}[], schematic? }` |
| `graph` | `{ expr, xLabel?, yLabel?, domain?, units? }` |
| `interactive_widget` | `{ caption, params: {name, value, min, max, unit?, fixed?}[], drives?: id[] }` |
| `annotation` | `{ targetId, text, compareWith? }` |
| `highlight` | `{ targetId, part?, persistent }` |
| `result` | `{ value, unit?, label? }` |
| `hint` | `{ text, level }` |
| `section` | `{ title }` |

### Snapshot (what the tutor reads)

`inspect` returns a compact `BoardSnapshot`: revision, focusId, and per object `{id, type, author, summary, revision, verification, visible, dependsOn, section}`. Full object data is fetched only on request (`ids`). The student's view omits hidden objects and reports only `hiddenCount`.

## 2. Tutor action payloads

Every action may carry `baseRevision` (the board revision the tutor was looking at) and `author` (default `"tutor"`; a student gesture uses `"student"`).

```jsonc
{ "action": "inspect",  "ids": ["o3"], "types": ["equation"], "author": "student", "view": "tutor" }
{ "action": "create",   "object": { "type": "equation", "data": { "latex": "W = Fd\\cos\\theta", "expr": "..." }, "section": "s1", "visible": true, "dependsOn": ["angle"] }, "after": "o2", "baseRevision": 7 }
{ "action": "focus",    "targetId": "o3" }
{ "action": "highlight","targetId": "g1", "part": "mg sinθ", "persistent": false }
{ "action": "annotate", "targetId": "g1", "text": "this component opposes the displacement" }
{ "action": "update",   "targetId": "angle", "patch": { "latex": "\\theta = 40^\\circ", "expr": "40" }, "expectedObjectRevision": 2 }
{ "action": "append_step", "section": "s1", "step": { "formula": "W = Fd\\cos\\theta", "substituted": "15×4×cos 0°", "expr": "15*4*cos(0)", "result": 60, "unit": "J" }, "dependsOn": ["angle"] }
{ "action": "reveal",   "targetIds": ["step3"] }            // or { "all": true }
{ "action": "validate", "targetId": "step3" }                // engine evaluates `expr`; model never self-certifies
{ "action": "compare",  "leftId": "m1", "rightId": "m2", "text": "same result, two routes" }
{ "action": "remove",   "targetId": "o9" }                   // soft; undoable
{ "action": "organize", "order": ["o1", "o2", "o3"] }        // positions only; must list every active object once
{ "action": "archive",  "targetIds": ["o1", "o2"] }
{ "action": "reset",    "scope": "section", "section": "s1" } // scope is REQUIRED; student work is archived, never deleted; the problem is kept
{ "action": "undo" }
```

### Result (always returned)

```ts
{ ok: true,  revision, changed: id[], stale: id[], object?, snapshot?, note? }
{ ok: false, error: { code, message, targetId?, currentRevision } }
// code ∈ NOT_FOUND | STALE_REVISION | FORBIDDEN_STUDENT_WORK | INVALID_PAYLOAD | SCOPE_REQUIRED | NOTHING_TO_UNDO | DUPLICATE | UNSUPPORTED
```

The tutor may only tell the student a board change happened if the result says `ok: true`.

### Rules the reducer enforces

- Highlight/annotate/focus never touch or recreate the target.
- The same problem is never added twice (`DUPLICATE`).
- The tutor can't update/remove/archive student work (`FORBIDDEN_STUDENT_WORK`) — it annotates or adds a correction beside it.
- A stale `baseRevision` / `expectedObjectRevision` is rejected (`STALE_REVISION`), so an out-of-date tutor action never overwrites a newer student edit.
- `update` marks the object unverified and every transitive dependent `stale`; `validate` (deterministic engine, injected) is the only way to `verified`/`invalid`. If the engine can't evaluate, it stays `unverified`.
- Hidden objects are excluded from the student snapshot until `reveal`.
- Generated SVG containing scripts, event handlers, `foreignObject`, `javascript:` etc. is rejected.
- `undo` restores exactly the objects/order/focus the last revision changed.

## 3. How this maps to what exists today

| Spec | Today (extend, don't rewrite) |
|---|---|
| Typed objects with ids | `BoardEntry` (shared/types.ts): `id`, `kind`, `owner`, `status`, `expectedAnswer`, plus the typed `diagram`/`graph`/`interactive` payloads |
| Authorship | `owner: "otto" \| "student"`; student entries are never rewritten (`WRITE_TO_BOARD` guard) |
| Inspect | the numbered board listing in the tutor prompt (`boardSurfaceBlock`) |
| Create / annotate | `WRITE_TO_BOARD`, `CREATE_PROBLEM`, `ANNOTATE_BOARD`, `GEOMETRY_ON_BOARD`, `GRAPH_ON_BOARD`, … (server/tutor.ts `applyTool`) |
| Validate | `shared/mathEquiv.ts` (`equivalent`, gap checks), `evalMathExpr`, problem `check` expressions |
| Focus/highlight | `focus` entries, `ANNOTATE_BOARD` |
| Persistence | the task's `board` array (account row), localChatBoard |

## 4. Not done yet (honest status)

`shared/boardState.ts` is the schema + reducer + tests. It is **not yet wired in** as the live store: the running board is still the `BoardEntry[]` list. Implementation order from here:

1. **Adapter**: load a task's `BoardEntry[]` into `BoardState` and back (kind → type, owner → author), so the reducer can run beside the current store.
2. **Tutor tools → actions**: route `WRITE_TO_BOARD`/`ANNOTATE_BOARD` through `applyBoardAction`, pass `baseRevision`, and have the reply be built from the returned result (no claim without `ok: true`).
3. **Structured calculations**: have the tutor emit `calculation_step`s with `expr` + `dependsOn`, validated by the engine; render the verification badge (verified / stale).
4. **Linked widgets and vectors**: sliders that drive `drives` objects with deterministic recalculation.
5. **Layout engine, student editing, undo/redo UI, conflict handling** on the client.
