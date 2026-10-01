/**
 * Jet Hub 设置页面样式 —— 对齐 dsh-im 设计。
 */

const STYLES = `
.dim-jh-page { display: flex; flex-direction: column; height: 100%; }
.dim-jh-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-jh-brand { display: flex; flex-direction: column; }
.dim-jh-brandName { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-jh-brandDesc { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 2px 0 0; }

/* 布局：对齐 dsh-im 的两栏 */
.dim-jh-layout { display: flex; flex: 1; overflow: hidden; }

/* 左侧导航：align dsh-im .dim-rail */
.dim-jh-rail { width: 200px; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 8px; }

/* 每个 provider 按钮：align dsh-im .dim-channel */
.dim-jh-provider { width: 100%; min-height: 48px; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease; }
.dim-jh-provider:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); background: color-mix(in srgb, #1677ff 2%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-provider[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 12%, var(--dsw-alias-bg-layer-3, #fff)); box-shadow: 0 3px 12px rgb(51 112 255 / 7%); }
.dim-jh-provider:focus-visible { outline: none; border-color: color-mix(in srgb, #1677ff 72%, var(--dsw-alias-border-l2, #dfe1e5)); box-shadow: 0 0 0 1px color-mix(in srgb, #1677ff 24%, transparent) inset, 0 3px 12px rgb(51 112 255 / 7%); }

/* 图标容器：align dsh-im .dim-logo */
.dim-jh-providerIcon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; box-shadow: 0 1px 3px rgb(31 35 41 / 7%); overflow: hidden; }
.dim-jh-providerIcon img { display: block; width: 20px; height: 20px; border-radius: 2px; }
.dim-jh-providerIcon.codearts { background: white; }
.dim-jh-providerIcon.buddy { background: white; }
.dim-jh-providerIcon.workbuddy { background: white; }
.dim-jh-providerIcon.lobsterai { background: white; }
.dim-jh-providerIcon.qoder { background: white; }
/* Qoder 中国版：官方 ICO 缩图，白底容器中对比度足够。 */
.dim-jh-providerIcon.qodercn { background: white; }
.dim-jh-providerIcon.trae { background: white; }
/* Raccoon Work（商汤）：官方图标是深蓝底白色面具，白底容器中显示清晰。 */
.dim-jh-providerIcon.raccoon { background: white; }
/* MiniMax Code（中国版）：官方 logo **自带浅蓝底** #7DC6FF，白底容器中显示清晰。
   ⚠️ 本文件的样式整体是一个模板字符串 —— 注释里**不能出现反引号**（会提前终止）。 */
.dim-jh-providerIcon.minimax { background: white; }
/*
 * ZCode（智谱）：图标自带深色圆角底 + 青色 Z，本身即完整图形，
 * 故容器保持透明（加白底反而会出现一圈突兀的方块）。
 */
.dim-jh-providerIcon.zcode { background: transparent; }

/* provider 文案：align dsh-im .dim-channelCopy */
.dim-jh-providerLabel { min-width: 0; display: grid; }
.dim-jh-providerLabel strong { overflow: hidden; color: inherit; font-size: 14px; line-height: 20px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }

/* 右侧面板 */
.dim-jh-panel { flex: 1; padding: 24px; overflow-y: auto; }
.dim-jh-empty { text-align: center; padding: 40px; color: var(--dsw-alias-label-tertiary, #888); }
.dim-jh-empty p { margin: 8px 0; font-size: 14px; }

/* 账号卡片 */
.dim-jh-accountCard { position: relative; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 2px 8px rgb(31 35 41 / 3%); transition: border-color .16s ease, box-shadow .16s ease, opacity .16s ease; }
.dim-jh-accountCard:hover { border-color: color-mix(in srgb, #1677ff 22%, var(--dsw-alias-border-l2, #eef0f3)); box-shadow: 0 5px 16px rgb(31 35 41 / 5%); }
.dim-jh-accountCard[data-enabled="false"] { opacity: 0.62; }

/* 拖拽排序 */
/* 抓取柄：独立的小区域，避免与卡片内的按钮/文本选择冲突 */
.dim-jh-dragHandle { flex: none; width: 16px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: grab; color: var(--dsw-alias-label-tertiary, #9aa0a6); font-size: 12px; line-height: 1; letter-spacing: -1px; user-select: none; border-radius: 4px; }
.dim-jh-dragHandle:hover { color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 5%); }
.dim-jh-dragHandle:active { cursor: grabbing; }
/* 正在被拖动的卡片：淡出以表明它已"拿起" */
.dim-jh-accountCard[data-dragging="true"] { opacity: 0.4; border-style: dashed; }
/* 拖拽悬停的目标位置：插入线。上方=插到该卡片之前，下方=之后。 */
.dim-jh-accountCard[data-dropBefore="true"]::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
.dim-jh-accountCard[data-dropAfter="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -6px; height: 3px; border-radius: 2px; background: #1677ff; }
/* 序号徽标：让当前优先级一目了然（顺序即自动选号优先级） */
.dim-jh-accountOrder { flex: none; min-width: 18px; padding: 0 5px; border-radius: 6px; font-size: 11px; line-height: 17px; font-weight: 600; text-align: center; color: var(--dsw-alias-label-secondary, #5f6672); background: rgb(31 35 41 / 6%); }
.dim-jh-orderHint { margin: 0 0 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 顶部一行：状态点 + 名称 + 状态标签 */
.dim-jh-accountTop { display: flex; align-items: center; gap: 8px; }
.dim-jh-accountStatus { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9aa0a6); }
.dim-jh-accountStatus[data-on="true"] { background: #22c55e; box-shadow: 0 0 0 3px rgb(34 197 94 / 14%); }
.dim-jh-accountName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-accountTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 500; }
.dim-jh-accountTag[data-tone="on"] { color: #15803d; background: rgb(34 197 94 / 12%); }
.dim-jh-accountTag[data-tone="off"] { color: var(--dsw-alias-label-tertiary, #8f959e); background: rgb(143 149 158 / 12%); }

/* 元信息：键值对齐的网格 */
.dim-jh-accountMeta { display: grid; gap: 3px; margin: 8px 0 0; }
.dim-jh-metaRow { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-jh-metaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-metaRow dd[data-tone="warn"] { color: #e37400; }
/* 积分未取到时的弱化提示。与 warn 区分：这不是异常，只是还没有数据 */
.dim-jh-metaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-metaRow code { padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

/* 账号卡片上的积分余额。
   覆盖 metaRow 的 overflow:hidden / nowrap —— 这里要的是横向排列的
   数值 + 次要说明，而 dd 默认样式是为单行截断文本准备的。 */
.dim-jh-metaRow dd.dim-jh-creditValue { display: flex; flex-direction: row; align-items: baseline; gap: 6px; overflow: visible; }
.dim-jh-creditTotal { font-size: 13px; font-weight: 600; color: #1677ff; font-variant-numeric: tabular-nums; }
.dim-jh-creditPackages { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 已失效额度：弱化的橙色提示，与主数值的蓝色明确区分 */
.dim-jh-creditExpired { font-size: 11px; color: #b45309; }

/* 限额重置徽章行 */
.dim-jh-rateLimits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.dim-jh-rateLimitsLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }

/* 操作按钮：横向一行，右对齐 */
.dim-jh-accountActions { display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: flex-end; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, #f0f1f3); }

/* 按钮：align dsh-im .dim-deliveryButton */
.dim-jh-btn { font-size: 12px; line-height: 18px; padding: 4px 12px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; color: var(--dsw-alias-label-primary, #1f2329); white-space: nowrap; transition: border-color .15s ease, background .15s ease, color .15s ease; }
.dim-jh-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 40%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-jh-btn[data-kind="primary"] { background: #1677ff; color: #fff; border-color: #1677ff; }
.dim-jh-btn[data-kind="primary"]:hover:not(:disabled) { background: #0f5fce; border-color: #0f5fce; color: #fff; }
.dim-jh-btn[data-kind="danger"] { color: #d93025; border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #dfe1e5)); }
.dim-jh-btn[data-kind="danger"]:hover:not(:disabled) { color: #b3261e; border-color: #d93025; background: rgb(217 48 37 / 6%); }
.dim-jh-btn:disabled { opacity: 0.5; cursor: default; }

/* 纯图标按钮（如「领取新手任务」的礼物图标）。
   ⚠️ 存在的理由：.dim-jh-accountActions 是 flex-wrap: nowrap，
   行内已有 5 个文字按钮，再加一个「领取新手任务」会被挤出容器（用户报障）。
   故把它压成等宽等高的方形图标按钮，文案移到 title tooltip。
   正方形靠固定 padding（左右 = 上下）实现，不依赖内容宽度。
   ⚠️ 本文件整体是一个 JS 模板字符串，注释里**不能出现反引号** —— 会提前
   终止字符串（本次构建失败的成因）。 */
.dim-jh-iconBtn { display: inline-flex; align-items: center; justify-content: center; padding: 4px 8px; min-width: 26px; }
.dim-jh-iconBtn svg { display: block; }

/* 限流 TTL 徽章 */
.dim-jh-ttlBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: rgb(227 116 0 / 10%); color: #b45309; font-size: 11px; line-height: 17px; font-weight: 500; }

/* 面板标题区：标题独占一行，操作按钮另起一行。
   此前用单行 space-between 把标题与 5 个按钮挤在一起，面板一窄就溢出被裁掉。 */
.dim-jh-panelHead { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 16px; }
.dim-jh-panelTitle { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }

/* 面板标题下方的操作按钮组（显示列表 / 刷新积分 / 一键领取积分 / 重测所有 / 重置所有 / 新建账号）。
   允许换行：按钮数量随 provider 变化（CodeBuddy 有「一键领取积分」，其他没有），
   固定单行在窄面板下必然放不下。 */
.dim-jh-headerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }

/* 上一次「重测 / 重置」的结果提示 */
.dim-jh-probeNotice { margin-bottom: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); background: var(--dsw-alias-bg-layer-2, #f7f8fa); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dim-jh-probeNotice[data-tone="ok"] { border-color: color-mix(in srgb, #22c55e 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(34 197 94 / 8%); color: #15803d; }
.dim-jh-probeNotice[data-tone="warn"] { border-color: color-mix(in srgb, #e37400 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(227 116 0 / 8%); color: #b45309; }
.dim-jh-probeNotice[data-tone="error"] { border-color: color-mix(in srgb, #d93025 35%, var(--dsw-alias-border-l2, #eef0f3)); background: rgb(217 48 37 / 8%); color: #b3261e; }
.dim-jh-probeDetails { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
.dim-jh-probeDetails li { font-size: 12px; line-height: 18px; }

/* 登录弹窗 */
.dim-jh-loginOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.dim-jh-loginDialog { background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 12px; padding: 24px; min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
.dim-jh-loginDialog h3 { margin: 0 0 8px; font-size: 16px; }
.dim-jh-loginDialog p { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 0 0 16px; }
.dim-jh-loginActions { display: flex; gap: 8px; justify-content: flex-end; }

/* ── 模型列表弹窗（「显示列表」） ── */
/* 复用登录弹窗的遮罩模式：fixed 覆盖全屏，z-index 高于设置页内容。
   3000 高于 .dim-jh-loginOverlay 的 1000，保证两个弹窗同时存在时模型列表在上。 */
.dim-jh-modalOverlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.32); }
/* 模型列表弹窗：**顶部锚定**而非垂直居中。
   ⚠️ 这是修真实缺陷（用户报障「输入文字后整个弹框的位置会发生改变，有点突兀」）：
   弹窗高度随列表长度变化，而 align-items: center 会把高度变化直接变成**整体
   位置跳动** —— 实测输入搜索词后 top 从 4px 跳到 187px（结果变少 → 弹窗变矮 →
   居中的位置跟着上移）。顶部锚定后上边缘固定，只在下方伸缩，视觉上稳定。
   只作用于模型列表，不影响账号备份弹窗。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。 */
.dim-jh-modalOverlay--top { align-items: flex-start; padding-top: max(24px, 8vh); }
/* 顶锚后可用高度由 padding 决定，故 max-height 按 padding box 计算（100%），
   不再用 100vh - 48px 这类视口算式 —— 否则 8vh 大于 24px 时会溢出视口。 */
.dim-jh-modalOverlay--top .dim-jh-modal { max-height: 100%; }
.dim-jh-modal { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(640px, calc(100vh - 48px)); padding: 20px 22px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
.dim-jh-modalHead { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-jh-modalTitle { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dim-jh-modalSubtitle { overflow: hidden; font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }
/* 头部右侧按钮组与标题里的计数徽标 */
.dim-jh-modelPanelActions { flex: none; display: flex; align-items: center; gap: 8px; }
.dim-jh-modelPanelCount { font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8f959e); }
.dim-jh-modalHint { flex: none; margin: 10px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* 弹窗提示里的强调词：danger=危险操作（覆盖/不可撤销），warn=警示（妥善保管） */
.dim-jh-emph-danger { color: #b3261e; font-weight: 600; }
.dim-jh-emph-warn { color: #b45309; font-weight: 600; }
.dim-jh-modal .dim-jh-probeNotice { flex: none; margin: 10px 0 0; }
/* 批量工具条（打开全部 / 关闭全部）：固定不滚动，紧跟在说明文字下方 */
.dim-jh-modelBulkBar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 搜索 + 状态筛选条（Cline 目录近 500 条，没有它就只能一页页翻）。
   允许换行：窄面板下搜索框与三个状态按钮放不进一行。 */
.dim-jh-modelFilterBar { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
/* 搜索框占据剩余宽度，最小 140px —— 再窄就输不下有意义的模型名片段。 */
.dim-jh-modelSearch { flex: 1 1 140px; min-width: 140px; width: auto; }
.dim-jh-modelStatusFilter { flex: none; display: flex; align-items: center; gap: 6px; }
/* 选中的筛选按钮高亮：三个按钮外观一致时用户看不出当前筛的是什么。 */
.dim-jh-modelStatusFilter .dim-jh-btn[data-active="true"] { border-color: #1677ff; color: #1677ff; background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-3, #fff)); font-weight: 600; }
/* 列表区独立滚动：头部与说明固定，模型多时只滚中间 */
/* ⚠️ overflow-x: hidden 是**兜底**，不是主修复（主修复见下方 grid 的 minmax）。
   没有它时，任何一行的偶然溢出都会让整个弹窗出现横向滚动条，而横向滚动条会把
   每一行的**开关**一起推出可视区 —— 用户报障「开关在最右边，要横向滑动才看得到」。
   ⚠️ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串，
   本次就因此构建失败过一次）—— 说明 CSS 属性时一律不加反引号。 */
.dim-jh-modalBody { flex: 1 1 auto; min-height: 0; margin-top: 10px; overflow-y: auto; overflow-x: hidden; }
.dim-jh-modalBody .dim-jh-empty { padding: 24px; }

/* 每行一个模型：左侧名称 + id，右侧开关 */
/* ⚠️ grid-template-columns: minmax(0, 1fr) 是**必须的**，不能省。
   单列 grid 的列宽默认是 auto，而 grid 项的 min-width 默认也是 auto ——
   两者叠加会让列宽按**最宽内容**撑开，于是长 id 把行推宽、行末的开关被挤出
   弹窗右边缘（真实缺陷：Cline 有 300 个 id 超过 20 字符，几乎每行都中招，
   表现为「开关在最后，需要横向滑动，我看不到」）。
   minmax(0, 1fr) 把列的最小宽度显式压到 0，行才会跟着容器收缩。 */
.dim-jh-modelList { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
/* 行本身是 grid 项也是 flex 容器，两处都需要 min-width: 0 才允许收缩。 */
.dim-jh-modelRow { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 7px 8px; border-radius: 8px; cursor: pointer; transition: background .15s ease; }
.dim-jh-modelRow:hover { background: var(--dsw-alias-bg-layer-2, #f7f8fa); }
/* 已关闭的模型整体降透明度：一眼能看出哪些被隐藏了 */
.dim-jh-modelRow[data-disabled="true"] .dim-jh-modelInfo { opacity: 0.5; }
.dim-jh-modelInfo { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
/* 名称与 id 都必须能收缩（min-width: 0 + 可收缩的 flex-basis），否则长内容会
   顶宽整行。展示名优先保留，故 id 另加 max-width 上限。
   ⚠️ id 早期是 flex: none（拒绝收缩）—— 那正是「开关被挤出可视区」最直接的成因。 */
.dim-jh-modelName { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 13px; line-height: 19px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-modelId { flex: 0 1 auto; min-width: 0; max-width: 46%; overflow: hidden; padding: 1px 5px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f4f5f7); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f959e); text-overflow: ellipsis; white-space: nowrap; }

/* 开关：基于 checkbox 绘制，保持原生语义（可聚焦、可键盘操作、可读屏） */
.dim-jh-switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--dsw-alias-border-l2, #d0d3d9); cursor: pointer; transition: background .18s ease; }
.dim-jh-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(31 35 41 / 20%); transition: transform .18s ease; }
.dim-jh-switch:checked { background: #1677ff; }
.dim-jh-switch:checked::after { transform: translateX(14px); }
.dim-jh-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 30%, transparent); }
.dim-jh-switch:disabled { opacity: 0.5; cursor: default; }

/* ── 账号备份（导出 / 恢复）── */
/* 口令输入框：宽度撑满弹窗内容区，避免在窄面板下挤坏布局。
   ⚠️ 背景必须用**真实存在**的 token。早期写的是 --dsw-alias-bg-input，而主题里
   根本没有这个 token（真实的是 bg-base / bg-layer-1/2/3）—— var() 遇不存在的
   token **不报错**，静默取 fallback #fff，于是深色模式下变成「浅色文字 + 白底」，
   文字完全看不见（用户报障）。这里对齐官方 Input 原语用的 bg-layer-1，
   并去掉 fallback 以免再次掩盖 token 拼错。 */
.dim-jh-input { box-sizing: border-box; width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); font-size: 13px; color: var(--dsw-alias-label-primary); }
.dim-jh-input:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 2px color-mix(in srgb, #1677ff 20%, transparent); }
/* placeholder 用官方 Input 的 dimmed 色：默认色在深色模式下对比度不足。 */
.dim-jh-input::placeholder { color: var(--dsw-alias-label-dimmed); }
/* 加密勾选行：勾选框 + 文案一行排开 */
.dim-jh-checkRow { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; font-size: 13px; color: var(--dsw-alias-label-primary, #1f2329); cursor: pointer; }
.dim-jh-checkRow input[type="checkbox"] { margin: 0; accent-color: #1677ff; }
/* 两次口令输入：纵向堆叠 */
.dim-jh-formRows { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
/* 弹窗底部动作区：右对齐（生成/确认按钮） */
.dim-jh-modalActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

/*
 * ── 官方「模型卡片 → 编辑」内的 ZCode 账号区（前缀 dim-jh-zc） ──
 *
 * ⚠ 本区**刻意不复用** .dim-jh-accountCard / .dim-jh-btn / .dim-jh-accountTop 等类：
 * 那些类同时被 Jet Hub 设置页使用（见 jet-hub.js 的 ProviderPanel），改它们会连带
 * 改掉设置页的观感。用户报障的是「编辑卡片里这块风格突兀」，故这里整套重画。
 *
 * 重画依据是官方 dsh-client-ui-settings-models 的编辑卡片（实测计算样式）：
 *   分组    = 上细线 .5px var(--dsw-alias-border-l2) + padding-top 10px
 *             （官方 .zGbnIq_customized / .zGbnIq_modelCatalog 都是这个组合）
 *   折叠行  = 12px/500、secondary 色、padding 2px 4px、margin-left -4px、radius 6px、
 *             chevron 用 5x5 + 1.5px 右/下边框再旋转 45 度（官方 .zGbnIq_customizedSummary）
 *   按钮    = 高 28px、padding 0 10px、radius 14px、12px/400、边框 .5px border-l3
 *             （官方 .zGbnIq_secondaryButton / .zGbnIq_linkButton）
 *   主按钮  = 底色 button-primary-fill + 前景 label-primary-foreground（官方保存键同款）
 *
 * 颜色一律走 --dsw-alias-* 令牌，**不再出现自定义蓝 #1677ff** —— 用户要求
 * 「颜色和官方默认颜色一样」，而官方这套里根本没有那个蓝。
 *
 * ⚠ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
 */
.dim-jh-zcSection { border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
/*
 * 隐藏本 route 自己维护、用户改不得的官方字段（见 zcode-card.js 文件头 ⑦）。
 *
 * 为什么需要：官方 ProviderEditor 对 pi-ai 卡片**无条件**渲染「API 密钥」与「API 地址」，
 * 没有 props 能关掉。而 zcode-free 的 baseURL 指向插件每次启动自起的本地桥（端口每次都变）、
 * 密钥是占位串，二者都由 src/pi-ai-mirror.ts 重写 —— 用户在这里改只会把桥打断。
 *
 * ⚠ display:none 而不是 visibility:hidden：后者仍占位，会留下两块空白。
 * ⚠ 用属性选择器（标记由 zcode-card.js 打），不做文本匹配 —— CSS 没法按文本选元素。
 * ⚠ 本文件整体是 JS 模板字符串，注释里**不能出现反引号**（会提前终止字符串）。
 */
[data-jet-hub-hidden] { display: none !important; }
.dim-jh-zcSummary { display: flex; align-items: center; gap: 6px; box-sizing: border-box; width: 100%; margin-left: -4px; padding: 2px 4px; border-radius: 6px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); cursor: pointer; list-style: none; }
.dim-jh-zcSummary::-webkit-details-marker { display: none; }
/* 折叠箭头：右/下边框各 1.5px 的 5x5 方块旋转 -45 度即 ▸；展开态（details[open]）转 45 度即 ▾ */
.dim-jh-zcSummary::before { content: ""; flex: none; width: 5px; height: 5px; border-bottom: 1.5px solid; border-right: 1.5px solid; transition: transform .12s; transform: rotate(-45deg) translate(-1px, -1px); }
.dim-jh-zcSection[open] > .dim-jh-zcSummary::before { transform: rotate(45deg) translate(-1px, -1px); }
.dim-jh-zcSummary:hover { color: var(--dsw-alias-label-primary); }
.dim-jh-zcSummary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
/* 折叠行右侧的次要说明：官方 .zGbnIq_modelCatalogMeta 就是这个规格（12px/400 tertiary） */
.dim-jh-zcCount { flex: none; white-space: nowrap; font-size: 12px; line-height: 18px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dim-jh-zcBody { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }

/* 单账号：官方 .zGbnIq_modelEntry 的规格（border .5px border-l4 + radius 10px + padding 6px） */
.dim-jh-zcAccount { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px; border: .5px solid var(--dsw-alias-border-l4); border-radius: 10px; }
.dim-jh-zcAccountTop { display: flex; align-items: center; gap: 8px; }
/* 状态点：官方 rowHead 的绿点同款色（state-success-primary），停用取 state-idle-primary 灰 */
.dim-jh-zcDot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dim-jh-zcDot[data-on="true"] { background: var(--dsw-alias-state-success-primary); }
.dim-jh-zcName { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }
/* 状态标签：走官方「自定义」那种**中性灰**胶囊，不用绿色 —— 绿色是突兀感的主要来源 */
.dim-jh-zcTag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 17px; font-weight: 400; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover-solid); }

.dim-jh-zcMeta { display: grid; gap: 2px; margin: 0; }
.dim-jh-zcMetaRow { display: grid; grid-template-columns: 48px minmax(0, 1fr); align-items: baseline; gap: 8px; }
.dim-jh-zcMetaRow dt { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-zcMetaRow dd { min-width: 0; margin: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-zcMetaRow dd[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }
.dim-jh-zcMetaRow dd[data-tone="muted"] { color: var(--dsw-alias-label-tertiary); }
/* 额度数值：覆盖 metaRow 的单行截断（要的是数值 + 次要说明并排） */
.dim-jh-zcMetaRow dd.dim-jh-zcCreditValue { display: flex; flex-direction: row; align-items: baseline; gap: 6px; overflow: visible; }
.dim-jh-zcCreditTotal { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
/* 折叠行右侧整组（账号数 + 号池总额度）：margin-left auto 把它推到最右。
 * ⚠ 需要 .dim-jh-zcSummary 从 fit-content 改为 100% 宽才有「右边」可言（见下）。 */
.dim-jh-zcSummaryRight { display: flex; align-items: baseline; gap: 8px; margin-left: auto; }
/* 号池两模型的总额度（折叠态可见，故用 secondary 而不是 tertiary —— tertiary 太淡） */
.dim-jh-zcPoolTotals { font-size: 12px; line-height: 18px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
/* 手机号：等宽数字，弱于账号名 */
.dim-jh-zcPhone { flex: none; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 逐模型额度：dd 里放多行，故要覆盖 metaRow 的单行 nowrap（与 .dim-jh-zcCreditValue 同理） */
.dim-jh-zcMetaRow dd.dim-jh-zcCreditList { display: flex; flex-direction: column; gap: 1px; overflow: visible; white-space: normal; }
.dim-jh-zcCreditModel { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dim-jh-zcCreditModelName { min-width: 0; overflow: hidden; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.dim-jh-zcCreditModelValue { flex: none; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
/* 未下发该模型额度时的占位（比 0 弱：0 是「已用光」，未下发是「查不到」） */
.dim-jh-zcCreditModelValue[data-tone="muted"] { font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.dim-jh-zcCreditModelValue[data-tone="warn"] { font-weight: 400; color: var(--dsw-alias-state-warn-label); }
/* 小号次按钮（账号行里的「删除」）—— 与 .dim-jh-zcBtn 同族，只是更矮更窄 */
.dim-jh-zcBtn[data-size="sm"] { height: 22px; padding: 0 8px; border-radius: 11px; font-size: 11px; line-height: 16px; }
/* 账号行内的操作条（目前只有「删除」）：右对齐，与额度行留一点间距 */
.dim-jh-zcAccountActions { display: flex; justify-content: flex-end; gap: 6px; }

.dim-jh-zcActions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.dim-jh-zcBtn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 14px; background: 0 0; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; font-weight: 400; white-space: nowrap; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.dim-jh-zcBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dim-jh-zcBtn[data-kind="primary"] { border-color: var(--dsw-alias-button-primary-fill); background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dim-jh-zcBtn[data-kind="primary"]:hover:not(:disabled) { border-color: var(--dsw-alias-button-primary-hover); background: var(--dsw-alias-button-primary-hover); }
.dim-jh-zcBtn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.dim-jh-zcBtn:disabled { opacity: .4; cursor: default; }

.dim-jh-zcEmpty { padding: 2px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dim-jh-zcEmpty p { margin: 0 0 4px; }
/* 结果提示：**刻意留在折叠区外**（见 zcode-card.js），故自带下间距 */
.dim-jh-zcNotice { margin-top: 10px; padding: 8px 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dim-jh-zcNotice[data-tone="ok"] { background: var(--dsw-alias-state-success-tertiary); }
.dim-jh-zcNotice[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary); }
.dim-jh-zcNotice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }
.dim-jh-zcNotice ul { margin: 4px 0 0; padding-left: 18px; }
.dim-jh-zcLink { color: var(--dsw-alias-link); word-break: break-all; }
`

let injected = false
export function installJetHubStyles() {
  if (injected) return () => {}
  injected = true
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => {
    style.remove()
    injected = false
  }
}
