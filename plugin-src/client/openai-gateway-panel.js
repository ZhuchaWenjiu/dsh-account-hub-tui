/**
 * 「本机 OpenAI 网关」设置面板的状态判定与文案（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `provider-toggle.js` / `model-bulk.js` / `credits-capabilities.js` 同理：
 * 本仓库的单测环境里 react 不在依赖内，组件无法渲染。把判定与文案抽成纯函数
 * 才能用真实断言覆盖，而不是靠源码级字符串匹配间接验证。
 *
 * ## 判据全部由宿主侧给定，前端不重算
 *
 * `enabled` / `running` / `blockedByEnv` / `address` 四项都来自
 * `gateway.getEnabled`（见 `src/jet-hub-rpc.ts`）。前端**只读不判**：
 *
 * - `enabled` 是**用户的选择**（持久化状态），与端口是否真在监听无关；
 * - `running` 是**实际运行态**（可能因端口冲突而未监听）；
 * - `blockedByEnv` 表示被 `DSH_OPENAI_GATEWAY_ENABLED` 显式停用，此时
 *   用户的 `enabled` 为真也**不会**让网关跑起来。
 *
 * ⚠️ 前端若自己拿 `enabled` 推导「是否在运行」，就会在端口冲突或 env 停用时
 * 显示「已开启」而用户连不上 —— 这类自相矛盾最难排查，故一律以宿主侧为准。
 *
 * @typedef {object} ApiKeyInfo
 * @property {string} value 密钥本体
 * @property {boolean} fromEnv 是否来自 DSH_OPENAI_GATEWAY_API_KEY
 * @property {string | null} path 密钥文件路径（来自环境变量时为 null）
 *
 * @typedef {object} GatewayStatus
 * @property {boolean} enabled 用户在设置页里的选择
 * @property {boolean} running 当前是否真的在监听端口
 * @property {boolean} blockedByEnv 是否被环境变量显式停用
 * @property {{ host: string, port: number } | null} address 实际监听地址
 * @property {ApiKeyInfo | null} [apiKey] 正在使用的凭据
 */

/**
 * 把密钥写进剪贴板。
 *
 * ## 为什么默认**不**把密钥明文渲染到页面上
 *
 * 设置页会被截图、被录屏、被投屏演示。让用户点一下「复制」比让密钥整条躺在
 * 屏幕上更可控 —— 明文只在用户主动点击的那一刻进入剪贴板。
 *
 * ## 失败必须自己处理
 *
 * 浏览器只在**用户手势**里允许 `navigator.clipboard.writeText`，异步兜底
 * （非 https、权限被拒、旧内核无 Clipboard API）都会 reject。调用方必须据此
 * 提示「请手动复制」并把值显示出来，否则用户点了按钮却毫无反应 —— 这正是
 * 「复制按钮点了没反应」这类最难自查的失败。
 *
 * @param {string} value 要复制的文本
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function copyToClipboard(value) {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 密钥来源的展示文案。
 *
 * ⚠️ 来自环境变量时**不显示文件路径** —— 那一刻根本没有文件，显示一个假路径
 * 只会让用户去那儿找然后扑空。
 *
 * @param {{ fromEnv: boolean, path: string | null } | null | undefined} apiKey
 * @returns {string}
 */
export function gatewayApiKeyHint(apiKey) {
  if (!apiKey) return '网关尚未生成过密钥：启用一次网关即会自动生成。'
  if (apiKey.fromEnv) return '密钥来自环境变量 DSH_OPENAI_GATEWAY_API_KEY（不在文件里）。'
  return apiKey.path ? `密钥文件：${apiKey.path}` : '密钥来自环境变量。'
}

/**
 * 页头按钮的文字。
 *
 * ⚠️ 刻意**只写「网关」**（不是「网关开关」）：页头按钮排成一行，文字越长越容易
 * 把右端的「关闭」挤到第二行（`jet-hub.js` 里「供应商」按钮旁有同款注释）。
 * 完整语义由 `title` 与弹窗标题承担。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayButtonLabel(status) {
  if (!status) return '网关'
  // 运行态用「●」提示，开着的按钮一眼可辨；但绝不用颜色单独承载语义
  // （`title` 与弹窗里都有文字说明）。
  return status.running ? '网关 ●' : '网关'
}

/**
 * 该模型是否接受图片输入。
 *
 * ⚠️ 判据取自**宿主回传的 `input`**（与 `/v1/models` 同一份），前端不自行推断。
 * 缺字段时按「不支持」处理：宁可少标一个（用户发图后拿到明确错误），也不要
 * 错标成支持（用户发完图才发现图被拒）。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {boolean}
 */
export function modelSupportsImage(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}

/**
 * 模型行上的能力标记。
 *
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {string} 空串表示不标任何标记
 */
export function modelCapabilityBadge(model) {
  return modelSupportsImage(model) ? '可发图片' : '';
}

/**
 * 列出模型 ID 的一行文本（每行一个，供粘贴到 agent 配置）。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @returns {string}
 */
export function formatModelIdList(models) {
  if (!models || models.length === 0) return ''
  return models.map((model) => model.id).join('\n')
}

