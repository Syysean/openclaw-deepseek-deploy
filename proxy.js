const http  = require("http");
const https = require("https");

// ─── 上游主机 ───────────────────────────────────────────────────────────────
const OPENAI_COMPATIBLE_HOST = process.env.OPENAI_COMPATIBLE_HOST || "api.siliconflow.cn";

// ─── API Keys ───────────────────────────────────────────────────────────────
const TEXT_KEY      = process.env.MATRIX_TEXT_API_KEY;
const TOOL_KEY      = process.env.MATRIX_TOOL_API_KEY;
const VISION_KEY    = process.env.MATRIX_VISION_API_KEY;
const REASONING_KEY = process.env.MATRIX_REASONING_API_KEY;
const CODE_KEY      = process.env.MATRIX_CODE_API_KEY;
const EMBED_KEY     = process.env.MATRIX_EMBED_API_KEY;

const REQUIRED_KEYS = { TEXT: TEXT_KEY, TOOL: TOOL_KEY, VISION: VISION_KEY, REASONING: REASONING_KEY, CODE: CODE_KEY, EMBED: EMBED_KEY };
for (const [name, val] of Object.entries(REQUIRED_KEYS)) {
  if (!val) {
    console.error(`[proxy] ❌ 致命错误：缺少必要环境变量 MATRIX_${name}_API_KEY`);
    process.exit(1);
  }
}

// ─── 模型配置 ────────────────────────────────────────────────────────────────
const MATRIX_MODELS = {
  TEXT:      process.env.MATRIX_TEXT_MODEL      || "Pro/deepseek-ai/DeepSeek-V3.2",
  VISION:    process.env.MATRIX_VISION_MODEL    || "Qwen/Qwen3-VL-32B-Instruct",
  REASONING: process.env.MATRIX_REASONING_MODEL || "Pro/deepseek-ai/DeepSeek-R1",
  CODE:      process.env.MATRIX_CODE_MODEL      || "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  EMBED:     process.env.MATRIX_EMBED_MODEL     || "BAAI/bge-m3",
  RERANK:    process.env.MATRIX_RERANK_MODEL    || "BAAI/bge-reranker-v2-m3",
};

// ─── 常量 ────────────────────────────────────────────────────────────────────
const MAX_BODY_SIZE       = 10 * 1024 * 1024; // 10MB
const UPSTREAM_TIMEOUT_MS = 600_000;           // 10分钟
const VISION_TIMEOUT_MS   = 120_000;           // 视觉分析超时 2分钟
const SSE_BUFFER_LIMIT    = 1024 * 1024;       // 1MB SSE缓冲上限

// ─── 连接池 ───────────────────────────────────────────────────────────────────
const upstreamAgent = new https.Agent({
  keepAlive:      true,
  keepAliveMsecs: 30_000,
  maxSockets:     30,
  maxFreeSockets: 15,
  scheduling:     "lifo",
});

// ─── 统计 ────────────────────────────────────────────────────────────────────
let totalRequests = 0;
let totalErrors   = 0;
let reqCounter    = 0;

// ─── media://inbound/<id> URI 解析 (PR #55513 Claim Check 契约) ─────────────
// 网关对 2–5MB 图片存盘后在消息文本中注入 media://inbound/<id>。
// proxy 检测到此 URI 后，读取文件并转为 base64，统一交给 analyzeImageBase64 处理。
const MEDIA_INBOUND_DIR = process.env.OPENCLAW_MEDIA_INBOUND_DIR ||
  require("path").join(process.env.HOME || "/home/node", ".openclaw", "media", "inbound");
