import type { VercelRequest, VercelResponse } from "@vercel/node";
import fetch from "node-fetch";
import { AbortController } from "abort-controller";

// Vercel 平台配置，禁用默认的 body 解析器，以便我们能读取原始请求体
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Webhook 配置 ---
// 从 Vercel 环境变量 WEBHOOK_CONFIG 中读取配置
// 格式: {"your_key": {"url": "WECOM_WEBHOOK_URL", "type": "wecom"}}
interface WebhookConfig {
  url: string;
  type?: "raw" | "wecom"; // 支持 'wecom' (企业微信) 或 'raw' (原始文本)
}
let webhookMap: Record<string, WebhookConfig> = {};
try {
  if (process.env.WEBHOOK_CONFIG) {
    webhookMap = JSON.parse(process.env.WEBHOOK_CONFIG);
  }
} catch (e) {
  console.error("无法解析 WEBHOOK_CONFIG 环境变量:", e);
  webhookMap = {};
}

/* ==================================
 * 基础工具函数
 * ================================== */

/**
 * 获取请求的原始 body
 * @param req Vercel 请求对象
 * @param maxSize 最大体积限制 (默认 1MB)
 * @returns 返回 Buffer 格式的 body
 */
function getRawBody(req: VercelRequest, maxSize = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error("请求体过大 (Payload too large)"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err: Error) => reject(err));
  });
}

/**
 * 带超时功能的 fetch 函数
 * @param url 请求地址
 * @param options fetch 选项，额外包含 timeout 参数
 * @returns 返回 fetch 的响应
 */
