import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view';
import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { store } from './store';
import { debuggerController } from './debugger';

const setDebugLines = StateEffect.define<{ breakpoints: number[]; current: number | null }>();

const debugLines = StateField.define<{ breakpoints: number[]; current: number | null }>({
  create: () => ({ breakpoints: [], current: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDebugLines)) return e.value;
    return value;
  }
});

class Marker extends GutterMarker {
  constructor(private kind: 'breakpoint' | 'current' | 'both') {
    super();
  }
  override eq(other: Marker) {
    return other.kind === this.kind;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `cm-debug-marker cm-debug-${this.kind}`;
    el.title = this.kind === 'current' ? 'Paused here' : 'Breakpoint (click to remove)';
    return el;
  }
}

const markers = { breakpoint: new Marker('breakpoint'), current: new Marker('current'), both: new Marker('both') };

function buildMarkers(state: EditorState) {
  const { breakpoints, current } = state.field(debugLines);
  const lines = [...new Set([...breakpoints, ...(current ? [current] : [])])].filter((l) => l >= 1 && l <= state.doc.lines).sort((a, b) => a - b);
  const b = new RangeSetBuilder<GutterMarker>();
  for (const l of lines) {
    const bp = breakpoints.includes(l);
    b.add(state.doc.line(l).from, state.doc.line(l).from, l === current ? (bp ? markers.both : markers.current) : markers.breakpoint);
  }
  return b.finish();
}

const currentLine = EditorView.decorations.compute([debugLines], (state) => {
  const { current } = state.field(debugLines);
  if (!current || current > state.doc.lines) return Decoration.none;
  return Decoration.set([Decoration.line({ class: 'cm-debug-current-line' }).range(state.doc.line(current).from)]);
});

export function debugGutter(file: string): Extension {
  const sync = ViewPlugin.define((view) => {
    let last = '';
    const update = () => {
      const loc = store.state.debug.location;
      const next = { breakpoints: debuggerController.breakpointsFor(file), current: loc && loc.file === file ? loc.line : null };
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      queueMicrotask(() => view.dispatch({ effects: setDebugLines.of(next) }));
    };
    update();
    const unsubscribe = store.subscribe(update);
    return { destroy: () => void unsubscribe() };
  });
  return [
    debugLines,
    sync,
    currentLine,
    Prec.highest(gutter({
      class: 'cm-debug-gutter',
      markers: (view) => buildMarkers(view.state),
      initialSpacer: () => markers.breakpoint,
      lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setDebugLines))),
      domEventHandlers: {
        mousedown(view, line) {
          debuggerController.toggleBreakpoint(file, view.state.doc.lineAt(line.from).number);
          return true;
        }
      }
    }))
  ];
}
