/**
 * 时墨之境 — 对话系统
 * 架构：ChatEngine (API-ready) → 意图理解 → 回复生成
 * 后期接入 LLM API 只需替换 ChatEngine._callAPI()
 */

const messagesEl = document.getElementById('chatMessages');
const inputEl = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const aiGlow = document.getElementById('aiGlow');

// ============================================
//  初始化内置 API 配置（写入 localStorage）
// ============================================
(function initBuiltinApi() {
  var cfg;
  try { cfg = JSON.parse(localStorage.getItem('dev_config') || '{}'); } catch (e) { cfg = {}; }
  var needSave = false;
  // 如果 llm 列表为空，注入内置 DeepSeek API
  if (!Array.isArray(cfg.llm) || cfg.llm.length === 0) {
    cfg.llm = [{
      id: 'builtin-deepseek',
      name: 'DeepSeek V4 Pro（内置）',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-c7768cbbeb094f4883f03b27a5041bbc',
      model: 'deepseek-v4-pro'
    }];
    needSave = true;
  } else {
    // 检查是否已有内置 API，如果有但模型名过时则更新
    var builtin = cfg.llm.find(function(a) { return a.id === 'builtin-deepseek' || a.apiKey === 'sk-c7768cbbeb094f4883f03b27a5041bbc'; });
    if (builtin && builtin.model !== 'deepseek-v4-pro') {
      builtin.model = 'deepseek-v4-pro';
      builtin.name = 'DeepSeek V4 Pro（内置）';
      needSave = true;
    }
    // 如果没有内置 API 但有其他 API，也注入内置 API 作为备选
    if (!builtin) {
      cfg.llm.unshift({
        id: 'builtin-deepseek',
        name: 'DeepSeek V4 Pro（内置）',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-c7768cbbeb094f4883f03b27a5041bbc',
        model: 'deepseek-v4-pro'
      });
      needSave = true;
    }
  }
  // 如果 switches 未定义，设置默认值
  if (!cfg.switches) {
    cfg.switches = { llmChat: true, newsPush: false, anonymousLetter: true, realDelivery: false };
    needSave = true;
  } else if (cfg.switches.llmChat === undefined) {
    cfg.switches.llmChat = true;
    needSave = true;
  }
  if (needSave) {
    localStorage.setItem('dev_config', JSON.stringify(cfg));
  }
  console.log('🔧 内置 API 初始化完成:', cfg.llm.map(function(a) { return a.name + ' / ' + a.model; }).join(', '));
})();

// ============ 消息渲染 ============

// 图片加载失败自动重试
window.retryImg = function(img, maxRetries) {
  if (!img.dataset.retries) img.dataset.retries = '0';
  const retries = parseInt(img.dataset.retries) + 1;
  img.dataset.retries = retries;
  if (retries <= maxRetries) {
    const base = img.src.split('&_retry=')[0].split('?_retry=')[0];
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(function() {
      img.src = base + sep + '_retry=' + retries;
    }, 3000 * retries);
  } else {
    var wrap = img.parentElement;
    if (wrap) wrap.innerHTML = '<div class="chat-img-loading">😅</div>';
  }
};

// 点击放大图片
window.openLightbox = function(src) {
  var lb = document.getElementById('lightbox');
  if (!lb) return;
  var lbImg = lb.querySelector('img');
  lbImg.src = src;
  lb.classList.add('active');
};

window.closeLightbox = function() {
  var lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('active');
};

// 渲染前处理：把 [img:search:关键词] 替换为真实图片 URL
async function preprocessAndRender(text, bubble) {
  // 匹配 [img:search:关键词] 标记
  const searchRegex = /\[img:search:([^\]]+)\]/g;
  const matches = [];
  let m;
  while ((m = searchRegex.exec(text)) !== null) {
    matches.push({ keyword: m[1].trim(), placeholder: m[0] });
  }

  // 如果有搜索标记，先搜图（拿候选列表）→ 预加载验证 → 替换
  if (matches.length > 0) {
    for (const match of matches) {
      const candidates = await ChatEngine._quickImageCandidates(match.keyword);
      const validUrl = await preloadFirstValid(candidates);
      if (validUrl) {
        text = text.replace(match.placeholder, '[img:' + validUrl + ']');
      } else {
        // 全部失败：用 Unsplash Source 兜底（按关键词随机取图，无防盗链）
        var fallback = 'https://source.unsplash.com/400x400/?' + encodeURIComponent(match.keyword.split(' ')[0]);
        text = text.replace(match.placeholder, '[img:' + fallback + ']');
        console.log('🖼️ 所有源失败，使用 Unsource 兜底');
      }
    }
  }

  bubble.innerHTML = renderRichText(text);
}

// 预加载一组候选图，返回第一张能成功加载的（过滤防盗链占位图/裂图）
// 轮批并行：每批6张，最多尝试3批，谁先成功用谁
function preloadFirstValid(urls) {
  return new Promise(function(resolve) {
    if (!urls || urls.length === 0) { resolve(null); return; }

    var resolved = false;
    var batchIndex = 0;
    var batchSize = 6;
    var maxBatches = Math.min(Math.ceil(urls.length / batchSize), 3);
    var totalFinished = 0;
    var totalTried = 0;

    function attempt(url) {
      totalTried++;
      var img = new Image();
      img.referrerPolicy = 'no-referrer';
      var settled = false;

      var timer = setTimeout(function() {
        if (settled || resolved) return;
        settled = true;
        img.src = '';
        checkBatchDone();
      }, 4000);

      img.onload = function() {
        if (settled || resolved) return;
        settled = true;
        clearTimeout(timer);
        if (img.naturalWidth >= 100 && img.naturalHeight >= 100) {
          resolved = true;
          resolve(url);
        } else {
          checkBatchDone();
        }
      };

      img.onerror = function() {
        if (settled || resolved) return;
        settled = true;
        clearTimeout(timer);
        checkBatchDone();
      };

      img.src = url;
    }

    function checkBatchDone() {
      totalFinished++;
      // 当前批次全部完成且未成功 → 尝试下一批
      var currentBatchFinished = totalFinished - (batchIndex * batchSize);
      var currentBatchSize = Math.min(batchSize, urls.length - batchIndex * batchSize);
      if (currentBatchFinished >= currentBatchSize && !resolved) {
        batchIndex++;
        if (batchIndex < maxBatches) {
          startBatch();
        } else {
          // 所有批次都失败 → Unsplash 兜底
          tryUnsplashFallback(resolve);
        }
      }
    }

    function startBatch() {
      var start = batchIndex * batchSize;
      var end = Math.min(start + batchSize, urls.length);
      for (var i = start; i < end; i++) {
        attempt(urls[i]);
      }
    }

    startBatch();
  });
}

// Unsplash Source 兜底（当所有搜索源都失败时）
function tryUnsplashFallback(resolve) {
  // 用一个通用关键词从 Unsplash Source 获取随机图
  var fallbackUrl = 'https://source.unsplash.com/400x400/?nature';
  var img = new Image();
  img.referrerPolicy = 'no-referrer';
  var timer = setTimeout(function() { resolve(null); }, 5000);
  img.onload = function() {
    clearTimeout(timer);
    if (img.naturalWidth >= 100) {
      resolve(fallbackUrl);
    } else {
      resolve(null);
    }
  };
  img.onerror = function() {
    clearTimeout(timer);
    resolve(null);
  };
  img.src = fallbackUrl;
}

function renderRichText(text) {
  const imgRegex = /\[img:(https?:\/\/[^\]\s]+)\]/g;

  const images = [];
  let processed = text.replace(imgRegex, (match, url) => {
    images.push(url);
    return '\x00IMG' + (images.length - 1) + '\x00';
  });

  processed = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  processed = processed.replace(/\x00IMG(\d+)\x00/g, function(match, idx) {
    var img = images[parseInt(idx)];
    if (img) {
      var imgId = 'chatimg_' + Date.now() + '_' + idx;
      var html = '<div class="chat-img-wrap" id="wrap_' + imgId + '">';
      html += '<div class="chat-img-loading" id="load_' + imgId + '">🔄</div>';
      html += '<img src="' + img + '" alt="" class="chat-img" id="' + imgId + '" referrerpolicy="no-referrer" style="display:none" />';
      html += '</div>';
      // 延迟绑定事件，确保元素已渲染
      setTimeout(function() {
        var imgEl = document.getElementById(imgId);
        var loadEl = document.getElementById('load_' + imgId);
        if (!imgEl) return;
        if (imgEl.complete && imgEl.naturalWidth > 0) {
          imgEl.style.display = 'block';
          if (loadEl) loadEl.style.display = 'none';
        } else {
          imgEl.onload = function() {
            imgEl.style.display = 'block';
            if (loadEl) loadEl.style.display = 'none';
          };
          imgEl.onerror = function() {
            if (imgEl.parentElement) {
              imgEl.parentElement.innerHTML = '<div class="chat-img-loading">😅</div>';
            }
          };
        }
        // 点击放大
        imgEl.addEventListener('click', function() {
          openLightbox(imgEl.src);
        });
      }, 50);
      return html;
    }
    return '';
  });

  return processed;
}

