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

import { supportsCreditBalance, supportsDailyCheckin } from './credits-capabilities.js';
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
  const [claiming, setClaiming] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const root = React.useRef(null);
  /** 供定时器与按钮调用的「读一次」入口（每次渲染替换，避免闭包过期）。 */
  const read = React.useRef(() => {});

  // 换渠道时先清空旧读数：否则会短暂把上一个渠道的余额画到新渠道的名字下。
  React.useEffect(() => {
    setSnapshot(null);
    setFailed(false);
    setNotice('');
    setPrefError('');
  }, [provider]);

  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    /**
     * 读一次。`manual === true` = 用户点刷新/签到后：**绕过宿主 TTL**，
     * 并显示按钮忙碌态（自动轮询不显示，避免界面每分钟闪一下）。
     */
    const load = async (manual) => {
      if (inFlight) return;
      // 隐藏的标签页跳过轮询（值不值得为一个没人看的数字保持请求）。
      if (manual !== true && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      if (manual === true) setBusy(true);
      try {
        const value = await readBadge(provider, manual === true ? { force: true } : {});
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
        if (alive && manual === true) setBusy(false);
      }
    };
    read.current = () => { void load(true); };
    void load(true);
    const timer = setInterval(() => { void load(false); }, BADGE_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(false); };
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
  const view = badgeView({
    providerLabel: label,
    preference: effectivePreference,
    subscription: value?.subscription,
    accounts: value?.accounts ?? [],
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

  /** 一键签到（仅能力表允许的渠道渲染按钮）。 */
  const onClaim = async () => {
    setClaiming(true);
    setNotice('');
    try {
      const result = await claimCredits(provider);
      setNotice(describeClaim(result));
      // 签到会改变余额 → 立刻强制重读（否则要等下一轮轮询才看到新数字）。
      read.current();
    } catch (error) {
      setNotice(error?.message || '签到失败');
    } finally {
      setClaiming(false);
    }
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

  /** 弹窗内容（订阅区 → 积分区 → 签到 → 脚注）。 */
  function renderPopover() {
    // `formatUpdatedAt` 对缺失时刻返回空串（不显示 1970），故这里也要处理空值。
    const stamp = snapshot === null ? '' : formatUpdatedAt(value?.generatedAt ?? snapshot.at);
    const children = [
      React.createElement('div', { key: 'head', className: 'dim-jh-badgeHead' }, [
        React.createElement('span', { key: 'title', className: 'dim-jh-badgeTitle' }, `${label} 用量`),
        React.createElement('span', { key: 'at', className: 'dim-jh-badgeAt' },
          snapshot === null
            ? '读取中…'
            : `${stamp === '' ? '已读取' : `更新于 ${stamp}`}${value?.cached === true ? '（缓存）' : ''}`),
        React.createElement('button', {
          key: 'refresh',
          type: 'button',
          className: 'dim-jh-badgeAction',
          disabled: busy,
          onClick: () => read.current(),
        }, busy ? '刷新中…' : '刷新'),
      ]),
      renderPreference(),
    ];

    if (failed && snapshot === null) {
      children.push(React.createElement('div', { key: 'fail', className: 'dim-jh-badgeFail', role: 'alert' },
        '用量不可用（可点「刷新」重试）'));
      return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
    }

    children.push(renderSubscription());
    children.push(renderCredits());
    if (supportsDailyCheckin(provider)) children.push(renderClaim());
    children.push(renderFoot());
    return React.createElement('div', { className: 'dim-jh-badgePop' }, children);
  }

  /** 显示偏好三态开关（分段按钮；本仓库无 `<select>` 先例，故用按钮组）。 */
  function renderPreference() {
    return React.createElement('div', { key: 'pref', className: 'dim-jh-badgePref' }, [
      React.createElement('span', { key: 'label', className: 'dim-jh-badgeNote' }, '显示偏好'),
      ...BADGE_PREFERENCES.map((item) => React.createElement('button', {
        key: item,
        type: 'button',
        className: 'dim-jh-badgePrefBtn',
        'aria-pressed': effectivePreference === item,
        title: item === 'credits' ? '始终显示积分（套餐判定不准时用这个）' : undefined,
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
            return React.createElement('div', { key: type, className: 'dim-jh-badgeRow' }, [
              React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
                React.createElement('span', { key: 'l' }, windowLabel),
                React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' }, formatQuotaPercent(percent)),
              ]),
              React.createElement('div', { key: 'track', className: 'dim-jh-quotaBar' },
                React.createElement('div', {
                  key: 'fill',
                  className: 'dim-jh-quotaBarFill',
                  'data-tone': quotaTone(percent),
                  style: { width: `${percent}%` },
                })),
              left === '' ? null : React.createElement('div', { key: 'note', className: 'dim-jh-badgeNote' }, left),
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
            React.createElement('span', { key: 'l' }, group.name),
            React.createElement('span', { key: 'v', className: 'dim-jh-badgeValue' },
              `${formatUnits(group.remaining, group.unit) ?? '?'} / ${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`),
          ]),
          React.createElement('div', { key: 'note', className: 'dim-jh-badgeNote' },
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
    return React.createElement('div', { key: 'credits', className: 'dim-jh-badgeSection' }, [
      React.createElement('div', { key: 'title', className: 'dim-jh-badgeSectionTitle' },
        accounts.length === 0 ? '积分' : `积分（启用账号合计 ${view.groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`).join(' · ') || '—'}）`),
      ...(accounts.length === 0
        ? [React.createElement('div', { key: 'empty', className: 'dim-jh-badgeNote' },
          value?.disabledCount > 0 ? '该渠道的账号全部已停用' : '该渠道还没有账号（可在 Jet Hub 设置页添加）')]
        : accounts.map((row) => React.createElement('div', { key: row.accountId, className: 'dim-jh-badgeRow' }, [
          React.createElement('div', { key: 'head', className: 'dim-jh-badgeRowHead' }, [
            React.createElement('span', { key: 'l' }, row.nickname || row.accountId),
            React.createElement('span', {
              key: 'v',
              className: 'dim-jh-badgeValue',
              'data-tone': row.balance === null ? 'warn' : 'ok',
              title: row.error || undefined,
            }, row.balance === null ? (row.error || '查询失败') : balanceLine(row.balance)),
          ]),
          row.balance === null ? null : React.createElement('div', { key: 'note', className: 'dim-jh-badgeNote' },
            splitLine(row.balance, windowDays, provider)),
        ]))),
    ]);
  }

  /** 一键签到（能力表允许的渠道才渲染）。 */
  function renderClaim() {
    return React.createElement('div', { key: 'claim', className: 'dim-jh-badgeSection' }, [
      React.createElement('button', {
        key: 'btn',
        type: 'button',
        className: 'dim-jh-badgeAction',
        disabled: claiming,
        title: '每日签到领取积分（各渠道接口不同，结果按渠道如实回报）',
        onClick: () => { void onClaim(); },
      }, claiming ? '领取中…' : '一键签到'),
      notice === '' ? null : React.createElement('div', { key: 'notice', className: 'dim-jh-badgeNote' }, notice),
    ]);
  }

  /** 脚注：停用账号数、失败账号数与失败原因。 */
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
 * 签到结果的**一行摘要**。
 *
 * 宿主返回的是 `{ results, summary }`（逐账号四态 `ClaimOutcome` + 汇总），
 * 这里按用户最关心的顺序给一句话：本次领到多少 → 已领过几个 → 几个失败。
 * ⚠️ 幂等判据在各渠道的响应体里（不是 HTTP 状态码），故「已领过」是**成功**语义，
 * 不能与失败混为一谈。
 */
function describeClaim(result) {
  const summary = result?.summary;
  if (summary === undefined) return '签到完成';
  const parts = [];
  if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功，共 +${Math.round(Number(summary.totalCredit) || 0)} 积分`);
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`);
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
  if (summary.failed > 0) {
    const reason = (result.results || []).find((row) => row?.outcome?.kind === 'failed')?.outcome?.message;
    parts.push(`${summary.failed} 个失败${reason ? `：${reason}` : ''}`);
  }
  return parts.length === 0 ? '签到完成（无可领取的账号）' : parts.join('；');
}
