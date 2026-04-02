'use strict'; // 🚀 统一开启严格模式

const mode = process.argv[2]; // 'search' (Jina), 'read' (Jina 快读), 或 'scrape' (Firecrawl 重型渲染)
const target = process.argv.slice(3).join(' ');

if (!mode || !target) {
    console.error('使用方法: node tools/web_fetch.cjs <search|read|scrape> <query|url>');
    process.exit(1);
}

// ── 环境变量配置 ──────────────────────────────────────────────
const JINA_API_KEY = process.env.JINA_API_KEY || '';
// 如果你部署了本地 Firecrawl，可以在 docker-compose 里把 FIRECRAWL_API_URL 设为 http://firecrawl:3002
const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || ''; 

async function run() {
    try {
        const controller = new AbortController();
        // Firecrawl 渲染慢，将炸弹引信延长到 45 秒
        const timeoutId = setTimeout(() => controller.abort(), 45_000); 

        let text = '';

        // ==========================================
        // 🚀 引擎 1：Jina (轻骑兵) - 负责快速搜索和简单快读
        // ==========================================
        if (mode === 'search' || mode === 'read') {
            let url = mode === 'search' ? 
                'https://s.jina.ai/' + encodeURIComponent(target) : 
                'https://r.jina.ai/' + (target.startsWith('http') ? target : 'https://' + target);

            const headers = { 'X-Return-Format': 'markdown' };
            if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;

            const response = await fetch(url, { headers, signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.error(`[Jina 引擎失败] HTTP 状态码 ${response.status}。提示：如果是 401，请配置 JINA_API_KEY。`);
                process.exit(1);
            }
            text = await response.text();
        } 
        
        // ==========================================
        // 🚜 引擎 2：Firecrawl (重型推土机) - 负责复杂 JS 渲染
        // ==========================================
        else if (mode === 'scrape') {
            const url = `${FIRECRAWL_API_URL}/v1/scrape`;
            const headers = { 'Content-Type': 'application/json' };
            // 如果连的是官方云端，必须带 Key；如果是本地自托管，可以不要 Key
            if (FIRECRAWL_API_KEY) headers['Authorization'] = `Bearer ${FIRECRAWL_API_KEY}`;

            const body = JSON.stringify({
                url: target.startsWith('http') ? target : 'https://' + target,
                formats: ["markdown"],
                // 强制只返回干净的 markdown，丢弃乱七八糟的 HTML 和 Metadata
                onlyMainContent: true 
            });

            const response = await fetch(url, { 
                method: 'POST', 
                headers, 
                body,
                signal: controller.signal 
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[Firecrawl 引擎失败] 状态码 ${response.status} | 详情: ${errText}`);
                process.exit(1);
            }
            
            const json = await response.json();
            if (!json.success) {
                console.error(`[Firecrawl 引擎异常] 抓取失败: ${json.error}`);
                process.exit(1);
            }
            text = json.data?.markdown || '';
        } 
        
        else {
            console.error('模式错误。只能使用 "search"、"read" 或 "scrape"。');
            process.exit(1);
        }

        // 🛡️ 核心安全锁：防止网页太长撑爆 Token 窗口 (截断在 15000 字符)
        const maxLength = 15000;
        if (text.length > maxLength) {
            console.log(text.substring(0, maxLength) + '\n\n...[为保护大模型上下文，已自动截断超长内容]...');
        } else {
            console.log(text);
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('[网络异常] 抓取超时 (超过设定时间)，已强行掐断以保护系统。');
        } else {
            console.error('[网络异常] 抓取失败，请检查网络或代理设置:', error.message);
        }
        process.exit(1);
    }
}

run();