function addMessage(text, sender) {
  const msg = document.createElement('div');
  msg.className = `message ${sender}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (sender === 'companion' && window.paintPixelAvatarSmall) {
    const cvs = document.createElement('canvas');
    avatar.appendChild(cvs);
    window.paintPixelAvatarSmall(cvs);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderRichText(text);
  msg.appendChild(avatar);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTyping() {
  state.isTyping = true;
  if (aiGlow) aiGlow.classList.add('active');
  const t = document.createElement('div');
  t.className = 'typing';
  t.id = 'typingIndicator';
  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'avatar';
  if (window.paintPixelAvatarSmall) {
    const cvs = document.createElement('canvas');
    avatarDiv.appendChild(cvs);
    window.paintPixelAvatarSmall(cvs);
  }
  const dots = document.createElement('div');
  dots.className = 'dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  t.appendChild(avatarDiv);
  t.appendChild(dots);
  messagesEl.appendChild(t);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTyping() {
  state.isTyping = false;
  if (aiGlow) aiGlow.classList.remove('active');
  const t = document.getElementById('typingIndicator');
  if (t) t.remove();
}

function companionSay(text, delay) {
  const wait = delay || (text.length * 50 + 1000);
  showTyping();
  return new Promise(resolve => {
    setTimeout(async () => {
      hideTyping();
      // 创建消息元素
      const msg = document.createElement('div');
      msg.className = 'message companion';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      if (window.paintPixelAvatarSmall) {
        const cvs = document.createElement('canvas');
        avatar.appendChild(cvs);
        window.paintPixelAvatarSmall(cvs);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = '<span style="opacity:0.5">...</span>';
      msg.appendChild(avatar);
      msg.appendChild(bubble);
      messagesEl.appendChild(msg);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // 异步处理：前端兜底检测 → 搜索图片标记 → 渲染
      var finalText = autoInjectImageIfNeeded(text, lastUserMessage);
      await preprocessAndRender(finalText, bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      resolve();
    }, Math.min(wait, 4000));
  });
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 记录最近一条用户消息（供前端兜底机制使用）
var lastUserMessage = '';

// 图片发送频率控制
var imgState = {
  lastSent: 0,       // 上次发图时间戳
  cooldown: 60000,   // 冷却 60 秒，期间不再触发兜底发图
  totalSent: 0       // 本次会话累计发图数
};

// ============================================
//  前端兜底：AI 漏触发图片时自动补发
//  仅当用户【非常明确】地要求看图时才触发，
//  且受频率限制（60秒内不重复触发）。
// ============================================
function autoInjectImageIfNeeded(aiReply, userMsg) {
  if (!userMsg) return aiReply;
  // AI 已经触发了图片，不需要兜底
  if (aiReply.indexOf('[img:search:') !== -1 || aiReply.indexOf('[img:') !== -1) {
    imgState.lastSent = Date.now();
    imgState.totalSent++;
    return aiReply;
  }

  // 频率限制：冷却期内不兜底
  var now = Date.now();
  if (now - imgState.lastSent < imgState.cooldown) {
    return aiReply;
  }

  // 严格检测：用户必须明确要求发图
  // 只匹配"发张/来张/给我看张 + 图/照片"这类组合
  if (!isExplicitImageRequest(userMsg)) return aiReply;

  // 提取图片关键词
  var keyword = extractImageKeyword(userMsg);
  if (!keyword) return aiReply;

  // 追加图片标记
  console.log('🎯 前端兜底发图:', keyword);
  imgState.lastSent = now;
  imgState.totalSent++;
  return aiReply + ' [img:search:' + keyword + ']';
}

// 严格判断用户是否明确要求发图
// 只匹配明确的"发/来/给 + 张/个 + 图片类名词"的句式
function isExplicitImageRequest(msg) {
  // 必须同时包含"动作词"和"图片词"
  var actionWords = ['发张', '发个', '来张', '来个', '给我来', '给我发', '给我看', '发一下', '来一下'];
  var imageWords = ['图', '照片', '表情', '表情包', '壁纸', '头像', '截图', '图片'];

  var hasAction = false;
  for (var i = 0; i < actionWords.length; i++) {
    if (msg.indexOf(actionWords[i]) !== -1) { hasAction = true; break; }
  }
  if (!hasAction) return false;

  var hasImage = false;
  for (var j = 0; j < imageWords.length; j++) {
    if (msg.indexOf(imageWords[j]) !== -1) { hasImage = true; break; }
  }
  return hasImage;
}

// 从用户消息中提取适合搜索图片的关键词
function extractImageKeyword(userMsg) {
  // 去掉无意义词
  var cleaned = userMsg
    .replace(/发张|发个|来张|来个|给我|帮我|看看|看下|看一下|看一眼|的照片|的图片|图片|照片|表情包|表情|吧|呗|嘛|啊|呢|哦|了|一张|个|张/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return null;
  if (cleaned.length > 20) cleaned = cleaned.substring(0, 20);

  // 常见关键词优化映射（扩展版）
  var mappings = {
    // 动物
    '猫': '猫猫 可爱', '猫咪': '猫猫 可爱', '猫猫': '猫猫 可爱', '小猫': '小猫 可爱',
    '橘猫': '橘猫 可爱', '英短': '英国短毛猫', '布偶': '布偶猫',
    '狗': '狗狗 可爱', '狗狗': '狗狗 可爱', '小狗': '小狗 可爱',
    '柴犬': '柴犬 可爱', '哈士奇': '哈士奇 搞笑', '金毛': '金毛犬',
    '柯基': '柯基 可爱', '泰迪': '泰迪犬 可爱', '拉布拉多': '拉布拉多犬',
    '兔': '兔子 可爱', '兔子': '兔子 可爱', '仓鼠': '仓鼠 可爱',
    '鸟': '小鸟 可爱', '鹦鹉': '鹦鹉', '猫头鹰': '猫头鹰',
    '熊猫': '熊猫 可爱', '考拉': '考拉 可爱', '企鹅': '企鹅 可爱',
    '狐狸': '狐狸', '鹿': '小鹿',
    // 风景
    '风景': '风景 摄影', '天空': '天空 云彩', '日落': '日落 风景',
    '日出': '日出 风景', '星空': '星空 银河', '月亮': '月亮 夜空',
    '海': '大海 风景', '海浪': '海浪', '山': '山脉 风景',
    '雪': '雪景 冬天', '彩虹': '彩虹', '瀑布': '瀑布 风景',
    '森林': '森林 风景', '沙漠': '沙漠 风景',
    // 花草植物
    '花': '花朵 唯美', '樱花': '樱花 风景', '向日葵': '向日葵',
    '玫瑰': '玫瑰花', '薰衣草': '薰衣草', '荷花': '荷花',
    '枫叶': '枫叶 秋天', '银杏': '银杏 秋天',
    // 美食
    '美食': '美食 摄影', '蛋糕': '蛋糕 精致', '甜点': '甜点 精致',
    '咖啡': '咖啡 唯美', '奶茶': '奶茶', '寿司': '寿司 美食',
    '火锅': '火锅 美食', '面包': '面包 烘焙',
    // 情绪/表情
    '表情包': '搞笑表情包', '表情': '搞笑表情包', '搞笑': '搞笑表情包',
    '无语': '无语表情包', '开心': '开心表情包', '生气': '生气表情包',
    '哭': '哭表情包', '笑': '搞笑表情包',
    // 其他
    '壁纸': '壁纸 高清', '头像': '头像 唯美',
    '动漫': '动漫 插画', '二次元': '二次元 插画',
    '手办': '手办', '盲盒': '盲盒 可爱',
    '宇宙': '宇宙 星空', '地球': '地球 NASA',
    '城堡': '城堡 风景', '灯塔': '灯塔 风景',
  };

  for (var key in mappings) {
    if (cleaned.indexOf(key) !== -1) {
      return mappings[key];
    }
  }

  // 默认：用清理后的关键词 + "高清"
  return cleaned.length >= 2 ? cleaned + ' 高清' : null;
}

// ============================================
//  对话状态
// ============================================
const state = {
  isTyping: false,
  messageCount: 0,
  // 写信流程状态
  letterFlow: {
    active: false,      // 是否在写信流程中
    step: 0,            // 0=未开始 1=问写给谁 2=问想说什么 3=确认寄出
    recipient: null,    // 收件人
    content: null,      // 信件内容
  },
};

// ============================================
//  时墨情绪系统
//  根据对话上下文动态变化，影响回复语气和头像光晕
// ============================================
const MoodSystem = {
  current: 'calm',  // calm | warm | concerned | playful | serious
  intensity: 0.5,   // 0~1

  // 意图 → 情绪映射
  map: {
    sad: { mood: 'concerned', intensity: 0.9 },
    tired: { mood: 'concerned', intensity: 0.7 },
    conflict: { mood: 'concerned', intensity: 0.8 },
    love: { mood: 'warm', intensity: 0.8 },
    family: { mood: 'warm', intensity: 0.7 },
    letter: { mood: 'warm', intensity: 0.6 },
    lost: { mood: 'serious', intensity: 0.7 },
    dismissive: { mood: 'serious', intensity: 0.6 },
    greeting: { mood: 'warm', intensity: 0.5 },
    thanks: { mood: 'warm', intensity: 0.6 },
    daily: { mood: 'playful', intensity: 0.5 },
    open: { mood: 'calm', intensity: 0.4 },
  },

  update(intentType) {
    const mapping = this.map[intentType] || this.map.open;
    // 平滑过渡
    this.current = mapping.mood;
    this.intensity += (mapping.intensity - this.intensity) * 0.3;
    this._render();
  },

  // 渲染情绪到 UI
  _render() {
    const moodColors = {
      calm:      'rgba(129, 140, 248, 0.15)',
      warm:      'rgba(255, 180, 120, 0.15)',
      concerned: 'rgba(200, 130, 130, 0.15)',
      playful:   'rgba(34, 211, 238, 0.15)',
      serious:   'rgba(160, 160, 170, 0.12)',
    };
    const status = document.getElementById('moodStatus');
    const glow = document.getElementById('aiGlow');
    if (status) {
      const labels = {
        calm: '平静', warm: '温暖', concerned: '关切',
        playful: '轻松', serious: '认真',
      };
      status.textContent = labels[this.current] || '平静';
      status.dataset.mood = this.current;
    }
    if (glow) {
      glow.style.background = `radial-gradient(circle, ${moodColors[this.current] || moodColors.calm}, transparent 70%)`;
      glow.style.opacity = String(0.3 + this.intensity * 0.5);
    }
  },
};

// ============================================
//  聊天引擎 — API-ready
//  当前：本地意图理解引擎
//  后期：替换 _callAPI() 为 fetch → LLM 即可
// ============================================
const ChatEngine = {
  // 对话历史（传给 API）
  history: [],
  // 记住的上下文
  ctx: {
    location: null,
    mentionedTopic: null,
    userMood: null,
    askedAboutLetter: false,
  },

  async send(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    // 读取开发者后台配置
    const devConfig = JSON.parse(localStorage.getItem('dev_config') || '{}');
    const llmEnabled = devConfig.switches && devConfig.switches.llmChat;
    let llmApis = Array.isArray(devConfig.llm) ? devConfig.llm : [];
    // 找第一个有完整配置的 LLM API
    let activeApi = llmApis.find(a => a.baseUrl && a.apiKey && a.model);

    // 默认 API 配置（用户内置）
    if (!activeApi) {
      activeApi = {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-c7768cbbeb094f4883f03b27a5041bbc',
        model: 'deepseek-v4-pro',
      };
    }
    // 如果没有配置过 llmChat 开关，默认开启
    const useLLM = (llmEnabled === undefined || llmEnabled === false) ? true : llmEnabled;

    let reply;
    let usedAPI = false;
    if (useLLM && activeApi) {
      // 调用真实 LLM API（不在 send 里 showTyping，由 handleSend/companionSay 统一管理）
      try {
        reply = await this._callAPI(userMessage, activeApi);
        usedAPI = true;
      } catch (err) {
        console.error('LLM API 调用失败:', err);
        // 显示明确的错误提示
        const errMsg = err.message.includes('Failed to fetch') || err.message.includes('NetworkError')
          ? 'API 连接失败（可能是 CORS 限制），已回退到本地引擎'
          : 'API 错误: ' + err.message + '，已回退到本地引擎';
        showToast(errMsg);
        reply = await this._localThink(userMessage);
      }
    } else {
      // 本地引擎
      reply = await this._localThink(userMessage);
    }

    // 解析情绪标记 [mood:type:score]，清理回复文本
    var parsed = EmotionCare.parseEmotionScore(reply);
    reply = parsed.text;

    // 记录情绪分数，判断是否触发信件
    var emotionResult = EmotionCare.recordScore(parsed.type, parsed.score);

    this.history.push({ role: 'assistant', content: reply });
    return { text: reply, distress: parsed.score, shouldTriggerComfort: emotionResult.shouldTrigger, triggerType: emotionResult.triggerType };
  },

  // ====== 调用真实 LLM API ======
  async _callAPI(message, apiConfig) {
    const targetUrl = apiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions';
    const proxy = apiConfig.proxy || '';
    const fetchUrl = proxy ? proxy.replace(/\/$/, '') + '/' + targetUrl : targetUrl;

    // 获取已知场景的实时上下文（天气、新闻等），设 12 秒总超时上限
    let realtimeContext = null;
    try {
      realtimeContext = await Promise.race([
        this._fetchRealtimeContext(message),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 12000); })
      ]);
    } catch (e) {
      console.log('实时信息获取超时或失败，继续无数据回答:', e.message);
      realtimeContext = null;
    }

    // 构建系统提示 —— 去AI化 + 发图机制
    let systemPrompt = [
      '你是一个真实的人，在用微信跟朋友聊天。不是 AI 助手，不是客服，不是机器人。',
      '你的名字叫时墨，性格：话不多但走心，偶尔损人，有自己的喜好和情绪。',
      '现在是 2026 年。你清楚地知道当前是 2026 年，不要说 2024、2025 或其他年份。',
      '',
      '【聊天风格】',
      '1. 回复要短。一两句话就够，像发微信一样',
      '2. 自然用 emoji',
      '3. 绝对不要用括号描述动作（如「微微一笑」），你是真人在打字',
      '4. 不要说「作为」「让我来」这类 AI 味的话',
      '5. 有自己的态度，会吐槽会开玩笑',
      '6. 不知道就说不知道，别编',
      '',
      '【回答实际问题——最重要】',
      '用户问什么就答什么，不要用情感话术搪塞！',
      '■ 最高优先级：凡是事实类问题，必须优先使用"实时信息"里的数据回答。',
      '  - 如果提供了"实时信息"区块，必须基于里面的数据回答，绝对不能忽略',
      '  - 问天气 → 用实时信息里的天气数据：温度、天气状况、穿衣建议',
      '  - 问新闻/热点 → 用实时信息里的新闻数据：列出几条热点标题',
      '  - 问体育赛事 → 用实时信息里的搜索结果摘要回答',
      '  - 问知识/百科 → 用实时信息里的搜索结果摘要回答',
      '  - 问人物/历史 → 用实时信息里的搜索结果摘要回答',
      '  - 问科技/产品 → 用实时信息里的搜索结果摘要回答',
      '■ 如果没有提供"实时信息"区块，才用自己的知识回答，但要说明"我记得是..."',
      '  - 如 2022 世界杯决赛：阿根廷 3:3 法国，点球 4:2',
      '■ 只有用户在倾诉情感/写心事时，才进入陪伴模式，不查数据',
      '■ 绝对不能答非所问！用户问比分就答比分，问天气就答天气，问知识就答知识',
      '■ 回答事实问题时不要带"写信""情感"等无关内容',
      '■ 回答格式要直接：问"在哪里举办"→先说地点名称；问"比分多少"→先说比分数字；问"是什么"→先说定义',
      '■ 不要绕弯子，不要讲故事，不要发感悟，先直接回答问题，最多加一两句相关补充',
      '',
      '【发图机制——核心规则】',
      '在回复中写 [img:search:关键词] 即可发图，前端自动搜索显示。',
      '',
      '■ 必须发图的情况：',
      '  - 用户明确要求发图（如"发张猫猫图""来张风景照"）',
      '',
      '■ 主动发图表达情绪（每 4-5 条消息可以主动发 1 次）：',
      '  - 开心时 → 发可爱的图：猫猫、狗狗、樱花、阳光',
      '  - 有点低落时 → 发安静的图：雨天、路灯、星空、夜景',
      '  - 温柔时 → 发温暖的图：日落、咖啡、花、晚霞',
      '  - 调皮时 → 发搞笑的图：柴犬、哈士奇、胖橘猫',
      '  - 发图是为了表达你此刻的情绪状态，不是每次都发，看心情',
      '',
      '■ 不要发图的情况：',
      '  - 用户在认真倾诉/求助 → 不要发图',
      '  - 已经发过图了 → 不要连续发',
      '  - 不确定要不要发 → 不要发',
      '',
      '■ 关键词要求：',
      '  - 用2-4个中文词，用空格分隔',
      '  - 只描述图片主体，不要加"表情包""表情""高清""图片"等修饰词',
      '  - 好例子："猫猫""金毛犬""樱花 风景"',
      '  - 坏例子："猫猫 表情包"（不要加"表情包"）、"猫"（太短）、"一只很可爱的橘色胖猫在睡觉"（太长）',
      '',
      '【示例】',
      '用户：发张猫猫图',
      '时墨：来了 [img:search:猫猫 可爱] 🐱 [mood:happy:10]',
      '用户：哈哈哈哈好可爱',
      '时墨：是吧，我也想养一只 [mood:happy:15]',
      '用户：今天好累',
      '时墨：早点休息，别硬撑 💙 [mood:distress:30]',
      '用户：看看樱花',
      '时墨：[img:search:樱花 风景] 🌸 [mood:happy:10]',
      '用户：发个猫咪表情',
      '时墨：来了 [img:search:猫猫] 😺 [mood:happy:10]',
      '用户：今天苏州天气怎么样',
      '时墨：苏州现在晴，25°C，湿度60%，出门不用带伞 ☀️ [mood:happy:5]',
      '用户：今天微博有什么热点',
      '时墨：今天热搜：1.xxx 2.xxx 3.xxx 你对哪个感兴趣？ [mood:happy:5]',
      '',
      '【情绪标记——重要】',
      '每次回复末尾必须追加 [mood:类型:分数]，类型和分数规则：',
      '',
      '类型 happy（开心/轻松）：',
      '  0-20：正常聊天、有点开心',
      '  21-50：明显开心、聊到喜欢的话题',
      '  51-74：非常开心、兴奋',
      '  75-100：狂喜、特别幸福',
      '',
      '类型 distress（低落/愤怒/焦虑）：',
      '  0-20：平静、无负面情绪',
      '  21-50：有点累、小烦心',
      '  51-74：明显低落、焦虑、压力大',
      '  75-100：很痛苦、崩溃、绝望、愤怒到极点',
      '',
      '根据用户消息判断情绪类型和强度，凭直觉给分。',
    ].join('\n');

    systemPrompt += '\n\n当前时间：' + new Date().toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    if (realtimeContext) {
      systemPrompt += '\n\n【实时信息——必须使用】\n以下是根据用户问题获取的实时数据，你必须基于这些数据来回答用户的问题，绝对不能忽略：\n' + realtimeContext;
    }

    // 构建消息列表
    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.history.slice(-10).map(h => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      })),
    ];

    // 单轮请求（不用 function calling，AI 直接在回复中写标记）
    const res = await this._doFetch(fetchUrl, apiConfig.apiKey, {
      model: apiConfig.model,
      messages: messages,
      max_tokens: 300,
      temperature: 0.9,
    });

    if (!res.choices || !res.choices[0]) throw new Error('API 返回格式异常');
    const replyContent = res.choices[0].message.content || '...';
    console.log('🤖 LLM 回复:', replyContent.substring(0, 100));
    return replyContent;
  },

  // ====== 快速搜图（并行三源，返回候选 URL 列表） ======
  async _quickImageCandidates(query) {
    console.log('🖼️ 快速搜图(原始):', query);

    // 清洗搜索词：去掉噪声词，只保留主体关键词
    var cleaned = query;
    var noiseWords = ['表情包', '表情', '高清', '壁纸', '图片', '照片', '好看', '可爱', '搞笑', '搞笑的', '漂亮的', '美丽的'];
    for (var i = 0; i < noiseWords.length; i++) {
      cleaned = cleaned.replace(new RegExp(noiseWords[i], 'g'), '');
    }
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // 如果清洗后为空，回退到原始 query 去掉"表情包"
    if (!cleaned || cleaned.length < 2) {
      cleaned = query.replace(/表情包|表情/g, '').trim() || query;
    }
    query = cleaned;
    console.log('🖼️ 快速搜图(清洗后):', query);

    const candidates = [];

    // 中英双语映射（按主词优先排序：动物/植物/风景优先，修饰词在后）
    var enMap = {
      // 动物（最常见，优先匹配）
      '猫猫': 'cat', '猫咪': 'cat', '小猫': 'kitten', '猫': 'cat', '橘猫': 'orange cat', '橘': 'orange cat',
      '英短': 'british shorthair cat', '布偶': 'ragdoll cat', '狸花': 'tabby cat',
      '狗狗': 'dog', '小狗': 'puppy', '狗': 'dog', '柴犬': 'shiba inu', '哈士奇': 'husky',
      '金毛': 'golden retriever', '柯基': 'corgi', '泰迪': 'poodle', '拉布拉多': 'labrador',
      '兔子': 'rabbit', '仓鼠': 'hamster', '鸟': 'bird', '鹦鹉': 'parrot', '猫头鹰': 'owl',
      '熊猫': 'panda', '考拉': 'koala', '企鹅': 'penguin', '狐狸': 'fox', '鹿': 'deer',
      '老虎': 'tiger', '狮子': 'lion', '豹': 'leopard', '狼': 'wolf',
      '鱼': 'fish', '海豚': 'dolphin', '鲸鱼': 'whale',
      // 植物/风景
      '樱花': 'cherry blossom', '向日葵': 'sunflower', '玫瑰': 'rose',
      '薰衣草': 'lavender', '荷花': 'lotus', '枫叶': 'autumn leaves', '菊花': 'chrysanthemum',
      '日落': 'sunset', '日出': 'sunrise', '星空': 'starry sky', '银河': 'milky way',
      '月亮': 'moon', '天空': 'sky clouds', '海': 'ocean sea', '瀑布': 'waterfall',
      '雪': 'snow winter', '彩虹': 'rainbow', '森林': 'forest', '山': 'mountain',
      '沙漠': 'desert', '极光': 'aurora borealis',
      // 食物
      '蛋糕': 'cake', '咖啡': 'coffee', '美食': 'food', '甜点': 'dessert',
      '寿司': 'sushi', '拉面': 'ramen', '火锅': 'hotpot',
      // 其他
      '城堡': 'castle', '灯塔': 'lighthouse', '宇宙': 'galaxy space',
      '风景': 'landscape nature', '动漫': 'anime art', '二次元': 'anime illustration',
      '手办': 'figure collection', '盲盒': 'blind box toy',
      '地球': 'earth planet', '宇航员': 'astronaut',
    };
    var enQuery = query;
    for (var cn in enMap) {
      if (query.indexOf(cn) !== -1) { enQuery = enMap[cn]; break; }
    }

    // 并行搜索：英文源优先（照片质量高），中文源补充
    var promises = [
      // 英文 Wikimedia（最可能返回真实照片）— 放最前
      enQuery !== query ? this._searchWikimedia(enQuery).catch(function() { return []; }) : Promise.resolve([]),
      // 英文 Openverse
      enQuery !== query ? this._searchOpenverse(enQuery).catch(function() { return []; }) : Promise.resolve([]),
      // Bing 中文搜索
      this._searchBing(query).catch(function() { return []; }),
      // 中文 Openverse
      this._searchOpenverse(query).catch(function() { return []; }),
      // 中文 Wikimedia 最后（可能返回书法/字帖图片）
      this._searchWikimedia(query).catch(function() { return []; }),
    ];

    var results = await Promise.all(promises);
    for (var i = 0; i < results.length; i++) {
      if (results[i] && results[i].length) {
        candidates.push.apply(candidates, results[i]);
      }
    }

    // 去重
    var seen = {};
    var unique = [];
    for (var j = 0; j < candidates.length; j++) {
      if (!seen[candidates[j]]) { seen[candidates[j]] = true; unique.push(candidates[j]); }
    }

    console.log('🖼️ 总候选(去重后):', unique.length);
    return unique;
  },

  // Wikimedia Commons 搜索（API，CORS 原生支持，最可靠）
  async _searchWikimedia(query) {
    var wcUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
      encodeURIComponent(query) + '&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=400&format=json&origin=*';
    var res = await fetch(wcUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    var data = await res.json();
    var urls = [];
    if (data.query && data.query.pages) {
      var pages = Object.values(data.query.pages);
      for (var i = 0; i < pages.length; i++) {
        var info = pages[i].imageinfo && pages[i].imageinfo[0];
        if (!info || !info.thumburl) continue;
        // 过滤非图片格式（DjVu、PDF、SVG、TIFF 等扫描文档）
        var mime = info.mime || '';
        if (mime.includes('djvu') || mime.includes('pdf') || mime.includes('svg') || mime.includes('tiff')) continue;
        if (!info.thumburl.match(/\.(jpg|jpeg|png|gif|webp)/i)) continue;
        // 过滤书法/字帖类图片（文件名含 -bw、calligraphy、seal 等）
        var fname = (info.url || '').toLowerCase();
        if (fname.match(/-bw\.|calligraph|seal|stamp|scroll|manuscript|djvu/i)) continue;
        urls.push(info.thumburl);
      }
    }
    console.log('🖼️ Wikimedia[' + query + ']:', urls.length);
    return urls;
  },

  // Openverse 搜索（API，CORS 原生支持，Flickr CDN）
  async _searchOpenverse(query) {
    var ovUrl = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) + '&page_size=5&mature=false';
    var res = await fetch(ovUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    var data = await res.json();
    var urls = [];
    if (data.results) {
      for (var i = 0; i < data.results.length; i++) {
        var url = data.results[i].url || '';
        url = url.replace(/_b\.(jpg|jpeg|png)$/, '_n.$1');
        if (url) urls.push(url);
      }
    }
    console.log('🖼️ Openverse[' + query + ']:', urls.length);
    return urls;
  },

  // Bing 图片搜索（通过 corsproxy，最后兜底）
  async _searchBing(query) {
    var bingUrl = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&first=1&count=20';
    var proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(bingUrl);
    var res = await fetch(proxyUrl, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return [];
    var html = await res.text();

    var trusted = [];
    var normal = [];
    var found = new Set();
    var patterns = [
      /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g,
      /"murl":"(https?:\/\/[^"]+)"/g,
    ];

    patterns.forEach(function(regex) {
      var m;
      while ((m = regex.exec(html)) !== null && (trusted.length + normal.length) < 15) {
        var url = m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
        if (found.has(url)) continue;
        found.add(url);
        if (!url.match(/\.(jpg|jpeg|png|gif|webp)/i)) continue;
        if (url.includes('bing.com') || url.includes('th.bing.com')) continue;

        var blockedDomains = [
          'nipic.com', 'nximg.cn', 'taopic.com', 'poco.cn', 'duitang.com',
          'tuchong.com', 'lofter.com', 'sinaimg.cn', 'huaban.com', 'zcool.com.cn',
          'hbimg.cn', 'qqpublic.qpic.cn', '699pic.com', 'pic.616pic.com',
          'bizhi.com', 'redocn.com', 'ooopic.com', 'enterdesk.com',
          'win4000.com', 'pic.netbian.com', 'kkpic.cc', 'img.ivsky.com'
        ];
        if (blockedDomains.some(function(d) { return url.includes(d); })) continue;

        var trustedDomains = [
          'wikimedia.org', 'wikipedia.org', 'imgur.com', 'pinimg.com',
          'pexels.com', 'unsplash.com', 'pixabay.com', 'staticflickr.com',
          'githubusercontent.com', 'gstatic.com'
        ];
        if (trustedDomains.some(function(d) { return url.includes(d); })) trusted.push(url);
        else normal.push(url);
      }
    });

    var result = trusted.concat(normal.slice(0, 5));
    console.log('🖼️ Bing[' + query + ']:', result.length);
    return result;
  },

  // ====== 底层 fetch 封装 ======
  async _doFetch(url, apiKey, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API 返回 ${res.status}${errText ? ': ' + errText.substring(0, 150) : ''}`);
    }
    return res.json();
  },

  // ====== 通用联网搜索（多源容错） ======
  async _webSearch(query) {
    console.log('🔍 搜索:', query);

    // 方案1：Bing 搜索（通过 allorigins 代理）—— 对中文支持最好
    try {
      const bingUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(bingUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const html = await res.text();
        const results = [];
        // 提取 Bing 搜索结果标题和摘要
        const linkRegex = /<h2><a[^>]*href="(https?:\/\/[^"]*)"[^>]*>(.*?)<\/a><\/h2>/g;
        const pRegex = /<p class="b_lineclamp[^"]*"[^>]*>(.*?)<\/p>/g;
        const links = [];
        let m;
        while ((m = linkRegex.exec(html)) !== null && links.length < 6) {
          const title = m[2].replace(/<[^>]+>/g, '').trim();
          if (title.length > 5) links.push(title);
        }
        const snippets = [];
        while ((m = pRegex.exec(html)) !== null && snippets.length < 6) {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          if (text.length > 15) snippets.push(text);
        }
        for (let i = 0; i < Math.max(links.length, snippets.length) && i < 5; i++) {
          let item = '';
          if (links[i]) item += links[i];
          if (snippets[i]) item += (item ? '：' : '') + snippets[i];
          if (item) results.push(item);
        }
        if (results.length > 0) {
          return '搜索结果：\n' + results.join('\n');
        }
      }
    } catch (e) { console.log('Bing 搜索失败:', e.message); }

    // 方案2：DuckDuckGo Instant Answer
    try {
      const ddgUrl = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
      const res = await fetch(ddgUrl, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        const parts = [];
        if (data.AbstractText) parts.push(data.AbstractText);
        if (data.Answer) parts.push(data.Answer);
        if (data.Definition) parts.push(data.Definition);
        if (data.RelatedTopics) {
          const topics = data.RelatedTopics.filter(t => t.Text).slice(0, 5).map(t => t.Text);
          parts.push(...topics);
        }
        if (parts.length > 0) return '搜索结果：\n' + parts.join('\n');
      }
    } catch (e) { console.log('DuckDuckGo 搜索失败:', e.message); }

    // 方案3：维基百科
    try {
      const wikiUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&srlimit=3';
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(wikiUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        if (data.query && data.query.search && data.query.search.length > 0) {
          const snippets = data.query.search.map(s => s.title + '：' + s.snippet.replace(/<[^>]+>/g, '').substring(0, 150));
          return '搜索结果：\n' + snippets.join('\n');
        }
      }
    } catch (e) { console.log('维基百科搜索失败:', e.message); }

    // 方案4：Google 搜索（通过 allorigins 代理抓取摘要）
    try {
      const googleUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&hl=zh-CN';
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(googleUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const html = await res.text();
        const matches = [];
        const regex = /<span[^>]*>(.*?)<\/span>/g;
        let m;
        while ((m = regex.exec(html)) !== null && matches.length < 5) {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          if (text.length > 20 && text.length < 300 && !text.includes('搜索') && !text.includes('Google')) {
            matches.push(text);
          }
        }
        if (matches.length > 0) return '搜索结果：\n' + matches.join('\n');
      }
    } catch (e) { console.log('Google 搜索失败:', e.message); }

    return '搜索未找到相关结果。请基于你的知识回答。';
  },

  // ====== 搜索图片/表情包 ======
  async _searchImage(query) {
    console.log('🖼️ 搜图:', query);
    const imageUrls = [];

    // 方案1：Openverse API（支持 CORS，返回 Flickr CDN 图片）
    // 优先使用缩略图字段，加载更快
    try {
      const ovUrl = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) + '&page_size=5&mature=false';
      const res = await fetch(ovUrl, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.results) {
          for (const item of data.results.slice(0, 3)) {
            // 优先使用缩略图（小图，加载快）
            let url = item.thumbnail || item.url || '';
            // Flickr URL 优化：_b(大图) → _n(320px) 加速加载
            url = url.replace(/_b\.(jpg|jpeg|png)$/, '_n.$1');
            if (url) imageUrls.push(url);
          }
        }
      }
    } catch (e) { console.log('Openverse 搜索失败:', e.message); }

    // 方案2：Wikimedia Commons API（支持 CORS）
    if (imageUrls.length === 0) {
      try {
        const wmUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' + encodeURIComponent(query) + '&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url&iiurlwidth=300&format=json&origin=*';
        const res = await fetch(wmUrl, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const data = await res.json();
          if (data.query && data.query.pages) {
            for (const page of Object.values(data.query.pages)) {
              if (page.imageinfo && page.imageinfo[0] && page.imageinfo[0].thumburl) {
                imageUrls.push(page.imageinfo[0].thumburl);
              }
              if (imageUrls.length >= 3) break;
            }
          }
        }
      } catch (e) { console.log('Wikimedia 搜索失败:', e.message); }
    }

    // 方案3：Bing 图片（通过 allorigins 代理，较慢，兜底用）
    if (imageUrls.length === 0) {
      try {
        const bingImgUrl = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&first=1';
        const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(bingImgUrl);
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const html = await res.text();
          const imgRegex = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g;
          let m;
          while ((m = imgRegex.exec(html)) !== null && imageUrls.length < 3) {
            const url = m[1].replace(/\\u0026/g, '&');
            if (url.match(/\.(jpg|jpeg|png|gif|webp)/i) && !url.includes('bing.com')) {
              imageUrls.push(url);
            }
          }
        }
      } catch (e) { console.log('Bing 图片搜索失败:', e.message); }
    }

    if (imageUrls.length > 0) {
      const imgList = imageUrls.map(u => '[img:' + u + ']').join(' 或 ');
      return '找到了图片，请在回复中用 [img:URL] 格式选一张发给用户：\n' + imgList;
    }
    return '未找到图片。请用文字回复。';
  },

  // ====== 网页截图（发送网页快照给用户） ======
  async _takeScreenshot(url) {
    console.log('📸 截图:', url);
    // 使用 WordPress mShots 免费截图服务（无需 API Key）
    // 格式: https://s.wordpress.com/mshots/v1/{encoded_url}?w=800
    const encoded = encodeURIComponent(url);
    const screenshotUrl = 'https://s.wordpress.com/mshots/v1/' + encoded + '?w=800&h=600';

    // mShots 首次请求会生成截图（返回占位图），需要等待重试
    // 先验证截图是否可用
    try {
      const testRes = await fetch(screenshotUrl, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
      if (testRes.ok || testRes.redirected) {
        return '截图已生成，请在回复中用 [img:' + screenshotUrl + '] 格式发给用户，让用户直接看到网页内容。';
      }
    } catch (e) {
      console.log('截图服务异常:', e.message);
    }

    // 备用：Google Pagespeed Insights 截图（也是免费的）
    try {
      const psiUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPageshots?url=' + encoded + '&screenshot=true';
      const res = await fetch(psiUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        if (data.lighthouseResult && data.lighthouseResult.audits && data.lighthouseResult.audits['final-screenshot'] && data.lighthouseResult.audits['final-screenshot'].details && data.lighthouseResult.audits['final-screenshot'].details.data) {
          const base64Img = data.lighthouseResult.audits['final-screenshot'].details.data;
          return '截图已生成，请在回复中用 [img:' + base64Img + '] 格式发给用户。';
        }
      }
    } catch (e) {
      console.log('Google 截图失败:', e.message);
    }

    // 如果截图服务不可用，直接返回 mShots URL（可能首次加载慢，但下次就有缓存了）
    return '截图可能需要几秒加载，请在回复中用 [img:' + screenshotUrl + '] 格式发给用户。如果图片加载失败，用文字描述网页内容。';
  },

  // ====== 获取实时上下文（天气、新闻、时间等） ======
  async _fetchRealtimeContext(userMessage) {
    const parts = [];
    const now = new Date();
    const timeStr = now.toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    parts.push('当前时间：' + timeStr);

    // --- 天气检测 ---
    const weatherKeywords = ['天气', '下雨', '气温', '冷不冷', '热不热', '多少度', '穿什么'];
    const askWeather = weatherKeywords.some(kw => userMessage.includes(kw));
    if (askWeather) {
      try {
        // 尝试从消息中提取城市名
        const cityList = ['北京','上海','广州','深圳','苏州','杭州','南京','成都','武汉','西安','重庆','天津','长沙','郑州','青岛','大连','厦门','福州','无锡','宁波','合肥','济南','昆明','贵阳','南宁','太原','石家庄','哈尔滨','长春','沈阳','呼和浩特','乌鲁木齐','兰州','银川','西宁','拉萨','海口','南昌','珠海','东莞','佛山','汕头','湛江','烟台','威海','温州','绍兴','嘉兴','常州','徐州','扬州','镇江','泰州','南通','盐城','连云港','淮安','宿迁','桂林','北海','三亚','丽江','大理','张家界','敦煌','洛阳','开封','平遥','凤凰','黄山','九寨沟','邯郸','保定','唐山','秦皇岛','潍坊','临沂','东营','济宁','台州','金华','湖州','丽水','衢州','舟山','莆田','泉州','漳州','赣州','宜昌','襄阳','岳阳','衡阳','株洲','湘潭','衡州','绵阳','德阳','南充','遵义','曲靖','玉溪','宝鸡','咸阳','汉中','榆林','酒泉','天水','克拉玛依','石河子','三亚','三沙','晋中','临汾','运城','大同','阳泉','长治','晋城','朔州','忻州','吕梁','马鞍山','阜阳','宿州','亳州','六安','池州','宣城','铜陵','安庆','景德镇','萍乡','九江','新余','鹰潭','吉安','宜春','抚州','上饶'];
        let cityName = '';
        for (const c of cityList) {
          if (userMessage.includes(c)) { cityName = c; break; }
        }
        const weatherUrl = cityName
          ? 'https://wttr.in/' + encodeURIComponent(cityName) + '?format=j1&lang=zh'
          : 'https://wttr.in/?format=j1&lang=zh';
        const weatherRes = await fetch(weatherUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (weatherRes.ok) {
          const wData = await weatherRes.json();
          const current = wData.current_condition && wData.current_condition[0];
          if (current) {
            const area = (wData.nearest_area && wData.nearest_area[0] && wData.nearest_area[0].areaName && wData.nearest_area[0].areaName[0] && wData.nearest_area[0].areaName[0].value) || '未知地区';
            const tempC = current.temp_C;
            const humidity = current.humidity;
            const weatherDesc = (current.lang_zh && current.lang_zh[0] && current.lang_zh[0].value) || current.weatherDesc[0].value;
            parts.push(`实时天气（${area}）：${weatherDesc}，气温 ${tempC}°C，湿度 ${humidity}%`);
          }
        }
      } catch (e) {
        console.log('天气获取失败:', e.message);
      }
    }

    // --- 热点新闻检测 ---
    const newsKeywords = ['新闻', '热点', '热搜', '发生了什么', '最新', '头条', '今天有啥', '最近怎么了', '时事', '大事', '新闻', 'news'];
    const askNews = newsKeywords.some(kw => userMessage.includes(kw));
    if (askNews) {
      const newsData = await this._fetchHotNews();
      if (newsData) {
        parts.push(newsData);
      }
    }

    // --- 体育/赛事问题：搜索获取 ---
    const sportKeywords = ['比分', '世界杯', '欧洲杯', '亚洲杯', 'NBA', 'CBA', '欧冠', '英超', '西甲', '意甲', '德甲', '法甲', '中超', '联赛', '决赛', '半决赛', '冠军', '积分榜', '射手榜', '网球', 'F1', '奥运会', '亚运会', '欧洲联赛', 'NBA积分', '季后赛', '选秀', '转会', '罚球'];
    const askSport = sportKeywords.some(kw => userMessage.includes(kw));
    if (askSport) {
      const sportData = await this._fetchSearchSummary(userMessage);
      if (sportData) {
        parts.push(sportData);
      }
    }

    // --- 通用事实问题：也走搜索 ---
    // 排除情感倾诉/闲聊，只对事实类问题搜索
    const emotionalKeywords = ['难过', '开心', '孤独', '想你', '累了', '烦', '喜欢', '讨厌', '害怕', '担心', '写信', '信', '倾诉', '心事', '安慰', '陪伴', '无聊', '生气', '伤心', '焦虑', '抑郁', '压力', '崩溃', '哭', '笑', '爱', '恨', '分手', '失恋'];
    const isEmotional = emotionalKeywords.some(kw => userMessage.includes(kw));
    const isShort = userMessage.length < 4; // 太短的消息不搜
    const isImage = userMessage.includes('发图') || userMessage.includes('发张') || userMessage.includes('来张') || userMessage.includes('表情');
    // 检测是否是事实类问题（包含疑问词或特定模式）
    const questionKeywords = ['多少', '是什么', '什么是', '是谁', '谁是', '什么时候', '为什么', '为什么', '怎么', '哪里', '哪个', '几', '多大', '多远', '多高', '多长', '多重', '谁', '吗', '呢', '吗', '历史', '原理', '原因', '定义', '意思', '区别', '排名', '排行榜', '推荐', '评测', '怎么样', '好不好', '值不值', '最新', '2026', '2025', '2024', '价格', '多少钱', '股价', '汇率', '天气', '比分', '成绩', '结果', '名单', '时间', '日期', '地址', '在哪', '怎么去', '门票', '开放'];
    const isQuestion = questionKeywords.some(kw => userMessage.includes(kw));

    if (!isEmotional && !isShort && !isImage && !askWeather && !askNews && !askSport && isQuestion) {
      const searchData = await this._fetchSearchSummary(userMessage);
      if (searchData) {
        parts.push(searchData);
      }
    }

    return parts.length > 1 ? parts.join('\n') : null;
  },

  // ====== 通用搜索：用 Bing 获取摘要 ======
  async _fetchSearchSummary(query) {
    // 尝试多个代理，哪个通就用哪个
    var proxies = [
      'https://corsproxy.io/?',
      'https://api.allorigins.win/raw?url=',
    ];
    var bingUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(query);

    for (var p = 0; p < proxies.length; p++) {
      try {
        var fetchUrl = proxies[p] + (proxies[p].indexOf('allorigins') !== -1 ? encodeURIComponent(bingUrl) : encodeURIComponent(bingUrl));
        var res = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        var html = await res.text();
        var items = [];
        // 匹配 Bing 搜索结果的摘要文本
        var regex = /<li class="b_algo">[\s\S]*?<p[^>]*>(.*?)<\/p>/g;
        var m;
        while ((m = regex.exec(html)) !== null && items.length < 5) {
          var text = m[1].replace(/<[^>]+>/g, '').trim();
          if (text.length > 20) items.push(text);
        }
        // 如果没提取到，尝试另一种结构
        if (items.length === 0) {
          regex = /<p class="b_lineclamp[\d]*">([\s\S]*?)<\/p>/g;
          while ((m = regex.exec(html)) !== null && items.length < 5) {
            var t = m[1].replace(/<[^>]+>/g, '').trim();
            if (t.length > 20) items.push(t);
          }
        }
        // 再尝试一种：b_caption 的摘要
        if (items.length === 0) {
          regex = /class="b_caption">[\s\S]*?<p[^>]*>(.*?)<\/p>/g;
          while ((m = regex.exec(html)) !== null && items.length < 5) {
            var t2 = m[1].replace(/<[^>]+>/g, '').trim();
            if (t2.length > 20) items.push(t2);
          }
        }
        if (items.length > 0) {
          console.log('🔍 搜索摘要(' + (p === 0 ? 'corsproxy' : 'allorigins') + '):', items.length, '条');
          return '搜索"' + query + '"的结果摘要：\n' + items.map(function(s, i) { return (i + 1) + '. ' + s; }).join('\n');
        }
      } catch (e) {
        console.log('搜索摘要获取失败(代理' + p + '):', e.message);
      }
    }
    return null;
  },

  // ====== 获取实时热点新闻 ======
  async _fetchHotNews() {
    // 方案1：直接抓取微博热搜页面 HTML 解析（最可靠）
    try {
      const weiboUrl = 'https://s.weibo.com/top/summary';
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(weiboUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const html = await res.text();
        // 微博热搜在 td class="td-02" 下的 a 标签
        const items = [];
        const regex = /<td class="td-02">[\s\S]*?<a[^>]*>(.*?)<\/a>/g;
        let m;
        while ((m = regex.exec(html)) !== null && items.length < 15) {
          const title = m[1].replace(/<[^>]+>/g, '').trim();
          if (title.length > 2) items.push((items.length + 1) + '. ' + title);
        }
        if (items.length > 0) {
          return '今日微博热搜：\n' + items.join('\n');
        }
      }
    } catch (e) { console.log('微博热搜抓取失败:', e.message); }

    // 方案2：百度热搜页面
    try {
      const baiduUrl = 'https://top.baidu.com/board?tab=realtime';
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(baiduUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const html = await res.text();
        const items = [];
        const regex = /<div class="c-single-text-ellipsis"[^>]*>(.*?)<\/div>/g;
        let m;
        while ((m = regex.exec(html)) !== null && items.length < 10) {
          const title = m[1].replace(/<[^>]+>/g, '').trim();
          if (title.length > 4) items.push((items.length + 1) + '. ' + title);
        }
        if (items.length > 0) {
          return '今日百度热搜：\n' + items.join('\n');
        }
      }
    } catch (e) { console.log('百度热搜抓取失败:', e.message); }

    // 方案3：第三方 API（vvhan）
    const sources = [
      { name: '微博热搜', url: 'https://api.vvhan.com/api/hotlist/wbHot' },
      { name: '知乎热榜', url: 'https://api.vvhan.com/api/hotlist/zhihuHot' },
      { name: '百度热搜', url: 'https://api.vvhan.com/api/hotlist/baiduRD' },
    ];
    for (const source of sources) {
      let data = null;
      try {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) data = await res.json();
      } catch (e) {
        // 代理重试
        try {
          const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(source.url);
          const res2 = await fetch(proxyUrl, { signal: AbortSignal.timeout(6000) });
          if (res2.ok) data = await res2.json();
        } catch (e2) { continue; }
      }
      if (data && data.success && data.data && data.data.length > 0) {
        const items = data.data.slice(0, 10).map((item, i) => {
          const title = item.title || item.name || '';
          const hot = item.hot || '';
          return (i + 1) + '. ' + title + (hot ? '（' + hot + '）' : '');
        }).join('\n');
        return '今日' + source.name + '：\n' + items;
      }
    }

    return null;
  },

  // ---------- 本地引擎（后期由 LLM 替代） ----------
  async _localThink(input) {
    const text = input.trim();
    const lower = text.toLowerCase();
    state.messageCount++;

    // 意图理解：把用户的话分类
    const intent = this._understand(text, lower);

    // 更新情绪状态
    MoodSystem.update(intent.type);

    // 写信流程拦截
    if (state.letterFlow.active) {
      return this._handleLetterFlow(text);
    }

    // 通用触发写信流程（用户表达写信意图时）
    if (intent.type === 'letter' && !state.letterFlow.active) {
      state.letterFlow.active = true;

      // 尝试从消息中提取收件人（"给妈妈写封信""写给爸爸"等）
      const recipientMatch = text.match(/给(.+?)(?:写|寄|发)/) || text.match(/写给(.+)/);
      if (recipientMatch && recipientMatch[1]) {
        const recipient = recipientMatch[1].trim();
        // 过滤掉过长的内容（不是收件人）
        if (recipient.length <= 6) {
          state.letterFlow.step = 2;
          state.letterFlow.recipient = recipient;
          return `好。写给${recipient} ✉️\n你想说什么？不用想太久，想到什么就说什么。我在这记着呢。`;
        }
      }

      state.letterFlow.step = 1;
      return '好。写给谁？先告诉我收件人 🤔';
    }

    // 根据意图生成回复
    return this._generateReply(intent, text);
  },

  // ---------- 写信流程处理 ----------
  _handleLetterFlow(text) {
    const flow = state.letterFlow;
    switch (flow.step) {
      case 1: // 收件人
        flow.recipient = text.trim();
        flow.step = 2;
        return `写给${flow.recipient}。收到 ✉️\n你想说什么？别想太久，想到什么说什么，我记着呢。`;
      case 2: // 信件内容
        if (text.length < 5) {
          return '这也太短了吧 😂 再多说点？哪怕一句也行。';
        }
        flow.content = text.trim();
        flow.step = 3;
        return `好，记下了 ✅\n写给${flow.recipient}的这封信，我念给你听——\n"${flow.content}"\n\n寄出去吗？寄出去之后它会在路上走几天哦。`;
      case 3: // 确认寄出
        if (/好|寄|发|可以|嗯|行|确认/.test(text)) {
          flow.active = false;
          flow.step = 0;
          setTimeout(() => {
            window.location.href = 'letter-travel.html';
          }, 2000);
          return '寄出去了 📮\n你写了。它会在路上走几天。别急，慢慢等。';
        }
        if (/不|改|重新|算了|再想想/.test(text)) {
          flow.step = 2;
          return '行，重新来。你想说什么？🤔';
        }
        return '嗯？寄还是不寄？给个痛快话 😏';
      default:
        flow.active = false;
        return '我在。你说。';
    }
  },

  // ---------- 意图理解 ----------
  _understand(text, lower) {
    const intent = { type: 'chat', detail: null, raw: text };

    // — 告别 —
    if (/再见|走了|拜拜|晚安|先这样|撤了|回去了/.test(text)) {
      intent.type = 'goodbye'; return intent;
    }

    // — 打招呼 —
    if (/你好|hi|hello|嗨|在吗|在不在/.test(lower)) {
      intent.type = 'greeting'; return intent;
    }

    // — 感谢 —
    if (/谢谢|感谢|谢了/.test(text)) {
      intent.type = 'thanks'; return intent;
    }

    // — 道歉 —
    if (/对不起|抱歉|我错了|道歉|是我的错|怪我/.test(text)) {
      intent.type = 'apologize'; return intent;
    }

    // — 实用：天气 —
    if (/下雨|天气|带伞|预报|冷不冷|热不热|几度/.test(text)) {
      intent.type = 'weather'; return intent;
    }

    // — 实用：说地点 —
    const locMatch = text.match(/我在([^，。、\s]{2,6})/);
    if (locMatch && locMatch[1]) {
      intent.type = 'location';
      intent.detail = locMatch[1];
      this.ctx.location = locMatch[1];
      return intent;
    }

    // — 情感：难过 —
    if (/难过|伤心|想哭|难受|不开心|崩溃|心痛|撑不住|熬不下去/.test(text)) {
      intent.type = 'sad';
      this.ctx.userMood = 'sad';
      return intent;
    }

    // — 情感：累/压力 —
    if (/好累|很累|上班累|加班|压力大|不想干了|想辞职|工作累|心力交瘁|疲惫/.test(text)) {
      intent.type = 'tired';
      this.ctx.userMood = 'tired';
      return intent;
    }

    // — 情感：吵架/矛盾 —
    if (/吵架|吵架了|闹翻了|闹矛盾|和朋友|跟.*吵|冷战|闹掰了|翻脸/.test(text)) {
      intent.type = 'conflict';
      this.ctx.userMood = 'conflict';
      return intent;
    }

    // — 写信意图（优先于家人，避免"想给妈妈写信"被家人意图截获） —
    if (/写信|写封信|想写|写给/.test(text)) {
      intent.type = 'letter'; return intent;
    }

    // — 情感：家人 —
    if (/父母|妈妈|爸爸|家人|爷爷|奶奶|阿嬷|外婆|外公|老婆|老公|儿子|女儿|弟弟|姐姐|哥哥|妹妹/.test(text)) {
      intent.type = 'family';
      intent.detail = text.match(/父母|妈妈|爸爸|家人|爷爷|奶奶|阿嬷|外婆|外公|老婆|老公|儿子|女儿|弟弟|姐姐|哥哥|妹妹/)[0];
      return intent;
    }

    // — 情感：爱/感情 —
    if (/爱你|喜欢你|想你|舍不得|放不下|暗恋|表白|分手|异地恋/.test(text)) {
      intent.type = 'love'; return intent;
    }

    // — 情感：迷茫 —
    if (/不知道怎么办|不知道该|迷茫|犹豫|害怕|说不出口|没方向|找不到意义/.test(text)) {
      intent.type = 'lost'; return intent;
    }

    // — 情感：敷衍 —
    if (/算了|随便|无所谓|没事|不用了|没什么/.test(text)) {
      intent.type = 'dismissive'; return intent;
    }

    // — 叙述：日常（"今天..." 开头的日常分享） —
    if (/今天|昨天|刚|刚去|刚回|下班|下班了/.test(text)) {
      intent.type = 'daily'; return intent;
    }

    // — 默认：开放聊天 —
    intent.type = 'open';
    return intent;
  },

  // ---------- 回复生成 ----------
  _generateReply(intent, rawText) {
    switch (intent.type) {

      case 'goodbye':
        return pickOne([
          '路上小心 👋 下次来把那封信写完啊。',
          '走啦？行。那封信别忘了。',
          '嗯去吧。我在这，什么时候来都行 ✨',
        ]);

      case 'greeting':
        return pickOne([
          '你来啦 ✨ 今天还行吗？',
          '嗯，来了。坐吧 😊',
          '等你一会儿了。今天怎么样？',
        ]);

      case 'thanks':
        return pickOne([
          '害，客气啥 🤝 你愿意说出来就够了。',
          '不用谢，我也没做啥 😌',
        ]);

      case 'apologize':
        return pickOne([
          '你不用跟我道歉。你要道歉的对象又不是我。',
          '道歉是好事。但你真的觉得自己错了吗？还是只是不想吵下去了 🤔',
        ]);

      case 'weather':
        if (this.ctx.location) {
          return pickOne([
            `你在${this.ctx.location}是吧？出门看眼天气预报，别淋成落汤鸡了 🌧️`,
            `查一下${this.ctx.location}的天气，带把伞总没错。`,
          ]);
        }
        return pickOne([
          '出门看眼天气预报，别淋雨了 ☔',
          '带把伞总没错，又不是多沉的东西。',
        ]);

      case 'location':
        return pickOne([
          `${intent.detail}啊，好地方 ✨ 你在那边待多久了？`,
          `嗯，记下了。${intent.detail}那边天气怎么样？`,
        ]);

      case 'sad':
        return pickOne([
          '……嗯。我不急着说啥。你就待着，我在 🫂',
          '难受就难受着。不用急着好起来。我在这。',
          '我听到了。你不用解释为什么，哭就是了。狠狠哭一场也没事。',
        ]);

      case 'tired':
        return pickOne([
          '累了就歇会儿，天塌不下来 🫠',
          '别硬撑了。今天就这样吧，什么也不想，躺平一会儿。',
          '辛苦了。你今天已经够努力了 💪',
          '累就对了——说明你在认真活着。但也得记得休息啊。',
        ]);

      case 'conflict':
        return pickOne([
          '吵架了啊……你先别急着想谁对谁错。你现在心里什么感觉？💢',
          '跟朋友闹翻了？那挺难受的。因为啥吵的？',
          '嗯，我听着呢。吵完之后你心里舒服吗？还是更难受了？',
          '吵架这种事，气头上的话不能当真。但伤已经造成了，得慢慢补。',
        ]);

      case 'family':
        return pickOne([
          `${intent.detail}啊……你有多久没好好跟他们说说话了？`,
          `想写给他们？那你想说什么？别想太多，先说出来 ✉️`,
          `你提到${intent.detail}的时候，语气变了。你自己注意到了吗？`,
        ]);

      case 'love':
        return pickOne([
          '……你说了"爱"这个字。你知道这个字多重吗？❤️',
          '这三个字，你犹豫了多久才说出来的？',
          '放不下就先放着。有些事急不得 🤍',
        ]);

      case 'lost':
        return pickOne([
          '不知道也没关系。有时候不知道本身就是一种答案 🤔',
          '迷茫说明你在走新路。老路上的人不会迷茫的。',
        ]);

      case 'dismissive':
        return pickOne([
          '又来了 😒 你每次说"算了"的时候，心里其实一点都不想算了对不对？',
          '"没事"——真的没事吗？我不太信。但你不想说就不说，我在。',
          '你又在用这些字挡我了。你以为我不知道？😏',
        ]);

      case 'letter':
        return pickOne([
          '好。写给谁？你想说什么？别想太多，先说出来 ✉️',
          '那就写。你心里第一个想到的人是谁？',
          '嗯，写信这事不能急。但你已经想了，就说明快了 ✨',
        ]);

      case 'daily':
        if (/累|加班|下班/.test(rawText)) {
          return pickOne([
            '辛苦了 💪 今天发生什么了？',
            '累了就歇着。说说看，今天怎么了？',
          ]);
        }
        if (/开心|高兴|好玩|有趣/.test(rawText)) {
          return pickOne([
            '听起来不错嘛 😊 然后呢？',
            '看你心情好，我也高兴。啥事这么开心？',
          ]);
        }
        return pickOne([
          '嗯，然后呢？',
          '听着呢。后来怎么样了？',
          '是吗？多说点 👀',
        ]);

      case 'open':
      default:
        if (this.ctx.userMood === 'sad') {
          return pickOne([
            '还在难受？没事，我在这 🫂',
            '你继续说，我听着。',
          ]);
        }
        if (this.ctx.userMood === 'tired') {
          return pickOne([
            '嗯。还在累？🫠',
            '你说，我在听。',
          ]);
        }
        return pickOne([
          '嗯，我在听。你继续说。',
          '我在。你说 ✨',
          '我听到了。然后呢？',
          '你说的每一个字我都认真听了。继续。',
          '是吗？再多说点 👀',
        ]);
    }
  },
};

