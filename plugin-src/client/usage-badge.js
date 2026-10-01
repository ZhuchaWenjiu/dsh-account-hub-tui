/**
 * 用量徽标 —— 会话输入区（模型选择器旁）那枚读数。
 *
 * ## 参考实现
 *
 * `dsh-cline-pass` v0.2.4（issue #15 的落地版）在 `conversation.input.right`
 * 插槽挂了一枚折叠徽标（`Pass · 5 小时 6% · 周 2%`），点击展开用量浮层。
 * 本组件沿用它的三条做法：**只在选中本插件渠道时渲染**、**60 秒轮询且隐藏页
 * 跳过**、**读取失败保留上一次成功读数**；在此基础上按 jet-hub 的多渠道与
 * 「签到领积分」的定位扩展成：订阅优先 / 积分兜底 + 逐账号明细 + 一键签到。
 *
 * ## 渲染门控（三道，全部在**发请求之前**）
 *
 * 1. 目录快照里必须有当前模型（`current.provider`）；没有就整体不渲染；
 * 2. 该 provider 必须在**能力表**里具备余额能力（`supportsCreditBalance`，
 *    12 个渠道全为真）—— 判定来自能力表而不是 `PROVIDERS.includes()`，
 *    与设置页同一真相源；
 * 3. 其余（有没有账号、账号是否启用）由宿主返回后决定显示成「未配置启用账号」，
 *    此时宿主**不会**产生任何上游请求（账号列表为空 ⇒ 余额分支空转）。
 *
 * 非本插件的模型（如 DeepSeek 官方）在第 2 道就被挡掉：**不渲染、不发请求**。
 *
 * ## 与设置页的分工
 *
 * 徽标只回答「现在还剩多少、要不要现在用」；账号增删改、模型开关、备份等仍在
 * Jet Hub 设置页。弹窗因此刻意做得很薄：读 + 刷新 + 签到 + 切换显示偏好。
 */

import * as React from 'react';

import { supportsCreditBalance, supportsDailyCheckin, checkinProviders } from './credits-capabilities.js';
import {
  badgeView,
  formatUpdatedAt,
  BADGE_PREFERENCES,
  BADGE_PREFERENCE_LABELS,
} from './badge-model.js';
import {
  quotaWindowsOf,
  quotaResetsIn,
  quotaTone,
  quotaPercentValue,
  formatQuotaPercent,
} from './quota-format.js';
import { formatUnits, unitLabel } from './credits-format.js';
import {
  formatExpirySplitLine,
  formatPoolSplitLine,
  splitCreditsByExpiry,
} from './credit-expiry.js';

/**
 * 轮询间隔：60 秒（参考实现同款）。
 *
 * ⚠️ 它与宿主侧 TTL 是**两层**：这里决定「多久问一次宿主」，宿主那边决定
 * 「多久问一次上游」。宿主默认 120s，故真实的账号余额请求最多每两分钟一轮。
 * 隐藏的标签页会被跳过（见下面的 `visibilityState` 判定）。
 */
export const BADGE_POLL_MS = 60_000;

/**
 * 徽标本体：只做门控，真正的工作在 {@link UsageBadgeActive}。
 *
 * ⚠️ 用 `useSyncExternalStore` 订阅模型目录（与参考实现同款）：目录快照变化
 * （用户切模型 / 切渠道）会立刻触发重渲染，徽标的 provider 随之更新。
 */
export function UsageBadge(props) {
  const directory = props.directory;
  const state = React.useSyncExternalStore(
    (onChange) => directory.subscribe(onChange),
    () => directory.getSnapshot(),
    () => directory.getSnapshot(),
  );
  const provider = state?.current?.provider;
  // 没有选中模型（新会话尚未选择 / 已寻址的 subagent 会话）→ 不渲染。
  if (typeof provider !== 'string' || provider.length === 0) return null;
  // 不是本插件的渠道 → 不渲染，且**不会**发任何请求。
  if (!supportsCreditBalance(provider)) return null;
  return React.createElement(UsageBadgeActive, { ...props, provider });
}