const MEDIA_URI_RE = /media:\/\/inbound\/([^\s\]"'<>]+)/g;

function resolveMediaUriToDataUrl(mediaId) {
  const fs   = require("fs");
  const pa   = require("path");
  const safeMediaId = pa.basename(mediaId); 
  const filePath = pa.resolve(MEDIA_INBOUND_DIR, safeMediaId);
  
  if (!fs.existsSync(filePath)) return null;
  const ext  = pa.extname(filePath).toLowerCase();
  const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png",  ".webp": "image/webp", ".gif": "image/gif" };
  const mime = MIME[ext] || "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

// ─── 视觉分析：base64 → 文字描述 ──────────────────────────────────────────────
// 仅在默认分支检测到 base64 图片时调用。
// 原因：base64 数据只存在于当前请求内存，无法落盘供 ask_vision.cjs 读取，
// 因此必须在 proxy 层直接调用 Qwen-VL 完成转换，再把文字描述注入 DeepSeek 上下文。
function analyzeImageBase64(dataUrl, reqId) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      console.error(`[proxy][${reqId}] vision timeout`);
      resolve("[视觉分析超时，图片内容无法获取]");
    }, VISION_TIMEOUT_MS);

    const payload = JSON.stringify({
      model: MATRIX_MODELS.VISION,
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: "请详细描述这张图片的完整内容。如果包含文字请准确转录，如果是界面截图请描述所有可见的UI元素、状态信息和核心内容。" }
        ]
      }]
    });

    const req = https.request({
      hostname: OPENAI_COMPATIBLE_HOST,
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${VISION_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Connection":     "keep-alive",
      },
      agent: upstreamAgent,
    }, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode >= 400) {
          console.error(`[proxy][${reqId}] vision API error ${res.statusCode}:`, data.slice(0, 200));
          resolve(`[视觉分析失败 HTTP ${res.statusCode}]`);
          return;
        }
        try {
          const text = JSON.parse(data).choices?.[0]?.message?.content || "";
          if (!text.trim()) { resolve("[视觉分析返回空内容]"); return; }
          resolve(text);
        } catch {
          resolve("[视觉分析结果解析失败]");
        }
      });
    });

    req.setTimeout(VISION_TIMEOUT_MS, () => {
      req.destroy();
      clearTimeout(timer);
      resolve("[视觉分析请求超时]");
    });
    req.on("error", err => {
      clearTimeout(timer);
      console.error(`[proxy][${reqId}] vision request error:`, err.message);
      resolve(`[视觉网络错误: ${err.message}]`);
    });

    req.write(payload);
    req.end();
  });
}

// ─── 工具函数：清理 R1 不支持的消息格式 ──────────────────────────────────────
function sanitizeForR1(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages
    .filter(m => m.role !== "tool")
    .map(m => {
      if (!m.tool_calls && typeof m.content === "string") return m;
      const clean = { role: m.role };
      if (m.name) clean.name = m.name;
      if (typeof m.content === "string") {
        clean.content = m.content;
      } else if (Array.isArray(m.content)) {
        clean.content = m.content.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
      } else {
        clean.content = "";
      }
      return clean;
    });
}

// ─── SSE 流转发 ───────────────────────────────────────────────────────────────
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-length",
]);

function forwardStreamResponse(proxyRes, res, targetRoute) {
  const safeHeaders = {};
  for (const [k, v] of Object.entries(proxyRes.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) safeHeaders[k] = v;
  }
  if (!res.headersSent) res.writeHead(proxyRes.statusCode, safeHeaders);

  if (!(proxyRes.headers["content-type"] || "").includes("text/event-stream")) {
    proxyRes.pipe(res);
    return;
  }

  let buffer = "";
  proxyRes.on("data", chunk => {
    buffer += chunk.toString("utf8");
    if (buffer.length > SSE_BUFFER_LIMIT) {
      console.error("[proxy] ⚠️ SSE 缓冲区溢出，强制断开");
      res.destroy(new Error("SSE buffer overflow"));
      return;
    }

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
        try {
          const jsonStr = line.slice(6)
            .replace(/"content"\s*:\s*null/g,           '"content":""')
            .replace(/"reasoning_content"\s*:\s*null/g, '"reasoning_content":""');
          const obj = JSON.parse(jsonStr);

          if (obj.usage) delete obj.usage;

          if (targetRoute === "vision" && obj.choices) {
            for (const choice of obj.choices) {
              if (choice.delta?.content) {
                choice.delta.content = choice.delta.content
                  .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
              }
            }
          }

          res.write(`data: ${JSON.stringify(obj)}\n`);
        } catch {
          res.write(line + "\n");
        }
      } else {
        res.write(line + "\n");
      }
    }
  });

  proxyRes.on("end",   () =>  { if (buffer) res.write(buffer + "\n"); res.end(); });
  proxyRes.on("error", err => { console.error("[proxy] pipe error:", err.message); res.destroy(err); });
}