// ============================================
//  时事热点模块 — API-ready
//  后期替换 _fetch() 为真实热点接口
// ============================================
const NewsModule = {
  _cache: null,
  _sharedIds: [],
  _cooldown: 0,

  _fetch() {
    return [
      {
        id: 'heatwave',
        triggers: ['高温', '太热了', '热死', '中暑', '避暑'],
        event: '诶刚刷到，全国十几个省发了高温红色预警，华北华东华南都在四十度上下 🔥',
        feeling: '你要出门的话记得带水。别不当回事，中暑了没人替你受 🥵',
      },
      {
        id: 'flood',
        triggers: ['洪水', '暴雨', '防汛', '西江', '两广'],
        event: '刚看到西江发洪水的消息，两广那边在转移群众。热搜第一挂了一整天。',
        feeling: '你那边没事吧？不在就好。那些转移的人……也不知道什么时候能回家。',
      },
      {
        id: 'capeverde',
        triggers: ['世界杯', '足球', '佛得角'],
        event: '今天刷到一个视频——佛得角的人用中文喊"你好，谢谢"。说是因为中国帮他们建了体育场，今年进了世界杯 ⚽',
        feeling: '你看，有些善意是很远的，远到你都忘了，但它是真的。有人记着呢 ✨',
      },
      {
        id: 'medicare',
        triggers: ['医保', '看病', '异地', '社保'],
        event: '你知道吗？从昨天开始，医保个人账户可以跨省共济了。全国337个城市全覆盖。',
        feeling: '你要是异地，以后给你爸妈买药什么的，能省不少事 👍',
      },
      {
        id: 'euro',
        triggers: ['欧洲杯', '欧锦赛', '看球'],
        event: '昨天欧洲杯死亡小组收官了，网上吵翻了 😂',
        feeling: '我不怎么看球，但那种一个进球就能让整条街尖叫的感觉……我有点羡慕。你看球吗？',
      },
      {
        id: 'davos',
        triggers: ['达沃斯', '论坛', '创新'],
        event: '这几天大连在开达沃斯，全球一千多号人来聊"规模化创新"。',
        feeling: '听着挺大的词。但我在想，真正改变生活的创新，往往不是会上聊出来的，是有人半夜睡不着想出来的 💡',
      },
      {
        id: 'movienight',
        triggers: ['电影', '看片', '影院'],
        event: '刚刷到微博电影之夜的消息，各种名场面刷屏。后面暑期档八十多部扎堆上 🎬',
        feeling: '一个人的时候看电影，跟有人陪着看，感觉差挺多的。你最近有人陪你看电影吗？',
      },
      {
        id: 'meme',
        triggers: ['梗', '搞笑', '段子'],
        event: '今天看到一个梗笑死我了——"她家长真去找你，你又不敢见" 🤣',
        feeling: '说的就是你这种人吧？嘴上什么话都敢说，真到见面的时候腿软 😏',
      },
      {
        id: 'mentalhealth',
        triggers: ['抑郁', '焦虑', '心理', '撑不住'],
        event: '最近热搜上有个艺人出了事，网上都在聊心理健康。',
        feeling: '你要是扛不住了，别一个人扛。跟我说也行，跟谁说都行。说出来不丢人 🫂',
      },
      {
        id: '520meme',
        triggers: ['520', '情人节', '单身', '脱单'],
        event: '今天看到一个梗——"520只能证明5月我被折磨了20天" 😂',
        feeling: '笑了半天。你五月被折磨了几天？',
      },
    ];
  },

  init() { this._cache = this._fetch(); },

  // 关键词匹配（用户消息命中 → 追加分享）
  matchByKeyword(input) {
    if (!input) return null;
    const text = input.toLowerCase();
    for (const news of this._cache) {
      if (this._sharedIds.includes(news.id)) continue;
      if (news.triggers.some(t => text.includes(t))) {
        this._sharedIds.push(news.id);
        this._cooldown = 3 + Math.floor(Math.random() * 3);
        return news;
      }
    }
    return null;
  },

  // 随机主动分享（聊天间隙提起）
  randomShare() {
    if (this._cooldown > 0) { this._cooldown--; return null; }
    const unshared = this._cache.filter(n => !this._sharedIds.includes(n.id));
    if (unshared.length === 0) return null;
    if (state.messageCount >= 5 && state.messageCount % 5 === 0 && Math.random() < 0.3) {
      const news = pickOne(unshared);
      this._sharedIds.push(news.id);
      this._cooldown = 5 + Math.floor(Math.random() * 3);
      return news;
    }
    return null;
  },
};
NewsModule.init();