async function fetchWithTimeout(url: string, options: any = {}) {
  const { timeout = 2000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

/**
 * 将请求体（可能是JSON）转化为可读的字符串
 * @param raw 原始字符串
 * @returns 格式化后的字符串
 */
function stringifyAlertBody(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
  } catch {
    return raw; // 如果不是合法的 JSON，直接返回原文
  }
}

/* ==================================
 * 股票中文名查询模块
 * ================================== */

// 使用 TextDecoder 处理新浪/腾讯接口返回的 GBK 编码
const gbDecoder = new TextDecoder("gb18030");

/**
 * 查询股票中文名 (新浪接口)
 * @param stockCode 股票代码
 * @param marketPrefix 市场前缀 'sh', 'sz', 'hk'
 * @returns 股票名称或 null
 */
async function getStockNameFromSina(stockCode: string, marketPrefix: "hk" | "sh" | "sz"): Promise<string | null> {
  const finalCode = marketPrefix === "hk" ? String(stockCode).padStart(5, "0") : stockCode;
  const url = `https://hq.sinajs.cn/list=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const name = text.split('"')[1]?.split(",")[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * 查询股票中文名 (腾讯接口)
 * @param stockCode 股票代码
 * @param marketPrefix 市场前缀 'sh', 'sz', 'hk'
 * @returns 股票名称或 null
 */
async function getStockNameFromTencent(stockCode: string, marketPrefix: "hk" | "sh" | "sz"): Promise<string | null> {
  const finalCode = marketPrefix === "hk" ? String(stockCode).padStart(5, "0") : stockCode;
  const url = `https://qt.gtimg.cn/q=${marketPrefix}${finalCode}`;
  try {
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const text = gbDecoder.decode(buf);
    const parts = text.split("~");
    return parts.length > 1 ? parts[1]?.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * 智能判断市场并获取股票中文名 (新浪/腾讯双接口备份)
 * @param code 纯数字股票代码
 * @returns 股票名称或 null
 */
async function getChineseStockName(code: string): Promise<string | null> {
  let prefix: "hk" | "sh" | "sz" | null = null;
  if (/^\d{1,5}$/.test(code)) {
    prefix = "hk"; // 1-5位数字，按港股处理
  } else if (/^\d{6}$/.test(code)) {
    if (/^[568]/.test(code)) prefix = "sh"; // 6位数字，5,6,8开头为沪市
    else if (/^[013]/.test(code)) prefix = "sz"; // 0,1,3开头为深市
  }
  if (!prefix) return null;

  // 优先使用新浪接口，失败后尝试腾讯接口
  let name = await getStockNameFromSina(code, prefix);
  if (!name) name = await getStockNameFromTencent(code, prefix);
  return name || null;
}

/**
 * 并行查询所有需要查找的股票代码并替换回原文
 * @param text 原始消息文本
 * @returns 替换名称后的消息文本
 */
async function resolveStockNames(text: string): Promise<string> {
  // 匹配所有形如 "标的: 12345" 的纯数字代码
  const lookupRegex = /(标的\s*[:：]\s*)(\d{1,6})\b/g;
  const matches = [...text.matchAll(lookupRegex)];
  const codesToLookup = [...new Set(matches.map(match => match[2]))];

  if (codesToLookup.length === 0) {
    return text;
  }

  // 并行查询所有股票的名称
  const namePromises = codesToLookup.map(code => getChineseStockName(code));
  const names = await Promise.all(namePromises);

  // 创建一个 代码 -> 名称 的映射表
  const nameMap = new Map(codesToLookup.map((code, i) => [code, names[i]]));

  // 一次性替换所有匹配项
  return text.replace(lookupRegex, (match, prefix, code) => {
    const name = nameMap.get(code);
    return name ? `${prefix}${name}(${code})` : match; // 如果找到名称，替换为 "名称(代码)"，否则保持原样
  });
}

/* ==================================
 * 信号解析与美化
 * ================================== */

const Direction = {
  Long: "long",
  Short: "short",
  Stop: "stop",
  Neutral: "neutral",
} as const;
type DirectionType = typeof Direction[keyof typeof Direction];

function detectDirection(s: string = ""): DirectionType {
  const t = s.toLowerCase();
  if (/(空信号|做空|空单|卖信号|short|sell|调仓空|追击空)/i.test(t)) return Direction.Short;
  if (/(多信号|做多|多单|买信号|long|buy|调仓多|追击多)/i.test(t)) return Direction.Long;
  if (/止损/i.test(t)) return Direction.Stop;
  return Direction.Neutral;
}

function getIcon(d: DirectionType): string {
  switch (d) {
    case Direction.Long: return "🟢 多";
    case Direction.Short: return "🔴 空";
    case Direction.Stop: return "⚠️ 止损";
    default: return "🟦 中性";
  }
}

/**
 * 格式化最终发送到企业微信的 Markdown 消息
 * @param content 经过名称解析后的内容
 * @returns 格式化后的 Markdown 字符串
 */
function beautifyAlerts(content: string): string {
  const lines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const alerts: string[] = [];

  for (const line of lines) {
    const stockMatch = line.match(/标的\s*[:：]\s*([^\s,，!！]+)/);
    if (!stockMatch) continue; // 忽略没有标的的行

    const stock = stockMatch[1];
    const period = line.match(/周期\s*[:：]\s*([^\s,，!！]+)/)?.[1];
    const price = line.match(/(?:当前)?价格\s*[:：]\s*([^\s,，!！]+)/)?.[1];
    const signal = line.match(/信号\s*[:：]\s*([^\s,，!！]+)/)?.[1] || line; // 兜底为整行内容
    const indicator = line.match(/指标\s*[:：]\s*([^\s,，!！]+)/)?.[1];
    
    const direction = detectDirection(signal);
    const icon = getIcon(direction);

    let parts: string[] = [];
    parts.push(`${icon}｜**${stock}**`);
    if (period) parts.push(`周期: ${period}`);
    if (price) parts.push(`价格: ${price}`);
    // 过滤掉已经提取的字段，显示剩余信息作为信号描述
    const remainingSignal = signal
      .replace(/标的\s*[:：]\s*[^\s,，!！]+/, "")
      .replace(/周期\s*[:：]\s*[^\s,，!！]+/, "")
      .replace(/(?:当前)?价格\s*[:：]\s*[^\s,，!！]+/, "")
      .replace(/指标\s*[:：]\s*[^\s,，!！]+/, "")
      .replace(/[,，]/g, ' ')
      .trim();

    if (remainingSignal && !/(多信号|空信号|买信号|卖信号)/.test(remainingSignal)) {
      parts.push(remainingSignal);
    }
    if (indicator) parts.push(`指标: ${indicator}`);
    
    alerts.push(`- ${parts.join(" · ")}`);
  }

  // 如果没有解析出任何有效信号，则返回原始内容，防止消息丢失
  return alerts.length > 0 ? alerts.join("\n") : content;
}

/* ==================================
 * 主处理函数
 * ================================== */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "只允许 POST 请求 (Method Not Allowed)" });
    }

    const key = req.query.key as string;
    const cfg = key ? webhookMap[key] : undefined;
    if (!cfg?.url) {
      return res.status(404).json({ error: "未找到对应的 key 配置 (Key not found)" });
    }

    // 1. 读取原始请求体
    const rawBody = (await getRawBody(req)).toString("utf8");
    const messageBody = stringifyAlertBody(rawBody);

    // 2. 查询并替换股票中文名
    const resolvedBody = await resolveStockNames(messageBody);

    // 3. 美化消息格式
    const finalText = beautifyAlerts(resolvedBody);
    
    // 如果处理后内容为空，则不发送
    if (!finalText.trim()) {
        return res.status(200).json({ success: true, message: "内容为空，已忽略" });
    }

    // 4. 转发到目标地址
    const isWecom = cfg.type === "wecom";
    const resp = await fetchWithTimeout(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": isWecom ? "application/json" : "text/plain; charset=utf-8",
      },
      body: isWecom
        ? JSON.stringify({ msgtype: "markdown", markdown: { content: finalText } })
        : finalText,
      timeout: 3000, // 转发超时设为3秒
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("转发失败:", errorText);
      return res.status(502).json({ error: `转发失败 (Forward failed): ${errorText}` });
    }

    res.status(200).json({ success: true });

  } catch (err: any) {
    console.error("发生内部错误:", err);
    res.status(500).json({
      error: "服务器内部错误 (Internal Server Error)",
      message: err.message,
      name: err.name,
    });
  }
}