/**
 * 模型目录的说明文案。
 *
 * ⚠️ 空清单必须**自解释**：此前只说「还没有可用模型，登录至少一个供应商」，
 * 而真实原因可能是宿主根本没给出任何可枚举的 provider（插件加载异常）。
 * 用户照着错误提示去检查自己的登录，怎么都找不到原因。
 *
 * @param {Array<{ id: string }> | null | undefined} models
 * @param {'catalog' | 'adapters' | 'none'} [source] 目录来源
 * @returns {string}
 */
export function gatewayModelsHint(models, source) {
  if (!models || models.length === 0) {
    if (source === 'none') {
      return '拿不到任何 provider 列表，模型清单无法读取。'
        + '这不是登录问题 —— 通常是 DSH 侧的模型服务尚未就绪，重启 DSH 或稍后点「刷新」再试。';
    }
    return '还没有可用模型：登录至少一个供应商后，点「刷新」即可看到可用的模型 ID。';
  }
  const base = `共 ${models.length} 个可用模型。`
    + '有些客户端（如 ZCode）不会自动扫描模型目录，需要从这里把模型 ID 复制到它的配置里。'
    + 'ID 区分大小写；同名模型在不同供应商下也是不同模型（例如 codearts 与 buddy 各有一份 deepseek-v4.1-flash）。';
  return source === 'adapters'
    ? base + '（当前目录来自本插件已注册的适配器，可能不含 DSH 自带的模型）'
    : base;
}

/**
 * 用命令行查看目录的命令模板。
 *
 * ⚠️ 刻意**不含明文密钥**，用占位符代替：命令会进剪贴板历史、可能被贴到聊天里，
 * 把真 key 写进去等于顺手泄露。
 *
 * @param {string | null | undefined} endpoint
 * @returns {string}
 */
export function gatewayModelsCurl(endpoint) {
  const base = endpoint ? endpoint.replace(/\/v1$/, '') : 'http://127.0.0.1:8326'
  return `curl ${base}/v1/models -H "Authorization: Bearer <把你的 API Key 贴在这里>"`
}

/**
 * 页头按钮的 tooltip。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayButtonTitle(status) {
  if (!status) return '本机 OpenAI 网关：读取状态中。'
  if (status.blockedByEnv) {
    return '本机 OpenAI 网关：已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，'
      + '在这里改开关不会让它监听端口。'
  }
  if (status.running) return `本机 OpenAI 网关：运行中（${gatewayEndpoint(status)}）。`
  if (status.enabled) return '本机 OpenAI 网关：已选择开启，但当前未在监听（通常是端口被占用）。'
  return '本机 OpenAI 网关：已关闭。'
}

/**
 * 网关的对外基地址，形如 `http://127.0.0.1:8326/v1`。
 *
 * ⚠️ `address` 为 `null` 时返回 `''` 而不是编造默认端口：端口可被
 * `DSH_OPENAI_GATEWAY_PORT` 改过，写死 `8326` 会让用户拿一个连不上的地址去
 * 配客户端，且这种错误在客户端侧表现为「连不上」，极难自查。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string}
 */
export function gatewayEndpoint(status) {
  const address = status?.address
  if (!address) return ''
  return `http://${address.host}:${address.port}/v1`
}

/**
 * 弹窗里的状态说明行。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {string[]}
 */
export function gatewayStatusLines(status) {
  if (!status) return ['正在读取网关状态…']
  if (status.blockedByEnv) {
    return [
      '已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 停用，网关不会监听端口。',
      '在下面的开关里做出的选择会被记住，但需要先取消该环境变量才会生效。',
    ]
  }
  if (status.running) {
    const endpoint = gatewayEndpoint(status)
    return [
      '网关正在运行。把外部客户端的 OpenAI 兼容地址设为下面这一行。',
      endpoint ? `地址：${endpoint}` : '',
    ].filter(Boolean)
  }
  if (status.enabled) {
    return [
      '已选择开启，但网关当前没有在监听。',
      '最常见的原因是端口被其它程序占用 —— 换 DSH_OPENAI_GATEWAY_PORT 后重启即可。',
    ]
  }
  return ['网关已关闭，不会监听任何端口。']
}

/**
 * 开关是否可点。
 *
 * ⚠️ 被 env 停用时**禁用**而不是「点了没反应」：让用户完成一次明知无效的操作，
 * 比直接说清「这里改不动、原因是什么」更让人困惑。
 *
 * @param {GatewayStatus | null | undefined} status
 * @returns {boolean}
 */
export function gatewaySwitchDisabled(status) {
  if (!status) return true
  return status.blockedByEnv
}

/**
 * 切换成功后给出的一句提示。
 *
 * @param {GatewayStatus | null | undefined} status 切换后的状态
 * @param {boolean} nextEnabled 用户想要的状态
 * @returns {string}
 */
export function gatewayToggleNotice(status, nextEnabled) {
  if (status?.blockedByEnv) {
    return '选择已保存，但 DSH_OPENAI_GATEWAY_ENABLED 仍在停用网关，取消它才会生效。'
  }
  if (!nextEnabled) return '网关已关闭，不再监听端口。'
  if (status?.running) return `网关已启动：${gatewayEndpoint(status)}`
  return '已选择开启，但网关没有在监听，请检查端口是否被占用。'
}