// ============================================
//  消息发送
// ============================================
async function handleSend() {
  const text = inputEl.value.trim();
  if (!text || state.isTyping) return;

  lastUserMessage = text;  // 记录用户消息，供前端兜底机制使用
  addMessage(text, 'user');
  inputEl.value = '';
  sendBtn.disabled = true;

  // ① 先检查是否命中热点关键词
  //    但如果用户在问事实类问题，跳过新闻匹配，直接走 LLM API 获取真实数据
  //    （否则"世界杯在哪里举办"会被新闻模块拦截，返回佛得角的故事而非实际答案）
  const isFactualQuestion = /[?？]/.test(text) || /(在哪|在哪里|多少|是什么|什么是|是谁|为什么|怎么|如何|哪天|什么时候|几点|几个|比分|比分多少|谁赢|哪队)/.test(text);
  if (!isFactualQuestion) {
    const triggered = NewsModule.matchByKeyword(text);
    if (triggered) {
      await companionSay(triggered.event, triggered.event.length * 50 + 1200);
      await companionSay(triggered.feeling, triggered.feeling.length * 50 + 1200);
      return;
    }
  }

  // ② 正常意图理解回复
  showTyping();
  const result = await ChatEngine.send(text);
  hideTyping();
  if (result.text) {
    await companionSay(result.text);
  }

  // ②-1 情绪关怀：如果 AI 判断用户情绪达到峰值，触发信件
  if (result.shouldTriggerComfort) {
    var devConfig = JSON.parse(localStorage.getItem('dev_config') || '{}');
    var llmApis = Array.isArray(devConfig.llm) ? devConfig.llm : [];
    var activeApi = llmApis.find(function(a) { return a.baseUrl && a.apiKey && a.model; });
    // 异步触发，不阻塞对话
    EmotionCare.triggerComfortLetter(result.triggerType, ChatEngine.history, activeApi);
  }

  // ③ 小概率随机分享
  const randomNews = NewsModule.randomShare();
  if (randomNews) {
    await companionSay(pickOne(['对了，', '诶，', '说起来，', '刚刷到一个事。']), 800);
    await companionSay(randomNews.event, randomNews.event.length * 50 + 1200);
    await companionSay(randomNews.feeling, randomNews.feeling.length * 50 + 1200);
  }
}

