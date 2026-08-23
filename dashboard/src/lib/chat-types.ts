export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  isStreaming?: boolean
  senderAgentId?: string
}
