// deep_search.cjs
// Final compact LLM-optimized deep search for OpenClaw
// - No cache
// - True sliding-window chunking
// - Explicit ID mapping for rerank results
// - POSIX-safe source paths
// - Clean preview stripping markdown images/links
// - JSON stdout + explicit exit for exec-friendly capture

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const query = String(process.argv[2] || '').trim();
const topN = clampInt(parseInt(process.argv[3], 10), 1, 20, 5);
const maxFiles = clampInt(parseInt(process.argv[4], 10), 1, 5000, 120);
const chunkSize = clampInt(parseInt(process.argv[5], 10), 300, 8000, 1200);
const overlap = clampInt(parseInt(process.argv[6], 10), 0, Math.max(0, chunkSize - 1), 240);
const proxyHost = String(process.argv[7] || process.env.PROXY_HOST || 'siliconflow-proxy').trim();
const proxyPort = clampInt(parseInt(process.env.PROXY_PORT || '13001', 10), 1, 65535, 13001);
const rerankModel = String(process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3').trim();
const requestTimeoutMs = clampInt(parseInt(process.env.REQUEST_TIMEOUT_MS || '8000', 10), 1000, 60000, 8000);
const maxAttempts = clampInt(parseInt(process.env.RERANK_MAX_ATTEMPTS || '2', 10), 1, 5, 2);

if (!query) {
  emitAndExit({
    query: '',
    mode: 'error',
    error: 'usage',
    usage: 'node tools/deep_search_v3_8.cjs "STM32 定时器 PWM" [topN=5] [maxFiles=120] [chunkSize=1200] [overlap=240] [proxyHost]',
    items: []
  }, 1);
}

const workspaceRoot = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '..');
const memoryRoot = path.join(workspaceRoot, 'memory');

logErr(`deep_search_v3_8 | query="${query}" topN=${topN} maxFiles=${maxFiles} chunkSize=${chunkSize} overlap=${overlap}`);

const terms = tokenizeQuery(query);
const files = collectMarkdownFiles(memoryRoot, maxFiles);
const docs = buildChunkDocuments(files, chunkSize, overlap);

if (!docs.length) {
  emitAndExit({
    query,
    mode: 'empty',
    topN,
    count: 0,
    items: []
  }, 0);
}

const candidates = preselectCandidates(docs, terms, Math.max(topN * 12, 60));
const rankedLocal = candidates.map(doc => ({
  id: doc.id,
  doc,
  score: scoreChunk(doc, terms)
})).sort((a, b) => b.score - a.score);

rerankDocuments(rankedLocal, terms);

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}

function logErr(msg) {
  process.stderr.write(String(msg) + '\n');
}

function emitAndExit(payload, code = 0) {
  const out = JSON.stringify(payload);
  process.stdout.write(out + '\n', () => process.exit(code));
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function shouldSkipDir(fullPath) {
  return (
    fullPath.includes(`${path.sep}_meta`) ||
    fullPath.includes(`${path.sep}.git`) ||
    fullPath.includes(`${path.sep}node_modules`)
  );
}

function collectMarkdownFiles(rootDir, limit) {
  const out = [];
  if (!exists(rootDir)) return out;

  const stack = [rootDir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(fullPath)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(fullPath);
        if (out.length >= limit) break;
      }
    }
  }

  // Prefer recent files when there are more than limit already collected.
  out.sort((a, b) => safeMtime(b) - safeMtime(a));
  return out.slice(0, limit);
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function normalizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripFrontmatter(content) {
  const text = normalizeText(content);
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return text;
  return text.slice(end + 5).trimStart();
}

function extractFrontmatter(content) {
  const text = normalizeText(content);
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return {};
  const raw = text.slice(4, end).trim();
  const meta = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith('[') && value.endsWith(']')) ||
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).trim();
      }
      meta[match[1].trim()] = value;
    }
  }
  return meta;
}

function extractTitle(content, fallback) {
  const lines = normalizeText(content).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^#\s+/.test(t)) return t.replace(/^#\s+/, '').trim();
  }
  const fm = extractFrontmatter(content);
  if (fm.title) return String(fm.title).trim();
  return fallback;
}

