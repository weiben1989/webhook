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

// --- API Helper 1: Fetch from Sina ---
async function getStockNameFromSina(stockCode, marketPrefix) {
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${stockCode}`;
  console.log(`[DEBUG] Trying Sina API: ${url}`);
  try {
    const response = await fetch(url, { timeout: 3000 }); // 3 seconds timeout
    if (!response.ok) return null;
    
    const responseBuffer = await response.arrayBuffer();
    const responseText = new TextDecoder('gbk').decode(responseBuffer);
    
    const parts = responseText.split('"');
    if (parts.length > 1 && parts[1] && parts[1].length > 1) {
      return parts[1].split(',')[0];
    }
    return null;
  } catch (error) {
    console.error(`[DEBUG] Sina API Error:`, error.message);
    return null;
  }
}

// --- API Helper 2: Fetch from Tencent ---
async function getStockNameFromTencent(stockCode, marketPrefix) {
  let finalStockCode = stockCode;
  if (marketPrefix === 'hk') {
    // Tencent API requires HK stock codes to be padded to 5 digits
    finalStockCode = stockCode.padStart(5, '0');
  }
  const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalStockCode}`;
  console.log(`[DEBUG] Trying Tencent API: ${url}`);
  try {
    const response = await fetch(url, { timeout: 3000 }); // 3 seconds timeout
    if (!response.ok) return null;

    const responseBuffer = await response.arrayBuffer();
    const responseText = new TextDecoder('gbk').decode(responseBuffer);

    // Tencent format: v_sz002074="51~国轩高科~002074~..." or v_hk00268="51~金蝶国际~..."
    const parts = responseText.split('~');
    if (parts.length > 1 && parts[1]) {
      return parts[1];
    }
    return null;
  } catch (error) {
    console.error(`[DEBUG] Tencent API Error:`, error.message);
    return null;
  }
}

/**
 * Fetches the Chinese name of a stock using multiple APIs as fallbacks.
 * @param {string} stockCode The stock code (e.g., '002074').
 * @returns {Promise<string|null>} The Chinese name or null if not found.
 */
async function getChineseStockName(stockCode) {
  let marketPrefix;

  // Rule for Hong Kong Stocks (numeric, <= 5 digits)
  if (stockCode.length <= 5 && /^\d+$/.test(stockCode)) {
    marketPrefix = 'hk';
  } 
  // Rule for A-Share Stocks & ETFs (numeric, 6 digits)
  else if (stockCode.length === 6 && /^\d+$/.test(stockCode)) {
    if (stockCode.startsWith('6') || stockCode.startsWith('51') || stockCode.startsWith('68')) {
      marketPrefix = 'sh'; // Shanghai Stock, ETF, STAR Market
    } else if (stockCode.startsWith('0') || stockCode.startsWith('3') || stockCode.startsWith('15') || stockCode.startsWith('1')) {
      marketPrefix = 'sz'; // Shenzhen Stock & ETF
    }
  }

  if (!marketPrefix) {
    console.log(`[DEBUG] No known market rule for stock code: ${stockCode}`);
    return null;
  }

  // --- Engine 1: Try Sina first ---
  let chineseName = await getStockNameFromSina(stockCode, marketPrefix);
  if (chineseName) {
    console.log(`[DEBUG] Success from Sina API. Name: ${chineseName}`);
    return chineseName;
  }

  // --- Engine 2: Fallback to Tencent ---
  console.log(`[DEBUG] Sina API failed or returned empty, falling back to Tencent.`);
  chineseName = await getStockNameFromTencent(stockCode, marketPrefix);
  if (chineseName) {
    console.log(`[DEBUG] Success from Tencent API. Name: ${chineseName}`);
    return chineseName;
  }

  console.log(`[DEBUG] All APIs failed for stock code: ${stockCode}`);
  return null;
}

/**
 * NEW: Extracts a stock code from the message body using a list of regex patterns.
 * @param {string} body The message body text.
 * @returns {{stockCode: string, originalText: string}|null} An object with the code and the full text that was matched, or null.
 */
function extractStockCode(body) {
    // --- Rule Engine for Stock Code Extraction ---
    // Add new regex patterns here to support more message formats.
    const patterns = [
        /标的:.*\(([^)]+)\)/,        // Original: 标的: XX (000001)
        /(?:标的|合约|symbol|ticker):\s*([a-zA-Z0-9\.]+)/i, // Key: code, e.g. 标的: 000001 or symbol: AAPL
        /"ticker"\s*:\s*"([^"]+)"/, // JSON-like: "ticker": "000001"
    ];

    for (const pattern of patterns) {
        const match = body.match(pattern);
        if (match && match[1]) {
            console.log(`[DEBUG] Matched with pattern: ${pattern}`);
            return {
                stockCode: match[1],      // The captured stock code
                originalText: match[0],   // The full string that was matched by the regex
            };
        }
    }
    return null;
}


export default async function handler(req, res) {
  console.log(`\n--- New Request Received at ${new Date().toISOString()} ---`);
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // BEST PRACTICE: Use environment variables for secrets like webhook URLs
    const webhookURL = process.env.WECHAT_WEBHOOK_URL || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=cee69a01-8397-486c-a820-f44cd5181313';

    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');
    console.log('[DEBUG] Received Raw Body:', rawBody);

    let messageBody;
    const contentType = req.headers['content-type'] || '';
    
    // Simplified body processing
    if (contentType.includes('application/json')) {
      const jsonData = JSON.parse(rawBody);
      messageBody = Object.entries(jsonData)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n');
    } else {
      // For text/plain or other types, just use the raw body
      messageBody = rawBody;
    }

    let finalContent = messageBody;
    
    // --- Use the new flexible extraction function ---
    const stockInfo = extractStockCode(messageBody);

    if (stockInfo) {
      const { stockCode, originalText } = stockInfo;
      console.log(`[DEBUG] Matched asset code: ${stockCode} from text: "${originalText}"`);

      // Attempt to get the Chinese name
      const chineseName = await getChineseStockName(stockCode);
      
      if (chineseName) {
        console.log(`[DEBUG] Translation successful. Final Name: ${chineseName}`);
        const replacementText = `标的: ${chineseName} (${stockCode})`;
        // Replace only the originally matched text, which is more precise
        finalContent = messageBody.replace(originalText, replacementText);
      } else {
        console.log(`[DEBUG] Translation failed. Chinese name not found from any API.`);
      }
    } else {
        console.log(`[DEBUG] No asset code found in the message body using any pattern.`);
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
