/**
 * ZCode provider 卡片（keyed 槽 `settings.models.provider-card`）：把 Jet Hub 的 ZCode
 * 按键塞进官方「设置 → 模型 → 模型卡片 → **编辑卡片内部**」，与 `zcode-free` 那一行同级。
 * 六条不能改的约束：
 *  ① keyed 槽注册必须给 `key`（不是 `id`）；
 *  ② 全部 `llm-pi-ai` route 共用同一 settingsNs，本组件会被每张 pi-ai 卡片各渲染一次，
 *     判定「是不是 zcode」只能用 `props.provider.provider`，**不能**用 settingsNs；
 *  ③ RPC 方法名与 payload 逐字对齐 `jet-hub.js`（宿主见 src/jet-hub-rpc.ts），
 *     参数名写错不报 400，只会「查不到账号 / 领不到」；
 *  ④ **route 名与池里的 provider 名是两个东西**：卡片挂在官方 pi-ai 的声明式 route 上
 *     （`zcode-free`），而账号池 / RPC 的 provider 是旧直连 route `zcode`。用同一个常量
 *     判定会让卡片在官方模板里渲染成空。
 *  ⑤ **官方编辑卡片内部没有任何槽位**：`settings.models.provider-card` 只被
 *     `dsh-client-ui-settings-models` 的三处 renderSlot 消费（首配卡片 / 普通行卡片 /
 *     新增流程卡片），`ProviderEditor` 内部是纯官方渲染。且编辑态（`open = !addOpen &&
 *     editing?.provider === row.entry.provider`）在官方 state 里，**props 拿不到**。
 *     所以只能：槽里放一个不可见锚点 → MutationObserver 盯住同一个 `<li>` → 官方编辑卡片
 *     一出现，就用 `createPortal` 把账号 UI 送进它内部（紧跟 `…_editorHeader`）。
 *  ⑥ **默认一个 RPC 都不发**：账号 UI 只在编辑卡片打开时挂载，关掉即卸载；17 张 pi-ai
 *     卡片各渲染一次本组件，若在槽里就拉账号，用户只是想改 contextWindow 也会白发请求。
 *  ⑦ **用不上的字段要藏**：`zcode-free` 是声明式 route —— baseURL 指向插件自起的本地桥、
 *     密钥是占位串，两者都由 `src/pi-ai-mirror.ts` 每次加载时重写。用户在这里改了只会把桥
 *     打断；而官方 `ProviderEditor` 对 pi-ai 卡片是**无条件**渲染「API 密钥」与「API 地址」
 *     两个 field 的（没有任何 props 能关掉；官方自己的 DeepSeek 卡片没有它们，是因为
 *     `curatedFields` 整段被 `accountProvider` 短路了）。故只能标记 + CSS 隐藏。
 *
 * 为什么用 portal 而不是「在槽里渲染 + CSS 挪位置」：槽节点与编辑卡片是 `<li>` 下的**兄弟**
 * 节点，CSS 只能改绘制顺序，改不了父子层级，做不出「账号块在编辑卡片里面」。
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
const h = React.createElement; // 短别名控制行数，同 React.createElement
/** 账号池与 Jet Hub RPC 的 provider 名（旧直连 route，`src/zcode-product.ts` 的 `ZCODE.id`）。 */
const PROVIDER = 'zcode';
/** 本卡片认领的 pi-ai route：官方模板那条（`src/pi-ai-mirror.ts` 的 `MIRROR_ROUTE`）。
 *  同时收 `zcode`，这样 route 若改回直连名、或用户手工加回一条同名 route，卡片都还在。 */
const ROUTE_IDS = ['zcode-free', 'zcode'];
/** 官方编辑卡片根节点的类名片段（CSS Modules 哈希前缀每次构建都变，只能按 `_editor` 认）。 */
const EDITOR_RE = /(^|_)editor($|_)/;
/** `…_editorHeader` 的类名片段，用来把我方容器插到「ZCode（…）zcode-free」这一行正下方。 */
const EDITOR_HEADER_RE = /(^|_)editorHeader($|_)/;
/** field 标签的类名片段（官方 `…_fieldLabel`）。 */
const FIELD_LABEL_RE = /(^|_)fieldLabel($|_)/;
/** 我方 portal 容器在官方 DOM 上的标记，用来判断「已经插过没有」。 */
const MOUNT_ATTR = 'data-jet-hub-mount';
/** 官方编辑卡片里由本 route 自己维护、**不该给用户看**的字段标签（见文件头 ⑦）。
 *  ⚠ 按 label 文本判定而不是类名：官方类名是 CSS Modules 哈希（每次构建都变），按类名
 *  匹配下次官方升级就静默失效。中英两套都列，否则英文界面漏隐藏。 */
