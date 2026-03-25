const http = require("http");
const https = require("https");

const SILICONFLOW_HOST = "api.siliconflow.cn";

const TEXT_KEY       = process.env.SILICONFLOW_TEXT_API_KEY;
const TOOL_KEY       = process.env.SILICONFLOW_TOOL_API_KEY; // 🚀 修复：激活被闲置的工具专属 Key
const VISION_KEY     = process.env.SILICONFLOW_VISION_API_KEY;
const REASONING_KEY  = process.env.SILICONFLOW_REASONING_API_KEY;
const CODE_KEY       = process.env.SILICONFLOW_CODE_API_KEY;
const EMBED_KEY      = process.env.SILICONFLOW_EMBED_API_KEY;

// 🚀 修复：启动时硬核校验，漏填 Key 直接报错拦截，拒绝静默死亡
const REQUIRED_KEYS = { TEXT: TEXT_KEY, TOOL: TOOL_KEY, VISION: VISION_KEY, REASONING: REASONING_KEY, CODE: CODE_KEY, EMBED: EMBED_KEY };
for (const [name, val] of Object.entries(REQUIRED_KEYS)) {
  if (!val) {
    console.error(`[proxy] ❌ 致命错误：缺少必要环境变量 SILICONFLOW_${name}_API_KEY`);
    process.exit(1);
  }
}

const TEXT_MODEL      = "Pro/deepseek-ai/DeepSeek-V3.2";
const VISION_MODEL    = "Qwen/Qwen3-VL-32B-Instruct";
const REASONING_MODEL = "Pro/deepseek-ai/DeepSeek-R1";
const CODE_MODEL      = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
const EMBED_MODEL     = "BAAI/bge-m3";
const RERANK_MODEL    = "BAAI/bge-reranker-v2-m3";

const MAX_BODY_SIZE       = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 600_000;

const EXPERT_MODELS = new Set([
  REASONING_MODEL,
  VISION_MODEL,
  CODE_MODEL
]);

function sanitizeMessagesForPureModels(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.filter(m => m.role !== "tool").map(m => {
    let clean = { ...m };
    if (clean.tool_calls) delete clean.tool_calls;
    
    // 🚀 修复：增强对多模态数组的处理，防止包含图片的请求把纯文本专家搞崩溃
    if (typeof clean.content === 'string') {
        clean.content = clean.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '[系统备注：工具调用已隐藏]');
    } else if (Array.isArray(clean.content)) {
        clean.content = clean.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
    }
    return clean;
  });
}

const upstreamAgent = new https.Agent({
  keepAlive: true, 
  keepAliveMsecs: 30_000, 
  maxSockets: 30,       
  maxFreeSockets: 15     
  // 🚀 修复：去掉了 node 原生不支持的 timeout 属性，避免配置误导
});

let totalRequests = 0; let totalErrors = 0;