// ─── 转发到上游 ───────────────────────────────────────────────────────────────
function sendToUpstream(req, res, json, selectedKey, targetRoute, routeLabel, reqId, reqStart) {
  console.log(`[proxy][${reqId}] ${routeLabel}`);

  const bodyStr = JSON.stringify(json);
  const headers = {
    ...req.headers,
    host:             OPENAI_COMPATIBLE_HOST,
    authorization:    `Bearer ${selectedKey}`,
    "content-type":   "application/json",
    "content-length": Buffer.byteLength(bodyStr),
    "connection":     "keep-alive",
  };
  delete headers["accept-encoding"];
  delete headers["transfer-encoding"];

  const proxy = https.request(
    { hostname: OPENAI_COMPATIBLE_HOST, path: req.url, method: req.method, headers, agent: upstreamAgent },
    proxyRes => {
      console.log(`[proxy][${reqId}] upstream ${proxyRes.statusCode} in ${Date.now() - reqStart}ms`);
      if (proxyRes.statusCode >= 400) {
        totalErrors++;
        const errChunks = [];
        proxyRes.on("data", c => errChunks.push(c));
        proxyRes.on("end", () => {
          const errStr = Buffer.concat(errChunks).toString();
          console.error(`[proxy][${reqId}] error ${proxyRes.statusCode}:`, errStr.slice(0, 300));
          if (!res.headersSent) res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
          res.end(errStr);
        });
        return;
      }
      forwardStreamResponse(proxyRes, res, targetRoute);
    }
  );

  res.on("close", () => { if (!res.writableEnded) proxy.destroy(new Error("client disconnected")); });
  proxy.setTimeout(UPSTREAM_TIMEOUT_MS, () => proxy.destroy(new Error("upstream timeout")));
  proxy.on("error", err => {
    totalErrors++;
    console.error(`[proxy][${reqId}] request error:`, err.message);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Bad Gateway: ${err.message}`);
  });

  proxy.write(bodyStr);
  proxy.end();
}

// ─── HTTP 服务 ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(process.uptime()), totalRequests, totalErrors }));
    return;
  }

  totalRequests++;
  const reqId    = String(++reqCounter % 10000).padStart(4, "0");
  const reqStart = Date.now();
  const chunks   = [];
  let bodySize   = 0;
  let aborted    = false;

  req.on("data", chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      aborted = true;
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Request body too large");
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });

  req.on("end", async () => {
    if (aborted) return;

    let json;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400); res.end("Bad Request"); return;
    }

    // ── 路由决策 ──────────────────────────────────────────────────────────────
    const isEmbedding = req.url.includes("/embeddings");
    const isRerank    = req.url.includes("/rerank");

    let selectedKey;
    let routeLabel;
    let targetRoute = "text";

    if (isEmbedding) {
      json.model  = MATRIX_MODELS.EMBED;
      selectedKey = EMBED_KEY;
      routeLabel  = `embed  -> ${json.model}`;

    } else if (isRerank) {
      json.model  = MATRIX_MODELS.RERANK;
      selectedKey = EMBED_KEY;
      routeLabel  = `rerank -> ${json.model}`;

    } else if (json.model === MATRIX_MODELS.REASONING) {
      selectedKey = REASONING_KEY;
      routeLabel  = `reason -> ${json.model}`;
      targetRoute = "reason";
      delete json.tools;
      delete json.tool_choice;
      json.messages = sanitizeForR1(json.messages);

    } else if (json.model === MATRIX_MODELS.VISION) {
      selectedKey = VISION_KEY;
      routeLabel  = `vision -> ${json.model}`;
      targetRoute = "vision";

    } else if (json.model === MATRIX_MODELS.CODE) {
      selectedKey = CODE_KEY;
      routeLabel  = `code   -> ${json.model}`;
      targetRoute = "code";

    } else {
      // ── 默认：DeepSeek 大脑 ──────────────────────────────────────────────────
      // ① base64 inline 图片拦截（< 2MB，直接编码路径）
      // ② media://inbound/<id> URI 拦截（2–5MB Claim Check 路径，PR #55513）
      if (json.messages) {
        for (const m of json.messages) {

          // ① image_url block（base64 inline）
          if (Array.isArray(m.content)) {
            const newContent = [];
            let hasImage = false;
            for (const block of m.content) {
              if (block.type === "image_url" && block.image_url?.url?.startsWith("data:")) {
                hasImage = true;
                console.log(`[proxy][${reqId}] 📸 检测到 base64 图片，调用 Qwen-VL 分析...`);
                const description = await analyzeImageBase64(block.image_url.url, reqId);
                console.log(`[proxy][${reqId}] ✅ 视觉分析完成，注入 DeepSeek 上下文`);
                newContent.push({ type: "text",
                  text: `\n[视觉专家 Qwen3-VL 图像分析报告]：\n${description}\n[报告结束]` });
              } else {
                newContent.push(block);
              }
            }
            if (hasImage) {
              // 展平为纯文本，避免 DeepSeek 收到混合内容格式报错
              m.content = newContent.map(b => (typeof b === "string" ? b : b.text || "")).join("\n");
            }
          }

          // ② media://inbound/<id> URI（Claim Check，文本内注入）
          const textContent = typeof m.content === "string" ? m.content : "";
          if (textContent && textContent.includes("media://inbound/")) {
            MEDIA_URI_RE.lastIndex = 0;
            const matches = [...textContent.matchAll(MEDIA_URI_RE)];
            if (matches.length > 0) {
              let replaced = textContent;
              for (const match of matches) {
                const mediaId = match[1];
                const dataUrl = resolveMediaUriToDataUrl(mediaId);
                if (!dataUrl) {
                  console.warn(`[proxy][${reqId}] ⚠️ media://inbound/${mediaId} 文件不存在，跳过`);
                  continue;
                }
                console.log(`[proxy][${reqId}] 🖼️ 检测到 media://inbound URI，调用 Qwen-VL 分析...`);
                const description = await analyzeImageBase64(dataUrl, reqId);
                console.log(`[proxy][${reqId}] ✅ media URI 视觉分析完成 (${mediaId})`);
                replaced = replaced.replace(match[0],
                  `[视觉专家 Qwen3-VL 图像分析报告 (${mediaId})]：\n${description}\n[报告结束]`);
              }
              m.content = replaced;
            }
          }
        }
      }

      json.model  = MATRIX_MODELS.TEXT;
      targetRoute = "text";
      const hasTools = Array.isArray(json.tools) && json.tools.length > 0;
      selectedKey = hasTools ? TOOL_KEY : TEXT_KEY;
      routeLabel  = `${hasTools ? "tool" : "text"} -> ${json.model}`;
    }

    sendToUpstream(req, res, json, selectedKey, targetRoute, routeLabel, reqId, reqStart);
  });

  req.on("error", err => console.error(`[proxy][${reqId}] client error:`, err.message));
});

