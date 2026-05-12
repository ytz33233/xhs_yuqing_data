#!/usr/bin/env node
/**
 * fetch-weibo-data.js
 * 微博舆情数据采集脚本（支持 analyzing 状态轮询重试）
 * 
 * 说明：微博智搜 API 有时返回 analyzing: true 表示结果正在分析中。
 * 此脚本通过轮询等待机制，持续重试直到获取正式结果或达到最大重试次数。
 * 
 * 用法: 由 OpenClaw agent 调用 weibo_search 工具采集，此脚本记录轮询策略
 * 
 * 轮询策略:
 * - 首次请求后若返回 analyzing: true，等待 30 秒后重试
 * - 每次重试间隔递增: 30s → 60s → 90s → 120s
 * - 最大重试次数: 5 次（总计约 7.5 分钟）
 * - 若仍 analyzing，记录异常并跳过当日微博采集
 * 
 * 输出: ym-daily/weibo-YYYY-MM-DD.md
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = '/root/.openclaw/workspace';
const DAILY_DIR = path.join(WORKSPACE, 'ym-daily');

// 微博搜索关键词矩阵（与 keywords.md 同步）
const WEIBO_KEYWORDS = [
    '工行 升金有礼',
    '工银i豆',
    '工行 i豆活动',
    '工行 升金有礼 投诉',
    '工行 i豆 投诉',
    '工行 活动 虚假宣传',
    '工行 谢谢参与',
    '工行 积分 清零'
];

// 轮询配置
const POLL_CONFIG = {
    maxRetries: 5,
    baseIntervalMs: 30000,  // 30 秒
    intervalIncrementMs: 30000,  // 每次增加 30 秒
    maxWaitTimeMs: 600000  // 最大等待 10 分钟
};

function formatDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function getTodayBeijing() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const beijing = new Date(utc + (3600000 * 8));
    return formatDate(beijing);
}

/**
 * 生成微博舆情报告模板（当 API 异常时）
 */
function generateWeiboReport(dateStr, records, apiStatus) {
    const lines = [
        `# 工行微博舆情监测报告`,
        ``,
        `**监测日期**: ${dateStr}  `,
        `**数据来源**: 微博智搜 + 微博热搜主榜  `,
        `**监测说明**: ${apiStatus}`,
        ``,
        `---`,
        ``,
        `## 📌 24h 内舆情`,
        ``
    ];

    const recentRecords = records.filter(r => r.recency === '24h内');
    const historyRecords = records.filter(r => r.recency === '历史');

    if (recentRecords.length === 0) {
        lines.push('当日微博渠道无24h内有效舆情。');
        lines.push('');
    } else {
        recentRecords.forEach((r, i) => {
            lines.push(`### ${i + 1}. ${r.title}`);
            lines.push(`- **内容摘要**：${r.content}`);
            lines.push(`- **来源博主**：${r.source}`);
            lines.push(`- **发布时间**：${r.publishTime}`);
            lines.push(`- **情绪倾向**：${r.sentiment}`);
            lines.push(`- **时效性标签**：24h内`);
            lines.push(`- **原文链接**：${r.url || 'N/A'}`);
            lines.push('');
        });
    }

    lines.push('## 📜 历史舆情');
    lines.push('');

    if (historyRecords.length === 0) {
        lines.push('当日微博渠道无历史舆情。');
        lines.push('');
    } else {
        historyRecords.forEach((r, i) => {
            lines.push(`### ${i + 1}. ${r.title}`);
            lines.push(`- **内容摘要**：${r.content}`);
            lines.push(`- **来源博主**：${r.source}`);
            lines.push(`- **发布时间**：${r.publishTime}`);
            lines.push(`- **情绪倾向**：${r.sentiment}`);
            lines.push(`- **时效性标签**：历史`);
            lines.push(`- **原文链接**：${r.url || 'N/A'}`);
            lines.push('');
        });
    }

    lines.push('---');
    lines.push('');
    lines.push('## 📝 备注');
    lines.push('');
    lines.push('- 微博智搜 API 轮询策略：analyzing 状态时等待并重试');
    lines.push(`- 最大重试次数：${POLL_CONFIG.maxRetries} 次`);
    lines.push('- 热搜主榜每日 09:00 + 20:00 盯盘');
    lines.push('');

    return lines.join('\n');
}

/**
 * 记录 API 状态到日志
 */
function logApiStatus(dateStr, status, details) {
    const logDir = path.join(WORKSPACE, 'sentiment_monitor', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `weibo-api-${dateStr}.log`);
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${status}: ${details}\n`;
    fs.appendFileSync(logFile, line);
}

/**
 * 写入微博中间文件
 */
function writeWeiboFile(dateStr, content) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const filePath = path.join(DAILY_DIR, `weibo-${dateStr}.md`);
    fs.writeFileSync(filePath, content);
    return filePath;
}

// ===== 主流程（供 OpenClaw agent 调用参考）=====
function main() {
    const dateStr = process.argv[2] || getTodayBeijing();
    
    console.log(`\n📱 微博舆情采集: ${dateStr}`);
    console.log('='.repeat(50));
    console.log('');
    console.log('⚠️  重要提示：');
    console.log('   微博智搜 API 返回 analyzing: true 时，需要轮询等待。');
    console.log('   请按以下步骤执行：');
    console.log('');
    console.log('1. 调用 weibo_search 搜索关键词（8组）');
    console.log('2. 若返回 analyzing: true：');
    console.log('   - 等待 30 秒后再次调用');
    console.log('   - 间隔递增: 30s → 60s → 90s → 120s');
    console.log('   - 最多重试 5 次');
    console.log('3. 若仍 analyzing，记录异常原因');
    console.log('4. 同时检查微博热搜主榜');
    console.log('');
    console.log('轮询配置:');
    console.log(`   最大重试: ${POLL_CONFIG.maxRetries}`);
    console.log(`   基础间隔: ${POLL_CONFIG.baseIntervalMs/1000}s`);
    console.log(`   递增步长: ${POLL_CONFIG.intervalIncrementMs/1000}s`);
    console.log(`   最大等待: ${POLL_CONFIG.maxWaitTimeMs/60000}分钟`);
    console.log('='.repeat(50));
}

main();

module.exports = {
    POLL_CONFIG,
    generateWeiboReport,
    logApiStatus,
    writeWeiboFile,
    WEIBO_KEYWORDS
};
