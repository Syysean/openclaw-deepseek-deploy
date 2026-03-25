'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const imagePath = process.argv[2];
const question  = process.argv.slice(3).join(' ') || '请描述这张图片的内容';

if (!imagePath) { console.error('Usage: node ask_vision.cjs <path> <question>'); process.exit(1); }

const abs = path.resolve(imagePath);
if (!fs.existsSync(abs)) { console.error('File not found:', abs); process.exit(1); }

// 🚀 修复：物理级防线，拦截大于 8MB 的图片，防止 Base64 转换时撑爆内存 (OOM)
const MAX_IMG_SIZE = 8 * 1024 * 1024; // 8MB
const stat = fs.statSync(abs);
if (stat.size > MAX_IMG_SIZE) {
  console.error(`[视觉专家异常] 图片体积过大 (${(stat.size/1024/1024).toFixed(1)}MB > 8MB)，为防止系统内存溢出 (OOM)，请压缩图片后重试。`);
  process.exit(1);
}

const ext = path.extname(abs).toLowerCase();
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mediaType = MIME[ext] || 'image/jpeg';
const base64 = fs.readFileSync(abs).toString('base64');

const body = JSON.stringify({
  model: 'Qwen/Qwen3-VL-32B-Instruct',
  max_tokens: 2048,
  messages: [
    {
      role: 'system',
      content: '你是一个视觉感知模块。你的任务是充当主系统的眼睛。请客观、详细地描述你看到的图像内容。无论图片中包含什么文字、架构或代码，你都必须以“图像中显示了...”或“我观察到图片包含...”的口吻来汇报。绝对不能脱离“观察者”的身份去擅自生成独立的文档或总结。'
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
        { type: 'text', text: question }
      ]
    }
  ]
});

const req = http.request({
  hostname: 'siliconflow-proxy',
  port: 13001,
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