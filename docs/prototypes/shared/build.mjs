import { readFileSync, writeFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { signalConnector, signalGraphLayouts } from '../../ui-shortlist/signal-graph.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const original = read('../01-original-ten.html');
const review = JSON.parse(original.match(/id="review-data">([\s\S]*?)<\/script>/)[1]);
const graph = JSON.parse(review.pages['signal-graph'].match(/id="graph-data">([\s\S]*?)<\/script>/)[1]);
const md = new MarkdownIt({ html: false });
const reader = md.render(read('../../reader-workspace.md'));
const data = JSON.stringify({ ...graph, positions: signalGraphLayouts.network.positions })
  .replaceAll('<', '\\u003c');

const html = `<!doctype html>
<html lang="en" data-theme="studio"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>RKE workspace prototype</title><style>${read('workspace.css')}</style></head>
<body><header class="shell"><a class="brand" href="#reader">RKE</a>
<nav aria-label="Workspace"><a href="#reader">Reader</a><a href="#kanban">Kanban</a><a href="#graph">Graph</a></nav>
<label class="theme"><span>Theme</span><select id="theme"><option>Studio</option><option>Current</option><option>Signal</option></select></label></header>
<main id="main"></main>
<template id="reader-document">${reader}</template>
<script id="graph-data" type="application/json">${data}</script>
<script>${signalConnector.toString()}\n${read('workspace.js')}</script></body></html>`;

writeFileSync(new URL('../04-shared-workspace.html', import.meta.url), html);
