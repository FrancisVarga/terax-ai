import {
  copyLineDown,
  copyLineUp,
  cursorLineBoundaryForward,
  deleteLine,
  indentLess,
  indentMore,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  toggleComment,
} from "@codemirror/commands";
import {
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import { type Command, type KeyBinding } from "@codemirror/view";

// VSCode's "insert line below" (Ctrl+Enter) and "insert line above"
// (Ctrl+Shift+Enter). CodeMirror ships `insertBlankLine` (a plain blank line
// at the cursor) but no above/below-the-current-line variant, so we build them
// from primitives: jump to a line boundary, then insert a blank line. This
// matches VSCode, which opens a new indented line regardless of cursor column.

const insertLineBelow: StateCommand = ({ state, dispatch }) => {
  // Move every range to the end of its line, then run insertBlankLine so the
  // new line lands *below* the current one with language-aware indentation.
  const tr = state.update(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      return {
        range: EditorSelection.cursor(line.to),
        changes: [],
      };
    }),
  );
  dispatch(tr);
  return insertBlankLine({ state: tr.state, dispatch });
};

const insertLineAbove: StateCommand = ({ state, dispatch }) => {
  // Move every range to the start of its line, insert a newline before it, then
  // place the cursor on the freshly created (now empty) line above.
  const tr = state.update(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      return {
        range: EditorSelection.cursor(line.from),
        changes: [],
      };
    }),
  );
  dispatch(tr);
  return insertBlankLine({ state: tr.state, dispatch });
};

// Smart Home: first press → first non-whitespace char, second → column 0.
// VSCode's default Home behaviour; CodeMirror's plain boundary command always
// lands on the visual start, so we add the toggle.
const cursorLineStartSmart: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.ranges;
  const ranges = sel.map((range) => {
    const line = state.doc.lineAt(range.head);
    const text = line.text;
    const firstNonWs = text.length - text.trimStart().length;
    const indentPos = line.from + firstNonWs;
    // Already at the indent boundary → go to column 0; else go to indent.
    const target = range.head === indentPos ? line.from : indentPos;
    return EditorSelection.cursor(target);
  });
  dispatch(
    state.update({ selection: EditorSelection.create(ranges), userEvent: "select" }),
  );
  return true;
};

const asCommand = (cmd: StateCommand): Command =>
  (view) => cmd({ state: view.state, dispatch: view.dispatch });

/**
 * VSCode-default key bindings layered on top of CodeMirror's `defaultKeymap`.
 *
 * `defaultKeymap` already covers Mod-/ (comment), Alt-Arrow (move line),
 * Shift-Alt-Arrow (copy line) and Shift-Mod-k (delete line). We re-declare the
 * core line ops here too so the editor keeps VSCode parity even if `basicSetup`
 * is ever trimmed, and we ADD the bindings VSCode users expect that the emacs-
 * flavored defaults omit or bind to something else (Ctrl+D, Ctrl+Shift+L,
 * Ctrl+Enter, Ctrl+]/[ on all platforms, smart Home).
 *
 * Bindings here are mounted at a precedence ABOVE the defaults so VSCode wins
 * the conflicts (e.g. defaultKeymap binds Ctrl+D to deleteCharForward; VSCode
 * uses it for "add next occurrence to selection").
 */
export const vscodeKeymap: readonly KeyBinding[] = [
  // ── Commenting ─────────────────────────────────────────────────────────
  // Mod-/ = toggle line comment (language-aware: picks lineComment vs
  // blockComment from the active language data in the language compartment).
  { key: "Mod-/", run: toggleComment, preventDefault: true },

  // ── Line movement & duplication ────────────────────────────────────────
  { key: "Alt-ArrowUp", run: moveLineUp, preventDefault: true },
  { key: "Alt-ArrowDown", run: moveLineDown, preventDefault: true },
  { key: "Shift-Alt-ArrowUp", run: copyLineUp, preventDefault: true },
  { key: "Shift-Alt-ArrowDown", run: copyLineDown, preventDefault: true },

  // ── Line insertion (VSCode Ctrl+Enter / Ctrl+Shift+Enter) ──────────────
  { key: "Mod-Enter", run: asCommand(insertLineBelow), preventDefault: true },
  {
    key: "Shift-Mod-Enter",
    run: asCommand(insertLineAbove),
    preventDefault: true,
  },

  // ── Line deletion (Ctrl+Shift+K) ───────────────────────────────────────
  { key: "Shift-Mod-k", run: deleteLine, preventDefault: true },

  // ── Indentation (Ctrl+] / Ctrl+[ — works on all platforms incl. win) ───
  { key: "Mod-]", run: indentMore, preventDefault: true },
  { key: "Mod-[", run: indentLess, preventDefault: true },

  // ── Multi-cursor / occurrence selection ────────────────────────────────
  // Ctrl+D: add the next occurrence of the current word/selection.
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  // Ctrl+Shift+L: select ALL occurrences of the current selection.
  { key: "Shift-Mod-l", run: selectSelectionMatches, preventDefault: true },
  // Ctrl+L: expand selection to the whole line (VSCode "Select Line").
  { key: "Mod-l", run: selectLine, preventDefault: true },

  // ── Smart Home / End ───────────────────────────────────────────────────
  { key: "Home", run: asCommand(cursorLineStartSmart), preventDefault: true },
  { key: "Shift-Home", run: selectLineBoundaryBackward, preventDefault: true },
  { key: "End", run: cursorLineBoundaryForward, preventDefault: true },
  { key: "Shift-End", run: selectLineBoundaryForward, preventDefault: true },
];