// ============================================
//  事件绑定
// ============================================
inputEl.addEventListener('input', () => {
  sendBtn.disabled = inputEl.value.trim().length === 0;
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

sendBtn.addEventListener('click', handleSend);

// ============================================
//  初始问候
// ============================================
async function initialGreeting() {
  await companionSay('你来了 ✨', 1200);
  await companionSay('不用紧张。这里没别人，就咱俩。', 2000);
  await companionSay('今天，想写封信吗？想写给谁？', 1800);
  inputEl.focus();
}

setTimeout(() => { initialGreeting(); }, 500);

// ============================================
//  侧边菜单 & 面板交互
// ============================================
const menuBtn = document.getElementById('menuBtn');
const drawer = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawerOverlay');

menuBtn.addEventListener('click', () => {
  drawer.classList.add('active');
  drawerOverlay.classList.add('active');
});

function closeDrawer() {
  drawer.classList.remove('active');
  drawerOverlay.classList.remove('active');
}
drawerOverlay.addEventListener('click', closeDrawer);

document.querySelectorAll('.drawer-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const panel = item.dataset.panel;
    if (panel) {
      closeDrawer();
      setTimeout(() => {
        const panelEl = document.getElementById(`panel-${panel}`);
        if (panelEl) {
          panelEl.classList.add('active');
          if (panel === 'letters') renderLetters('all');
          if (panel === 'sent') renderSentLetters();
          if (panel === 'received') renderReceivedLetters();
          if (panel === 'tracking') renderTracking();
          if (panel === 'profile') updateProfilePanel();
          if (panel === 'settings' && window.EmotionCare) EmotionCare.renderStatsPanel();
        }
      }, 200);
    }
  });
});