const HIDDEN_FIELD_LABELS = ['API 密钥', 'API key', 'API 地址', 'Base URL'];
/** 打在被隐藏字段上的标记；真正让它不可见的是 jet-hub-styles.js 里的同属性选择器。 */
const HIDDEN_ATTR = 'data-jet-hub-hidden';

/** 槽入口。⚠ 条件 return 必须在任何 hook **之前**：非 zcode 实例若走完 hooks 会凭空
 *  多发 RPC，而「先 return 再 use*」又违反 hooks 顺序规则，故渲染体拆成独立组件。 */
export function ZcodeProviderCard(props) {
  if (!ROUTE_IDS.includes(props?.provider?.provider)) return null;
  return h(ZcodeProviderCardHost, props);
}

/** 宿主：在槽里只放一个不可见锚点，真正的账号 UI 走 portal 进官方编辑卡片（见文件头 ⑤）。
 *  锚点是 React 自己管的节点，**永远不动它**，这样官方重渲染不会跟我们抢 DOM。 */
function ZcodeProviderCardHost(props) {
  const anchorRef = React.useRef(null);
  const [mount, setMount] = React.useState(null); // 官方编辑卡片里的 portal 容器

  React.useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;
    const row = anchor.closest('li') || anchor.parentElement;
    if (!row) return undefined;

    /** 在同一个 `<li>` 里找官方编辑卡片：不是锚点、且类名含 `_editor`。 */
    const findEditor = () => {
      for (const child of row.children) {
        if (child === anchor) continue;
        if (EDITOR_RE.test(String(child.className || ''))) return child;
      }
      return null;
    };

    /** 给「API 密钥」「API 地址」两个 field 打隐藏标记（见文件头 ⑦）。
     *  按 label 文本找，找不到就静默放过 —— 官方改结构时退化成「字段又出现」，
     *  而不是把整张卡片弄坏。 */
    const hideRedundantFields = (editor) => {
      for (const label of editor.querySelectorAll('span')) {
        if (!FIELD_LABEL_RE.test(String(label.className || ''))) continue;
        if (!HIDDEN_FIELD_LABELS.includes(String(label.textContent || '').trim())) continue;
        const field = label.parentElement;
        if (field && field !== editor) field.setAttribute(HIDDEN_ATTR, '');
      }
    };

    const sync = () => {
      const editor = findEditor();
      if (!editor) { setMount(null); return; }
      hideRedundantFields(editor);
      // 官方 React 可能整棵重建编辑卡片，故每次都按标记找一遍已存在的容器。
      const existing = editor.querySelector(`:scope > [${MOUNT_ATTR}]`);
      if (existing) { setMount(existing); return; }
      const box = document.createElement('div');
      box.setAttribute(MOUNT_ATTR, '');
      const header = [...editor.children].find((c) =>
        EDITOR_HEADER_RE.test(String(c.className || '')));
      if (header) header.after(box);       // 「ZCode（…）zcode-free」正下方 = 同级
      else editor.prepend(box);            // 兜底：卡片结构变了也还塞得进去
      setMount(box);
    };

    sync();
    // subtree:true 是为了官方重建卡片内部时也能把我们被删掉的容器补回来；
    // 我方插入发生在 editor 内部（不在 row 上），故不会自激；同一节点 setState 会被 React 跳过。
    const observer = new MutationObserver(sync);
    observer.observe(row, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const anchor = h('div', { ref: anchorRef, hidden: true, [MOUNT_ATTR + '-anchor']: '' });
  return h(React.Fragment, null, anchor,
    mount && typeof props.rpcCall === 'function'
      ? createPortal(h(ZcodeProviderCardBody, props), mount)
      : null);
}

/** token → `9.45M` / `945.39K`。规则同 jet-hub.js 的 formatTokens，但那边是模块私有且
 *  本次不得改它，故刻意复制一份。 */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}

