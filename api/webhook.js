import fetch from "node-fetch";

// Vercel/Next.js API route config
// We disable the default bodyParser to handle raw body for encoding issues.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper function to read the raw request body as a buffer
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Fetches the Chinese name of a stock from Sina Finance API.
 * @param {string} stockCode The stock code (e.g., '002074').
 * @returns {Promise<string|null>} The Chinese name or null if not found.
 */
async function getChineseStockName(stockCode) {
  // Determine market prefix (sh for Shanghai, sz for Shenzhen)
  let marketPrefix;
  if (stockCode.startsWith('6')) {
    marketPrefix = 'sh';
  } else if (stockCode.startsWith('0') || stockCode.startsWith('3')) {
    marketPrefix = 'sz';
  } else {
    // Can add more rules for other markets (e.g., hk, us) if needed
    return null;
  }

  const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    // The response is text, not JSON, and needs to be decoded correctly.
    // GBK is often used by these older APIs.
    const responseBuffer = await response.arrayBuffer();
    const responseText = new TextDecoder('gbk').decode(responseBuffer);
    
    // Response format: var hq_str_sz002074="国轩高科,..."
    const parts = responseText.split('"');
    if (parts.length > 1) {
      const stockData = parts[1].split(',');
      if (stockData[0]) {
        return stockData[0]; // The first part is the Chinese name
      }
    }
    return null;
  } catch (error) {
    console.error(`API Error fetching stock name for ${stockCode}:`, error);
    return null;
  }
}


export default async function handler(req, res) {
  try {
    // 1. 安全检查：只接受 POST 请求
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 企业微信 webhook 地址
    const webhookURL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cee69a01-8397-486c-a820-f44cd5181313';

    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');

    // 2. 智能解析请求体
    let messageBody;
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
        const jsonData = JSON.parse(rawBody);
        messageBody = Object.entries(jsonData)
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
            .join('\n');
    } else { 
      try {
        const alertData = JSON.parse(rawBody);
        messageBody = Object.entries(alertData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
      } catch (e) {
        messageBody = rawBody;
      }
    } 

    // 3. 翻译股票名称 (现在通过API动态查询)
    let finalContent = messageBody;
    const stockMatch = messageBody.match(/标的:.*\(([^)]+)\)/);
    if (stockMatch && stockMatch[1]) {
      const stockCode = stockMatch[1];
      // Call the new API function
      const chineseName = await getChineseStockName(stockCode);
      if (chineseName) {
        finalContent = messageBody.replace(
          /标的:.*?\n/, 
          `标的: ${chineseName} (${stockCode})\n`
        );
      }
    }

    // 4. 发送到企业微信
    const wechatResponse = await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: finalContent },
      }),
    });

    if (!wechatResponse.ok) {
        const wechatResult = await wechatResponse.json();
        console.error("Error sending to WeChat:", wechatResult);
        throw new Error(`Failed to send message to WeChat: ${wechatResult.errmsg || 'Unknown error'}`);
    }

    // 5. 向 TradingView 返回成功响应
    return res.status(200).json({ success: true, message: 'Alert forwarded successfully' });

  } catch (error) {
    console.error('Webhook Error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

