import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('P1 entry wires manual studio and real diagnostic runner into permanent service',async()=>{
 const source=await readFile(new URL('../hermes/plugin.jsx',import.meta.url),'utf8');
 assert.match(source,/import\s*\{[^}]*StudioPage[^}]*DiagnosticsPage[^}]*\}\s*from\s*['"]\.\/studio-page\.jsx['"]/);
 assert.match(source,/diagnosticsRunner:runDiagnostics/);
 assert.match(source,/path:'\/design-studio'[^\n]+StudioPage/);
 assert.match(source,/path:'\/design-studio\/diagnostics'[^\n]+DiagnosticsPage/);
 assert.match(source,/design-studio-p1/);
});
