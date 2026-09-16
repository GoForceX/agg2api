/**
 * Central UI copy.
 *
 * Every user-visible string lives here so the admin has exactly one vocabulary: a
 * label shared by two views (the window names, the routing strategies, the six
 * usage columns) is defined once and cannot drift apart. Interpolated text is a
 * function, not a template string, so the caller cannot invent sentence shapes the
 * table does not describe.
 *
 * `copy.ts` stays separate from `format.ts` because the two have different inputs:
 * this table is a constant, while the formatters are locale-sensitive functions
 * that need the active locale at call time.
 */
import type { ProviderKind, RoutingStrategy } from "./types.ts"

/** Aliased so the table reads as data rather than as a type puzzle. */
export type Copy = typeof COPY

export const COPY = {
  brand: { name: "agg2api", admin: "管理端" },

  nav: {
    sections: "导航",
    dashboard: "概览",
    providers: "上游",
    routes: "路由",
    keys: "API 密钥",
    usage: "用量",
    token: "令牌"
  },

  footer: {
    defaultWindow: (window: string) => `默认窗口：${window}`,
    apiPath: "管理 API 位于 /admin/api"
  },

  /** Window labels, keyed by the stable id in `queries.ts`. */
  windows: {
    "1h": "1 小时",
    "24h": "24 小时",
    "7d": "7 天",
    "30d": "30 天"
  } satisfies Record<string, string>,

  /** Provider kinds are server enum values; the keys must match `ProviderKind`. */
  kinds: {
    "openai-chat": "OpenAI Chat",
    "openai-responses": "OpenAI Responses",
    workbuddy2api: "workbuddy2api"
  } satisfies Record<ProviderKind, string>,

  strategies: {
    priority: "优先级",
    weighted: "加权随机"
  } satisfies Record<RoutingStrategy, string>,

  strategy: {
    label: "路由策略",
    priority: "按优先级：始终先走优先级最高且可用的上游",
    weighted: "按权重：权重越高被选中的概率越大"
  },

  /** Field labels reused across the provider, route and key forms. */
  field: {
    name: "名称",
    enabled: "启用",
    kind: "类型",
    baseUrl: "接口地址",
    apiKey: "API 密钥",
    priority: "优先级",
    weight: "权重",
    headers: "自定义请求头",
    inputPrice: "输入单价",
    outputPrice: "输出单价",
    currency: "计价货币",
    models: "模型",
    publicModel: "对外模型名",
    upstreamModel: "上游模型名",
    strategy: "策略",
    targets: "目标上游",
    rateLimit: "限速（每分钟请求数）",
    allowedModels: "允许的模型",
    comments: "备注",
    secret: "密钥"
  },

  action: {
    create: "新建",
    add: "添加",
    edit: "编辑",
    save: "保存",
    saving: "保存中…",
    cancel: "取消",
    close: "关闭",
    delete: "删除",
    confirmDelete: "确认删除",
    dismiss: "知道了",
    retry: "重试",
    refresh: "刷新",
    copy: "复制",
    copied: "已复制",
    test: "测试",
    testing: "测试中…",
    discover: "拉取模型",
    discovering: "拉取中…",
    sync: "同步路由",
    syncing: "同步中…",
    probe: "探测余额",
    probing: "探测中…",
    clearFilters: "清除筛选",
    loadMore: "加载更多",
    showSecret: "显示密钥",
    previous: "上一页",
    next: "下一页",
    addEntry: "添加一项",
    removeEntry: (name: string) => `移除 ${name}`
  },

  state: {
    loading: "加载中…",
    loadingOverview: "正在加载概览",
    loadingUsage: "正在加载用量",
    loadingProviders: "正在加载上游",
    loadingRoutes: "正在加载路由",
    loadingKeys: "正在加载密钥",
    empty: "暂无数据",
    never: "从未",
    unknown: "未知",
    none: "无",
    yes: "是",
    no: "否",
    ok: "正常",
    failed: "失败",
    succeeded: "成功"
  },

  /** Pagination, shared by every paged table. */
  pager: {
    range: (first: number, last: number, total: number) => `${first}–${last} / 共 ${total} 条`,
    pageOf: (page: number, pages: number) => `第 ${page} / ${pages} 页`
  },

  /** Shared table and card headings, so two views cannot label one column differently. */
  column: {
    requests: "请求数",
    errors: "错误数",
    promptTokens: "输入 Token",
    completionTokens: "输出 Token",
    cachedTokens: "缓存 Token",
    cacheRate: "缓存命中率",
    cost: "费用",
    avgLatency: "平均延迟",
    avgTtft: "平均首字延迟",
    time: "时间",
    model: "模型",
    provider: "上游",
    status: "状态",
    latency: "延迟",
    tokens: "Token",
    strategy: "策略",
    clientKey: "客户端密钥",
    errorKind: "错误类型",
    detail: "详情",
    attempts: "尝试次数",
    endpoint: "协议",
    stream: "流式",
    actions: "操作"
  },

  metric: {
    requests: "请求数",
    errors: "错误数",
    errorRate: "错误率",
    cost: "费用",
    promptTokens: "输入 Token",
    completionTokens: "输出 Token",
    cachedTokens: "缓存 Token",
    cacheRate: "缓存命中率",
    avgLatency: "平均延迟",
    avgTtft: "平均首字延迟",
    tokensSaved: "缓存节省 Token"
  },

  chart: {
    requests: "请求",
    errors: "错误",
    noRequests: "该时间窗口内没有请求。",
    requestsOverTime: "请求随时间变化",
    label: (window: string) => `最近 ${window} 内每个时间分桶的请求数`,
    tooltip: (time: string, requests: string, errors: string) => `${time} · ${requests} 个请求 · ${errors} 个错误`
  },

  token: {
    title: "需要管理令牌",
    intro: "管理接口需要令牌才能访问。令牌只保存在本机浏览器中。",
    label: "管理令牌",
    placeholder: "粘贴 AGG2API_ADMIN_TOKEN",
    submit: "进入",
    reject: "令牌无效或已过期，请重新输入。",
    change: "更换令牌",
    hint: "令牌来自启动配置项 AGG2API_ADMIN_TOKEN。"
  },

  error: {
    requestFailed: "请求失败",
    loadFailed: "加载失败",
    saveFailed: "保存失败",
    deleteFailed: "删除失败",
    network: "无法连接到服务，请确认网关正在运行。",
    unauthorized: "令牌无效或已过期。"
  },

  validation: {
    nameRequired: "请填写名称",
    baseUrlRequired: "请填写接口地址",
    urlInvalid: "接口地址必须是有效的 URL",
    numberInvalid: "请填写有效数字",
    numberNegative: "不能为负数",
    modelRequired: "请填写模型名",
    atLeastOneTarget: "至少选择一个上游",
    weightRequired: "权重大于 0"
  },

  dashboard: {
    title: "概览",
    subtitle: "默认时间窗口内的总体情况",
    providers: "上游",
    providersHint: (enabled: number, total: number) => `已启用 ${enabled} / 共 ${total}`,
    breakersOpen: "熔断中",
    breakersHint: "正在冷却的上游",
    models: "模型",
    modelsHint: "已发现的模型",
    routes: "路由",
    routesHint: "对外模型映射",
    keys: "密钥",
    keysHint: "客户端密钥",
    credits: "余额",
    creditsHint: "workbuddy2api 上游",
    sessions: "会话亲和",
    sessionsHint: (pinned: number) => (pinned === 0 ? "暂无固定会话" : `已固定 ${pinned} 个会话`),
    uptime: "运行时长",
    uptimeHint: "自本次启动起",
    traffic: "请求流量",
    byProvider: "按上游统计",
    byProviderHint: "各上游在该窗口内的合计",
    noProviderTraffic: "该时间窗口内没有上游流量。",
    degraded: "服务未就绪",
    degradedHint: (detail: string) => `每个请求都会失败：${detail}`,
    /** Legend for the `N / M` stat value, which shows enabled against total. */
    providersRatio: "已启用 / 总数",
    sessionsReuse: (pinned: number, reused: number) => `已固定 ${pinned} 个会话 · 复用 ${reused} 次`,
    trafficTitle: (window: string) => `请求流量 · 最近 ${window}`,
    trafficSubtitle: "默认窗口内所有上游的合计",
    noTraffic: "暂无流量",
    errorRateHint: (rate: string) => `占请求数的 ${rate}`,
    costHint: "由上游上报",
    /** Shown when providers with different currencies are summed into one figure. */
    costMixedCurrency: (currencies: string) => `跨币种（${currencies}），该合计无单一单位`,
    ttftHint: "首个 Token 的延迟",
    cacheBarLabel: (rate: string) => `输入缓存命中率 ${rate}`,
    cacheNote: (cached: string, prompt: string) => `${prompt} 个输入 Token 中有 ${cached} 个来自上游缓存。`,
    noUsage: "暂无用量数据。",
    aggregateKey: "分组"
  },

  providers: {
    title: "上游",
    subtitle: "上游连接、健康状态与余额",
    add: "添加上游",
    edit: "编辑上游",
    editTitle: (name: string) => `编辑上游 ${name}`,
    listTitle: (count: number) => `${count} 个上游`,
    settingsLine: (strategy: string, timeout: string, interval: string) =>
      `默认策略：${strategy} · 请求超时 ${timeout} · 每 ${interval} 秒拉取一次模型`,
    empty: "还没有配置上游。添加一个之后才能路由请求。",
    baseUrlHint: "不要带 /v1，网关会自动拼接接口路径。",
    apiKeyHint: "留空表示沿用已有密钥；表格中只显示掩码。",
    headersHint: "每行一个，格式为 名称: 值",
    priceHint: "用于计算费用；留空表示不计费。",
    discovering: "正在拉取模型列表…",
    discoverResult: (id: number, added: number, removed: number, total: number) =>
      `上游 ${id}：新增 ${added} 个模型，移除 ${removed} 个，共 ${total} 个`,
    discoverFailed: "拉取失败",
    testOk: (model: string, latency: string, reply: string) => `连通正常 · ${model} · ${latency} · “${reply}”`,
    testFailed: (model: string, message: string) => `连接失败 · ${model}：${message}`,
    deleteConfirm: "删除该上游会同时移除它在所有路由中的引用。确定删除吗？",
    breaker: "熔断",
    lastError: "最近错误",
    lastSuccess: "最近成功",
    lastLatency: "最近延迟",
    routedModels: "已路由模型",
    accounts: "账户",
    healthyAccounts: (healthy: number) => `${healthy} 个可用`,
    creditsTotal: "余额合计",
    creditsFetched: (time: string) => `获取于 ${time}`,
    accountColumns: {
      uid: "UID",
      nickname: "昵称",
      realm: "区域",
      credits: "余额",
      state: "状态"
    },
    disabled: "已停用",
    cooling: "冷却中",
    /** Provider table heading that no other view shares. */
    credits: "余额",
    discoverAll: "全部拉取模型",
    discoveringAll: "正在拉取全部上游…",
    refreshCredits: "刷新余额",
    hideAccounts: "收起账户",
    routedCount: (count: number) => `已路由 ${count} 个模型`,
    notRouted: "未路由",
    enableToggle: (name: string) => `启用 ${name}`,
    lastSuccessAt: (time: string) => `成功 ${time}`,
    noSuccess: "还没有成功记录",
    noCreditSnapshot: "还没有余额数据，点击“刷新余额”获取。",
    noAccounts: "上游没有返回任何账户。",
    healthyAccountsLabel: "可用账户",
    discoverAllOk: (total: number) => `已在 ${total} 个上游上完成拉取。`,
    discoverAllFailed: (total: number, failed: number, detail: string) =>
      `${total} 个上游中有 ${failed} 个拉取失败：${detail}`,
    creditsFailed: (message: string) => `余额获取失败：${message}`,
    kindHint: "上游协议类型",
    apiKeyNewHint: "作为上游凭据发送；新建时必须填写。",
    apiKeyRequired: "新建上游必须填写 API 密钥",
    priorityHint: "优先级越高越先被选中；加权策略下同时作为权重",
    maxRetries: "最大重试次数",
    maxRetriesHint: "切换到其它上游之前，在本上游内部的重试次数",
    modelRename: "模型重命名",
    modelRenameHint: "暂无重命名。左侧填上游模型名，右侧填对外模型名。",
    modelAllowHint: "每行一个通配符；留空表示允许全部模型。",
    modelDeny: "排除的模型",
    modelDenyHint: "每行一个通配符；在允许列表之后应用。",
    headerNamePlaceholder: "请求头名称",
    headerValuePlaceholder: "值",
    namePlaceholder: "openai-main",
    baseUrlPlaceholder: "https://api.openai.com",
    apiKeyPlaceholder: "sk-…",
    numberPlaceholder: "0",
    currencyPlaceholder: "USD",
    modelAllowPlaceholder: "gpt-*\no1-*",
    modelDenyPlaceholder: "*-preview\n*-audio-*",
    /** Shown when models.dev is unreachable, so null capabilities are explained. */
    capabilitiesIndexMissing: "models.dev 未加载，无法推断模型能力",
    priceNote: (currency: string) => `价格按每百万 Token 计；用量费用以 ${currency} 结算。`
  },

  routes: {
    title: "路由",
    subtitle: "对外模型名到上游模型的映射",
    add: "新建路由",
    edit: "编辑路由",
    editTitle: (model: string) => `编辑路由：${model}`,
    empty: "还没有路由。拉取模型并同步之后会自动生成。",
    publicModelHint: "客户端请求时使用的模型名。",
    targetsHint: "同一策略下的多个上游会按优先级或权重选择。",
    upstreamModelHint: "留空表示与对外模型名相同。",
    deleteConfirm: "删除该路由后，客户端请求这个模型会返回 404。确定删除吗？",
    syncResult: (created: number, updated: number, removed: number) =>
      `新增 ${created} 个，更新 ${updated} 个，移除 ${removed} 个`,
    noTargets: "该路由没有可用上游，所有请求都会失败。",
    /** Legend under the heading: how the gateway default and `inherit` interact. */
    strategyLegend: (strategy: string) =>
      `网关默认策略为 ${strategy}；设为“继承默认”的路由会跟随它。按优先级时，由优先级最高且可用的目标上游处理每个请求；按权重时，优先级同时是权重，任何可用的目标上游都可能被选中。`,
    inherit: "继承默认",
    resolvedTo: (strategy: string) => `解析为 ${strategy}`,
    cardSubtitle: (model: string, targets: number, updated: string) =>
      `${model} · ${targets} 个目标上游 · 更新于 ${updated}`,
    displayName: "显示名称",
    displayNameHint: "可选，只在本控制台显示的名称。",
    serving: "服务中",
    servingVia: (provider: string, model: string) => `由 ${provider} → ${model} 提供服务`,
    weightedEligible: (targets: number) => `${targets} 个可用目标上游，按优先级加权`,
    preferredColumn: "首选",
    targetsEmpty: "暂无目标上游。",
    targetsEmptyHint: "还没有目标上游。没有目标上游的路由会让该模型返回 404。",
    selectProvider: "选择上游",
    selectProviderFirst: "请先选择上游",
    noDiscoveredModels: "没有已发现的模型",
    selectModel: "选择模型",
    disabledSuffix: "（已停用）",
    notDiscovered: (model: string) => `${model}（未发现）`,
    addTarget: "添加目标上游",
    removeTarget: "移除目标上游",
    /** Shown beside the chosen model so an operator knows what it accepts. */
    capabilitiesUnknown: "能力未知",
    /** Provenance matters: a provider's own claim and a catalogue lookup differ in trust. */
    sourceUpstream: "上游自报",
    sourceModelsDev: "models.dev",
    sourceNearest: "models.dev 推断",
    capabilityTools: "工具",
    capabilityReasoning: "推理",
    capabilityStructured: "结构化输出"
  },

  keys: {
    title: "API 密钥",
    subtitle: "客户端访问 /v1 所需的密钥",
    add: "新建密钥",
    edit: "编辑密钥",
    empty: "还没有客户端密钥。",
    requireHint: "开启 AGG2API_REQUIRE_CLIENT_KEY 后，没有密钥的请求会返回 401。",
    secretOnce: "请立即复制保存。密钥只显示这一次，之后无法再次查看。",
    rateLimitHint: "0 表示不限速。",
    allowedModelsHint: "每行一个模型名；留空表示允许全部模型。",
    deleteConfirm: "删除后使用该密钥的客户端会立即失效。确定删除吗？",
    lastUsed: "最近使用",
    totalRequests: "累计请求",
    optionalHint: "客户端密钥为可选项：未知调用方会被放行，但密钥仍然承担限速与模型白名单。",
    revealTitle: "立即复制新密钥",
    clipboardUnavailable: "无法访问剪贴板——请选中输入框手动复制。",
    countTitle: (count: number) => `${count} 个密钥`,
    rpm: "限速",
    allModels: "全部模型",
    unlimited: "不限速",
    createdAt: (time: string) => `创建于 ${time}`,
    enableToggle: (name: string) => `启用 ${name}`,
    editTitle: (name: string) => `编辑密钥：${name}`,
    secretGenerated: "密钥留空时由网关生成，创建后只显示这一次。",
    secretImmutable: "密钥本身无法修改或再次查看；如需轮换请删除后重建。",
    namePlaceholder: "prod-app",
    modelsPlaceholder: "gpt-4o\nclaude-*",
    doneButton: "我已保存"
  },

  usage: {
    title: "用量",
    subtitle: "请求明细与统计",
    byProvider: "按上游统计",
    byModel: "按模型统计",
    log: "请求日志",
    logHint: "按时间倒序，配合下方筛选",
    filters: "筛选",
    window: "时间窗口",
    allProviders: "全部上游",
    allModels: "全部模型",
    allStatuses: "全部状态",
    onlyErrors: "仅错误",
    onlyCached: "仅命中缓存",
    noLog: "该条件下没有请求记录。",
    cached: "命中缓存",
    notCached: "未命中缓存",
    attemptsHint: (n: number) => `尝试 ${n} 次`,
    empty: "该时间窗口内没有用量数据。",
    byKey: "按密钥统计",
    breakdown: "分组统计",
    totalsLast: (window: string) => `最近 ${window}合计`,
    bucketEvery: (bucket: string) => `每 ${bucket}聚合一个数据点`,
    reasoningTokens: "推理 Token",
    requestId: "请求 ID",
    ttft: "首字延迟",
    filteredTotals: (rows: string) => `筛选结果合计 · 共 ${rows} 条`,
    noModelTraffic: "该时间窗口内没有模型流量。",
    noKeyTraffic: "该时间窗口内没有密钥流量。"
  },

  toast: {
    created: "已创建",
    updated: "已更新",
    deleted: "已删除",
    synced: "已同步",
    discovered: "已拉取模型"
  }
} as const

/** Model names are data, not copy; this only labels the synthetic "everything" entry. */
export const ALL = "全部"
