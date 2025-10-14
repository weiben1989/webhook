import fetch from "node-fetch";
import { URL } from 'url';

// Vercel/Next.js API route config
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Webhook Configuration ---
let webhookMap = {};
try {
    if (process.env.WEBHOOK_CONFIG) {
        webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
    } else {
        console.warn("WARN: WEBHOOK_CONFIG environment variable is not set.");
    }
} catch (error) {
    console.error("FATAL: Could not parse WEBHOOK_CONFIG. Please check its JSON format.", error);
}

// Helper function to read the raw request body
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

// --- Stock Name API Helpers ---
async function getStockNameFromSina(stockCode, marketPrefix) {
    const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
    try {
        const response = await fetch(url, { timeout: 3000 });
        if (!response.ok) return null;
        const responseBuffer = await response.arrayBuffer();
        const responseText = new TextDecoder('gbk').decode(responseBuffer);
        const parts = responseText.split('"');
        if (parts.length > 1 && parts[1] && parts[1].length > 1) {
            return parts[1].split(',')[0];
        }
        return null;
    } catch (error) {
        console.error(`[DEBUG] Sina API call failed for ${stockCode}`, error);
        return null;
    }
}

async function getStockNameFromTencent(stockCode, marketPrefix) {
    let finalStockCode = stockCode;
    if (marketPrefix === 'hk') {
        finalStockCode = stockCode.padStart(5, '0');
    }
    const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalStockCode}`;
    try {
        const response = await fetch(url, { timeout: 3000 });
        if (!response.ok) return null;
        const responseBuffer = await response.arrayBuffer();
        const responseText = new TextDecoder('gbk').decode(responseBuffer);
        const parts = responseText.split('~');
        if (parts.length > 1 && parts[1]) {
            return parts[1];
        }
        return null;
    } catch (error) {
        console.error(`[DEBUG] Tencent API call failed for ${stockCode}`, error);
        return null;
    }
}

async function getChineseStockName(stockCode) {
    let marketPrefix;
    if (stockCode.length <= 5 && /^\d+$/.test(stockCode)) {
        marketPrefix = 'hk';
    } else if (stockCode.length === 6 && /^\d+$/.test(stockCode)) {
        if (stockCode.startsWith('6') || stockCode.startsWith('5')) {
            marketPrefix = 'sh';
        } else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('1')) {
            marketPrefix = 'sz';
        }
    }
    if (!marketPrefix) {
        console.log(`[DEBUG] No market prefix found for stock code: ${stockCode}.`);
        return null;
    }
    console.log(`[DEBUG] Identified market '${marketPrefix}' for stock code: ${stockCode}`);
    let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
    if (chineseName) {
        console.log(`[DEBUG] Sina returned name: ${chineseName}`);
        return chineseName;
    }
    chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
    if (chineseName) {
        console.log(`[DEBUG] Tencent returned name: ${chineseName}`);
    }
    return chineseName;
}

// --- Message Processing Function with Debug Info ---
async function processMessage(body) {
    let debugReport = [];
    debugReport.push(`1. Original Body (raw):\n---\n${body}\n---`);
    debugReport.push(`2. Body length: ${body.length}, Contains newline: ${body.includes('\n')}`);
    
    let messageToProcess = body;
    let finalContent = messageToProcess;

    // 先尝试单行格式匹配（无论是否有换行，都先试试）
    const singleLineRegex = /标的\s*[:：]\s*(\d{5,6})\s*[,，]?\s*(.*)/;
    const singleLineMatch = messageToProcess.match(singleLineRegex);
    
    console.log(`[DEBUG] Single-line regex match: ${!!singleLineMatch}`);
    
    if (singleLineMatch) {
        debugReport.push("3. Single-Line Pattern Detected: YES");
        
        const stockCode = singleLineMatch[1];
        let remainderPart = singleLineMatch[2];
        
        console.log(`[DEBUG] Extracted stock code: ${stockCode}`);
        console.log(`[DEBUG] Remainder: ${remainderPart}`);
        
        debugReport.push(`4. Found Code: '${stockCode}'`);
        debugReport.push(`5. Remainder: '${remainderPart}'`);
        
        // 清理开头的逗号和空格
        remainderPart = remainderPart.replace(/^[,，\s]+/, '');

        // 获取股票中文名称
        console.log(`[DEBUG] Fetching Chinese name for: ${stockCode}`);
        const chineseName = await getChineseStockName(stockCode);
        console.log(`[DEBUG] Chinese name result: ${chineseName || 'NULL'}`);
        
        debugReport.push(`6. API Result for '${stockCode}': '${chineseName || 'FAILED'}'`);

        let formattedStockLine;
        if (chineseName) {
            formattedStockLine = `标的:${chineseName}(${stockCode})`;
        } else {
            formattedStockLine = `标的:(${stockCode})`;
        }
        
        // 如果原文是单行，就用换行分隔；如果是多行，就替换第一行
        if (!messageToProcess.includes('\n')) {
            finalContent = `${formattedStockLine}\n${remainderPart}`;
        } else {
            // 多行情况：替换第一个匹配项
            const originalMatch = messageToProcess.match(/标的\s*[:：]\s*\d{5,6}/);
            if (originalMatch) {
                finalContent = messageToProcess.replace(originalMatch[0], formattedStockLine);
            }
        }
        
        debugReport.push(`7. Final Formatted Content:\n---\n${finalContent}\n---`);

    } else {
        // 完全没有匹配到股票代码格式
        debugReport.push("3. Single-Line Pattern Detected: NO");
        debugReport.push("4. No stock code pattern found, returning original message.");
        console.log(`[DEBUG] No stock pattern matched in message`);
    }

    return { finalContent, debugInfo: debugReport.join('\n') };
}


export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    
    const requestUrl = new URL(req.url, `https://${req.headers.host}`);
    const proxyKey = requestUrl.searchParams.get('key');
    const isDebugMode = requestUrl.searchParams.get('debug') === 'true';

    console.log(`[PROXY] Request received - Key: ${proxyKey}, Debug: ${isDebugMode}`);

    if (!proxyKey) {
        return res.status(400).json({ error: "Missing 'key' parameter." });
    }
    const proxyConfig = webhookMap[proxyKey];
    if (!proxyConfig || !proxyConfig.url) {
        return res.status(404).json({ error: `Proxy key '${proxyKey}' not found or misconfigured.` });
    }
    
    const finalWebhookUrl = proxyConfig.url;
    const destinationType = proxyConfig.type || 'raw'; 

    const rawBody = (await getRawBody(req)).toString('utf8');
    console.log(`[PROXY] Raw body received: ${rawBody}`);
    
    let messageBody;
    try {
        const alertData = JSON.parse(rawBody);
        console.log(`[PROXY] Parsed as JSON, converting to text...`);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
        console.log(`[PROXY] Converted message: ${messageBody}`);
    } catch (e) {
        console.log(`[PROXY] Not JSON, using raw body`);
        messageBody = rawBody;
    }
    
    const trimmedBody = messageBody.trim();
    console.log(`[PROXY] Trimmed body: ${trimmedBody}`);

    // --- Apply all processing ---
    const { finalContent, debugInfo } = await processMessage(trimmedBody);
    console.log(`[PROXY] Processed content: ${finalContent}`);
    
    // 版本标记
    let messageToSend = `✅ ${finalContent}`;
    
    if (isDebugMode) {
        messageToSend += `\n\n--- 诊断报告 ---\n${debugInfo}`;
    }

    console.log(`[PROXY] Final message to send: ${messageToSend}`);

    // --- INTELLIGENT PAYLOAD FORMATTING ---
    let forwardResponse;
    if (destinationType === 'wecom') {
        const payload = {
            msgtype: 'markdown',
            markdown: { content: messageToSend },
        };
        console.log(`[PROXY] Sending to WeCom with payload: ${JSON.stringify(payload)}`);
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } else {
        console.log(`[PROXY] Sending as plain text`);
        forwardResponse = await fetch(finalWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: messageToSend,
        });
    }

    const responseText = await forwardResponse.text();
    console.log(`[PROXY] Forward response status: ${forwardResponse.status}, body: ${responseText}`);

    if (!forwardResponse.ok) {
        console.error(`[PROXY] Failed to forward. Key: ${proxyKey}, Type: ${destinationType}, Status: ${forwardResponse.status}`);
    } else {
        console.log(`[PROXY] Successfully forwarded alert for key '${proxyKey}'.`);
    }

    return res.status(200).json({ success: true, message: `Alert processed for key '${proxyKey}'.` });

  } catch (error) {
    console.error('Webhook Error:', error.message, error.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