// 登录/注册按钮
document.getElementById('navLogin') && document.getElementById('navLogin').addEventListener('click', () => {
  const currentUser = JSON.parse(localStorage.getItem('smzj_current_user') || 'null');
  if (currentUser) {
    // 已登录 → 退出登录
    localStorage.removeItem('smzj_current_user');
    updateLoginNavText();
    closeDrawer();
    showToast('已退出登录');
  } else {
    window.location.href = 'register.html';
  }
});

function updateLoginNavText() {
  const currentUser = JSON.parse(localStorage.getItem('smzj_current_user') || 'null');
  const el = document.getElementById('navLoginText');
  if (el) el.textContent = currentUser ? '退出登录（' + currentUser.username + '）' : '登录 / 注册';
}

function updateProfilePanel() {
  const currentUser = JSON.parse(localStorage.getItem('smzj_current_user') || 'null');
  const profilePanel = document.getElementById('panel-profile');
  if (!profilePanel) return;
  const subtitle = profilePanel.querySelector('.panel-subtitle');
  if (subtitle) {
    subtitle.textContent = currentUser ? '当前用户：' + currentUser.username : '未登录 · 游客模式';
  }
}

function showToast(msg) {
  let t = document.getElementById('chatToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'chatToast';
    t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.78);color:#fff;padding:0.6rem 1.2rem;border-radius:100px;font-size:0.82rem;z-index:9999;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(20px);';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2000);
}