// ─── 服务器超时配置 ───────────────────────────────────────────────────────────
server.timeout          = 600_000;
server.keepAliveTimeout = 600_000;
server.headersTimeout   = 605_000;

server.listen(13001, () => {
  console.log("[proxy] ══════════════════════════════════════");
  console.log("[proxy] Smart routing proxy on :13001");
  console.log("[proxy] ──────────────────────────────────────");
  console.log(`[proxy]  中央大脑 (text/tool) -> ${MATRIX_MODELS.TEXT}`);
  console.log(`[proxy]  视觉专家 (vision)   -> ${MATRIX_MODELS.VISION}`);
  console.log(`[proxy]  推理专家 (reason)   -> ${MATRIX_MODELS.REASONING}`);
  console.log(`[proxy]  代码专家 (code)     -> ${MATRIX_MODELS.CODE}`);
  console.log(`[proxy]  记忆检索 (embed)    -> ${MATRIX_MODELS.EMBED}`);
  console.log(`[proxy]  记忆重排 (rerank)   -> ${MATRIX_MODELS.RERANK}`);
  console.log("[proxy] ──────────────────────────────────────");
});

// ─── 优雅关闭 ─────────────────────────────────────────────────────────────────
let isShuttingDown = false;
process.on("SIGTERM", () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("\n[proxy] ⚠️ 收到 SIGTERM，停止接受新连接...");
  server.close(() => {
    console.log("[proxy] ✅ 安全关闭完成");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[proxy] ❌ 优雅关闭超时，强制退出");
    process.exit(1);
  }, 60_000);
});