function stripMarkdownNoise(text) {
  return normalizeText(text)
    .replace(/!\[.*?\]\(.*?\)/g, '[图片]')
    .replace(/https?:\/\/[^\s)]+/g, '[链接]')
    .replace(/\[\[([^\]]+)\]\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makePreview(text) {
  return stripMarkdownNoise(text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function tokenizeQuery(queryText) {
  const q = normalizeText(queryText).toLowerCase();
  const tokens = new Set();

  const asciiMatches = q.match(/[a-z0-9_+-]{2,}/gi) || [];
  for (const token of asciiMatches) tokens.add(token.toLowerCase());

  const hanMatches = q.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const token of hanMatches) {
    tokens.add(token);
    if (token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) {
        const bigram = token.slice(i, i + 2);
        if (bigram.trim()) tokens.add(bigram);
      }
    }
  }

  const splitMatches = q.split(/[\s,，.;;:：/\\|()【】\[\]{}<>!?"'`~]+/g).filter(Boolean);
  for (const token of splitMatches) {
    if (token.length >= 2) tokens.add(token);
  }

  return Array.from(tokens).slice(0, 32);
}

function chunkTextSlidingWindow(text, size, ovl) {
  const chunks = [];
  const body = normalizeText(text).trim();
  if (!body) return chunks;

  const step = Math.max(1, size - ovl);
  let index = 0;
  let chunkIndex = 0;

  while (index < body.length) {
    let end = Math.min(body.length, index + size);
    let chunk = body.slice(index, end);

    // Try to avoid leading/trailing whitespace noise without changing overlap semantics.
    chunk = chunk.replace(/^\s+/, '').replace(/\s+$/, '');
    if (chunk) {
      chunks.push({
        text: chunk,
        start: index,
        end,
        chunkIndex: chunkIndex + 1
      });
      chunkIndex += 1;
    }

    if (end >= body.length) break;
    index += step;
  }

  return chunks;
}

function buildChunkDocuments(filesList, size, ovl) {
  const docs = [];

  for (const file of filesList) {
    const raw = safeRead(file);
    if (!raw.trim()) continue;

    const fm = extractFrontmatter(raw);
    const body = stripFrontmatter(raw);
    const title = extractTitle(raw, path.basename(file, '.md'));
    const rel = path.relative(workspaceRoot, file).replace(/\\/g, '/');

    const windows = chunkTextSlidingWindow(body, size, ovl);
    if (!windows.length) continue;

    const total = windows.length;
    for (const win of windows) {
      const id = makeDocId(rel, title, win.chunkIndex, win.start, win.end);
      const header =
        `[[DOC_ID:${id}]]\n` +
        `[来源: ${rel}] [标题: ${title}] [chunk: ${win.chunkIndex}/${total}]`;

      docs.push({
        id,
        source: rel,
        title,
        meta: fm,
        chunkIndex: win.chunkIndex,
        chunkTotal: total,
        start: win.start,
        end: win.end,
        text: `${header}\n${win.text}`,
        bodyText: win.text,
        mtime: safeMtime(file)
      });
    }
  }

  return docs;
}

function makeDocId(rel, title, chunkIndex, start, end) {
  const seed = `${rel}|${title}|${chunkIndex}|${start}|${end}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `d${(hash >>> 0).toString(36)}`;
}

function scoreChunk(doc, termsList) {
  const hay = normalizeText(doc.text).toLowerCase();
  const titleHay = normalizeText(doc.title).toLowerCase();
  const metaText = JSON.stringify(doc.meta || {}).toLowerCase();

  let score = 0;

  for (const term of termsList) {
    const t = String(term).toLowerCase();
    if (!t) continue;
    if (titleHay.includes(t)) score += 3.0;
    if (hay.includes(t)) score += 1.8;
    if (metaText.includes(t)) score += 0.8;
  }

  // 💡 优化：根据目录结构分配权重，引导 AI 优先检索高质量核心知识
  if (doc.source.endsWith('/INDEX.md') || doc.source.endsWith('/README.md')) score += 0.9;

  // 1. 核心知识库 (高权重)
  if (doc.source.includes('/Tech/')) score += 0.6;   // 核心技术文档、API 参考等
  if (doc.source.includes('/Study/')) score += 0.5;  // 学习笔记、学术资料
  
  // 2. 辅助与记录区 (中等权重)
  if (doc.source.includes('/Life/')) score += 0.3;   // 日常记录、偏好设定
  if (doc.source.includes('/Inbox/')) score += 0.1;  // 待整理的临时记录
  
  // 3. 过时/垃圾回收区 (负权重惩罚)
  if (doc.source.includes('/Archive/')) score -= 0.5; // 废弃或过时的笔记，降低干扰

  if (String(doc.meta?.status || '').toLowerCase() === 'stable') score += 0.5;
  
  // Recent notes get a slight bump, but only mild.
  const ageDays = Math.max(0, (Date.now() - (doc.mtime || 0)) / 86400000);
  if (Number.isFinite(ageDays)) score += Math.max(0, 0.25 - ageDays * 0.0025);

  return Math.max(0.01, score);
}

function preselectCandidates(docsList, termsList, limit) {
  const scored = docsList.map(doc => ({
    doc,
    score: scoreChunk(doc, termsList)
  }));

  const matched = scored.filter(item => item.score > 0);
  const pool = matched.length ? matched : scored;

  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, Math.min(limit, pool.length)).map(item => item.doc);
}

function parseRerankResults(result, docById, fallbackDocs) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const out = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i] || {};
    const score = Number(r.relevance_score ?? r.score ?? 0);

    const docText =
      extractDocumentText(r) ||
      extractDocumentText(r.document) ||
      extractDocumentText(r.document?.text) ||
      '';

    const id = extractDocId(docText) || extractDocId(extractDocumentText(r.document)) || null;
    const doc =
      (id && docById.get(id)) ||
      (fallbackDocs[i] || null) ||
      (docText ? findDocByText(docById, docText) : null);

    if (doc) {
      out.push({ id: doc.id, doc, score });
    }
  }

  return out;
}

function extractDocumentText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function extractDocId(text) {
  const m = String(text || '').match(/\[\[DOC_ID:([A-Za-z0-9]+)\]\]/);
  return m ? m[1] : null;
}

function findDocByText(docById, text) {
  const needle = String(text || '').slice(0, 120);
  if (!needle) return null;
  for (const doc of docById.values()) {
    if (doc.text.slice(0, 120) === needle) return doc;
  }
  return null;
}

function rerankDocuments(localDocs, termsList) {
  const docById = new Map(localDocs.map(item => [item.id, item.doc]));
  const docsForApi = localDocs.map(item => item.doc);

  if (!docsForApi.length) {
    emitResults(localDocs, 'empty');
    return;
  }

  const postData = JSON.stringify({
    model: rerankModel,
    query,
    documents: docsForApi.map(doc => doc.text),
    top_n: topN,
    return_documents: true
  });

  const options = {
    hostname: proxyHost,
    port: proxyPort,
    path: '/v1/rerank',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': 'Bearer DUMMY'
    },
    timeout: requestTimeoutMs
  };

  let attempt = 0;

  const doAttempt = () => {
    attempt += 1;
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const mapped = parseRerankResults(parsed, docById, docsForApi);

          if (!mapped.length) {
            if (attempt < maxAttempts) return doAttempt();
            return fallbackLocalSearch(localDocs, termsList);
          }

          emitResults(mapped.slice(0, topN).map(item => ({
            id: item.id,
            doc: item.doc,
            score: item.score
          })), 'rerank');
        } catch {
          if (attempt < maxAttempts) return doAttempt();
          fallbackLocalSearch(localDocs, termsList);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', () => {
      if (attempt < maxAttempts) return doAttempt();
      fallbackLocalSearch(localDocs, termsList);
    });

    req.write(postData);
    req.end();
  };

  doAttempt();
}

function fallbackLocalSearch(localDocs, termsList) {
  const scored = localDocs
    .map(item => ({
      id: item.id,
      doc: item.doc,
      score: scoreChunk(item.doc, termsList)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  emitResults(scored, 'fallback');
}

function emitResults(results, mode) {
  const payload = {
    query,
    mode,
    topN,
    count: results.length,
    items: results.map((item, idx) => {
      const doc = item.doc || {};
      const preview = makePreview(doc.bodyText || doc.text || '');
      return {
        rank: idx + 1,
        id: doc.id || item.id || null,
        score: round4(item.score),
        title: doc.title || 'unknown',
        source: doc.source || 'unknown',
        chunk: `${doc.chunkIndex || 1}/${doc.chunkTotal || 1}`,
        preview,
        read_file_path: doc.source || null,
        read_file_cmd: doc.source ? `read_file ${doc.source}` : null
      };
    })
  };

  process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(0));
}

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}