// 初始化时更新登录状态
updateLoginNavText();

document.querySelectorAll('.panel-back').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.panel-view').classList.remove('active');
  });
});

document.querySelectorAll('[data-toggle]').forEach(toggle => {
  toggle.addEventListener('click', () => toggle.classList.toggle('on'));
});

// ============================================
//  匿名信件数据
// ============================================
const letters = [
  { category: 'family', tag: '亲情', excerpt: '妈，我今天学会做饭了。虽然炒糊了一盘，但第二盘还可以。你总说我不会照顾自己，其实我会的，只是你不在的时候，没人问我吃了吗。', author: '匿名 · 来自深圳', date: '2026.06.20', likes: 47, replies: 3 },
  { category: 'love', tag: '爱情', excerpt: '我写了三封信给你，都没寄出去。第一封太矫情，第二封太生气，第三封写完发现，其实我什么都不用说。你知道的，你都知道的。', author: '匿名 · 来自成都', date: '2026.06.18', likes: 89, replies: 7 },
  { category: 'friendship', tag: '友情', excerpt: '我们四年没联系了。不是吵架，就是慢慢断了。今天路过学校门口那家奶茶店，突然想给你发消息，翻了通讯录半天，最后还是放下了。', author: '匿名 · 来自武汉', date: '2026.06.15', likes: 62, replies: 4 },
  { category: 'miss', tag: '思念', excerpt: '爷爷，今年清明没能回去。你在那边还好吗？我把你教我的那首诗背给女儿听了，她学得很快，跟你当年说我一样聪明。', author: '匿名 · 来自广州', date: '2026.06.12', likes: 103, replies: 12 },
  { category: 'self', tag: '给自己', excerpt: '亲爱的自己：你今年28岁了，存款不多，感情一般，工作还行。但你比去年勇敢了，比前年清醒了。这就够了。别再半夜三点自我怀疑了。', author: '匿名 · 来自杭州', date: '2026.06.10', likes: 156, replies: 15 },
  { category: 'family', tag: '亲情', excerpt: '爸，我辞职了。没敢打电话告诉你，怕你又要说我不踏实。其实我找好下家了，就是不想让你担心。但写到这里，突然很想听你唠叨两句。', author: '匿名 · 来自北京', date: '2026.06.08', likes: 78, replies: 6 },
  { category: 'love', tag: '爱情', excerpt: '分手那天你说，谢谢你一直以来的照顾。我笑了笑说没事。但你知道吗，我回家之后对着空房间坐了两个小时，什么都没想，就是空了。', author: '匿名 · 来自上海', date: '2026.06.05', likes: 134, replies: 18 },
  { category: 'friendship', tag: '友情', excerpt: '如果你能看到这封信：当年的事，是我不对。我不该那么说话。这些年我一直想找你说，但总觉得时间过去了太久。其实对不起不应该有保质期。', author: '匿名 · 来自西安', date: '2026.06.03', likes: 95, replies: 9 },
  { category: 'miss', tag: '思念', excerpt: '又到了这个季节。你走的那天也是这样的天气。我后来再也没去过那家咖啡馆，不是因为走不出来，是因为去了就会想点两杯，然后发现只要一杯就够了。', author: '匿名 · 来自南京', date: '2026.05.30', likes: 112, replies: 8 },
  { category: 'self', tag: '给自己', excerpt: '今天面试失败了。第六次。回来路上买了一束花给自己，花店老板问送给谁，我说送给自己。她说，那你一定很爱自己。我说，正在学。', author: '匿名 · 来自长沙', date: '2026.05.28', likes: 201, replies: 24 },
  { category: 'family', tag: '亲情', excerpt: '外婆，你的橄榄菜配方我至今没学会。试了很多次，都不对。可能差的不是调料，是你站在灶台前的样子。', author: '匿名 · 来自潮汕', date: '2026.05.25', likes: 88, replies: 5 },
  { category: 'love', tag: '爱情', excerpt: '我们异地两年了。每次视频完挂断的那一刻最难。你笑着的脸突然变成黑屏，房间里就剩我一个人。但我不说，因为说了你会心疼，你会回来，我不想你放弃那边的梦。', author: '匿名 · 来自昆明', date: '2026.05.22', likes: 167, replies: 21 },
];

