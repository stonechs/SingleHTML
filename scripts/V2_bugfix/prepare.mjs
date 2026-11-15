import { parse } from 'acorn';

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (node.type) callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}

// ADVANCED cannot infer that dynamic string lookups depend on unquoted keys.
export function prepareJavaScript(source, handlers, report = {}) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const edits = [];
  const fetchShimDeclarations = [];
  let hasDirectEval = false;
  const protectedProperties = new Set();
  const classProperties = new Set();
  const memberProperties = new Set();
  const globalObjectProperties = new Set();
  visit(tree, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
      hasDirectEval = true;
    }
    if (node.type === 'VariableDeclaration' && node.declarations.some((declaration) =>
      declaration.id.type === 'Identifier' && declaration.id.name === 'fetch')) {
      fetchShimDeclarations.push(node.end);
    }
    if (node.type === 'MemberExpression') {
      if (!node.computed && node.property.type === 'Identifier') {
        protectedProperties.add(node.property.name);
        memberProperties.add(node.property.name);
        if (node.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(node.object.name)) globalObjectProperties.add(node.property.name);
        const separator = node.optional ? '?.' : '.';
        const separatorStart = source.lastIndexOf(separator, node.property.start - 1);
        if (separatorStart < node.object.end) throw new Error(`Cannot safely quote member access: ${node.property.name}`);
        edits.push({ start: separatorStart, end: node.property.end, text: `${node.optional ? '?.' : ''}[${JSON.stringify(node.property.name)}]` });
      } else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
        protectedProperties.add(node.property.value);
        memberProperties.add(node.property.value);
        if (node.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(node.object.name)) globalObjectProperties.add(node.property.value);
      }
    }
    if (['MethodDefinition', 'PropertyDefinition', 'FieldDefinition'].includes(node.type) && !node.computed) {
      const key = node.key;
      if (key.type === 'Identifier') {
        protectedProperties.add(key.name);
        classProperties.add(key.name);
      } else if (key.type === 'Literal' && typeof key.value === 'string') {
        protectedProperties.add(key.value);
      }
    }
    if (!['ObjectExpression', 'ObjectPattern'].includes(node.type)) return;
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.computed) continue;
      const key = property.key;
      if (key.type === 'Literal' && typeof key.value === 'string') protectedProperties.add(key.value);
      if (key.type !== 'Identifier') continue;
      protectedProperties.add(key.name);
      edits.push({ start: key.start, end: key.end, text: JSON.stringify(key.name) + (property.shorthand ? `:${key.name}` : '') });
    }
  });
  // Direct eval can execute code that was decoded at runtime, so Closure cannot
  // see its references to a lexical fetch shim. Keep that shim reachable by
  // publishing it as the global fetch implementation before the eval runs.
  if (hasDirectEval) {
    for (const position of fetchShimDeclarations) {
      edits.push({ start: position, end: position, text: '\n globalThis.fetch=fetch;' });
    }
  }
  const declared = new Map();
  const objectThisBindings = new Set();
  function bindings(pattern, kind) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') declared.set(pattern.name, kind);
    else if (pattern.type === 'RestElement') bindings(pattern.argument, kind);
    else if (pattern.type === 'AssignmentPattern') bindings(pattern.left, kind);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((node) => bindings(node, kind));
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((node) => bindings(node.type === 'RestElement' ? node.argument : node.value, kind));
  }
  function declarations(node, topLevel = false) {
    if (!node || typeof node !== 'object') return;
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type)) {
      if (topLevel && node.id) declared.set(node.id.name, node.type === 'FunctionDeclaration' ? 'function' : 'let');
      return;
    }
    if (['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.type)) return;
    if (node.type === 'VariableDeclaration' && (topLevel || node.kind === 'var')) {
      node.declarations.forEach((item) => {
        bindings(item.id, node.kind);
        if (topLevel && item.id.type === 'Identifier' && item.init?.type === 'ObjectExpression') {
          let usesThis = false;
          visit(item.init, (child) => { if (child.type === 'ThisExpression') usesThis = true; });
          if (usesThis) objectThisBindings.add(item.id.name);
        }
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => declarations(child));
      else if (value && typeof value === 'object') declarations(value);
    }
  }
  tree.body.forEach((node) => declarations(node, true));
  const stringReferences = [...handlers];
  // Do not split kebab-case strings into JavaScript identifier fragments.
  const identifierSequence = /(?<![-\p{ID_Continue}$])[$\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*/gu;
  const handlerReferences = new Set();
  for (const handler of handlers) {
    identifierSequence.lastIndex = 0;
    for (const match of handler.matchAll(identifierSequence)) handlerReferences.add(match[0]);
  }
  const dynamicCodeReferences = new Set();
  function addDynamicCode(text) {
    stringReferences.push(text);
    identifierSequence.lastIndex = 0;
    for (const match of text.matchAll(identifierSequence)) dynamicCodeReferences.add(match[0]);
  }
  const writes = new Set();
  const staticStrings = new WeakMap();
  function staticString(node) {
    if (staticStrings.has(node)) return staticStrings.get(node);
    let text;
    if (node.type === 'Literal' && typeof node.value === 'string') text = node.value;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = staticString(node.left), right = staticString(node.right);
      if (left !== undefined && right !== undefined) text = left + right;
    }
    staticStrings.set(node, text);
    return text;
  }
  visit(tree, (node) => {
    const text = staticString(node);
    if (node.type === 'MemberExpression' && node.computed) {
      const propertyName = staticString(node.property);
      if (propertyName !== undefined) {
        protectedProperties.add(propertyName);
        memberProperties.add(propertyName);
        if (node.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(node.object.name)) globalObjectProperties.add(propertyName);
      }
    }
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier') {
      const { name } = node.callee;
      const args = name === 'Function' ? node.arguments.slice(-1)
        : ['eval', 'setTimeout', 'setInterval'].includes(name) ? node.arguments.slice(0, 1)
          : [];
      for (const argument of args) {
        const code = staticString(argument);
        if (code !== undefined) addDynamicCode(code);
        else visit(argument, (part) => {
          if (part.type === 'Literal' && typeof part.value === 'string') addDynamicCode(part.value);
          if (part.type === 'TemplateElement') addDynamicCode(part.value.cooked ?? part.value.raw);
        });
      }
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') writes.add(node.left.name);
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') writes.add(node.argument.name);
  });
  const exports = new Set();
  const referencedNames = new Set();
  for (const text of stringReferences) {
    identifierSequence.lastIndex = 0;
    for (const match of text.matchAll(identifierSequence)) referencedNames.add(match[0]);
  }
  for (const name of declared.keys()) {
    // Keep top-level singleton objects visible so Closure cannot detach `this`-dependent methods.
    // Single-letter identifiers in ordinary strings are often card ranks/suits
    // or CSS labels. Export them only when an HTML event handler needs them.
    if ((referencedNames.has(name) && (name.length > 1 || handlerReferences.has(name) || dynamicCodeReferences.has(name))) || objectThisBindings.has(name)) exports.add(name);
  }
  if (edits.length) {
    const orderedEdits = edits.sort((a, b) => a.start - b.start);
    const chunks = [];
    let cursor = 0;
    for (const edit of orderedEdits) {
      if (edit.start < cursor) throw new Error('Overlapping JavaScript protection edits.');
      chunks.push(source.slice(cursor, edit.start), edit.text);
      cursor = edit.end;
    }
    chunks.push(source.slice(cursor));
    source = chunks.join('');
  }
  const protectedBindings = [...exports].map((name) => {
    // A top-level `var` is already a global-object property in a classic
    // script. Its own accessor would recurse, and Closure can rename another
    // binding to the same short name; extern generation preserves the var.
    if (declared.get(name) === 'var') return '';
    if (declared.get(name) === 'function' && !writes.has(name)) return `globalThis[${JSON.stringify(name)}]=${name};`;
    // Live accessors preserve changes made by both normal code and string handlers.
    let parameter = '__htmlpackValue';
    while (declared.has(parameter)) parameter += '_';
    const setter = declared.get(name) === 'const' ? '' : `,set:(${parameter})=>{${name}=${parameter}}`;
    return `Object.defineProperty(globalThis,${JSON.stringify(name)},{configurable:true,get:()=>${name}${setter}});`;
  }).join('\n');
  report.protectedGlobals = [...exports];
  report.protectedVarGlobals = [...exports].filter((name) => declared.get(name) === 'var');
  report.protectedProperties = [...protectedProperties];
  report.classProperties = [...classProperties];
  report.classPropertiesForExtern = [...classProperties].filter((name) => memberProperties.has(name) || referencedNames.has(name));
  report.stringReferencedProperties = [...protectedProperties].filter((name) => referencedNames.has(name));
  report.globalObjectProperties = [...globalObjectProperties];
  let directiveEnd = 0;
  for (const statement of tree.body) {
    if (!statement.directive) break;
    directiveEnd = statement.end;
  }
  return source.slice(0, directiveEnd) + '\n' + protectedBindings + '\n' + source.slice(directiveEnd);
}