function forwardStreamResponse(proxyRes, res, targetRoute) {
  const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "content-length"]);
  const safeHeaders = {};
  for (const [k, v] of Object.entries(proxyRes.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) safeHeaders[k] = v;
  }
  if (!res.headersSent) res.writeHead(proxyRes.statusCode, safeHeaders);

  const contentType = proxyRes.headers['content-type'] || '';
  
  if (!contentType.includes('text/event-stream')) {
    proxyRes.pipe(res);
    return;
  }

  let buffer = "";
  proxyRes.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1024 * 1024) {
      console.error("[proxy] ⚠️ 缓冲区溢出 (Buffer overflow)! 为了保护流完整性，强制断开连接。");
      // 🚀 修复：宁可掐断抛错，也绝不能给前端喂半截脏数据
      res.destroy(new Error("SSE buffer overflow"));
      return;
    }
    let lines = buffer.split('\n');
    buffer = lines.pop(); 

    for (let line of lines) {
      if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
        try {
          let jsonStr = line.slice(6).replace(/"content"\s*:\s*null/g, '"content":""').replace(/"reasoning_content"\s*:\s*null/g, '"reasoning_content":""');
          let obj = JSON.parse(jsonStr);
          
          if (obj.choices) {
            obj.choices.forEach(choice => {
              if (choice.delta?.content && targetRoute === "vision") {
                const original = choice.delta.content;
                const cleaned = original.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
                choice.delta.content = cleaned;
              }
            });
          }

          if (obj.usage) delete obj.usage; 
          res.write(`data: ${JSON.stringify(obj)}\n`);
        } catch(e) {
          res.write(line + '\n');
        }
      } else {
        res.write(line + '\n');
      }
    }
  });

  proxyRes.on('end', () => {
    if (buffer) res.write(buffer + '\n');
    res.end();
  });
  proxyRes.on("error", err => { console.error("[proxy] pipe error:", err.message); res.destroy(err); });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(process.uptime()), totalRequests, totalErrors }));
    return;
  }

  totalRequests++;
  const reqStart = Date.now();
  let body = [], bodySize = 0, aborted = false;

  req.on("data", chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      aborted = true; res.writeHead(413, { "Content-Type": "text/plain" }); res.end("Request body too large"); req.destroy();
    } else { body.push(chunk); }
  });

  req.on("end", () => {
    if (aborted) return;
    let bodyStr = Buffer.concat(body).toString();
    let json;
    try { json = JSON.parse(bodyStr); } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Bad Request: invalid JSON"); return;
    }

    const isEmbedding = req.url.includes("/embeddings");
    const isRerank = req.url.includes("/rerank"); 

    let selectedKey, routeLabel, targetRoute = "text"; 

    if (json.model && EXPERT_MODELS.has(json.model)) {
      if (json.model === REASONING_MODEL) {
        selectedKey = REASONING_KEY; routeLabel = `reason  -> ${json.model} [passthrough]`; targetRoute = "reason";
        delete json.tools; delete json.tool_choice; json.messages = sanitizeMessagesForPureModels(json.messages);
      } else if (json.model === CODE_MODEL) {
        selectedKey = CODE_KEY; routeLabel = `code    -> ${json.model} [passthrough]`; targetRoute = "code";
      } else if (json.model === VISION_MODEL) {
        selectedKey = VISION_KEY; routeLabel = `vision  -> ${json.model} [passthrough]`; targetRoute = "vision";
      }
    } 
    else if (isEmbedding) {
      json.model = EMBED_MODEL; selectedKey = EMBED_KEY; routeLabel = `embed   -> ${json.model}`; targetRoute = "embed";
    } 
    else if (isRerank) {
      json.model = RERANK_MODEL; selectedKey = EMBED_KEY; routeLabel = `rerank  -> ${json.model}`; targetRoute = "rerank";
    } 
    else {
      json.model = TEXT_MODEL; 
      targetRoute = "text";

      // 🚀 修复：全新的路由漏斗，嗅探 tools 阵列实现多 Key 计费分流
      const hasTools = Array.isArray(json.tools) && json.tools.length > 0;
      if (hasTools) {
        selectedKey = TOOL_KEY; 
        routeLabel = `tool -> ${TEXT_MODEL}`;
      } else {
        selectedKey = TEXT_KEY; 
        routeLabel = `text -> ${TEXT_MODEL}`;
      }

      if (json.messages) {
        json.messages.forEach(m => {
          if (Array.isArray(m.content)) {
            m.content = m.content.map(c => {
              if (c.type === "text") return c.text;
              return "[系统备注：用户上传了图片，原始图像载荷已被网关剥离。请通过文本中的 '[media attached: /path...]' 路径，调用 ask_vision 工具来查看图片内容。]";
            }).join("\n");
          }
        });
      }
    }

    console.log(`[proxy] ${routeLabel} (Coordinator Phase 1)`);

    bodyStr = JSON.stringify(json);
    const headers = {
      ...req.headers, host: SILICONFLOW_HOST, authorization: `Bearer ${selectedKey}`,
      "content-length": Buffer.byteLength(bodyStr), "content-type": "application/json", "connection": "keep-alive",
    };
    delete headers["accept-encoding"]; delete headers["transfer-encoding"];

    const proxy = https.request({ hostname: SILICONFLOW_HOST, path: req.url, method: req.method, headers, agent: upstreamAgent }, (proxyRes) => {
      console.log(`[proxy] upstream ${proxyRes.statusCode} in ${Date.now() - reqStart}ms`);
      if (proxyRes.statusCode >= 400) {
        totalErrors++; let errBody = [];
        proxyRes.on("data", c => errBody.push(c));
        proxyRes.on("end", () => {
          const errStr = Buffer.concat(errBody).toString();
          console.error(`[proxy] error ${proxyRes.statusCode}:`, errStr.slice(0, 300));
          if (!res.headersSent) res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
          res.end(errStr);
        });
        return;
      }
      forwardStreamResponse(proxyRes, res, targetRoute);
    });

    // 🚀 修复：当网关或前端中断连接时，同步切断跟硅流的长连接，避免 Token 白白浪费
    res.on("close", () => {
      if (!res.writableEnded) {
        proxy.destroy(new Error("client disconnected"));
      }
    });

    proxy.setTimeout(UPSTREAM_TIMEOUT_MS, () => { proxy.destroy(new Error("upstream timeout")); });
    proxy.on("error", err => {
      totalErrors++; console.error("[proxy] request error:", err.message);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Bad Gateway: ${err.message}`);
    });
    proxy.write(bodyStr); proxy.end();
  });

  req.on("error", err => { console.error("[proxy] client error:", err.message); });
});

server.timeout = 600_000;
server.keepAliveTimeout = 600_000; 
server.headersTimeout = 605_000;
server.listen(13001, () => {
  console.log("[proxy] ══════════════════════════════════════");
  console.log("[proxy] Smart routing proxy on :13001 (Coordinator Phase 1)");
  console.log("[proxy] ──────────────────────────────────────");
  console.log(`[proxy]  中央大脑 (text/tool) -> ${TEXT_MODEL}`);
  console.log(`[proxy]  视觉专家 (vision)   -> ${VISION_MODEL}`);
  console.log(`[proxy]  推理专家 (reason)   -> ${REASONING_MODEL}`);
  console.log(`[proxy]  代码专家 (code)     -> ${CODE_MODEL}`);
  console.log(`[proxy]  记忆检索 (embed)    -> ${EMBED_MODEL}`);
  console.log(`[proxy]  记忆重排 (rerank)   -> ${RERANK_MODEL}`);
  console.log("[proxy] ──────────────────────────────────────");
});

// 🚀 修复：优雅关闭机制。当 docker down 发送结束信号时，让还在跑的模型体面收尾
let isShuttingDown = false;
process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[proxy] ⚠️ 收到 SIGTERM 信号，停止接受新连接，等待现存任务完成...');
  server.close(() => { 
    console.log('[proxy] ✅ 所有任务处理完毕，服务器安全关闭。'); 
    process.exit(0); 
  });
  // 60秒强制退出兜底
  setTimeout(() => {
    console.error('[proxy] ❌ 优雅关闭超时，强制退出。');
    process.exit(1);
  }, 60_000);
});