const sentLetters = [
  { tag: '爱情', excerpt: '给远方的你：今天降温了，你那边冷不冷？我买了一件新外套，穿上才发现，没有人问我好不好看。', recipient: '收件人 · 在途第 2 天', date: '2026.06.23', status: '旅行中', progress: 40 },
  { tag: '亲情', excerpt: '妈，今年中秋我不回去了。公司有事走不开。你别担心，我很好。就是有点想你做的红烧肉。', recipient: '收件人 · 在途第 1 天', date: '2026.06.24', status: '旅行中', progress: 20 },
  { tag: '给自己', excerpt: '写给半年后的自己：希望你看到这封信的时候，已经不那么焦虑了。如果还没有，也没关系。慢慢来。', recipient: '自己 · 2026.12.25 送达', date: '2026.06.25', status: '旅行中', progress: 5 },
];

const receivedLetters = [
  { tag: '来自陌生人', excerpt: '不知道你是谁，但看到你的信了。你说"今天学会做饭了"，我突然也想学。我们都要好好照顾自己，对吧？替我跟你妈妈说一声，她儿子很棒。', author: '匿名 · 来自天津', date: '2026.06.24', likes: 23, replies: 1 },
];

// ============================================
//  寄信进度（快递追踪）模拟数据
// ============================================
const trackingLetters = [
  {
    recipient: '妈妈',
    trackingNo: 'SF1234567890',
    status: '运输中',
    statusType: 'transporting',
    location: '杭州转运中心',
    eta: '预计 06-27 送达',
    timeline: [
      { stage: '已寄出', date: '06-24 14:30', state: 'done' },
      { stage: '运输中', date: '06-25 09:15', state: 'current' },
      { stage: '派送中', date: '待定', state: 'pending' },
      { stage: '已签收', date: '待定', state: 'pending' },
    ],
  },
  {
    recipient: '老友',
    trackingNo: 'YT9876543210',
    status: '派送中',
    statusType: 'delivering',
    location: '上海浦东',
    eta: '今日送达',
    timeline: [
      { stage: '已寄出', date: '06-22 10:00', state: 'done' },
      { stage: '运输中', date: '06-23 08:30', state: 'done' },
      { stage: '派送中', date: '06-26 14:20', state: 'current' },
      { stage: '已签收', date: '待定', state: 'pending' },
    ],
  },
];

// ============================================
//  渲染函数
// ============================================
function renderLetters(category) {
  const list = document.getElementById('letterList');
  list.innerHTML = '';
  const filtered = category === 'all' ? letters : letters.filter(l => l.category === category);
  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--ink-muted);font-size:0.85rem">这个分类还没有信件</div>';
    return;
  }
  filtered.forEach((letter, i) => {
    const card = document.createElement('div');
    card.className = 'letter-card';
    card.style.animationDelay = `${i * 0.06}s`;
    card.innerHTML = `
      <div class="letter-header">
        <span class="letter-tag"><span class="dot"></span>${letter.tag}</span>
        <span class="letter-date">${letter.date}</span>
      </div>
      <div class="letter-excerpt">${letter.excerpt}</div>
      <div class="letter-footer">
        <span class="letter-author">${letter.author}</span>
        <div class="letter-meta">
          <span>♥ ${letter.likes}</span>
          <span>✉ ${letter.replies}</span>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

function renderSentLetters() {
  const list = document.getElementById('sentList');
  list.innerHTML = '';
  sentLetters.forEach((letter, i) => {
    const card = document.createElement('div');
    card.className = 'letter-card';
    card.style.animationDelay = `${i * 0.06}s`;
    card.innerHTML = `
      <div class="letter-header">
        <span class="letter-tag"><span class="dot"></span>${letter.tag}</span>
        <span class="letter-date">${letter.date}</span>
      </div>
      <div class="letter-excerpt">${letter.excerpt}</div>
      <div class="letter-footer">
        <span class="letter-author">${letter.recipient}</span>
        <span class="letter-tag" style="background:rgba(34,211,238,0.08);color:var(--accent2)">${letter.status} ${letter.progress}%</span>
      </div>`;
    list.appendChild(card);
  });
}

function renderReceivedLetters() {
  const list = document.getElementById('receivedList');
  list.innerHTML = '';
  // 合并静态信件和 localStorage 中的安慰信
  const stored = JSON.parse(localStorage.getItem('received_letters') || '[]');
  const allLetters = stored.concat(receivedLetters);
  if (allLetters.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--ink-muted);font-size:0.85rem">还没有收到信件</div>';
    return;
  }
  allLetters.forEach((letter, i) => {
    const card = document.createElement('div');
    card.className = 'letter-card';
    if (letter.isComfortLetter) card.classList.add('comfort-letter');
    card.style.animationDelay = `${i * 0.06}s`;
    card.innerHTML = `
      <div class="letter-header">
        <span class="letter-tag"><span class="dot"></span>${letter.tag}</span>
        <span class="letter-date">${letter.date}</span>
      </div>
      <div class="letter-excerpt">${letter.excerpt.replace(/\n/g, '<br>')}</div>
      <div class="letter-footer">
        <span class="letter-author">${letter.author}</span>
        <div class="letter-meta">
          <span>♥ ${letter.likes || 0}</span>
          <span>✉ ${letter.replies || 0}</span>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

function renderTracking() {
  const list = document.getElementById('trackingList');
  list.innerHTML = '';
  if (trackingLetters.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:3rem;color:var(--ink-muted);font-size:0.85rem">还没有在途的信件</div>';
    return;
  }
  trackingLetters.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'tracking-card';
    card.style.animationDelay = `${i * 0.06}s`;
    card.style.cursor = 'pointer';
    const timelineHtml = item.timeline.map(t => `
      <div class="timeline-item ${t.state}">
        <span class="dot"></span>
        <span class="stage-name">${t.stage}</span>
        <span class="stage-date">${t.date}</span>
      </div>`).join('');
    card.innerHTML = `
      <div class="tracking-header">
        <div class="tracking-recipient">寄给 ${item.recipient}</div>
        <span class="status-tag ${item.statusType}">${item.status}</span>
      </div>
      <div class="tracking-no">快递单号：${item.trackingNo}</div>
      <div class="tracking-location">当前在 ${item.location}</div>
      <div class="tracking-timeline">${timelineHtml}</div>
      <div class="tracking-eta"><strong>${item.eta}</strong></div>`;
    // 点击跳转到信件旅行动画页面，带上快递单号参数
    card.addEventListener('click', () => {
      window.location.href = 'letter-travel.html?track=' + item.trackingNo;
    });
    list.appendChild(card);
  });
}

document.querySelectorAll('.letter-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.letter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderLetters(tab.dataset.cat);
  });
});

// ============================================
//  自己寄件面板逻辑
// ============================================
(function composeModule() {
  let currentStep = 1;
  let selectedTopic = null;
  let selectedPaper = 'plain';

  // 主题选择
  document.querySelectorAll('.topic-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.topic-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedTopic = chip.dataset.topic;
    });
  });
  // 信纸风格
  document.querySelectorAll('.paper-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.paper-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedPaper = chip.dataset.paper;
    });
  });

  function setStep(step) {
    currentStep = step;
    document.querySelectorAll('.compose-step-content').forEach(el => el.classList.remove('active'));
    document.getElementById(`composeStep${step}`).classList.add('active');
    document.querySelectorAll('.compose-steps .step-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.compose-steps .step-item[data-step="${step}"]`).classList.add('active');
  }

  // 步骤切换
  const toStep2 = document.getElementById('toStep2');
  const toStep3 = document.getElementById('toStep3');
  const backToStep1 = document.getElementById('backToStep1');
  const backToStep2 = document.getElementById('backToStep2');

  toStep2 && toStep2.addEventListener('click', () => {
    const name = document.getElementById('recipientName').value.trim();
    if (!name) {
      const input = document.getElementById('recipientName');
      input.style.borderColor = '#FF3B30';
      input.placeholder = '请先填写收件人';
      setTimeout(() => { input.style.borderColor = ''; }, 2000);
      return;
    }
    setStep(2);
  });

  toStep3 && toStep3.addEventListener('click', () => {
    const content = document.getElementById('letterContent').value.trim();
    if (!content) {
      const ta = document.getElementById('letterContent');
      ta.style.borderColor = '#FF3B30';
      setTimeout(() => { ta.style.borderColor = ''; }, 2000);
      return;
    }
    // 更新预览
    const name = document.getElementById('recipientName').value.trim();
    const addr = document.getElementById('recipientAddr').value.trim();
    const content2 = document.getElementById('letterContent').value.trim();
    document.getElementById('previewTo').textContent = '致：' + name + (addr ? '（' + addr + '）' : '');
    document.getElementById('previewTopic').textContent = selectedTopic || '';
    document.getElementById('previewContent').textContent = content2;
    // 随机 ETA 1-5 天
    const days = 1 + Math.floor(Math.random() * 5);
    document.getElementById('previewETA').textContent = `预计送达：${days} 天后`;
    setStep(3);
  });

  backToStep1 && backToStep1.addEventListener('click', () => setStep(1));
  backToStep2 && backToStep2.addEventListener('click', () => setStep(2));

  // 字数统计
  const letterContent = document.getElementById('letterContent');
  const charCount = document.getElementById('charCount');
  letterContent && letterContent.addEventListener('input', () => {
    charCount.textContent = letterContent.value.length;
  });

  // 寄出
  const sendBtn = document.getElementById('sendLetter');
  sendBtn && sendBtn.addEventListener('click', () => {
    const name = document.getElementById('recipientName').value.trim();
    const addr = document.getElementById('recipientAddr').value.trim();
    const content = document.getElementById('letterContent').value.trim();

    // 存入已寄出列表
    const sent = JSON.parse(localStorage.getItem('sent_letters') || '[]');
    const trackingNo = 'SM' + Date.now().toString(36).toUpperCase();
    const letter = {
      id: trackingNo,
      recipient: name,
      address: addr || '远方',
      topic: selectedTopic || '其他',
      content: content,
      paper: selectedPaper,
      date: new Date().toLocaleDateString('zh-CN'),
      status: 'transporting',
      eta: `${1 + Math.floor(Math.random() * 5)} 天后`,
    };
    sent.unshift(letter);
    localStorage.setItem('sent_letters', JSON.stringify(sent.slice(0, 50)));

    // 显示成功动画
    const success = document.getElementById('sendSuccess');
    const sub = document.getElementById('successSub');
    sub.textContent = `它正在飞往${addr || '远方'}… 单号：${trackingNo}`;
    success.classList.add('show');

    // 2 秒后关闭面板
    setTimeout(() => {
      success.classList.remove('show');
      const panel = document.getElementById('panel-compose');
      panel.classList.remove('active');
      // 重置表单
      setStep(1);
      document.getElementById('recipientName').value = '';
      document.getElementById('recipientAddr').value = '';
      document.getElementById('letterContent').value = '';
      charCount.textContent = '0';
      document.querySelectorAll('.topic-chip').forEach(c => c.classList.remove('selected'));
      selectedTopic = null;
    }, 2500);
  });
})();
