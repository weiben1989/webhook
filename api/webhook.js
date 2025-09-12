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
  let marketPrefix;
  if (stockCode.startsWith('6')) {
    marketPrefix = 'sh';
  } else if (stockCode.startsWith('0') || stockCode.startsWith('3')) {
    marketPrefix = 'sz';
  } else {
    console.log(`[DEBUG] Unknown market for stock code: ${stockCode}`);
    return null;
  }

  const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
  console.log(`[DEBUG] Fetching URL: ${url}`);
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
        console.error(`[DEBUG] API response not OK. Status: ${response.status}`);
        return null;
    }
    
    const responseBuffer = await response.arrayBuffer();
    const responseText = new TextDecoder('gbk').decode(responseBuffer);
    console.log(`[DEBUG] Raw API Response: ${responseText}`);
    
    const parts = responseText.split('"');
    if (parts.length > 1 && parts[1]) {
      const stockData = parts[1].split(',');
      const chineseName = stockData[0];
      console.log(`[DEBUG] Parsed Chinese Name: ${chineseName}`);
      return chineseName;
    } else {
      console.log(`[DEBUG] Could not parse name from response.`);
      return null;
    }
  } catch (error) {
    console.error(`[DEBUG] API fetch error for ${stockCode}:`, error);
    return null;
  }
}


export default async function handler(req, res) {
  console.log(`\n--- New Request Received at ${new Date().toISOString()} ---`);
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const webhookURL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cee69a01-8397-486c-a820-f44cd5181313';

    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');
    console.log('[DEBUG] Received Raw Body:', rawBody);

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

    let finalContent = messageBody;
    const stockMatch = messageBody.match(/标的:.*\(([^)]+)\)/);

    if (stockMatch && stockMatch[1]) {
      const stockCode = stockMatch[1];
      console.log(`[DEBUG] Matched stock code: ${stockCode}`);

      const chineseName = await getChineseStockName(stockCode);
      
      if (chineseName) {
        console.log(`[DEBUG] Translation successful. Name: ${chineseName}`);
        finalContent = messageBody.replace(
          /标的:.*?\n/, 
          `标的: ${chineseName} (${stockCode})\n`
        );
      } else {
        console.log(`[DEBUG] Translation failed. Chinese name not found.`);
      }
    } else {
        console.log(`[DEBUG] No stock code found in message body.`);
    }

    console.log('[DEBUG] Final content to be sent:', finalContent);
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

    return res.status(200).json({ success: true, message: 'Alert forwarded successfully' });

  } catch (error) {
    console.error('Webhook Error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

