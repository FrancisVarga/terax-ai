import { useTheme } from "@/modules/theme";
import {
  autocompletion,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { json } from "@codemirror/lang-json";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { useEffect, useRef } from "react";

/**
 * Single-line attribute-match editor for the Traces/Logs filter bars. It is a
 * compact CodeMirror instance that adds two things over a plain <input>: JSON
 * syntax highlighting (so a `"key":"value"` fragment colors correctly) and
 * autocomplete of known attribute keys (fetched once via `otel.attributeKeys`).
 * Selecting a key inserts the `"key":"` prefix so the user only types the value.
 *
 * Enter is intercepted (kept single-line); changes are pushed up via `onChange`,
 * and `value` is reconciled back into the doc so external resets (filter clear)
 * stay in sync.
 */
export function AttrFilterInput({
  value,
  onChange,
  placeholder,
  attributeKeys,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  attributeKeys: string[];
}) {
  const { resolvedMode } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const keysRef = useRef(attributeKeys);
  keysRef.current = attributeKeys;

  // Mount once per theme. Attribute keys are read through a ref so the completion
  // source always sees the latest list without rebuilding the editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const completions = (ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/[\w."]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      const options: Completion[] = keysRef.current.map((k) => ({
        label: k,
        type: "property",
        // Insert the canonical attrSearch fragment so the value is all that's left.
        apply: `"${k}":"`,
        detail: "attribute",
      }));
      return { from: word.from, options, validFor: /^[\w."]*$/ };
    };

    const singleLine: Extension = EditorState.transactionFilter.of((tr) => {
      // Reject any change that introduces a newline → keep it single-line.
      if (tr.docChanged && tr.newDoc.toString().includes("\n")) return [];
      return tr;
    });

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          json(),
          singleLine,
          autocompletion({ override: [completions] }),
          keymap.of([
            // Swallow Enter so it never inserts a newline.
            { key: "Enter", run: () => true },
            ...completionKeymap,
            ...defaultKeymap,
          ]),
          cmPlaceholder(placeholder),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": { fontSize: "11px", backgroundColor: "transparent" },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              lineHeight: "1.6",
              overflow: "hidden",
            },
            ".cm-content": { caretColor: "var(--foreground)", padding: "5px 0" },
            ".cm-line": { padding: "0" },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            ".cm-placeholder": { color: "var(--muted-foreground)" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedMode, placeholder]);

  // Reconcile external value changes (e.g. a "clear filters" reset) into the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="min-w-0 flex-1 overflow-hidden" />;
}
