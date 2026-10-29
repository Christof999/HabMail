const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

test('der Kalender folgt der Bildschirmtastatur und entfernt beide Beobachter beim Schließen', () => {
  const source = ts.createSourceFile('CalendarView.tsx', readFileSync(`${__dirname}/CalendarView.tsx`, 'utf8'), ts.ScriptTarget.Latest, true);
  const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useKeyboardLift');
  assert.ok(hook);
  const listeners = new Map(), viewport = { height: 500, offsetTop: 0,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  let subscribe, snapshot, changed = 0;
  const module = { exports: {} }, window = { innerHeight: 800, scrollY: 80, visualViewport: viewport, scrollTo(_x, y) { this.scrollY = y; } };
  runInNewContext(ts.transpileModule(`${hook.getText(source)}\nmodule.exports = useKeyboardLift`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, window, useCallback: callback => callback,
    useSyncExternalStore: (watch, read) => { subscribe = watch; snapshot = read; return read(); },
  });
  assert.equal(module.exports(true), 300);
  const stop = subscribe(() => changed++);
  assert.equal(window.scrollY, 0);
  viewport.height = 600;
  listeners.get('resize')();
  assert.equal(snapshot(), 200);
  assert.equal(changed, 1);
  viewport.height = 760;
  listeners.get('scroll')();
  assert.equal(snapshot(), 0);
  stop();
  assert.equal(listeners.size, 0);
  assert.equal(module.exports(false), 0);
  subscribe(() => changed++ )();
  assert.equal(listeners.size, 0);
});
