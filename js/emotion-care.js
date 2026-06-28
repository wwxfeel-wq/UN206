/**
 * 时墨之境 · 情绪关怀系统 v2
 *
 * 双类型情绪峰值追踪：
 * - 正向峰值（高兴/喜悦）→ 祝贺信，年度上限 3 封
 * - 负向峰值（愤怒/低落/绝望）→ 安慰信，年度上限 6 封
 *
 * 月度峰值刷新：每月重置情绪趋势追踪，允许重新检测峰值
 * 年度配额：自然年内累计，次年自动重置
 * 后台统计：在设置面板展示本年度使用情况
 */

const EmotionCare = {
  // 情绪历史记录（最近 6 轮）
  history: [],

  // 触发阈值
  config: {
    triggerScore: 75,       // 单轮情绪强度阈值
    triggerCount: 2,         // 连续达到阈值的轮数
    cooldownHours: 24,       // 触发后冷却期（小时）
    maxHistory: 6,           // 保留的历史记录数
    // 年度配额
    yearlyLimit: {
      positive: 3,           // 正向情绪（高兴峰值）：年度上限 3 封
      negative: 6,            // 负向情绪（愤怒/低落峰值）：年度上限 6 封
    },
  },

  // 上次触发时间
  lastTriggered: null,
  // 当前月份追踪（用于月度峰值刷新）
  currentMonth: null,

  /**
   * 初始化：检查月度/年度重置
   */
  _initIfNeeded() {
    var now = new Date();
    var yearMonth = now.getFullYear() + '-' + (now.getMonth() + 1);

    // 月度刷新：新月份 → 清空情绪历史（允许重新检测峰值）
    if (this.currentMonth !== yearMonth) {
      if (this.currentMonth !== null) {
        console.log('💙 月度峰值刷新：', this.currentMonth, '→', yearMonth);
        this.history = [];
      }
      this.currentMonth = yearMonth;
    }

    // 年度配额重置：新年 → 清零计数器
    var stats = this._loadStats();
    if (stats.year !== now.getFullYear()) {
      console.log('💙 年度配额重置：', stats.year, '→', now.getFullYear());
      stats.year = now.getFullYear();
      stats.positiveSent = 0;
      stats.negativeSent = 0;
      this._saveStats(stats);
    }
  },

  /**
   * 从 AI 回复中提取情绪标记 [mood:type:score] 并清理
   * type: happy | distress
   * score: 0-100
   * 返回 { text: 清理后的文本, type: 'happy'|'distress', score: 情绪分数 }
   */
  parseEmotionScore(aiReply) {
    var type = 'distress';
    var score = 50;
    var text = aiReply;

    // 新格式：[mood:happy:80] 或 [mood:distress:85]
    var match = aiReply.match(/\[mood:(happy|distress):(\d+)\]/);
    if (match) {
      type = match[1];
      score = parseInt(match[2]);
      score = Math.max(0, Math.min(100, score));
      text = aiReply.replace(/\[mood:(?:happy|distress):\d+\]/, '').trim();
    } else {
      // 兼容旧格式：[distress:XX]
      var oldMatch = aiReply.match(/\[distress:(\d+)\]/);
      if (oldMatch) {
        score = parseInt(oldMatch[1]);
        score = Math.max(0, Math.min(100, score));
        type = score <= 20 ? 'happy' : 'distress';
        text = aiReply.replace(/\[distress:\d+\]/, '').trim();
      }
    }

    return { text: text, type: type, score: score };
  },

  /**
   * 记录本轮情绪分数，返回 { shouldTrigger, triggerType }
   */
  recordScore(type, score) {
    this._initIfNeeded();

    var now = Date.now();
    this.history.push({ type: type, score: score, time: now });
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    console.log('💙 情绪记录:', type, score, '历史:', this.history.map(function(h) { return h.type + ':' + h.score; }));

    var result = this._shouldTrigger(type);
    return { shouldTrigger: result.shouldTrigger, triggerType: result.triggerType };
  },

  /**
   * 判断是否应触发信件
   */
  _shouldTrigger(type) {
    // 冷却期内不触发
    if (this.lastTriggered) {
      var elapsed = Date.now() - this.lastTriggered;
      var cooldownMs = this.config.cooldownHours * 60 * 60 * 1000;
      if (elapsed < cooldownMs) {
        console.log('💙 情绪关怀：冷却期内，跳过');
        return { shouldTrigger: false, triggerType: null };
      }
    }

    // 检查年度配额
    var stats = this._loadStats();
    var limitKey = type === 'happy' ? 'positive' : 'negative';
    var used = stats[limitKey + 'Sent'] || 0;
    var limit = this.config.yearlyLimit[limitKey];
    if (used >= limit) {
      console.log('💙 情绪关怀：年度配额已满', limitKey, used + '/' + limit);
      return { shouldTrigger: false, triggerType: null };
    }

    // 历史记录不足
    if (this.history.length < this.config.triggerCount) {
      return { shouldTrigger: false, triggerType: null };
    }

    // 检查最近 N 轮是否连续达到阈值（同类型）
    var recent = this.history.slice(-this.config.triggerCount);
    var allMatch = recent.every(function(h) {
      return h.type === type && h.score >= 75;
    });
    if (!allMatch) return { shouldTrigger: false, triggerType: null };

    // 检查上升趋势
    var isRising = true;
    for (var i = 1; i < recent.length; i++) {
      if (recent[i].score < recent[i - 1].score - 5) {
        isRising = false;
        break;
      }
    }
    if (!isRising) return { shouldTrigger: false, triggerType: null };

    console.log('💙 情绪关怀：触发条件满足！类型:', limitKey);
    return { shouldTrigger: true, triggerType: limitKey };
  },

  // ====== 配额管理（localStorage 持久化） ======

  _loadStats() {
    var raw = localStorage.getItem('emotion_care_stats');
    if (raw) {
      try { return JSON.parse(raw); } catch (e) {}
    }
    return {
      year: new Date().getFullYear(),
      positiveSent: 0,
      negativeSent: 0,
      lastPositiveDate: null,
      lastNegativeDate: null,
    };
  },

  _saveStats(stats) {
    localStorage.setItem('emotion_care_stats', JSON.stringify(stats));
  },

  _incrementSent(type) {
    var stats = this._loadStats();
    var key = type === 'positive' ? 'positiveSent' : 'negativeSent';
    stats[key] = (stats[key] || 0) + 1;
    var dateKey = type === 'positive' ? 'lastPositiveDate' : 'lastNegativeDate';
    stats[dateKey] = new Date().toLocaleDateString('zh-CN');
    this._saveStats(stats);
    console.log('💌 配额更新:', type, stats[key] + '/' + this.config.yearlyLimit[type]);
  },

  /**
   * 获取后台统计数据（供设置面板显示）
   */
  getStats() {
    this._initIfNeeded();
    var stats = this._loadStats();
    return {
      year: stats.year,
      positive: { used: stats.positiveSent || 0, limit: this.config.yearlyLimit.positive, lastDate: stats.lastPositiveDate },
      negative: { used: stats.negativeSent || 0, limit: this.config.yearlyLimit.negative, lastDate: stats.lastNegativeDate },
      total: (stats.positiveSent || 0) + (stats.negativeSent || 0),
    };
  },

  /**
   * 触发信件流程
   * @param {String} triggerType - 'positive' | 'negative'
   * @param {Array} recentMessages - 最近的对话历史
   * @param {Object} apiConfig - LLM API 配置
   */
  async triggerComfortLetter(triggerType, recentMessages, apiConfig) {
    this.lastTriggered = Date.now();
    console.log('💌 开始生成' + (triggerType === 'positive' ? '祝贺' : '安慰') + '信...');

    try {
      var letter = await this._generateLetter(triggerType, recentMessages, apiConfig);
      if (letter) {
        this._saveLetter(letter);
        this._showNotification(letter, triggerType);
        this._incrementSent(triggerType);
        return letter;
      }
    } catch (e) {
      console.error('💌 信件生成失败:', e);
      this.lastTriggered = null;
    }
    return null;
  },

  /**
   * 调用 LLM 生成信件
   */
  async _generateLetter(triggerType, recentMessages, apiConfig) {
    if (!apiConfig || !apiConfig.baseUrl || !apiConfig.apiKey) {
      return this._templateLetter(triggerType);
    }

    var dialogue = recentMessages.slice(-6).map(function(m) {
      return (m.role === 'user' ? '用户' : '时墨') + '：' + m.content;
    }).join('\n');

    var tone = triggerType === 'positive'
      ? '你被对方的快乐触动了，想写一封简短的祝贺信。分享喜悦，但不要过度吹捧。'
      : '你被触动了，想给这个人写一封简短的安慰信。温暖但不煽情。';

    var prompt = [
      '你是一个匿名陌生人，在时墨之境的信件墙上看到了这个人的聊天记录。',
      tone,
      '',
      '【信件要求】',
      '1. 80-150 字，像手写信一样自然',
      '2. 不要说"我理解你的感受"这种话术',
      '3. 像一个真正关心你的陌生人——可以分享自己的小故事，或者说一句刚好需要听的话',
      '4. 不要署名，不要提具体细节（你只是"看到"了这个人的状态，不是窥探隐私）',
      '5. 真诚但不刻意，可以适当留白',
      '',
      '【对方的最近对话】',
      dialogue,
      '',
      '请直接写信件内容，不要加任何前缀说明。以"展信佳——"开头。',
    ].join('\n');

    var targetUrl = apiConfig.baseUrl.replace(/\/$/, '') + '/chat/completions';
    var proxy = apiConfig.proxy || '';
    var fetchUrl = proxy ? proxy.replace(/\/$/, '') + '/' + targetUrl : targetUrl;

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 15000);

    var res = await fetch(fetchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiConfig.apiKey,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.95,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error('API ' + res.status);
    var data = await res.json();
    var content = data.choices && data.choices[0] ? data.choices[0].message.content.trim() : '';
    if (!content) throw new Error('空回复');

    return this._makeLetter(content, triggerType);
  },

  /**
   * 模板信件（无 API 时兜底）
   */
  _templateLetter(triggerType) {
    var positiveTemplates = [
      '展信佳——\n看到你今天这么开心，我也跟着笑了。说起来你可能不信，我今天在路上看到一个小女孩举着气球跑，笑得特别大声。我突然就想到你。开心的时候尽情开心，别想太多。祝好。',
      '展信佳——\n你的快乐是有感染力的，隔着信件墙都能感觉到。我上一次这么开心是什么时候来着……哦，是吃到一碗特别好吃的面。祝你一直有值得开心的小事。',
    ];
    var negativeTemplates = [
      '展信佳——\n不知道你今天过得怎么样。我其实也不太会说话，但就是想告诉你：今天下班路上看到一只猫在晒太阳，它看起来什么都不不担心。我想到你，希望你也能有那么一刻，什么都不用想，就晒晒太阳。就这些。祝你今晚睡个好觉。',
      '展信佳——\n今天路过一家面包店，刚出炉的面包香味飘到街上。我站在那里闻了好一会儿，突然觉得活着挺好的。不知道你在经历什么，但希望你也遇到一个让你停下来闻一闻的瞬间。不用回信，看看就好。',
      '展信佳——\n我之前也有一段时间，觉得什么都提不起劲。后来发现不是事情变好了，是我慢慢学会了对自己说"今天够了，别逼了"。你也不必每时每刻都撑着。累了就歇会儿，没什么大不了的。',
      '展信佳——\n给你讲个事：我养了一盆绿萝，差点养死了，叶子全黄了。我没扔，就继续浇水。过了两个月，冒出一片新叶子。我说这个不是要讲道理，是想说——有些东西看起来完了，其实还在长。你别急。',
    ];
    var templates = triggerType === 'positive' ? positiveTemplates : negativeTemplates;
    return this._makeLetter(templates[Math.floor(Math.random() * templates.length)], triggerType);
  },

  _makeLetter(content, triggerType) {
    return {
      tag: triggerType === 'positive' ? '来自陌生人的祝贺' : '来自陌生人',
      excerpt: content,
      author: '匿名 · 来自时墨之境',
      date: new Date().toLocaleDateString('zh-CN'),
      likes: 0,
      replies: 0,
      isComfortLetter: true,
      triggerType: triggerType,
      timestamp: Date.now(),
    };
  },

  /**
   * 保存信件到收信箱
   */
  _saveLetter(letter) {
    var stored = JSON.parse(localStorage.getItem('received_letters') || '[]');
    stored.unshift(letter);
    localStorage.setItem('received_letters', JSON.stringify(stored.slice(0, 30)));
    console.log('💌 信件已存入收信箱');
  },

  /**
   * 显示通知 UI（自动消失）
   */
  _showNotification(letter, triggerType) {
    var notif = document.getElementById('comfortNotif');
    if (!notif) return;

    var titleEl = notif.querySelector('.comfort-title');
    var excerptEl = notif.querySelector('.comfort-excerpt');
    var iconEl = notif.querySelector('.comfort-icon');

    if (titleEl) {
      titleEl.textContent = triggerType === 'positive'
        ? '你收到了一封来自陌生人的祝贺信'
        : '你收到了一封来自陌生人的信';
    }
    if (iconEl) {
      iconEl.textContent = triggerType === 'positive' ? '🎉' : '✉️';
    }
    if (excerptEl) {
      var text = letter.excerpt.replace(/^展信佳[——\-]*/, '').trim();
      excerptEl.textContent = text.substring(0, 60) + '...';
    }

    // 先移除旧的定时器
    if (this._notifTimer) {
      clearTimeout(this._notifTimer);
    }

    notif.classList.add('show');

    // 5 秒后自动消失
    var self = this;
    this._notifTimer = setTimeout(function() {
      notif.classList.remove('show');
    }, 5000);
  },

  /**
   * 渲染后台统计到设置面板
   */
  renderStatsPanel() {
    var container = document.getElementById('emotionCareStats');
    if (!container) return;

    var stats = this.getStats();

    container.innerHTML =
      '<div class="ec-stats-header">' +
        '<div class="ec-stats-title">情绪关怀系统</div>' +
        '<div class="ec-stats-year">' + stats.year + ' 年度</div>' +
      '</div>' +
      '<div class="ec-stats-row">' +
        '<div class="ec-stat-card ' + (stats.negative.used >= stats.negative.limit ? 'ec-stat-full' : '') + '">' +
          '<div class="ec-stat-icon">🌧️</div>' +
          '<div class="ec-stat-body">' +
            '<div class="ec-stat-label">低落/愤怒峰值信</div>' +
            '<div class="ec-stat-value">' + stats.negative.used + ' / ' + stats.negative.limit + ' 封</div>' +
            '<div class="ec-stat-bar"><div class="ec-stat-bar-fill" style="width:' + Math.min(100, stats.negative.used / stats.negative.limit * 100) + '%"></div></div>' +
            (stats.negative.lastDate ? '<div class="ec-stat-date">上次：' + stats.negative.lastDate + '</div>' : '<div class="ec-stat-date">暂未触发</div>') +
          '</div>' +
        '</div>' +
        '<div class="ec-stat-card ' + (stats.positive.used >= stats.positive.limit ? 'ec-stat-full' : '') + '">' +
          '<div class="ec-stat-icon">🌈</div>' +
          '<div class="ec-stat-body">' +
            '<div class="ec-stat-label">喜悦峰值信</div>' +
            '<div class="ec-stat-value">' + stats.positive.used + ' / ' + stats.positive.limit + ' 封</div>' +
            '<div class="ec-stat-bar"><div class="ec-stat-bar-fill ec-bar-positive" style="width:' + Math.min(100, stats.positive.used / stats.positive.limit * 100) + '%"></div></div>' +
            (stats.positive.lastDate ? '<div class="ec-stat-date">上次：' + stats.positive.lastDate + '</div>' : '<div class="ec-stat-date">暂未触发</div>') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ec-stats-note">峰值每月刷新 · 配额年度重置 · 已寄出 ' + stats.total + ' 封</div>';
  },

  /**
   * 重置（用于调试）
   */
  reset() {
    this.history = [];
    this.lastTriggered = null;
    this.currentMonth = null;
    console.log('💙 情绪关怀系统已重置');
  },

  /**
   * 重置配额（用于调试）
   */
  resetQuota() {
    var stats = this._loadStats();
    stats.positiveSent = 0;
    stats.negativeSent = 0;
    stats.lastPositiveDate = null;
    stats.lastNegativeDate = null;
    this._saveStats(stats);
    console.log('💙 配额已重置');
    this.renderStatsPanel();
  },
};

// 暴露到全局
window.EmotionCare = EmotionCare;
