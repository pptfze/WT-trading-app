'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const files = [...fs.readdirSync('integration').filter(x => x.endsWith('.js')).map(x => path.join('integration', x)), 'server.js', ...fs.readdirSync('scripts').filter(x => x.endsWith('.js')).map(x => path.join('scripts', x)), ...fs.readdirSync('lib').filter(x => x.endsWith('.js')).map(x => path.join('lib', x)), ...fs.readdirSync('test').filter(x => x.endsWith('.js')).map(x => path.join('test', x))];
for (const file of files) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
const html = fs.readFileSync('public/index.html', 'utf8');
let count = 0;
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) { if (match[1].trim()) { new vm.Script(match[1], { filename: `inline-${++count}.js` }); } }
console.log(`Syntax passed: ${files.length} JavaScript files and ${count} inline script(s).`);
