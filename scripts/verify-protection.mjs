import { prepareJavaScript } from './prepare.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.resolve(root, '../../work');
await fs.mkdir(scratch, { recursive: true });
const temp = await fs.mkdtemp(path.join(scratch, 'protection-'));
const source = `let count=0; const dictionary={P:'♟'}; const rig={rotor0:{rotation:{y:0}}};
const receiver={value:7,read(){return this.value;}};
function repaint(){globalThis.result=dictionary['P']+count;}
function advance(){count++;repaint();}
class ChangeProbe{constructor(){this.callback=()=>{};}_onChange(callback){this.callback=callback;}run(){this.callback();}}
const probe=new ChangeProbe;probe._onChange(()=>{globalThis.probeCalled=true;});probe.run();
function tickRotor(index){rig['rotor'+index].rotation.y++;globalThis.rotorY=rig['rotor'+index].rotation.y;}tickRotor(0);tickRotor(0);
setTimeout('advance()',1); count=4;`;
const report = {};
const prepared = prepareJavaScript(source, ['count++;repaint();dictionary.P'], report);
assert.deepEqual(report.protectedGlobals.sort(), ['count', 'dictionary', 'repaint', 'advance', 'receiver'].sort());
const compilerInput = path.join(temp, 'input.js');
const compilerOutput = path.join(temp, 'output.js');
await fs.writeFile(compilerInput, `document.addEventListener('DOMContentLoaded',function(){${prepared}globalThis.result=receiver.read();});`);
const compilerCli = path.join(root, 'node_modules/google-closure-compiler/cli.js');
const identifierName = /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;
const allPropertyExternLines = ['/** @externs */'];
for (const name of report.protectedProperties) if (identifierName.test(name)) allPropertyExternLines.push(`Object.prototype.${name};`);
const propertyExternPath = path.join(temp, 'properties.externs.js');
await fs.writeFile(propertyExternPath, [...new Set(allPropertyExternLines)].join('\n'));
const externLines = ['/** @externs */'];
for (const name of report.protectedGlobals) externLines.push(`globalThis.${name};`);
const externPath = path.join(temp, 'preserve.externs.js');
await fs.writeFile(externPath, [...new Set(externLines)].join('\n'));
const compileOnce = (input, output) => {
  const result = spawnSync(process.execPath, [compilerCli, '--compilation_level=ADVANCED_OPTIMIZATIONS', '--env=BROWSER', '--warning_level=QUIET', '--externs', propertyExternPath, '--externs', externPath, '--js', input, '--js_output_file', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
compileOnce(compilerInput, compilerOutput);

// Model an input that was Closure-optimized before it entered this build.
const alreadyClosureOutput = path.join(temp, 'already-closure.js');
await fs.copyFile(compilerOutput, alreadyClosureOutput);
const reprotectedReport = {};
const reprotected = prepareJavaScript(await fs.readFile(alreadyClosureOutput, 'utf8'), [], reprotectedReport);
const reprotectedProperties = ['/** @externs */'];
for (const name of reprotectedReport.protectedProperties) if (identifierName.test(name)) reprotectedProperties.push(`Object.prototype.${name};`);
const reprotectedPropertyPath = path.join(temp, 'reprotected-properties.externs.js');
await fs.writeFile(reprotectedPropertyPath, [...new Set(reprotectedProperties)].join('\n'));
const reprotectedGlobals = ['/** @externs */'];
for (const name of reprotectedReport.protectedGlobals) reprotectedGlobals.push(`globalThis.${name};`);
const reprotectedGlobalPath = path.join(temp, 'reprotected-globals.externs.js');
await fs.writeFile(reprotectedGlobalPath, [...new Set(reprotectedGlobals)].join('\n'));
const reprotectedOutput = path.join(temp, 'reprotected-output.js');
await fs.writeFile(path.join(temp, 'reprotected-input.js'), reprotected);
const finalCompile = spawnSync(process.execPath, [compilerCli, '--compilation_level=ADVANCED_OPTIMIZATIONS', '--env=BROWSER', '--warning_level=QUIET', '--externs', reprotectedPropertyPath, '--externs', reprotectedGlobalPath, '--js', path.join(temp, 'reprotected-input.js'), '--js_output_file', reprotectedOutput], { encoding: 'utf8' });
assert.equal(finalCompile.status, 0, finalCompile.stderr);

async function checkRuntime(file) {
  const events = new Map(), timers = [];
  const sandbox = { document: { addEventListener(name, fn) { events.set(name, fn); } }, setTimeout(code) { timers.push(code); } };
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(file, 'utf8'), sandbox);
  events.get('DOMContentLoaded')();
  assert.equal(sandbox.count, 4);
  assert.equal(sandbox.result, 7);
  vm.runInContext('count++;repaint()', sandbox);
  assert.equal(sandbox.result, '♟5');
  vm.runInContext(timers.shift(), sandbox);
  assert.equal(sandbox.count, 6);
  assert.equal(sandbox.result, '♟6');
  assert.equal(sandbox.probeCalled, true);
  assert.equal(sandbox.rotorY, 2);
  assert.equal(vm.runInContext('dictionary.P', sandbox), '♟');
  assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'dictionary').set, undefined);
}
await checkRuntime(compilerOutput);
await checkRuntime(reprotectedOutput);
console.log('PASS: One-pass Closure preserves protected names, receiver methods, and behavior for original and pre-Closure-optimized inputs.');
