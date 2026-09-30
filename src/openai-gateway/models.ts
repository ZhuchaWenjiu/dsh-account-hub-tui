export interface GatewayModelInfo {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

export interface GatewayProviderModels {
  provider: string
  models: readonly GatewayModelInfo[]
}

export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description?: string
  context_window?: number
  max_tokens?: number
  input?: readonly string[]
}

export function toOpenAiModelId(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** 将 DSH 的 provider 分组目录转换为 OpenAI models 响应中的 data 项。 */
export function toOpenAiModels(groups: readonly GatewayProviderModels[]): OpenAiModel[] {
  return groups.flatMap(({ provider, models }) => models.map((model) => ({
    id: toOpenAiModelId(provider, model.id),
    object: 'model' as const,
    created: 0,
    owned_by: provider,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
    ...model.inputModalities === undefined ? {} : { input: model.inputModalities },
  })))
}
