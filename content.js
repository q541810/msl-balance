// msl-balance content script — 右下角常驻 DeepSeek 余额挂件
// 以 marcel 为唯一参数执行（非 ES 模块，顶层 await 可用）
// 交互/视觉参考 DeepSeek-Balance-Whale-Widget（DSH 版）：
//   文字锚定气泡精确中心 44.346%/25.5%；按压即 Q 弹（body 整层、底部坐标不变）；
//   拖拽中保持吸附形态、松手按落点重判翻转；自动刷新余额变化时才提示"加载中…"
(function () {
  const PLUGIN_ID = 'msl-balance';
  const ROOT_ATTR = 'data-msl-balance-widget';
  const SNAP_MARGIN = 16;          // 吸附边距 px
  const SNAP_THRESHOLD = 26;       // 吸附判定阈值 px（偏严格）
  const REFRESH_MS = 60 * 1000;    // 60s 自动刷新
  const CHANGE_HINT_MS = 900;      // 余额变化时"加载中…"提示时长
  const DEFAULT_CFG = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    scale: 1.2,
    snapX: 'right',
    snapY: 'bottom',
    x: null,
    y: null,
    showWenfeng: true,
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── 梁文峰 / 梁文谷 双档计价（A 轻量人格化）──
  const PEAK_RANGES = [[9,12],[14,18]]; // BJT 小时区间 [start,end)
  function isPeakNow(d) {
    d = d || new Date();
    const bjHour = (d.getUTCHours() + 8) % 24;
    return PEAK_RANGES.some(function(r){ return bjHour >= r[0] && bjHour < r[1]; });
  }
  const PRICING = {
    inputHit:  { idle:[0.05,0.15], peak:[0.10,0.30] },
    inputMiss: { idle:[1.5,4.5],   peak:[3.0,9.0] },
    output:    { idle:[4.5,13.5],  peak:[9.0,27.0] },
    concurrent:[2500,500]
  };
  function currentPricingTier() { return isPeakNow() ? 'peak' : 'idle'; }
  function fmtPricePair(pair) { return pair[0] + '/' + pair[1]; }
  function wenfengHint() {
    return isPeakNow() ? '文峰当班 · 点击看价' : '文谷摸鱼 · 点击看价';
  }
  function wenfengTitleLine() {
    const tier = currentPricingTier();
    const tag = tier === 'peak' ? '梁文峰当班（高峰 9-12/14-18）' : '梁文谷摸鱼（空闲 其余时段）';
    // 价目按表：命中/未命中/输出，均展示 A/B 两列
    const ih = PRICING.inputHit[tier];
    const im = PRICING.inputMiss[tier];
    const out = PRICING.output[tier];
    return tag + ' · 输入命中' + fmtPricePair(ih) + ' 未命中' + fmtPricePair(im) + ' 输出' + fmtPricePair(out) + ' 元/百万tok';
  }
  function applyWenfengDisplay() {
    if (!hintEl || !root) return;
    if (!cfg.showWenfeng) {
      hintEl.removeAttribute('data-tier');
      if (dot && dot.classList.contains('ok') && lastBalance != null) {
        hintEl.textContent = '点击刷新';
        const t = lastOkAt ? new Date(lastOkAt).toLocaleTimeString() : '—';
        root.title = '大肥鱼余额 · 已同步 ' + t + ' · 点击气泡刷新 · 长按鲸鱼拖拽 · 按 Q 捏一下';
      }
      return;
    }
    const tier = currentPricingTier();
    hintEl.setAttribute('data-tier', tier);
    // 仅在 ok 态覆盖 hint，其余态（loading/stale/err/config）由 setState 主导
    const dotOk = dot && dot.classList.contains('ok');
    if (dotOk && lastBalance != null) {
      hintEl.textContent = wenfengHint();
      const t = lastOkAt ? new Date(lastOkAt).toLocaleTimeString() : '—';
      root.title = '大肥鱼余额 · ' + wenfengTitleLine() + ' · 已同步 ' + t + ' · 点击气泡刷新 · 长按鲸鱼拖拽 · 按 Q 捏一下';
    } else if (dotOk) {
      hintEl.textContent = wenfengHint();
    }
  }

  // ── 幂等守卫：避免 rehydrate 重复注入 ──
  if (document.querySelector('[' + ROOT_ATTR + ']')) return;

  let cfg = { ...DEFAULT_CFG };
  let lastBalance = null;       // 最近一次成功余额
  let lastCurrency = 'CNY';
  let lastOkAt = null;          // 最近成功时间戳
  let inFlight = false;
  let saveTimer = null;
  let refreshTimer = null;
  let changeTimer = null;
  let configUnlisten = null;
  let navUnlisten = null;
  let wenfengTimer = null;
  let hasEverRendered = false;

  let root, bodyEl, whaleWrap, whaleImg, bubbleHit, textEl, labelEl, dot, amountEl, digitsEl, emptyEl, hintEl;

  // ── 读取配置（合并，保留对方字段）──
  async function readConfig(merge = {}) {
    try {
      const raw = await marcel.ipc.call('config.read');
      if (raw) {
        const parsed = JSON.parse(raw);
        cfg = { ...DEFAULT_CFG, ...parsed, ...merge };
      }
    } catch (e) {
      marcel.log.warn('read config failed:', String(e));
    }
    return cfg;
  }

  // 持久化（防抖，合并写：只覆盖挂件字段，保留配置页管理的 apiKey/baseUrl）
  function persist(delay = 350) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        let existing = {};
        try {
          const raw = await marcel.ipc.call('config.read');
          if (raw) existing = JSON.parse(raw);
        } catch (_) { /* ignore */ }
        const merged = {
          ...DEFAULT_CFG,
          ...existing,
          scale: cfg.scale,
          snapX: cfg.snapX,
          snapY: cfg.snapY,
          x: cfg.x,
          y: cfg.y,
          showWenfeng: cfg.showWenfeng,
        };
        await marcel.ipc.call('config.write', { content: JSON.stringify(merged, null, 2) });
      } catch (e) {
        marcel.log.warn('persist failed:', String(e));
      }
    }, delay);
  }

  // 鲸鱼图：主窗口无法直接加载 plugin:// 资源（WebView2 报 ERR_UNKNOWN_URL_SCHEME），
  // 故先用 fs.read 读插件自带的 base64 数据 URI 文件；失败再退回 plugin://（如后端修复）。
  function loadWhaleImage() {
    let done = false;
    const finish = (uri) => {
      if (!done && uri) {
        done = true;
        whaleImg.src = uri;
      }
    };
    (async () => {
      try {
        const uri = await marcel.ipc.call('fs.read', { path: 'whale.png.b64' });
        if (typeof uri === 'string' && uri.startsWith('data:image/')) finish(uri);
      } catch (_) { /* 下探回退 */ }
      if (!done) finish('plugin://' + PLUGIN_ID + '/whale.png');
    })();
  }

  function setHint(text) {
    if (hintEl) hintEl.textContent = text;
  }

  // ── 构建 DOM ──
  function buildDom() {
    root = marcel.overlay.create();
    root.setAttribute(ROOT_ATTR, '');
    root.title = '大肥鱼余额 · 点击气泡刷新 · 长按鲸鱼拖拽 · 按 Q 捏一下';
    root.style.left = '0px';
    root.style.top = '0px';
    root.style.setProperty('--msl-scale', String(cfg.scale));

    bodyEl = document.createElement('div');
    bodyEl.className = 'mslb-body';

    whaleWrap = document.createElement('div');
    whaleWrap.className = 'mslb-whale-wrap';
    whaleImg = document.createElement('img');
    whaleImg.alt = '';
    loadWhaleImage();
    whaleWrap.appendChild(whaleImg);
    bodyEl.appendChild(whaleWrap);

    bubbleHit = document.createElement('div');
    bubbleHit.className = 'mslb-bubble-hit';
    bubbleHit.addEventListener('click', onBubbleClick);
    bodyEl.appendChild(bubbleHit);

    textEl = document.createElement('div');
    textEl.className = 'mslb-text';

    labelEl = document.createElement('div');
    labelEl.className = 'mslb-label';
    dot = document.createElement('span');
    dot.className = 'mslb-dot';
    const labelText = document.createElement('span');
    labelText.textContent = '余 额';
    labelEl.appendChild(dot);
    labelEl.appendChild(labelText);
    textEl.appendChild(labelEl);

    amountEl = document.createElement('div');
    amountEl.className = 'mslb-amount';
    amountEl.style.transition = 'none'; // 首帧不滚
    amountEl.appendChild(document.createElement('span')); // currency 占位
    digitsEl = document.createElement('span');
    digitsEl.className = 'mslb-digits';
    amountEl.appendChild(digitsEl);
    textEl.appendChild(amountEl);

    emptyEl = document.createElement('div');
    emptyEl.className = 'mslb-empty';
    emptyEl.style.display = 'none';
    textEl.appendChild(emptyEl);

    hintEl = document.createElement('div');
    hintEl.className = 'mslb-hint';
    hintEl.textContent = '点击刷新';
    textEl.appendChild(hintEl);

    bodyEl.appendChild(textEl);
    root.appendChild(bodyEl);
  }

  // ── 配置页改动（尺寸等）即时生效：监听 msl-balance://config-saved ──
  // 事件 payload 携带完整新配置（配置页已先落盘），直接应用避免读到旧文件的竞态。
  function listenConfigEvents() {
    const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
    if (!tauriEvent || !tauriEvent.listen) return;
    tauriEvent.listen('msl-balance://config-saved', async (e) => {
      try {
        const p = e && e.payload;
        let needsRender = false;
        if (p && typeof p === 'object') {
          if (p.scale != null) cfg.scale = clamp(Number(p.scale) || 1.2, 0.6, 1.4);
          if (typeof p.showWenfeng === 'boolean') { cfg.showWenfeng = p.showWenfeng; needsRender = true; }
          if (p.showWenfeng == null && p.scale == null) await readConfig({});
          else if (p.showWenfeng != null && p.scale == null) { /* 已应用 */ }
        } else {
          await readConfig({});
          needsRender = true;
        }
        if (!root) return;
        root.style.setProperty('--msl-scale', String(cfg.scale));
        applyPosition(true);
        updateMirror();
        if (needsRender) applyWenfengDisplay();
      } catch (err) {
        marcel.log.warn('apply config failed:', String(err));
      }
    }).then((fn) => { configUnlisten = fn; }).catch((e) => {
      marcel.log.warn('listen config-saved failed:', String(e));
    });
  }

  // ── 位置计算 ──
  function expectedSize() {
    return clamp(196 * cfg.scale, 96, 292);
  }
  function widgetSize() {
    const r = root.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return { w: r.width, h: r.height };
    const e = expectedSize();
    return { w: e, h: e };
  }

  function snapPosition() {
    const { w, h } = widgetSize();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x, y;
    if (cfg.snapX === 'left') x = SNAP_MARGIN;
    else if (cfg.snapX === 'right') x = vw - w - SNAP_MARGIN;
    else x = cfg.x != null ? clamp(cfg.x, 0, Math.max(0, vw - w)) : vw - w - SNAP_MARGIN;
    if (cfg.snapY === 'top') y = SNAP_MARGIN;
    else if (cfg.snapY === 'bottom') y = vh - h - SNAP_MARGIN;
    else y = cfg.y != null ? clamp(cfg.y, 0, Math.max(0, vh - h)) : vh - h - SNAP_MARGIN;
    // 即使是吸附态也要钳制到视口内 —— 启动瞬间 vw 可能为 0 会算出负坐标
    x = clamp(x, 0, Math.max(0, vw - w));
    y = clamp(y, 0, Math.max(0, vh - h));
    return { x, y };
  }

  function applyPosition(animated) {
    const { x, y } = snapPosition();
    root.dataset.mslbSnapAnim = animated ? '1' : '0';
    root.style.left = x + 'px';
    root.style.top = y + 'px';
  }

  // ── 镜像翻转：左半边水平镜像 / 吸附上边垂直翻转（文字在 CSS 里反向保持可读）──
  // 注意：不能依赖 getBoundingClientRect 判位置——位置带 CSS 过渡时 reflow 可能读到
  // 过渡前的旧坐标（启动瞬间 root 还在左上角），会误翻转。用 style.left/top 目标值计算。
  function updateMirror() {
    const { w } = widgetSize();
    const x = parseFloat(root.style.left) || 0;
    const cx = x + w / 2;
    root.dataset.mslbMirrorX = cx < window.innerWidth / 2 ? '1' : '0';
    root.dataset.mslbMirrorY = cfg.snapY === 'top' ? '1' : '0';
  }

  // ── 余额刷新 ──
  function normalizeBase(u) {
    let s = String(u || '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com/v1';
    // DeepSeek 余额接口在 /user/balance（api 域），不在 /v1 下；常见误配 www 域
    s = s.replace(/\/v1$/i, '');
    s = s.replace(/^https:\/\/www\.deepseek\.com/i, 'https://api.deepseek.com');
    s = s.replace(/^http:\/\/www\.deepseek\.com/i, 'https://api.deepseek.com');
    return s;
  }

  async function doNetRequest(args) {
    try {
      return await marcel.ipc.call('net.request', args);
    } catch (e) {
      const msg = String(e && e.message || e);
      // 兼容旧版 pluginIpc 的 net.request 路由 bug（missing request / unknown command / not authorized）
      if (msg.includes('missing required key') || msg.includes('unknown command') || msg.includes('not authorized')) {
        const tauriCore = window.__TAURI__ && window.__TAURI__.core;
        if (tauriCore && tauriCore.invoke) {
          marcel.log.warn('net.request fallback to direct invoke', msg.slice(0,120));
          return await tauriCore.invoke('plugin_http_request', { request: args });
        }
      }
      throw e;
    }
  }

  async function refresh(manual) {
    if (inFlight) return;
    try { await readConfig({}); } catch (_) { /* ignore */ }
    const key = (cfg.apiKey || '').trim();
    if (!key) { setState('config'); return; }
    inFlight = true;
    // 手动刷新/首次加载：立即进入 loading；自动刷新保持静默（不闪点）
    if (manual || lastBalance == null) {
      setState('loading');
      setHint('加载中…');
    }
    try {
      const rawBase = String(cfg.baseUrl || '').trim();
      const base = normalizeBase(rawBase);
      if (rawBase && base !== rawBase.replace(/\/+$/,'')) {
        marcel.log.info('normalizeBase:', rawBase, '->', base);
      }
      const url = base + '/user/balance';
      marcel.log.info('fetch balance', url, 'key', key.slice(0, 8) + '…');
      const res = await doNetRequest({
        url: url,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      });
      marcel.log.info('balance resp', res && res.status, String(res && res.body).slice(0, 400));
      if (!res || res.status < 200 || res.status >= 300 || !res.body) {
        const snippet = String(res && res.body).slice(0, 120);
        marcel.log.warn('balance http fail', res && res.status, snippet);
        // 401/403 鉴权失败直接显示 Key 无效；5xx/网络抖动沿用旧值
        if (res && (res.status === 401 || res.status === 403)) {
          setState('err');
          setHint('Key 无效(' + res.status + ')');
          root.title = '余额请求 ' + res.status + (snippet ? ': ' + snippet.slice(0,80) : '') + ' · 请检查 Key/URL';
        } else {
          setState(lastBalance != null ? 'stale' : 'err');
          if (lastBalance == null && res) setHint('HTTP ' + res.status);
        }
        return;
      }
      let data;
      try { data = JSON.parse(res.body); } catch (pe) {
        marcel.log.warn('balance json parse fail', String(pe), String(res.body).slice(0,200));
        setState(lastBalance != null ? 'stale' : 'err');
        if (lastBalance == null) setHint('返回非 JSON');
        return;
      }
      const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const info = infos[0];
      if (info && info.total_balance != null) {
        const val = parseFloat(info.total_balance);
        if (isNaN(val)) { setState(lastBalance != null ? 'stale' : 'err'); return; }
        const currency = info.currency || 'CNY';
        const changed = lastBalance !== null && (val !== lastBalance || currency !== lastCurrency);
        lastBalance = val;
        lastCurrency = currency;
        lastOkAt = Date.now();
        setState('ok');
        renderBalance(val, currency);
        if (changed || manual) {
          clearTimeout(changeTimer);
          setHint('加载中…');
          hintEl.removeAttribute('data-tier');
          changeTimer = setTimeout(function(){
            if (cfg.showWenfeng) applyWenfengDisplay(); else setHint('点击刷新');
          }, CHANGE_HINT_MS);
        } else {
          if (cfg.showWenfeng) applyWenfengDisplay(); else setHint('点击刷新');
        }
      } else {
        marcel.log.warn('balance shape unexpected', String(res.body).slice(0,300));
        setState(lastBalance != null ? 'stale' : 'err');
        if (lastBalance == null) setHint('结构异常');
      }
    } catch (e) {
      marcel.log.warn('balance fetch failed:', String(e));
      setState(lastBalance != null ? 'stale' : 'err');
      if (lastBalance == null) setHint('网络异常');
    } finally {
      inFlight = false;
    }
  }

  // ── 状态点 / 空态 / 提示行 ──
  function setState(st) {
    dot.className = 'mslb-dot';
    if (st === 'loading') dot.classList.add('loading');
    else if (st === 'ok') dot.classList.add('ok');
    else if (st === 'stale') dot.classList.add('stale');
    else dot.classList.add('err');

    emptyEl.style.display = 'none';
    amountEl.style.display = 'flex';

    if (st === 'config') {
      amountEl.style.display = 'none';
      emptyEl.style.display = 'block';
      emptyEl.textContent = '未配置 Key';
      setHint('设置→插件 配置 Key');
      hintEl.removeAttribute('data-tier');
      root.title = '大肥鱼余额 · 未配置 DeepSeek API Key，请到 设置→插件→大肥鱼余额 配置';
    } else if (st === 'err' && lastBalance == null) {
      amountEl.style.display = 'none';
      emptyEl.style.display = 'block';
      emptyEl.textContent = 'Key 无效';
      setHint('获取失败 · 点击重试');
      hintEl.removeAttribute('data-tier');
    } else if (st === 'stale') {
      setHint('同步失败，稍后自动重试');
      hintEl.removeAttribute('data-tier');
    } else if (st === 'ok') {
      if (cfg.showWenfeng) applyWenfengDisplay();
      else { setHint('点击刷新'); hintEl.removeAttribute('data-tier'); }
    } else if (st === 'loading') {
      hintEl.removeAttribute('data-tier');
    }

    if (st === 'stale' && lastBalance != null) {
      const t = lastOkAt ? new Date(lastOkAt).toLocaleTimeString() : '—';
      root.title = '大肥鱼余额 · 同步失败，沿用上次余额（' + t + '）· 60s 后自动重试';
    } else if (st === 'ok' && lastBalance != null && lastOkAt) {
      if (!cfg.showWenfeng) {
        root.title = '大肥鱼余额 · 已同步 ' + new Date(lastOkAt).toLocaleTimeString() + ' · 点击气泡刷新 · 长按鲸鱼拖拽 · 按 Q 捏一下';
      }
      // showWenfeng 时 title 已在 applyWenfengDisplay 中设置
    }
  }

  // ── 数字滚动动画（逐位槽式）──
  const CURRENCY_SYM = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const DIGITS = '0123456789';

  function makeDigitCell(ch) {
    const cell = document.createElement('span');
    cell.className = 'mslb-digit';
    const roll = document.createElement('span');
    roll.className = 'mslb-droll';
    for (let i = 0; i < DIGITS.length; i++) {
      const s = document.createElement('span');
      s.textContent = DIGITS[i];
      roll.appendChild(s);
    }
    cell.appendChild(roll);
    return { cell, roll };
  }

  function renderBalance(val, currency) {
    const fmt = val.toFixed(2);
    const sym = CURRENCY_SYM[currency] || (currency + ' ');
    const curEl = amountEl.firstElementChild;
    curEl.textContent = sym;
    curEl.className = 'mslb-currency';

    const oldChars = Array.from(digitsEl.children).map((el) => el.dataset.mch || '');
    const prevShown = oldChars.join('');
    const animate = hasEverRendered && prevShown !== fmt;
    hasEverRendered = true;

    const frag = document.createDocumentFragment();
    const len = fmt.length;
    for (let i = 0; i < len; i++) {
      const c = fmt[i];
      if (DIGITS.includes(c)) {
        const { cell, roll } = makeDigitCell(c);
        cell.dataset.mch = c;
        const prev = oldChars[i];
        const targetY = '-' + c + 'em';
        if (animate && DIGITS.includes(prev) && prev !== c) {
          roll.style.transition = 'none';
          roll.style.transform = 'translateY(-' + prev + 'em)';
          const delay = (len - 1 - i) * 26 + 'ms';
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              roll.style.transition = '';
              roll.style.transitionDelay = delay;
              roll.style.transform = 'translateY(' + targetY + ')';
            });
          });
        } else {
          roll.style.transform = 'translateY(' + targetY + ')';
          if (animate) roll.style.transitionDelay = (len - 1 - i) * 26 + 'ms';
        }
        frag.appendChild(cell);
      } else {
        const s = document.createElement('span');
        s.className = 'mslb-punct';
        s.textContent = c;
        s.dataset.mch = c;
        frag.appendChild(s);
      }
    }
    digitsEl.innerHTML = '';
    digitsEl.appendChild(frag);
  }

  function onBubbleClick() {
    refresh(true);
    resetTimer();
  }

  function resetTimer() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  // ── 拖拽 + 逐边吸附（拖拽中保持吸附形态，松手按落点重判翻转）──
  let drag = null;
  let pointerSquished = false;
  let keySquished = false;
  function refreshSquish() {
    if (!bodyEl) return;
    if (pointerSquished || keySquished) bodyEl.classList.add('mslb-squish');
    else bodyEl.classList.remove('mslb-squish');
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    pointerSquished = true; refreshSquish();
    if (e.target.closest('.mslb-bubble-hit')) return;
    e.preventDefault();
    const { x, y } = snapPosition();
    drag = { startX: e.clientX, startY: e.clientY, baseX: x, baseY: y, moved: false };
    root.dataset.mslbDragging = '1';
    root.dataset.mslbSnapAnim = '0';
    try { root.setPointerCapture(e.pointerId); } catch (_) { /* 部分环境不支持 */ }
  }

  function onPointerMove(e) {
    if (!drag) return;
    e.preventDefault();
    drag.moved = true;
    const { w, h } = widgetSize();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = drag.baseX + (e.clientX - drag.startX);
    let y = drag.baseY + (e.clientY - drag.startY);

    // 逐轴独立判定吸附（偏严格阈值）
    let sx = null, sy = null;
    if (x <= SNAP_THRESHOLD) sx = 'left';
    else if (x + w >= vw - SNAP_THRESHOLD) sx = 'right';
    if (y <= SNAP_THRESHOLD) sy = 'top';
    else if (y + h >= vh - SNAP_THRESHOLD) sy = 'bottom';

    cfg.snapX = sx;
    cfg.snapY = sy;
    cfg.x = sx ? null : clamp(x, 0, vw - w);
    cfg.y = sy ? null : clamp(y, 0, vh - h);

    const pos = snapPosition();
    root.style.left = pos.x + 'px';
    root.style.top = pos.y + 'px';
    // 拖拽中保持拖前翻转形态，不实时翻转
  }

  function onPointerUp(e) {
    // 按压回弹要与拖拽解耦：气泡点击也会 squish，必须在无 drag 时也能回弹
    if (pointerSquished) { pointerSquished = false; refreshSquish(); }
    if (!drag) return;
    try { root.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    drag = null;
    root.dataset.mslbDragging = '0';
    root.dataset.mslbSnapAnim = '1';
    const pos = snapPosition();
    root.style.left = pos.x + 'px';
    root.style.top = pos.y + 'px';
    updateMirror(); // 松手按落点重判镜像，带动画翻
    persist();
  }

  // ── 窗口尺寸变化 ──
  function onResize() {
    // 窗口还原/最大化时先清挤压态（拖拽态保留，由 pointerup 清理，避免切页/缩放时卡住）
    if (pointerSquished) { pointerSquished = false; refreshSquish(); }
    const { w, h } = widgetSize();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    if (cfg.snapX == null && cfg.x != null) cfg.x = clamp(cfg.x, 0, vw - w);
    if (cfg.snapY == null && cfg.y != null) cfg.y = clamp(cfg.y, 0, vh - h);
    applyPosition(false);
    updateMirror();
  }

  // ── 按压 Q 弹玩偶（body 整层，底部坐标不变；Q 键亦可触发）──
  function isEditable(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable;
  }

  // 兼容旧调用（保留空函数，实际走 pointerSquished/keySquished）
  function squish() { pointerSquished = true; refreshSquish(); }
  function unsquish() { pointerSquished = false; keySquished = false; refreshSquish(); }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.key.toLowerCase() !== 'q') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(document.activeElement)) return;
    if (!root.isConnected) return;
    keySquished = true; refreshSquish();
  }

  function onKeyUp(e) {
    if (e.key.toLowerCase() !== 'q') return;
    keySquished = false; refreshSquish();
  }

  function onBlur() {
    pointerSquished = false; keySquished = false; refreshSquish();
    if (drag) { drag = null; if (root) root.dataset.mslbDragging = '0'; }
  }

  function onPointerCancel(e) {
    if (pointerSquished) { pointerSquished = false; refreshSquish(); }
    if (!drag) return;
    try { root.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    drag = null;
    root.dataset.mslbDragging = '0';
    root.dataset.mslbSnapAnim = '0';
  }

  // ── 初始化 ──
  async function init() {
    try {
      await readConfig({});
      buildDom();
      root.style.setProperty('--msl-scale', String(cfg.scale));
      // 初始化定位前禁用过渡：root 刚挂载时还在左上角，带过渡会从左上滑到目标位；
      // 且过渡期间 updateMirror 会读到过渡前坐标（镜像判定已改用 style.left，此处纯防滑动）
      root.style.transition = 'none';
      applyPosition(false);
      updateMirror();
      root.style.transition = '';
      // 启动时布局可能尚未就绪（getBoundingClientRect 取到 0 会用 expectedSize 兜底），
      // 但真实尺寸在下一帧才稳定，双 rAF 再校正一次，确保小窗口/高分屏下不跑到屏外。
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!root || !root.isConnected) return;
        applyPosition(false);
        updateMirror();
      }));

      root.addEventListener('pointerdown', onPointerDown);
      root.addEventListener('pointermove', onPointerMove);
      root.addEventListener('pointerup', onPointerUp);
      root.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('resize', onResize);
      // 兜底：ResizeObserver + visualViewport + Tauri 窗口事件，防止还原/最大化时 resize 丢失
      try {
        const ro = new ResizeObserver(() => onResize());
        ro.observe(document.documentElement);
        marcel.onCleanup(() => ro.disconnect());
      } catch {}
      try {
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', onResize);
          marcel.onCleanup(() => window.visualViewport.removeEventListener('resize', onResize));
        }
      } catch {}
      try {
        const getWin = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow;
        if (getWin) {
          const win = getWin();
          if (win && win.onResized) win.onResized(() => onResize()).then(fn => marcel.onCleanup(fn)).catch(()=>{});
        }
      } catch {}
      // 定时兜底：若跑出视口，800ms 内拉回
      const visibilityInterval = setInterval(() => {
        if (!root || !root.isConnected) return;
        const r = root.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        if (r.width < 1 || r.left < -10 || r.top < -10 || r.left + r.width > vw + 10 || r.top + r.height > vh + 10) {
          onResize();
        }
      }, 800);
      marcel.onCleanup(() => clearInterval(visibilityInterval));
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onBlur);
      // 切页后 SPA 区域重建可能导致 overlay 短暂失联或挤压态残留，监听导航重校正
      try { navUnlisten = marcel.events.on('ui:nav-change', () => {
        if (!root || !root.isConnected) return;
        pointerSquished = false; refreshSquish();
        if (drag) { drag = null; root.dataset.mslbDragging = '0'; root.dataset.mslbSnapAnim = '0'; }
        applyPosition(false);
        updateMirror();
      }); } catch (_) { /* 旧版无此事件 */ }
      listenConfigEvents();

      setState('loading');
      await refresh(false);
      resetTimer();
      // 跨高峰/空闲整点自动切换文峰/文谷显示
      wenfengTimer = setInterval(function(){
        if (!cfg.showWenfeng || !dot || !dot.classList.contains('ok') || lastBalance == null) return;
        const cur = currentPricingTier();
        const prev = hintEl && hintEl.getAttribute('data-tier');
        if (prev !== cur) applyWenfengDisplay();
      }, 60*1000);

      marcel.log.info('widget ready, snap=', cfg.snapX, cfg.snapY, 'scale=', cfg.scale);

      marcel.onCleanup(() => {
        clearInterval(refreshTimer);
        clearInterval(wenfengTimer);
        clearTimeout(saveTimer);
        clearTimeout(changeTimer);
        root.removeEventListener('pointerdown', onPointerDown);
        root.removeEventListener('pointermove', onPointerMove);
        root.removeEventListener('pointerup', onPointerUp);
        root.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
        if (navUnlisten) { try { navUnlisten(); } catch (_) { /* ignore */ } }
        if (configUnlisten) { try { configUnlisten(); } catch (_) { /* ignore */ } }
      });
    } catch (e) {
      marcel.log.error('init failed:', String(e));
    }
  }

  init();
})();