/** 展开态的完整实现（数据、轮询、弹窗）。 */
function UsageBadgeActive(props) {
  const { provider, providerLabel, readBadge, writePreference, claimCredits } = props;
  const label = providerLabel(provider);

  /** `{ value, at }`：宿主返回的读数 + **到达**本地的时刻（兜底显示用）。 */
  const [snapshot, setSnapshot] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  /** 本地偏好镜像：写入后立刻生效，不等待下一轮轮询（否则像「点了没反应」）。 */
  const [preference, setPreference] = React.useState(null);
  const [prefError, setPrefError] = React.useState('');
  /**
   * 领取状态。`claiming` 用**字符串**而不是布尔：
   * `'current'` = 只签当前渠道（单次请求）；`'all'` = 遍历全部支持签到的渠道
   * （串行多次请求，要显示 `done/total` 进度，否则用户以为卡住了）。
   */
  const [claiming, setClaiming] = React.useState(null);
  const [claimProgress, setClaimProgress] = React.useState(null);
  /** 领取结果：`{ tone, text, notes }`；`notes` 是**需要用户操作**的提示（后端显式字段）。 */
  const [claimNotice, setClaimNotice] = React.useState(null);
  const root = React.useRef(null);
  /** 供定时器与按钮调用的「读一次」入口（每次渲染替换，避免闭包过期）。 */
  const read = React.useRef(() => {});

  // 换渠道时先清空旧读数：否则会短暂把上一个渠道的余额画到新渠道的名字下。
  React.useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setClaimNotice(null);
    setPrefError('');
  }, [provider]);

  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    /**
     * 读一次。三种调用形态（**语义不同，不要合并**）：
     *
     * | 形态 | force | 隐藏页 | 用途 |
     * |---|---|---|---|
     * | `load()` | ✗ | **不跳过** | 挂载（含切渠道后）：走宿主缓存，**有缓存就立刻出数** |
     * | `load({ poll: true })` | ✗ | 跳过 | 60s 轮询与「切回前台」 |
     * | `load({ force: true })` | ✓ | 不跳过 | 用户点「刷新」/ 签到之后：必须拿最新 |
     *
     * ⚠️ 挂载时**不 force** 是用户报障的修复（2026-10-02「反应有点慢」）：
     * force 会绕过宿主 120s 缓存，于是每次挂载都要重新逐账号打上游（顺序
     * HTTP，几个账号就是几秒），首屏只能一直空着。走缓存后，同一渠道 120s 内
     * 的第二次挂载（切回来、新开会话）**立刻**出数。
     *
     * ⚠️ 挂载也不做「隐藏页跳过」：那是为**轮询**设计的节流，若挂载也跳过，
     * 后台标签页里新建的会话会一直停在「读取中…」。
     */
    const load = async (options = {}) => {
      if (inFlight) return;
      const force = options.force === true;
      // 隐藏的标签页跳过**轮询**（值不值得为一个没人看的数字保持请求）。
      if (options.poll === true && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      if (force) setBusy(true);
      try {
        const value = await readBadge(provider, force ? { force: true } : {});
        if (!alive) return;
        // 响应里带回了 provider：并发/切渠道时只认领属于自己的那一份读数。
        if (value?.provider !== undefined && value.provider !== provider) return;
        setSnapshot({ value, at: Date.now() });
        setFailed(false);
      } catch {
        // ⚠️ 保留上一次成功读数：一分钟前为真的数字，比一片空白有用得多。
        if (alive) setFailed(true);
      } finally {
        inFlight = false;
        if (alive && force) setBusy(false);
      }
    };
    read.current = () => { void load({ force: true }); };
    void load();
    const timer = setInterval(() => { void load({ poll: true }); }, BADGE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load({ poll: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      read.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [provider, readBadge]);

  // 点弹窗外面 / 按 Esc 关闭（仅在展开时挂监听）。
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const value = snapshot?.value;
  const effectivePreference = preference ?? value?.preference ?? 'auto';
  /**
   * 「首次读数还没到」与「首次读数就失败」都要**显式**告诉展示层。
   *
   * ⚠️ 不能靠「账号列表为空」推断：那会把「还没读到」显示成「未配置启用账号」
   *（用户报障，2026-10-02）。`snapshot === null` 才代表没有任何数据，
   * 有数据时刷新失败要保留旧数字（不降级成空态）。
   */
  const view = badgeView({
    providerLabel: label,
    preference: effectivePreference,
    subscription: value?.subscription,
    accounts: value?.accounts ?? [],
    loading: snapshot === null && !failed,
    failed: failed && snapshot === null,
  });

  /** 切换显示偏好：本地先生效，宿主写入失败时提示并回滚下一次渲染。 */
  const onPickPreference = async (next) => {
    setPreference(next);
    setPrefError('');
    try {
      await writePreference(next);
    } catch (error) {
      setPreference(null);
      setPrefError(error?.message || '偏好保存失败');
    }
  };

  /**
   * 一键签到 —— **只签当前渠道**（单次 `credits.claimAll({ provider })`）。
   *
   * 按钮只在能力表允许的渠道渲染（`supportsDailyCheckin`）。
   */
  const onClaim = async () => {
    setClaiming('current');
    setClaimNotice(null);
    try {
      const result = await claimCredits(provider);
      setClaimNotice(summarizeClaim(result));
      // 签到会改变余额 → 立刻强制重读（否则要等下一轮轮询才看到新数字）。
      read.current();
    } catch (error) {
      setClaimNotice({ tone: 'warn', text: error?.message || '签到失败', notes: [] });
    } finally {
      setClaiming(null);
    }
  };

  /**
   * 签到**所有支持签到的渠道**（用户 2026-10-02 要求放进弹窗）。
   *
   * 与 Jet Hub 设置页页头那个「一键签到」**同一套语义**（见 `jet-hub.js` 的
   * `checkinAll`），差别只是结果渲染成弹窗里的紧凑版：
   *
   * - **必须串行** `await`，不能 `Promise.all`：这是**真实领积分**的写操作，
   *   跨渠道并发会同时发出多路领取请求，触发风控的代价是用户当天领不到
   *  （单渠道内部本就是「逐账号顺序执行」，见 `src/jet-hub-rpc.ts`）。
   * - 渠道集合由能力表推导（`checkinProviders()`）：WorkBuddy 国际版 / Cline /
   *   Raccoon 后端没有签到接口，**绝不能**出现在请求列表里。
   * - 单渠道失败只计入失败数，**不中断后续渠道**。
   * - 每个**非零**计数都要出现在结果里（否则「暂无活动」的渠道会整条消失，
   *   用户以为它没执行）；一个渠道可能同时有成功与失败，不用 else-if 短路。
   * - `actionRequired` 的提示单独列出（后端显式字段，不靠文案匹配）。
   */
  const onClaimAll = async () => {
    const providers = checkinProviders();
    setClaiming('all');
    setClaimNotice(null);
    setClaimProgress({ done: 0, total: providers.length });
    const parts = [];
    const notes = [];
    let totalCredit = 0;
    let failed = 0;
    for (let index = 0; index < providers.length; index += 1) {
      const id = providers[index];
      try {
        const result = await claimCredits(id);
        const summary = result?.summary || {};
        const bits = [];
        if (summary.claimed > 0) {
          totalCredit += Number(summary.totalCredit) || 0;
          bits.push(`+${Math.round(Number(summary.totalCredit) || 0)}`);
        }
        if (summary.alreadyClaimed > 0) bits.push(`${summary.alreadyClaimed} 个今日已领`);
        if (summary.inactive > 0) bits.push(`${summary.inactive} 个暂无活动`);
        if (summary.failed > 0) {
          failed += summary.failed;
          const reason = (result?.results || [])
            .map((item) => item?.outcome?.message)
            .find((message) => typeof message === 'string' && message.length > 0);
          bits.push(`${summary.failed} 个失败${reason ? `（${reason}）` : ''}`);
        }
        parts.push(`${providerLabel(id)} ${bits.length > 0 ? bits.join('，') : '无账号'}`);
        for (const item of result?.results || []) {
          const outcome = item?.outcome || {};
          if (outcome.actionRequired !== true) continue;
          const message = outcome.message;
          if (typeof message !== 'string' || message.length === 0) continue;
          if (!notes.includes(message)) notes.push(message);
        }
      } catch (error) {
        failed += 1;
        parts.push(`${providerLabel(id)} 失败（${error?.message || '未知原因'}）`);
      }
      setClaimProgress({ done: index + 1, total: providers.length });
    }
    setClaimNotice({
      tone: failed > 0 || notes.length > 0 ? 'warn' : 'ok',
      text: parts.length > 0
        ? `全部渠道：${parts.join('；')}${totalCredit > 0 ? `（共 +${Math.round(totalCredit)} 积分）` : ''}`
        : '全部渠道：没有可领取的渠道',
      notes,
    });
    setClaimProgress(null);
    setClaiming(null);
    read.current();
  };

  const tone = failed && snapshot === null ? 'error' : view.tone;
  const title = view.failureReason === '' ? view.text : `${view.text}\n${view.failureReason}`;

  return React.createElement('div', { className: 'dim-jh-badge', ref: root }, [
    React.createElement('button', {
      key: 'btn',
      type: 'button',
      className: 'dim-jh-badgeBtn',
      'aria-expanded': open,
      'aria-label': `${label} 用量：${view.text}`,
      title,
      onClick: () => setOpen((was) => !was),
    }, [
      React.createElement('span', { key: 'dot', className: 'dim-jh-badgeDot', 'data-tone': tone }),
      React.createElement('span', { key: 'text', className: 'dim-jh-badgeText' }, view.text),
    ]),
    open ? renderPopover() : null,
  ]);

  /**
   * 弹窗内容。
   *
   * ## 布局取舍（用户 2026-10-02：「小巧、美观，但信息不能缺失」）
   *
   * 全部信息都在，但把**行数**压到最少：
   * - 头部一行：色调圆点 + 渠道名 + 更新时间（含「缓存」标记）+ 图标刷新按钮；
   * - 偏好做成分段控件（三个标签自带含义，故不再单占一行写「显示偏好」）；
   * - 节标题右侧直接带合计（省掉「合计…」那一行）；
   * - 每个账号一行：名字左、数值右，分桶/资源包说明作为**灰色小字**跟在后面
   *   （存在时才换到第二行，不存在就是单行）；
   * - 窗口两行：`名称 … 重置倒计时` / `进度条 + 百分比`；
   * - 两个签到按钮并排一行，结果摘要与「需要你操作」的提示在下方。
   */
  function renderPopover() {
    // `formatUpdatedAt` 对缺失时刻返回空串（不显示 1970），故这里也要处理空值。
    const stamp = snapshot === null ? '' : formatUpdatedAt(value?.generatedAt ?? snapshot.at);
    const children = [
      React.createElement('div', { key: 'head', className: 'dim-jh-badgeHead' }, [
        React.createElement('span', { key: 'dot', className: 'dim-jh-badgeDot', 'data-tone': tone }),
        React.createElement('span', { key: 'title', className: 'dim-jh-badgeTitle' }, label),
        React.createElement('span', { key: 'at', className: 'dim-jh-badgeAt' },
          snapshot === null
            ? '读取中…'
            : `${stamp === '' ? '已读取' : stamp}${value?.cached === true ? ' · 缓存' : ''}`),
        React.createElement('button', {
          key: 'refresh',
          type: 'button',
          className: 'dim-jh-badgeRefresh',
          disabled: busy,
          title: '刷新（绕过宿主缓存）',
          'aria-label': '刷新用量',
          onClick: () => read.current(),
        }, busy ? '…' : '↻'),
      ]),
      renderPreference(),
    ];

    // 首屏：读数未到 / 首次就失败 —— 说明白，但**不**渲染会说出
    // 「该渠道还没有账号」的明细区（用户报障：那是把「还没读到」说成「没有账号」）。
    if (snapshot === null) {
      children.push(React.createElement('div', {
        key: 'placeholder',
        className: failed ? 'dim-jh-badgeFail' : 'dim-jh-badgeNote',
        role: failed ? 'alert' : undefined,
      }, failed
        ? '用量不可用，可点右上角 ↻ 重试'
        : '正在读取用量…（首次要逐账号查询，可能要几秒）'));
      // 签到不依赖本渠道的读数，故首屏也放出来（用户可能就是想先签到）。
      children.push(renderClaim());
      return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
    }

    children.push(renderSubscription());
    children.push(renderCredits());
    children.push(renderClaim());
    children.push(renderFoot());
    return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
  }

  /**
   * 显示偏好：分段控件（本仓库无 `<select>` 先例，故用按钮组 + `aria-pressed`）。
   *
   * 不再单占一行写「显示偏好」：三个标签（自动 / 优先订阅 / 优先积分）自带含义，
   * 容器的 title 里给出完整解释 —— 省一行而信息不丢。
   */
  function renderPreference() {
    return React.createElement('div', {
      key: 'pref',
      className: 'dim-jh-badgePref',
      title: '显示偏好：决定徽标优先显示订阅还是积分（「优先积分」也是套餐判定不准时的兜底）',
    }, [
      ...BADGE_PREFERENCES.map((item) => React.createElement('button', {
        key: item,
        type: 'button',
        className: 'dim-jh-badgePrefBtn',
        'aria-pressed': effectivePreference === item,
        onClick: () => { void onPickPreference(item); },
      }, BADGE_PREFERENCE_LABELS[item])),
      prefError === '' ? null : React.createElement('span', { key: 'err', className: 'dim-jh-badgeFail' }, prefError),
    ]);
  }

  /** 订阅区：窗口（Cline）或套餐包（Qoder / ZCode / 两个 buddy）。 */
  function renderSubscription() {
    const subscription = value?.subscription;
    if (subscription === undefined) return null;
    if (subscription.kind === 'windows') {
      const rows = Array.isArray(subscription.accounts) ? subscription.accounts : [];
      const account = rows.find((row) => row?.ok === true) ?? rows[0];
      const windows = account === undefined ? [] : quotaWindowsOf(account.windows ?? []);
      return React.createElement('div', { key: 'sub', className: 'dim-jh-badgeSection' }, [
        React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, '订阅额度'),
        ...(windows.length === 0
          ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' },
            account?.ok === true ? '该账号没有额度窗口' : (account?.error || '订阅额度不可用'))]
          : windows.map(([type, windowLabel, win]) => {
            const percent = quotaPercentValue(win?.percentUsed);
            const left = quotaResetsIn(win?.resetsAt);
            return React.createElement('div', { key: type, className: 'dim-jh-badgeWin' }, [
              // 第一行：名称 + 重置倒计时（倒计时缺失就只留名称）
              React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
                React.createElement('span', { key: 'l' }, windowLabel),
                left === '' ? null : React.createElement('span', { key: 'r', className: 'dim-jh-badgeNote' }, left),
              ]),
              // 第二行：进度条 + 百分比（同一行放得下，省掉单独一行百分比）
              React.createElement('div', { key: 'track', className: 'dim-jh-badgeWinTrack' }, [
                React.createElement('div', { key: 'bar', className: 'dim-jh-quotaBar' },
                  React.createElement('div', {
                    key: 'fill',
                    className: 'dim-jh-quotaBarFill',
                    'data-tone': quotaTone(percent),
                    style: { width: `${percent}%` },
                  })),
                React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' }, formatQuotaPercent(percent)),
              ]),
            ]);
          })),
      ]);
    }

    const groups = view.planGroups;
    return React.createElement('div', { key: 'sub', className: 'dim-jh-badgeSection' }, [
      React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, '订阅套餐'),
      ...(groups.length === 0
        ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' }, '没有可用的套餐包')]
        : groups.map((group) => React.createElement('div', {
          key: `${group.name}\u0000${group.unit}`,
          className: 'dim-jh-badgeRow',
        }, [
          React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
            React.createElement('span', { key: 'l', className: 'dim-jh-badgeRowName', title: group.name }, group.name),
            React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' },
              `${formatUnits(group.remaining, group.unit) ?? '?'} / ${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`),
          ]),
          React.createElement('div', { key: 'note', className: 'dim-jh-badgeRowNote' },
            [
              group.accountCount > 1 ? `${group.accountCount} 个账号合计` : null,
              group.deductionEndTime === undefined ? null : `扣费截止 ${formatUpdatedAt(group.deductionEndTime)}`,
            ].filter(Boolean).join(' · ')),
        ]))),
    ]);
  }

  /** 积分区：逐账号余额（含失败原因与分桶文案）。 */
  function renderCredits() {
    const accounts = value?.accounts ?? [];
    const windowDays = value?.windowDays;
    const sum = view.groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`).join(' · ');
    return React.createElement('div', { key: 'credits', className: 'dim-jh-badgeSection' }, [
      // 合计放进节标题右侧，省掉一整行
      React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' }, [
        React.createElement('span', { key: 'l' }, '积分'),
        accounts.length === 0 || sum === ''
          ? null
          : React.createElement('span', { key: 'sum', className: 'dim-jh-badgeSectionSum' }, `合计 ${sum}`),
      ]),
      ...(accounts.length === 0
        ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' },
          value?.disabledCount > 0 ? '该渠道的账号全部已停用' : '该渠道还没有账号（可在 Jet Hub 设置页添加）')]
        : accounts.map((row) => React.createElement('div', { key: row.accountId, className: 'dim-jh-badgeRow' }, [
          React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
            React.createElement('span', {
              key: 'l',
              className: 'dim-jh-badgeRowName',
              title: row.nickname || row.accountId,
            }, row.nickname || row.accountId),
            React.createElement('span', {
              key: 'v',
              className: 'dim-jh-badgeValue',
              'data-tone': row.balance === null ? 'warn' : 'ok',
              title: row.error || undefined,
            }, row.balance === null ? (row.error || '查询失败') : balanceLine(row.balance)),
          ]),
          // 分桶/资源包说明：灰色小字，存在时才占一行
          row.balance === null
            ? null
            : renderNote(splitLine(row.balance, windowDays, provider)),
        ]))),
    ]);
  }

  /** 一行灰色小字；空串返回 `null`（不占位）。 */
  function renderNote(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    return React.createElement('div', { key: 'note', className: 'dim-jh-badgeRowNote' }, text);
  }

  /**
   * 签到：两个按钮并排（**都放在弹窗里**，用户 2026-10-02 选 B）。
   *
   * - `签到（仅 <渠道>）`：只在能力表允许的渠道渲染（`supportsDailyCheckin`）；
   * - `全部渠道签到`：与设置页页头同款语义，串行遍历 `checkinProviders()`
   *   （WorkBuddy 国际版 / Cline / Raccoon 没有签到接口，不在列表里）。
   *   它**不依赖本渠道的读数**，故首屏/失败态也渲染。
   */
  function renderClaim() {
    const canClaimCurrent = supportsDailyCheckin(provider);
    const allBusy = claiming === 'all';
    return React.createElement('div', { key: 'claim', className: 'dim-jh-badgeSection dim-jh-badgeClaim' }, [
      React.createElement('div', { key: 'row', className: 'dim-jh-badgeClaimRow' }, [
        canClaimCurrent
          ? React.createElement('button', {
            key: 'cur',
            type: 'button',
            className: 'dim-jh-badgeAction',
            disabled: claiming !== null,
            // ⚠️ 按钮文案**不写渠道名**：`签到（仅 CodeBuddy (腾讯)）` 在 300px 弹窗里
            // 会被 text-overflow 截成 `签到（仅 CodeBuddy (…`（截图核验发现）。渠道名
            // 已经在弹窗头部与 title 里，按钮只要说清「范围＝本渠道」即可。
            title: `只签到当前渠道（${label}）的全部账号`,
            onClick: () => { void onClaim(); },
          }, claiming === 'current' ? '领取中…' : '签到（本渠道）')
          : null,
        React.createElement('button', {
          key: 'all',
          type: 'button',
          className: 'dim-jh-badgeAction',
          disabled: claiming !== null,
          title: '串行签到全部支持签到的渠道（9 个；WorkBuddy 国际版 / Cline / Raccoon 后端没有签到接口）',
          onClick: () => { void onClaimAll(); },
        }, allBusy
          ? (claimProgress === null ? '签到中…' : `签到中 ${claimProgress.done}/${claimProgress.total}…`)
          : '全部渠道签到'),
      ]),
      claimNotice === null
        ? null
        : React.createElement('div', {
          key: 'notice',
          className: 'dim-jh-badgeNotice',
          'data-tone': claimNotice.tone,
        }, claimNotice.text),
      // 「需要用户操作」的提示单独列出（后端显式字段 actionRequired），
      // 混进计数行会被读漏，而它的价值就在于被看到。
      ...(claimNotice?.notes || []).map((message, index) => React.createElement('div', {
        key: `note-${index}`,
        className: 'dim-jh-badgeNotice',
        'data-tone': 'warn',
      }, message)),
    ]);
  }

  /** 脚注：停用账号数、失败账号数与「显示的是旧读数」提示。 */
  function renderFoot() {
    const parts = [];
    if (value?.disabledCount > 0) parts.push(`另有 ${value.disabledCount} 个账号已停用，未计入`);
    if (view.failedCount > 0) parts.push(`${view.failedCount} 个账号读取失败`);
    if (failed && snapshot !== null) parts.push('本次刷新失败，显示的是上一次读数');
    if (parts.length === 0) return null;
    return React.createElement('div', { key: 'foot', className: 'dim-jh-badgeFoot' }, parts.join(' · '));
  }
}

/** 一个账号的余额行（数值 + 单位）。 */
function balanceLine(balance) {
  const unit = (balance.packages || []).find((pkg) => pkg && pkg.unit)?.unit;
  const text = formatUnits(balance.total, unit) ?? '0';
  return `${text} ${unitLabel(unit)}`;
}

/**
 * 分桶文案（当日池优先，其次按到期分桶）。
 *
 * ⚠️ 与设置页账号卡片**同一套口径、同一批函数**（`credit-expiry.js`）：
 * 两处若各算各的，用户会看到「卡片说临时 55、徽标说长期 55」这种无法解释的偏差。
 * `now` 在渲染这一刻现取 —— 分桶是时间的函数，缓存它会让越线的包继续算长期。
 */
function splitLine(balance, windowDays, provider) {
  const packages = balance.packages || [];
  const unit = packages.find((pkg) => pkg && pkg.unit)?.unit;
  const format = (value) => formatUnits(value, unit);
  const poolText = formatPoolSplitLine(packages, format, provider === 'loomy' ? '永久' : '长期');
  if (poolText !== null) return poolText;
  const expiryText = formatExpirySplitLine(splitCreditsByExpiry(packages, windowDays, Date.now()), format);
  return expiryText ?? '';
}

/**
 * 单渠道签到结果 → `{ tone, text, notes }`。
 *
 * 宿主返回的是 `{ results, summary }`（逐账号四态 `ClaimOutcome` + 汇总），
 * 这里按用户最关心的顺序给一句话：本次领到多少 → 已领过几个 → 活动未开启 → 几个失败。
 *
 * ⚠️ **每个非零计数都要出现**：早期只判 claimed / alreadyClaimed / failed，
 * 于是「活动未开启」（`inactive > 0`）整条消失，用户以为那个渠道没执行。
 * ⚠️ 幂等判据在各渠道的响应体里（不是 HTTP 状态码），故「已领过」是**成功**语义，
 * 不能与失败混为一谈。
 */
function summarizeClaim(result) {
  const summary = result?.summary;
  if (summary === undefined) return { tone: 'ok', text: '签到完成', notes: [] };
  const parts = [];
  if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功，共 +${Math.round(Number(summary.totalCredit) || 0)} 积分`);
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
  if (summary.failed > 0) {
    const reason = (result.results || []).find((row) => row?.outcome?.kind === 'failed')?.outcome?.message;
    parts.push(`${summary.failed} 个失败${reason ? `：${reason}` : ''}`);
  }
  const notes = (result?.results || [])
    .map((row) => row?.outcome)
    .filter((outcome) => outcome?.actionRequired === true && typeof outcome.message === 'string' && outcome.message.length > 0)
    .map((outcome) => outcome.message)
    .filter((message, index, all) => all.indexOf(message) === index);
  return {
    tone: summary.failed > 0 || notes.length > 0 ? 'warn' : 'ok',
    text: parts.length === 0 ? '签到完成（无可领取的账号）' : parts.join('；'),
    notes,
  };
}
