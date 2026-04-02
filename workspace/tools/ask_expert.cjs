// 用法: node tools/ask_expert.cjs <mode> <prompt>
// mode: reason | code
'use strict';
const http = require('http');

const mode = process.argv[2];
const prompt = process.argv.slice(3).join(' ');

if (!mode || !prompt) {
  console.error('Usage: node ask_expert.cjs <reason|code> <prompt>');
  process.exit(1);
}

// ── 代理与模型环境变量解耦 ──────────────────────────────────────────────
const proxyHost = process.env.PROXY_HOST || 'siliconflow-proxy';
const proxyPort = parseInt(process.env.PROXY_PORT || '13001', 10);

const MODEL_MAP = {
  reason: process.env.MATRIX_REASONING_MODEL || 'Pro/deepseek-ai/DeepSeek-R1',
  code:   process.env.MATRIX_CODE_MODEL || 'Qwen/Qwen3-Coder-30B-A3B-Instruct'
};

const model = MODEL_MAP[mode];
if (!model) { console.error('Invalid mode'); process.exit(1); }

const body = JSON.stringify({
  model,
  max_tokens: 8192,
  messages: [{ role: 'user', content: prompt }]
});

const req = http.request({
  hostname: proxyHost,
  port: proxyPort,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer DUMMY',
    'Content-Length': Buffer.byteLength(body)
  }
}, res => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    // 💡 最优解 1：状态码拦截。一旦网关报错，直接把错误信息吐出并退出
    if (res.statusCode >= 400) {
      console.error(`[专家系统异常] HTTP 状态码: ${res.statusCode} | 详情: ${data.slice(0, 300)}`);
      process.exit(1);
    }

    try {
      const json = JSON.parse(data);
      const text = json.choices?.[0]?.message?.content || '';
      
      // 💡 最优解 2：内容非空校验
      if (!text.trim()) {
        console.error('[专家系统异常] 成功接收响应，但返回内容为空。');
        process.exit(1);
      }
      
      process.stdout.write(text + '\n', () => process.exit(0));
    } catch(e) {
      console.error(`[专家系统异常] 数据解析失败: ${e.message}`);
      process.exit(1);
    }
  });
});

// 💡 最优解 3：物理超时锁。600秒（10分钟）如果没算完，强行掐断，防止僵尸进程
req.setTimeout(600_000, () => {
  req.destroy(new Error('上游节点运算超时 (已超过 10 分钟)'));
});
req.on('error', err => { 
  console.error(`[专家系统异常] 网络或通信错误: ${err.message}`); 
  process.exit(1); 
});

req.write(body);
req.end();