/** 有效期：已过期 / 剩余时长 / 绝对时刻。 */
function formatExpiry(ts) {
  if (typeof ts !== 'number' || ts <= 0) return null;
  const diff = ts - Date.now();
  if (diff <= 0) return '已过期';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟后`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`;
  return new Date(ts).toLocaleString('zh-CN', { month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' });
}

/** 元信息行（有效期 / 额度共用）。⚠ 用 `dim-jh-zc*` 这一套类，**不要**复用
 *  设置页的 `dim-jh-metaRow` —— 那些类同时被 Jet Hub 设置页使用，改它们会连带改掉设置页。 */
const metaRow = (label, ddProps, ...content) =>
  h('div', { className: 'dim-jh-zcMetaRow' }, h('dt', null, label), h('dd', ddProps, ...content));

/** ZCode 免费额度通道的两张额度卡（与 `src/zcode-product.ts` 的 `ZCODE_FALLBACK_MODELS` 同序）。
 *  ⚠ 上游**只下发有额度的模型的桶**（实测本机账号只有 `GLM-5.3-Flash` 一个桶），故另一张卡
 *  必须由前端补占位行 —— 否则用户会以为「GLM-5.3 没额度了」而不是「这个模型没下发额度」。 */
const ZCODE_MODELS = ['GLM-5.3', 'GLM-5.3-Flash'];

/** 把 `balance.packages` 摊平成「每个模型一行」的展示数据。
 *
 *  为什么不能直接逐包渲染：包名来自上游 `show_name`，**只有有额度的模型才有包**。
 *  用户要的是「GLM-5.3 与 GLM-5.3-Flash 各自剩多少」，缺的那张必须显示成占位。
 *
 *  匹配按**最长命中**：`GLM-5.3-Flash` 的名字里含 `GLM-5.3`，若按「短名优先」会把
 *  Flash 的额度错算到 GLM-5.3 头上。故遍历时优先精确相等，其次取最长的包含关系。
 *  ⚠ 认不出来的包（上游改了名字 / 新增模型）**照样列出**（用包名当行名），不丢数据。 */
function modelBreakdown(balance) {
  const packages = balance?.packages || [];
  const used = new Set();
  const rows = [];
  // ① 先按**精确同名**认领；全部认领完再做包含匹配，避免顺序影响结果。
  for (const model of ZCODE_MODELS) {
    const index = packages.findIndex((p, i) => !used.has(i) && p?.name === model);
    if (index >= 0) used.add(index);
    rows.push({ model, index });
  }
  // ② 精确没认到的，按**最长模型名优先**做包含匹配（`GLM-5.3-Flash` 必须先于
  //    `GLM-5.3` 试，否则 Flash 的包会被短名抢走 —— 短名是它的前缀）。
  const ranked = [...ZCODE_MODELS].sort((a, b) => b.length - a.length);
  for (const model of ranked) {
    const row = rows.find(r => r.model === model);
    if (!row || row.index >= 0) continue;
    row.index = packages.findIndex((p, i) => !used.has(i)
      && typeof p?.name === 'string' && p.name.includes(model));
    if (row.index >= 0) used.add(row.index);
  }
  const result = rows.map(({ model, index }) => ({
    model,
    pack: index >= 0 ? packages[index] : undefined,
    missing: index < 0,
  }));
  // ③ 剩下的包（未识别的模型）逐条补上 —— 宁可多显示一行，也不静默丢额度。
  packages.forEach((pack, i) => {
    if (used.has(i)) return;
    result.push({ model: pack?.name || '其它额度', pack, missing: false });
  });
  return result;
}

/** 单行额度值：`99.88M`（token 用 K/M 缩写，其余按原值 + 单位）。 */
function formatAmount(pack) {
  if (!pack) return null;
  const isToken = pack.unit === 'token';
  const value = isToken ? formatTokens(pack.remaining) : null;
  return `${value ?? pack.remaining} ${isToken ? 'Token' : '积分'}`;
}

/** 号池汇总：把全部账号的包按模型名累加（折叠态右侧那行）。
 *  ⚠ 只统计**已取到的**额度；某账号查询失败时它不计入，但账号数仍照实显示 ——
 *  用户据「N 个账号」与总额度的对比就能看出有账号没查出来。 */
function poolTotals(accounts, credits) {
  const sums = new Map();
  for (const account of accounts) {
    const balance = credits[account.id]?.balance;
    if (!balance) continue;
    for (const { model, pack } of modelBreakdown(balance)) {
      if (!pack) continue;
      const isToken = pack.unit === 'token';
      if (!sums.has(model)) sums.set(model, { token: isToken, value: 0 });
      const entry = sums.get(model);
      if (entry.token === isToken && typeof pack.remaining === 'number') entry.value += pack.remaining;
    }
  }
  return [...sums.entries()].map(([model, { token, value }]) => {
    const text = token ? formatTokens(value) : String(value);
    // 卡片窄，模型名去掉 `GLM-5.3` 前缀只留区分度最高的部分（`Flash` / 空 = 主模型）。
    const short = model === 'GLM-5.3-Flash' ? 'Flash' : model.replace(/^GLM-/, '');
    return `${short} ${text ?? value}`;
  });
}

/** 单账号概览（展示：账号名 / 脱敏手机号 / 启用状态 / 有效期 / 逐模型额度 / 删除）。
 *  ⚠ 额度单位是 token（宿主 zcode 分支标 unit:'token'），不能按「积分」显示，否则用户把
 *  9 位数 token 当成 1 亿积分。样式规格对齐官方 .zGbnIq_modelEntry。 */
function ZcodeAccountRow({ account, entry, creditsLoading, busy, onDelete }) {
  const expired = account.expiresAt > 0 && account.expiresAt <= Date.now();
  // 账号名优先用凭据里的真实用户名（`user_info.displayName`），昵称多为占位串
  //（`zcode-xxxxxxxx` / `ZCode id:xxxxxx`），只作回退。
  const name = account.accountName || account.nickname || account.id;
  const rows = entry?.balance ? modelBreakdown(entry.balance) : [];
  const credit = creditsLoading && !entry
    ? metaRow('额度', { 'data-tone': 'muted' }, '查询中…')
    : !entry ? metaRow('额度', { 'data-tone': 'muted' }, '未查询')
      : entry.error ? metaRow('额度', { 'data-tone': 'warn' }, entry.error)
        : !entry.balance ? metaRow('额度', { 'data-tone': 'muted' }, '未查询到')
          : metaRow('额度', { className: 'dim-jh-zcCreditList' },
              rows.map(({ model, pack, missing }) => h('div', {
                key: model, className: 'dim-jh-zcCreditModel' },
                h('span', { className: 'dim-jh-zcCreditModelName' }, model),
                h('span', {
                  className: 'dim-jh-zcCreditModelValue',
                  'data-tone': missing ? 'muted' : undefined,
                  title: pack ? `共 ${pack.total} ${pack.unit === 'token' ? 'Token' : '积分'}`
                    : '上游未下发该模型的额度',
                }, missing ? '未下发' : formatAmount(pack)))));
  return h('div', { className: 'dim-jh-zcAccount' },
    h('div', { className: 'dim-jh-zcAccountTop' },
      h('span', { className: 'dim-jh-zcDot', 'data-on': account.enabled ? 'true' : 'false' }),
      h('span', { className: 'dim-jh-zcName', title: account.id }, name),
      account.phone ? h('span', { className: 'dim-jh-zcPhone' }, account.phone) : null,
      h('span', { className: 'dim-jh-zcTag' }, account.enabled ? '已启用' : '已停用')),
    h('dl', { className: 'dim-jh-zcMeta' },
      metaRow('有效期', { 'data-tone': expired ? 'warn' : undefined },
        formatExpiry(account.expiresAt) || '未知'),
      credit),
    // 删除：走既有 `account.delete`（宿主 src/jet-hub-rpc.ts 的 case 'account.delete'
    // → pool.removeAccount → ctx.credentials.unset）。二次确认在调用方做。
    h('div', { className: 'dim-jh-zcAccountActions' },
      h('button', {
        className: 'dim-jh-zcBtn', 'data-size': 'sm', type: 'button',
        disabled: busy !== null, onClick: () => onDelete(account),
      }, '删除')));
}

/** 操作结果提示。`notes` 是需要用户操作的条目。⚠ 由调用方渲染在**折叠区之外** —— 用户
 *  点完「一键领取」若顺手收起，失败原因不该跟着消失。 */
function noticeNode(notice) {
  if (!notice) return null;
  const notes = notice.notes || [];
  return h('div', { className: 'dim-jh-zcNotice', 'data-tone': notice.tone,
    role: notice.tone === 'ok' ? undefined : 'alert' },
    h('div', null, notice.text),
    notes.length > 0
      ? h('ul', null, notes.map((line, i) => h('li', { key: i }, line))) : null);
}

/** 渲染体。数据流同 jet-hub.js 的 ProviderPanel：挂载即拉账号；额度是另一次请求、独立
 *  loading —— 额度查询逐账号走网络、可能慢或失败，绝不能影响账号列表的可用性。
 *  ⚠ 本组件只在**官方编辑卡片打开时**才被挂载（宿主 portal 的时机），所以「挂载即拉」
 *  不再等于「进设置页就拉」——关掉编辑卡片即卸载，下次打开重新拉一次。 */
function ZcodeProviderCardBody({ rpcCall }) {
  const [accounts, setAccounts] = React.useState([]);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [credits, setCredits] = React.useState({});
  const [creditsLoading, setCreditsLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(null); // 三键共用，值为正在跑的键
  const [notice, setNotice] = React.useState(null);
  const [manualLoginUrl, setManualLoginUrl] = React.useState(null);
  const mounted = React.useRef(false);
  const call = React.useCallback((endpoint, payload) => rpcCall(endpoint, payload), [rpcCall]);
  /** 登录轮询的定时器（0 = 没在跑）。⚠ 必须能被**卸载清理**拿到 —— 见下面 useEffect。 */
  const pollRef = React.useRef(0);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // ⚠ 只置 mounted 标志是不够的（真实缺陷）：`createAccount` 的轮询在组件卸载后
      // 仍会每 1 秒发一次 `login.poll` 直到 5 分钟上限 —— 用户关掉编辑卡片就泄漏一串请求，
      // 且回调里的 setState 打在已卸载组件上。必须在这里真正停表。
      if (pollRef.current !== 0) { clearInterval(pollRef.current); pollRef.current = 0; }
    };
  }, []);

  const loadAccounts = React.useCallback(async () => {
    setPhase('loading'); setError(null);
    try {
      const res = await call('account.list', { provider: PROVIDER });
      if (!mounted.current) return;
      setAccounts(res?.accounts || []); setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || '无法读取账号列表'); setPhase('error');
    }
  }, [call]);

  // rpcCall 由槽的 inject 提供；缺失说明宿主侧没接上，此时不该发请求。
  React.useEffect(() => {
    if (typeof rpcCall !== 'function') return;
    void loadAccounts();
  }, [rpcCall, loadAccounts]);

  /** 账号列表就绪后**自动静默拉一次额度**。
   *
   *  为什么值得多发一次请求：折叠行右侧要显示号池两模型的**总额度**，而额度不是
   *  账号列表带的字段（`credits.balances` 是另一条链路）。若不自动拉，用户不点
   *  「刷新积分」就永远看不到那行数字 —— 而那正是用户明确要的展示。
   *
   *  ⚠ 约束 ⑥（「默认一个 RPC 都不发」）**没有被破坏**：本组件只在官方编辑卡片
   *  **打开时**才挂载（宿主 portal 的时机），关掉即卸载。所以这里的实际语义是
   *  「打开编辑卡片 = 发两条请求」，而不是「进设置页 = 发 17 组请求」。
   *
   *  ⚠ 依赖 `phase === 'ready'` 而不是直接跑：账号列表失败/为空时没有要查的账号，
   *  白发一次请求只会拖慢错误提示的呈现。 */
  React.useEffect(() => {
    if (phase !== 'ready' || accounts.length === 0) return;
    void refreshCredits(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, accounts.length]);

  /** 「刷新积分」：`credits.balances` 一次拿回本 provider 全部账号的额度。
   *
   *  ⚠ `silent` 用于**挂载时的自动拉取**：折叠态右侧要显示号池总额度，打开编辑卡片
   *  就得有数；但那次拉取不该弹「额度查询完成」的提示（用户没点任何按钮）。 */
  const refreshCredits = async (silent) => {
    if (!silent) { setBusy('refresh'); setNotice(null); }
    setCreditsLoading(true);
    try {
      const res = await call('credits.balances', { provider: PROVIDER });
      if (!mounted.current) return;
      const next = {};
      for (const item of res?.accounts || []) {
        next[item.accountId] = { balance: item.balance ?? null, error: item.error };
      }
      setCredits(next);
      if (silent) return;
      // 失败原因由每行 error 展示（凭据失效 / 企业版不下发数字等），这里只计数。
      const failed = Object.values(next).filter(v => v.error).length;
      setNotice(failed > 0
        ? { tone: 'warn', text: `额度查询完成，${failed} 个账号未取到。` }
        : { tone: 'ok', text: `额度查询完成（${Object.keys(next).length} 个账号）。` });
    } catch (caught) {
      if (!silent && mounted.current) {
        setNotice({ tone: 'error', text: caught?.message || '积分查询失败' });
      }
    } finally {
      if (mounted.current) setCreditsLoading(false);
      if (!silent) setBusy(null);
    }
  };

  /** 删除账号：二次确认后走既有 `account.delete`（同时清掉它的凭据与额度缓存）。 */
  const deleteAccount = async (account) => {
    const label = account.accountName || account.nickname || account.id;
    // ⚠ 用官方同款确认文案（旧 bundle 的 jet-hub.js 也是这句），说明凭据一并清除。
    if (!window.confirm(`确认删除账号「${label}」？关联的凭据也将被清除。`)) return;
    setBusy('delete'); setNotice(null);
    try {
      await call('account.delete', { accountId: account.id, provider: PROVIDER });
      if (!mounted.current) return;
      setCredits(prev => { const next = { ...prev }; delete next[account.id]; return next; });
      setNotice({ tone: 'ok', text: `已删除账号「${label}」。` });
      await loadAccounts();
    } catch (caught) {
      if (mounted.current) setNotice({ tone: 'error', text: caught?.message || '删除失败' });
    } finally { setBusy(null); }
  };

  /** 停表 + 收尾：清掉轮询句柄，并在**组件仍挂载**时给出结果提示、释放 busy。
   *  所有结束路径（成功 / 超时 / 卸载）都必须走这里，否则 busy 会永久卡住或句柄泄漏。 */
  const stopPoll = (result) => {
    if (pollRef.current !== 0) { clearInterval(pollRef.current); pollRef.current = 0; }
    if (!mounted.current) return;
    if (result) setNotice(result);
    setBusy(null);
  };

  /** 「添加账号」：同 jet-hub.js 的 createAccount。⚠ 登录页必须在新窗口打开，弹窗失败时
   *  只给手动链接 —— 回退 window.location.href 会把整个设置页导航走、登录完也回不来。
   *
   *  ⚠⚠ **`reused` 分支必判**：本机已有可用凭据时，后端**不新建条目、不返回 loginUrl**
   *  （用户报障「点了添加就多一个」的修复）。若只看 `loginUrl` 为空就报
   *  「后端未返回登录地址」，会把一次成功操作显示成失败。 */
  const createAccount = async () => {
    // ⚠ 已有一轮登录在跑时直接忽略（真实缺陷）：`busy` 曾在返回 loginUrl 后立刻清零，
    // 按钮随即恢复可点，再点一次会叠加第二个轮询 + 宿主再插一条占位账号。
    if (pollRef.current !== 0) return;
    setBusy('create'); setNotice(null);
    try {
      const res = await call('account.create', { provider: PROVIDER }) || {};
      if (!mounted.current) return;
      const { accountId, loginUrl, reused } = res;
      if (reused) {
        setManualLoginUrl(null);
        await loadAccounts();
        setNotice({ tone: 'ok', text: '已复用本机已有的账号凭据，未新建账号。' });
        return;
      }
      if (!loginUrl) {
        setNotice({ tone: 'error', text: '后端未返回登录地址（loginUrl 为空）。' });
        return;
      }
      const loginWindow = window.open(loginUrl, '_blank', 'width=800,height=600');
      if (!loginWindow || loginWindow.closed) setManualLoginUrl(loginUrl);
      // 轮询等登录完成；5 分钟后无条件停表。
      // ⚠ 超时**不用**另起的 setTimeout，而是记 deadline 在轮询里判：这样全场只有一个
      //   句柄（pollRef），卸载清理不会漏掉第二个定时器。
      const deadline = Date.now() + 300000;
      pollRef.current = setInterval(async () => {
        if (!mounted.current) { stopPoll(null); return; }
        if (Date.now() > deadline) {
          stopPoll({ tone: 'warn', text: '登录超时（5 分钟内未完成授权）。请重新点击「添加账号」。' });
          return;
        }
        try {
          const pollRes = await call('login.poll', { accountId, provider: PROVIDER });
          if (!mounted.current) return;
          if (!pollRes?.done) return;
          if (loginWindow && !loginWindow.closed) loginWindow.close();
          setManualLoginUrl(null);
          await loadAccounts();
          stopPoll({ tone: 'ok', text: '账号已添加。' });
        } catch { /* 网络抖动：继续轮询 */ }
      }, 1000);
    } catch (caught) {
      if (mounted.current) {
        setNotice({ tone: 'error', text: '新建账号失败：' + (caught?.message || '未知错误') });
      }
    } finally {
      // ⚠ 只在**没有**轮询在跑时释放 busy。登录未完成期间按钮必须保持禁用，
      // 否则用户再点一次就是上面那个「叠加第二个轮询 + 第二条占位账号」的缺陷。
      if (pollRef.current === 0) setBusy(null);
    }
  };

  /** 「一键领取积分」：`credits.claimAll`。⚠ 每个非零计数都要出现在提示里（照
   *  jet-hub.js）：只报 claimed / alreadyClaimed / failed 会让「暂无活动」的账号整条
   *  消失，用户看到的就是「什么都没发生」。 */
  const claimAll = async () => {
    setBusy('claim'); setNotice(null);
    try {
      const res = await call('credits.claimAll', { provider: PROVIDER });
      if (!mounted.current) return;
      const s = res?.summary || {}, bits = [];
      if (s.claimed > 0) {
        // ⚠ summary.totalCredit 恒为 0 是刻意的（宿主 src/zcode-auth.ts 的 toClaimOutcome：
        // ZCode 额度单位是 token 而非积分，填 0 以免伪装成积分）。故不能无条件渲染
        // `+${totalCredit}` —— 那会显示「+0 Token」，让明明领成功的用户以为白跑。
        const credit = s.totalCredit > 0 ? formatTokens(s.totalCredit) : null;
        bits.push(credit ? `已领 ${s.claimed} 个（+${credit}）` : `${s.claimed} 个已领取`);
      }
      if (s.alreadyClaimed > 0) bits.push(`${s.alreadyClaimed} 个今日已领`);
      if (s.inactive > 0) bits.push(`${s.inactive} 个暂无活动`);
      if (s.failed > 0) {
        const reason = (res?.results || []).map(i => i?.outcome?.message)
          .find(m => typeof m === 'string' && m);
        bits.push(`${s.failed} 个失败${reason ? `（${reason}）` : ''}`);
      }
      // 需用户操作的提示单独列；判据用后端显式字段 actionRequired，不要改成匹配文案
      //（改措辞就静默失效）。
      const notes = [];
      for (const item of res?.results || []) {
        const o = item?.outcome || {};
        if (o.actionRequired === true && typeof o.message === 'string' && o.message
          && !notes.includes(o.message)) notes.push(o.message);
      }
      setNotice({ tone: s.failed > 0 || notes.length > 0 ? 'warn' : 'ok',
        text: `一键领取：${bits.length > 0 ? bits.join('，') : '没有可领取的额度'}`, notes });
      await loadAccounts();
    } catch (caught) {
      if (mounted.current) setNotice({ tone: 'error', text: caught?.message || '领取失败' });
    } finally { setBusy(null); }
  };

  // 三键共用：任一键在跑、或 rpcCall 缺失时一律禁用。
  const disabled = busy !== null || typeof rpcCall !== 'function';
  const btn = (key, idle, running, onClick, extra) =>
    h('button', { className: 'dim-jh-zcBtn', disabled, onClick, ...extra },
      busy === key ? running : idle);

  /** 折叠行右侧：账号数 + **号池两模型总额度**（用户明确要求「右边应该显示号池两个
   *  模型的总额度」）。放这里而不是身体里，是为了**折叠态也能一眼看到**。
   *
   *  ⚠ 汇总只能由前端算：额度是 `credits.balances` 按账号给的，后端不提供「号池合计」
   *  这个语义（那是展示口径，不是业务数据）。 */
  const count = phase === 'loading' ? '读取中…'
    : phase === 'error' ? '读取失败'
      : `${accounts.length} 个账号`;
  const totals = poolTotals(accounts, credits);
  // 只在**真的**有额度时显示；查询中/失败时不显示，避免出现「Flash 0」这种误导数字
  //（0 是「已用光」的语义，而这里只是「还没查到」）。
  const poolLine = totals.length > 0 ? totals.join(' · ') : null;

  return h('div', null,
    // 分组折叠：结构与官方 `> 自定义设置` 完全一致（details > summary + body），
    // 上细线 + 12px/500 secondary 折叠行 + 5x5 旋转箭头，颜色全走官方令牌。
    // ⚠ 刻意**不传 open、也不监听 onToggle**：用原生 details 的非受控行为，默认折叠，
    //   箭头方向由 CSS `.dim-jh-zcSection[open] > .dim-jh-zcSummary::before` 负责。
    //   这样既不需要 state（少一次渲染），也不会碰上受控 details 在 React 里的同步怪癖。
    h('details', { className: 'dim-jh-zcSection' },
      h('summary', { className: 'dim-jh-zcSummary' },
        'ZCode 账号',
        h('span', { className: 'dim-jh-zcSummaryRight' },
          poolLine ? h('span', { className: 'dim-jh-zcPoolTotals',
            title: '号池各模型剩余额度合计' }, poolLine) : null,
          h('span', { className: 'dim-jh-zcCount' }, count))),
      h('div', { className: 'dim-jh-zcBody' },
        // 弹窗被拦截：只给可点击链接，不劫持当前页面。
        manualLoginUrl
          ? h('div', { className: 'dim-jh-zcNotice', 'data-tone': 'warn', role: 'alert' },
              h('div', null, '登录窗口未弹出，请点此链接完成登录：'),
              h('a', { className: 'dim-jh-zcLink', href: manualLoginUrl,
                target: '_blank', rel: 'noopener noreferrer' }, manualLoginUrl))
          : null,
        phase === 'loading'
          ? h('div', { className: 'dim-jh-zcEmpty' }, '正在读取账号列表…')
          : phase === 'error'
            ? h('div', { className: 'dim-jh-zcEmpty', role: 'alert' },
                h('p', null, error),
                h('button', { className: 'dim-jh-zcBtn', onClick: loadAccounts }, '重新读取'))
            : accounts.length === 0
              ? h('div', { className: 'dim-jh-zcEmpty' },
                  h('p', null, '尚未配置 ZCode 账号，点击「添加账号」进行浏览器登录。'))
              : h('div', { style: { display: 'grid', gap: 8 } }, accounts.map(account =>
                  h(ZcodeAccountRow, {
                    key: account.id, account, entry: credits[account.id], creditsLoading,
                    busy, onDelete: deleteAccount,
                  }))),
        h('div', { className: 'dim-jh-zcActions' },
          btn('create', '添加账号', '登录中…', createAccount),
          // ⚠ 必须包一层：`refreshCredits` 的第一个形参是 `silent`，直接把函数交给
          //   onClick 会把**事件对象**当 silent（真值）传进去 ⇒ 点按钮反而静默无提示。
          btn('refresh', '刷新积分', '查询中…', () => refreshCredits(false)),
          btn('claim', '一键领取积分', '领取中…', claimAll, { 'data-kind': 'primary' })))),
    // ⚠ 结果提示**刻意留在折叠区之外**：用户点完「一键领取」后若顺手收起，失败原因
    // 不该跟着消失（收起态下也要能看到上一次的结果）。
    noticeNode(notice));
}
