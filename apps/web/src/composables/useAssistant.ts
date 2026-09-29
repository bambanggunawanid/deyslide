import type { InjectionKey } from 'vue'
import type { AssistantApi } from '../assistant/api'
import { inject } from 'vue'

export const ASSISTANT_KEY: InjectionKey<AssistantApi> = Symbol('assistant')

export function useAssistantApi(): AssistantApi {
  const api = inject(ASSISTANT_KEY)
  if (!api)
    throw new Error('The assistant API is not provided')
  return api
}
